import type { SchedState } from "../model/scheduler";

// Collects every write of one operation and turns it into a handful of
// set-based statements (`... FROM json_each(?)`), executed in one db.batch:
// atomic, and the statement count does not grow with the number of rows.
// D1 allows at most 100 bound parameters per statement and counts every
// statement of a batch as a query, so per-row statements don't scale.

const CHUNK = 500;
/** D1 limits a bound value to 2 MB; keep each JSON parameter well below. */
const MAX_PARAM_BYTES = 900_000;
const encoder = new TextEncoder();

export interface NoteInsert {
  id: string;
  deck_id: string;
  type: "word" | "basic";
  kanji: string | null;
  kana: string | null;
  meaning: string | null;
  front: string | null;
  back: string | null;
  enabled_directions: string;
  notes: string | null;
  extra: string | null;
  external_id: string | null;
  trap: string | null;
}

/**
 * Field update for one note. Only keys present are changed (a present key with
 * value null clears the column). `extra_merge` is a JSON object merged into the
 * stored extra (RFC 7396 json_patch); `extra` replaces it.
 */
export interface NoteFieldUpdate {
  id: string;
  deck_id?: string;
  kanji?: string | null;
  kana?: string | null;
  meaning?: string | null;
  front?: string | null;
  back?: string | null;
  notes?: string | null;
  trap?: string | null;
  enabled_directions?: string;
  extra?: string | null;
  extra_merge?: string;
}

export interface LogInsert {
  id: string;
  card_id: string;
  rating: number;
  reviewed_at: number;
  source: string;
  answer: string | null;
  session_id: string | null;
  /** 0 when the answer was judged correct but couldn't be checked (IME kanji). */
  verified: number;
  /** 0 for early (volunteered, not asked) answers: history only, no scheduling. */
  affects_schedule: number;
  /** Teacher feedback shown to the learner. */
  feedback?: string | null;
}

/** Split rows into chunks of at most CHUNK rows and ~MAX_PARAM_BYTES of JSON. */
export function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 2;
  for (const x of xs) {
    const size = encoder.encode(JSON.stringify(x)).length + 1;
    if (size > MAX_PARAM_BYTES) throw new Error("A single row is too large to store");
    if (cur.length && (cur.length >= CHUNK || bytes + size > MAX_PARAM_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(x);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

const UPDATABLE = ["deck_id", "kanji", "kana", "meaning", "front", "back", "notes", "trap", "enabled_directions"] as const;

export class Writes {
  /** Statements that must run before everything else (e.g. the session-close guard). */
  first: D1PreparedStatement[] = [];
  decks: { id: string; name: string; description: string | null; default_directions: string | null }[] = [];
  /** Arbitrary statements run first (e.g. deck updates). */
  pre: D1PreparedStatement[] = [];
  /** One merged update per note: UPDATE ... FROM with duplicate keys would apply an arbitrary one. */
  noteUpdates = new Map<string, NoteFieldUpdate>();
  clearTags: string[] = [];
  untag: [string, string][] = [];
  notes: NoteInsert[] = [];
  /** [card_id, note_id, direction]; cards start in the empty (new) state at `now`. */
  cards: [string, string, string][] = [];
  /** [card_id, suspended 0|1] */
  cardFlags: [string, number][] = [];
  tags: [string, string][] = [];
  logs: LogInsert[] = [];
  states: (SchedState & { id: string })[] = [];
  /** Cards created in this batch with an imported schedule: state set and kept as initial_state. */
  imported: (SchedState & { id: string })[] = [];
  /** [pending_answer id, review_log id]: answers graded by a review in this batch. */
  graded: [string, string][] = [];
  /** Arbitrary statements run last (e.g. closing a study session). */
  post: D1PreparedStatement[] = [];

  constructor(
    private db: D1Database,
    private userId: string,
    private now: number,
    private emptyCard: SchedState,
  ) {}

  patchNote(u: NoteFieldUpdate) {
    const cur = this.noteUpdates.get(u.id);
    if (!cur) this.noteUpdates.set(u.id, { ...u });
    else {
      if (u.extra_merge && cur.extra_merge && !("extra" in u)) {
        u = { ...u, extra_merge: JSON.stringify({ ...JSON.parse(cur.extra_merge), ...JSON.parse(u.extra_merge) }) };
      }
      Object.assign(cur, u);
    }
  }

  addTags(noteId: string, tags: readonly string[] | undefined) {
    for (const t of new Set((tags ?? []).map((x) => x.trim()).filter(Boolean))) this.tags.push([noteId, t]);
  }

  get empty() {
    return ![
      this.first, this.decks, this.pre, [...this.noteUpdates.values()], this.clearTags, this.untag, this.notes,
      this.cards, this.cardFlags, this.tags, this.logs, this.states, this.imported, this.graded, this.post,
    ].some((a) => a.length);
  }

  statements(): D1PreparedStatement[] {
    const db = this.db;
    const u = this.userId;
    const s: D1PreparedStatement[] = [...this.first];
    for (const c of chunks(this.decks)) {
      s.push(
        db
          .prepare(
            `INSERT INTO decks (id, user_id, name, description, default_directions, created_at)
             SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.name'), json_extract(value, '$.description'),
                    json_extract(value, '$.default_directions'), ?3
             FROM json_each(?1)`,
          )
          .bind(JSON.stringify(c), u, this.now),
      );
    }
    s.push(...this.pre);
    for (const c of chunks([...this.noteUpdates.values()])) {
      // A column is set only when its key is present in the JSON object.
      const sets = UPDATABLE.map(
        (k) => `${k} = CASE WHEN json_type(j.value, '$.${k}') IS NULL THEN ${k} ELSE json_extract(j.value, '$.${k}') END`,
      );
      sets.push(
        `extra = CASE WHEN json_type(j.value, '$.extra') IS NOT NULL THEN json_extract(j.value, '$.extra')
                      WHEN json_type(j.value, '$.extra_merge') IS NOT NULL
                        THEN json_patch(COALESCE(extra, '{}'), json_extract(j.value, '$.extra_merge'))
                      ELSE extra END`,
      );
      s.push(
        db
          .prepare(
            `UPDATE notes SET ${sets.join(", ")}, updated_at = ?3
             FROM json_each(?1) AS j
             WHERE notes.id = json_extract(j.value, '$.id') AND notes.user_id = ?2`,
          )
          .bind(JSON.stringify(c), u, this.now),
      );
    }
    for (const c of chunks(this.clearTags)) {
      s.push(db.prepare(`DELETE FROM note_tags WHERE note_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(c)));
    }
    for (const c of chunks(this.untag)) {
      s.push(
        db
          .prepare(
            `DELETE FROM note_tags WHERE EXISTS (SELECT 1 FROM json_each(?) j
               WHERE json_extract(j.value, '$[0]') = note_tags.note_id AND json_extract(j.value, '$[1]') = note_tags.tag)`,
          )
          .bind(JSON.stringify(c)),
      );
    }
    for (const c of chunks(this.notes)) {
      s.push(
        db
          .prepare(
            `INSERT INTO notes (id, user_id, deck_id, type, kanji, kana, meaning, front, back,
               enabled_directions, notes, extra, external_id, trap, created_at, updated_at)
             SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.deck_id'), json_extract(value, '$.type'),
               json_extract(value, '$.kanji'), json_extract(value, '$.kana'), json_extract(value, '$.meaning'),
               json_extract(value, '$.front'), json_extract(value, '$.back'), json_extract(value, '$.enabled_directions'),
               json_extract(value, '$.notes'), json_extract(value, '$.extra'), json_extract(value, '$.external_id'),
               json_extract(value, '$.trap'), ?3, ?3
             FROM json_each(?1) ORDER BY key`,
          )
          .bind(JSON.stringify(c), u, this.now),
      );
    }
    const e = this.emptyCard;
    for (const c of chunks(this.cards)) {
      s.push(
        db
          .prepare(
            `INSERT INTO cards (id, user_id, note_id, direction, suspended, due, stability, difficulty,
               elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at)
             SELECT json_extract(value, '$[0]'), ?2, json_extract(value, '$[1]'), json_extract(value, '$[2]'), 0,
               ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?3
             FROM json_each(?1) ORDER BY key`,
          )
          .bind(
            JSON.stringify(c), u, this.now,
            e.due, e.stability, e.difficulty, e.elapsed_days, e.scheduled_days, e.learning_steps, e.reps, e.lapses, e.state, e.last_review,
          ),
      );
    }
    const cols = ["due", "stability", "difficulty", "elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses", "state", "last_review"];
    for (const c of chunks(this.imported)) {
      s.push(
        db
          .prepare(
            `UPDATE cards SET ${cols.map((k) => `${k} = json_extract(j.value, '$.${k}')`).join(", ")},
               initial_state = json_remove(j.value, '$.id')
             FROM json_each(?1) AS j
             WHERE cards.id = json_extract(j.value, '$.id') AND cards.user_id = ?2`,
          )
          .bind(JSON.stringify(c), u),
      );
    }
    for (const c of chunks(this.cardFlags)) {
      s.push(
        db
          .prepare(
            `UPDATE cards SET suspended = json_extract(j.value, '$[1]') FROM json_each(?1) AS j
             WHERE cards.id = json_extract(j.value, '$[0]') AND cards.user_id = ?2`,
          )
          .bind(JSON.stringify(c), u),
      );
    }
    for (const c of chunks(this.tags)) {
      s.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO note_tags (note_id, tag)
             SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)`,
          )
          .bind(JSON.stringify(c)),
      );
    }
    for (const c of chunks(this.logs)) {
      s.push(
        db
          .prepare(
            `INSERT INTO review_log (id, user_id, card_id, rating, reviewed_at, source, answer, session_id, verified, affects_schedule, feedback, created_at)
             SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.card_id'), json_extract(value, '$.rating'),
               json_extract(value, '$.reviewed_at'), json_extract(value, '$.source'), json_extract(value, '$.answer'),
               json_extract(value, '$.session_id'), json_extract(value, '$.verified'), json_extract(value, '$.affects_schedule'),
               json_extract(value, '$.feedback'), ?3
             FROM json_each(?1) ORDER BY key`,
          )
          .bind(JSON.stringify(c), u, this.now),
      );
    }
    for (const c of chunks(this.states)) {
      s.push(
        db
          .prepare(
            `UPDATE cards SET ${cols.map((k) => `${k} = json_extract(j.value, '$.${k}')`).join(", ")}
             FROM json_each(?1) AS j
             WHERE cards.id = json_extract(j.value, '$.id') AND cards.user_id = ?2`,
          )
          .bind(JSON.stringify(c), u),
      );
    }
    for (const c of chunks(this.graded)) {
      s.push(
        db
          .prepare(
            `UPDATE pending_answers SET graded_at = ?3, review_id = json_extract(j.value, '$[1]') FROM json_each(?1) AS j
             WHERE pending_answers.id = json_extract(j.value, '$[0]') AND pending_answers.user_id = ?2 AND pending_answers.graded_at IS NULL`,
          )
          .bind(JSON.stringify(c), u, this.now),
      );
    }
    s.push(...this.post);
    return s;
  }
}
