import {
  ALL_DIRECTIONS,
  type AskMode,
  DEFAULT_BASIC_DIRECTIONS,
  DEFAULT_WORD_DIRECTIONS,
  type Direction,
  type NoteType,
  type Prompt,
  acceptedAnswers,
  activeDirections,
  groupPrompts,
  splitDirection,
  isApplicable,
  isDirectionForType,
  planCards,
} from "../model/directions";
import { csvObjects, splitTags } from "../model/csv";
import { badReadings, bareBases, displayText, fillReadings, hasMarkup, plainText, rubySpans, spanBases, type RubySpan } from "../model/furigana";
import { NoteIndex, lookupKeys, normJa } from "../model/match";
import {
  RATINGS,
  RATING_NAMES,
  type RatingName,
  STATE_NAMES,
  type SchedState,
  type ScheduleInput,
  applyReview,
  emptyState,
  importedState,
  replay,
  retrievability,
} from "../model/scheduler";
import { FALLBACK_TZ, isValidTz, parseTime } from "../model/time";
import { type NoteFieldUpdate, type NoteInsert, Writes } from "./writes";

export type ReviewSource = "chat" | "lesson" | "self" | "ui";
export type OnConflict = "skip" | "update" | "merge";

/** Per-user settings (user_settings table). */
export interface Settings {
  /** A furigana span hides its reading once the word's kanji>kana card is in review with at least this stability. */
  furigana_known_days: number;
}
export const DEFAULT_SETTINGS: Settings = { furigana_known_days: 7 };

/** A furigana span that couldn't be resolved at write time (kept as written). */
export interface FuriganaProblem {
  field: string;
  text: string;
  status: "no_word" | "ambiguous" | "reading_not_kana";
  reason: string;
  candidates?: { note_id: string; kanji: string | null; kana: string | null; meaning: string | null }[];
}

/** Text fields that may carry furigana markup. */
const MARKUP_FIELDS = ["front", "back", "notes", "trap"] as const;
const MARKUP_EXTRA = ["example", "alt_backs", "alt_fronts"] as const;

export class UserError extends Error {}

/**
 * HAVING clause for "hardest notes" (grouped by n.id, cards c): only notes that are
 * actually struggling, so the list may be short or empty. Takes one positional
 * parameter (the window start) for the again/hard check.
 */
const STRUGGLING = `(SUM(c.lapses) > 0
  OR SUM(c.reps >= 2 AND c.stability < 1) > 0
  OR EXISTS (SELECT 1 FROM review_log hr JOIN cards hc ON hc.id = hr.card_id
             WHERE hc.note_id = n.id AND hr.rating <= 2 AND hr.reviewed_at >= ?))`;

/** SQL condition on cards `c`: no answer waiting for grading (such cards are not asked or counted as due). */
const NOT_PENDING = `NOT EXISTS (SELECT 1 FROM pending_answers pa WHERE pa.card_id = c.id AND pa.graded_at IS NULL)`;

/** Max characters for one text field (meaning, notes, trap, front, back...). */
export const FIELD_MAX = 2000;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DEFAULT_SIBLING_GAP = 6 * HOUR;
/** Sessions without session_end older than this are auto-closed by session_start. */
const OPEN_SESSION_MAX = 12 * HOUR;

interface NoteRow {
  id: string;
  deck_id: string;
  type: NoteType;
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
  created_at: number;
  updated_at: number;
}
type NoteWithDeck = NoteRow & { deck_name: string };

interface CardRow extends SchedState {
  id: string;
  note_id: string;
  direction: Direction;
  suspended: number;
  created_at: number;
  /** JSON SchedState imported from another tool; replays start from it. */
  initial_state?: string | null;
}

interface DeckInfo {
  id: string;
  name: string;
  default_directions: Direction[] | null;
}

export interface WordInput {
  kanji?: string | null;
  kana: string;
  meaning: string;
  notes?: string | null;
  tags?: string[];
  directions?: Direction[];
  extra?: Record<string, unknown> | null;
  external_id?: string | null;
  /** Short pitfall shown after the answer, e.g. "午 noon, not 牛 cow". */
  trap?: string | null;
  /** Initial schedule for the created cards (imported history). */
  schedule?: ScheduleInput | null;
}

export interface BasicInput {
  front: string;
  back: string;
  /** Other correct answers for the back (stored as extra.alt_backs). */
  accept?: string[] | null;
  reversible?: boolean;
  schedule?: ScheduleInput | null;
  notes?: string | null;
  tags?: string[];
  extra?: Record<string, unknown> | null;
  external_id?: string | null;
  trap?: string | null;
}

export interface NoteUpdate {
  deck?: string;
  kanji?: string | null;
  kana?: string | null;
  meaning?: string | null;
  front?: string | null;
  back?: string | null;
  notes?: string | null;
  extra?: Record<string, unknown> | null;
  trap?: string | null;
  /** Other correct answers for a basic note's back (merged into extra.alt_backs). */
  accept?: string[] | null;
  /** Merged into the note's tags, unless replace_tags is true. */
  tags?: string[];
  replace_tags?: boolean;
  remove_tags?: string[];
}

export interface ReviewInput {
  card_id: string;
  rating: RatingName;
  reviewed_at?: string | number;
  source?: ReviewSource;
  answer?: string | null;
  session_id?: string | null;
  /** false: correct but unverifiable (e.g. IME produced the kanji). Default true. */
  verified?: boolean;
  /** true: volunteered answer for a card that wasn't asked; kept in history, schedule unchanged. */
  early?: boolean;
  /** Teacher feedback shown to the learner in the UI. */
  feedback?: string | null;
}

/** A session_end review: by card_id, or by content (word kanji?/kana, basic front). */
export interface SessionReviewInput {
  card_id?: string;
  deck?: string;
  kanji?: string | null;
  kana?: string;
  meaning?: string;
  front?: string;
  back?: string;
  direction?: Direction;
  rating: RatingName;
  reviewed_at?: string | number;
  answer?: string | null;
  source?: ReviewSource;
  notes?: string | null;
  trap?: string | null;
  tags?: string[];
  verified?: boolean;
  early?: boolean;
  feedback?: string | null;
}

/** Imported schedule as given over the API (times as ISO / local strings). */
export interface ScheduleArg {
  state?: string | number;
  due: string | number;
  stability?: number;
  difficulty?: number;
  last_review?: string | number;
  reps?: number;
  lapses?: number;
}

export interface BulkRow {
  deck?: string;
  kanji?: string | null;
  kana?: string | null;
  meaning?: string | null;
  notes?: string | null;
  tags?: string[] | string;
  trap?: string | null;
  front?: string | null;
  back?: string | null;
  /** Word or basic directions for this row (else the deck's defaults / front>back). */
  directions?: string[] | string | null;
  /** Other correct backs (basic rows); in CSV separated by ; or |. */
  accept?: string[] | string | null;
  /** Initial schedule for the row's new cards (another tool's history); in CSV a JSON object. */
  schedule?: ScheduleArg | string | null;
}

const clean = (v: string | null | undefined) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};
/** kanji/kana are stored NFKC-normalised (half-width kana, compatibility kanji). */
const cleanJa = (v: string | null | undefined) => clean(v)?.normalize("NFKC") ?? null;
const parseJson = <T>(v: string | null, fallback: T): T => (v ? (JSON.parse(v) as T) : fallback);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const wordKey = (kanji: string | null | undefined, kana: string | null | undefined) => `${normJa(kanji)}\t${normJa(kana)}`;
/** Basic notes compare without furigana markup: {今日|きょう}は == 今日は. */
const basicKey = (front: string | null | undefined, back: string | null | undefined) =>
  `${normJa(front == null ? front : plainText(front))}\t${normJa(back == null ? back : plainText(back))}`;

function brief(n: { id: string; type: NoteType; kanji: string | null; kana: string | null; meaning: string | null; front: string | null; back?: string | null; deck_name?: string }) {
  return n.type === "word"
    ? { note_id: n.id, kanji: n.kanji, kana: n.kana, meaning: n.meaning, deck: n.deck_name }
    : { note_id: n.id, front: n.front, back: n.back ?? null, deck: n.deck_name };
}

/** Every query goes through here and is scoped to one user. */
export class Store {
  constructor(
    private db: D1Database,
    readonly userId: string,
    private clock: () => number = Date.now,
    readonly defaultTz: string = FALLBACK_TZ,
  ) {}

  private id() {
    return crypto.randomUUID();
  }

  private tz(tz?: string | null) {
    const t = tz || this.defaultTz;
    if (!isValidTz(t)) throw new UserError(`Unknown time zone "${t}" (use an IANA name like Europe/Paris)`);
    return t;
  }

  private writes(now = this.clock()) {
    return new Writes(this.db, this.userId, now, emptyState(now));
  }

  /** Run all collected writes in one atomic batch; returns the statement count. */
  private async commit(w: Writes) {
    const stmts = w.statements();
    if (!stmts.length) return 0;
    try {
      await this.db.batch(stmts);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("UNIQUE")) throw new UserError(uniqueMessage(msg));
      throw e;
    }
    return stmts.length;
  }

  // ---------- settings ----------

  async getSettings(): Promise<Settings> {
    const row = await this.db.prepare(`SELECT settings FROM user_settings WHERE user_id = ?`).bind(this.userId).first<{ settings: string }>();
    return { ...DEFAULT_SETTINGS, ...parseJson<Partial<Settings>>(row?.settings ?? null, {}) };
  }

  async updateSettings(patch: Partial<Settings>) {
    const cur = await this.getSettings();
    const next: Settings = { ...cur };
    if (patch.furigana_known_days !== undefined) {
      const d = Number(patch.furigana_known_days);
      if (!Number.isFinite(d) || d < 0 || d > 3650) throw new UserError("furigana_known_days must be between 0 and 3650");
      next.furigana_known_days = d;
    }
    await this.db
      .prepare(
        `INSERT INTO user_settings (user_id, settings, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET settings = ?2, updated_at = ?3`,
      )
      .bind(this.userId, JSON.stringify(next), this.clock())
      .run();
    return next;
  }

  // ---------- furigana ----------

  /**
   * Resolve bare {漢字} spans in the text fields of `items` (front, back, notes, trap,
   * extra.example / alt_backs / alt_fronts): exactly one word note with that kanji face → its
   * reading is written in; none or several → kept bare and reported. Words added in the same
   * call (`pending`) count too. Returns copies; nothing is guessed from partial matches.
   */
  private async resolveFurigana<T extends object>(
    items: readonly T[],
    pending: ReadonlyArray<{ kanji?: string | null; kana?: string | null }> = [],
  ): Promise<{ items: T[]; problems: FuriganaProblem[][] }> {
    type Loc = { obj: Record<string, unknown>; key: string; label: string };
    const copies = items.map((it) => {
      const c = { ...(it as Record<string, unknown>) };
      if (c.extra && typeof c.extra === "object") c.extra = { ...(c.extra as Record<string, unknown>) };
      return c;
    });
    const locs: Loc[][] = copies.map((c) => {
      const out: Loc[] = [];
      for (const k of MARKUP_FIELDS) if (typeof c[k] === "string") out.push({ obj: c, key: k, label: k });
      const ex = c.extra as Record<string, unknown> | null | undefined;
      if (ex) {
        for (const k of MARKUP_EXTRA) {
          if (typeof ex[k] === "string") out.push({ obj: ex, key: k, label: `extra.${k}` });
          else if (Array.isArray(ex[k])) {
            ex[k] = [...(ex[k] as unknown[])];
            (ex[k] as unknown[]).forEach((v, i) => typeof v === "string" && out.push({ obj: ex[k] as never, key: String(i), label: `extra.${k}[${i}]` }));
          }
        }
      }
      return out;
    });
    const problems: FuriganaProblem[][] = copies.map(() => []);
    const bases = new Set<string>();
    locs.flat().forEach((l) => bareBases(l.obj[l.key] as string).forEach((b) => bases.add(b)));
    const byKanji = new Map<string, { note_id: string; kanji: string | null; kana: string | null; meaning: string | null }[]>();
    if (bases.size) {
      const { results } = await this.db
        .prepare(`SELECT id, kanji, kana, meaning FROM notes WHERE user_id = ? AND type = 'word' AND kanji IN (SELECT value FROM json_each(?))`)
        .bind(this.userId, JSON.stringify([...bases]))
        .all<{ id: string; kanji: string; kana: string; meaning: string }>();
      for (const r of results) byKanji.set(r.kanji, [...(byKanji.get(r.kanji) ?? []), { note_id: r.id, kanji: r.kanji, kana: r.kana, meaning: r.meaning }]);
      for (const p of pending) {
        const k = cleanJa(p.kanji);
        if (!k || !bases.has(k) || (byKanji.get(k) ?? []).some((x) => x.kana === cleanJa(p.kana))) continue;
        byKanji.set(k, [...(byKanji.get(k) ?? []), { note_id: "(added in this call)", kanji: k, kana: cleanJa(p.kana), meaning: null }]);
      }
    }
    const readings = new Map<string, string>();
    for (const [k, list] of byKanji) if (list.length === 1 && list[0]!.kana) readings.set(k, list[0]!.kana);
    locs.forEach((list, i) => {
      for (const l of list) {
        const text = l.obj[l.key] as string;
        for (const b of new Set(bareBases(text))) {
          if (readings.has(b)) continue;
          const cands = byKanji.get(b) ?? [];
          problems[i]!.push(
            cands.length
              ? { field: l.label, text: b, status: "ambiguous", reason: `several words are written ${b}; give the reading: {${b}|…}`, candidates: cands }
              : { field: l.label, text: b, status: "no_word", reason: `no word note with kanji ${b}; give the reading: {${b}|…} (kept without furigana)` },
          );
        }
        for (const bad of badReadings(text)) {
          problems[i]!.push({ field: l.label, text: `{${bad.base}|${bad.reading}}`, status: "reading_not_kana", reason: "the reading should be kana (stored as written)" });
        }
        if (bareBases(text).length) l.obj[l.key] = fillReadings(text, readings);
      }
    });
    return { items: copies as T[], problems };
  }

  /**
   * Furigana rendering for text fields: per field with markup, `display` (readings to show in
   * brackets) and `ruby` spans. A reading is hidden once a word note with that kanji has a
   * kanji>kana card in review with stability >= furigana_known_days.
   */
  private async furiganaRenderer(texts: Iterable<string | null | undefined>) {
    const bases = new Set<string>();
    for (const t of texts) if (t && hasMarkup(t)) spanBases(t).forEach((b) => bases.add(b));
    const known = new Set<string>();
    if (bases.size) {
      const settings = await this.getSettings();
      const { results } = await this.db
        .prepare(
          `SELECT DISTINCT n.kanji FROM notes n JOIN cards c ON c.note_id = n.id AND c.direction = 'kanji>kana'
           WHERE n.user_id = ? AND n.type = 'word' AND n.kanji IN (SELECT value FROM json_each(?)) AND c.state = 2 AND c.stability >= ?`,
        )
        .bind(this.userId, JSON.stringify([...bases]), settings.furigana_known_days)
        .all<{ kanji: string }>();
      results.forEach((r) => known.add(r.kanji));
    }
    return (fields: Record<string, string | null | undefined>) => {
      const display: Record<string, string> = {};
      const ruby: Record<string, RubySpan[]> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!v || !hasMarkup(v)) continue;
        ruby[k] = rubySpans(v, (b) => known.has(b));
        display[k] = displayText(ruby[k]!);
      }
      return Object.keys(display).length ? { display, ruby } : null;
    };
  }

  // ---------- decks ----------

  async listDecks() {
    const now = this.clock();
    const { results } = await this.db
      .prepare(
        `SELECT d.id, d.name, d.description, d.default_directions,
           (SELECT COUNT(*) FROM notes n WHERE n.deck_id = d.id) AS notes,
           (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id
              WHERE n.deck_id = d.id AND c.suspended = 0) AS cards,
           (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id
              WHERE n.deck_id = d.id AND c.suspended = 0 AND c.state != 0 AND c.due <= ? AND ${NOT_PENDING}) AS due_reviews,
           (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id
              WHERE n.deck_id = d.id AND c.suspended = 0 AND c.state = 0 AND ${NOT_PENDING}) AS new_cards,
           (SELECT COUNT(*) FROM pending_answers p JOIN cards c ON c.id = p.card_id JOIN notes n ON n.id = c.note_id
              WHERE n.deck_id = d.id AND p.graded_at IS NULL) AS pending_grading
         FROM decks d WHERE d.user_id = ? ORDER BY d.name`,
      )
      .bind(now, this.userId)
      .all<{ id: string; name: string; description: string | null; default_directions: string | null }>();
    return results.map((d) => ({ ...d, default_directions: parseJson(d.default_directions, null) }));
  }

  async createDeck(name: string, description?: string | null, defaultDirections?: Direction[] | null) {
    name = name.trim();
    if (!name) throw new UserError("Deck name is empty");
    if (defaultDirections) this.wordDirections(defaultDirections);
    const id = this.id();
    await this.db
      .prepare(
        `INSERT INTO decks (id, user_id, name, description, default_directions, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, name) DO NOTHING`,
      )
      .bind(id, this.userId, name, description ?? null, defaultDirections ? JSON.stringify(defaultDirections) : null, this.clock())
      .run();
    return this.getDeck(name);
  }

  /**
   * Change a deck's description / default directions. Defaults apply to notes
   * added later; apply_to_existing also sets enabled_directions on every word
   * note in the deck and reconciles its cards (suspends, never deletes).
   */
  async updateDeck(
    name: string,
    opts: { default_directions?: Direction[] | null; description?: string | null; apply_to_existing?: boolean },
  ) {
    const deck = await this.getDeck(name);
    if (!deck) throw new UserError(`No deck "${name}"`);
    if (opts.default_directions) this.wordDirections(opts.default_directions);
    const w = this.writes();
    w.pre.push(
      this.db
        .prepare(
          `UPDATE decks SET default_directions = CASE WHEN ?1 THEN ?2 ELSE default_directions END,
             description = CASE WHEN ?3 THEN ?4 ELSE description END WHERE id = ?5 AND user_id = ?6`,
        )
        .bind(
          opts.default_directions !== undefined ? 1 : 0,
          opts.default_directions ? JSON.stringify(opts.default_directions) : null,
          opts.description !== undefined ? 1 : 0,
          clean(opts.description),
          deck.id,
          this.userId,
        ),
    );
    let applied: { word_notes: number; cards_created: number; cards_suspended: number; cards_reactivated: number } | null = null;
    if (opts.apply_to_existing) {
      const enabled = [...(opts.default_directions ?? deck.default_directions ?? DEFAULT_WORD_DIRECTIONS)];
      const [notes, cards] = await Promise.all([
        this.db
          .prepare(`SELECT * FROM notes WHERE user_id = ? AND deck_id = ? AND type = 'word'`)
          .bind(this.userId, deck.id)
          .all<NoteRow>(),
        this.db
          .prepare(
            `SELECT c.* FROM cards c JOIN notes n ON n.id = c.note_id
             WHERE c.user_id = ? AND n.deck_id = ? AND n.type = 'word'`,
          )
          .bind(this.userId, deck.id)
          .all<CardRow>(),
      ]);
      const byNote = groupBy(cards.results, (c) => c.note_id);
      applied = { word_notes: notes.results.length, cards_created: 0, cards_suspended: 0, cards_reactivated: 0 };
      const enabledJson = JSON.stringify(enabled);
      for (const n of notes.results) {
        if (n.enabled_directions !== enabledJson) w.patchNote({ id: n.id, enabled_directions: enabledJson });
        const plan = this.planReconcile(w, n, enabled, byNote.get(n.id) ?? []);
        applied.cards_created += plan.create.length;
        applied.cards_suspended += plan.suspend.length;
        applied.cards_reactivated += plan.activate.length;
      }
    }
    await this.commit(w);
    const out = (await this.listDecks()).find((d) => d.id === deck.id);
    return { ...out, applied_to_existing: applied };
  }

  private async getDeck(name: string) {
    const d = await this.db
      .prepare(`SELECT id, name, default_directions FROM decks WHERE user_id = ? AND name = ?`)
      .bind(this.userId, name.trim())
      .first<{ id: string; name: string; default_directions: string | null }>();
    if (!d) return null;
    return { ...d, default_directions: parseJson<Direction[] | null>(d.default_directions, null) };
  }

  private async loadDecks() {
    const { results } = await this.db
      .prepare(`SELECT id, name, default_directions FROM decks WHERE user_id = ?`)
      .bind(this.userId)
      .all<{ id: string; name: string; default_directions: string | null }>();
    return new Map<string, DeckInfo>(
      results.map((d) => [d.name, { ...d, default_directions: parseJson<Direction[] | null>(d.default_directions, null) }]),
    );
  }

  /** Decks are created on first use (inside the same batch), so "add to deck X" just works. */
  private deckResolver(w: Writes, decks: Map<string, DeckInfo>) {
    return (name: string): DeckInfo => {
      const n = name.trim();
      if (!n) throw new UserError("Deck name is empty");
      let d = decks.get(n);
      if (!d) {
        d = { id: this.id(), name: n, default_directions: null };
        decks.set(n, d);
        w.decks.push({ id: d.id, name: n, description: null, default_directions: null });
      }
      return d;
    };
  }

  private checkDirection(d: string): asserts d is Direction {
    if (!(ALL_DIRECTIONS as readonly string[]).includes(d)) {
      throw new UserError(`Unknown direction "${d}". Valid: ${ALL_DIRECTIONS.join(", ")}`);
    }
  }

  private wordDirections(dirs: readonly string[]): Direction[] {
    dirs.forEach((d) => this.checkDirection(d));
    const bad = dirs.filter((d) => !isDirectionForType(d as Direction, "word"));
    if (bad.length) throw new UserError(`Not word directions: ${bad.join(", ")}`);
    return [...dirs] as Direction[];
  }

  // ---------- notes ----------

  async addWords(deckName: string, words: WordInput[], opts: { on_conflict?: OnConflict; tz?: string } = {}) {
    if (words.length > 100) throw new UserError("At most 100 words per call");
    const tz = this.tz(opts.tz);
    words.forEach((w) => {
      if (!this.parseWord(w)) throw new UserError(`Word needs kana and meaning: ${JSON.stringify(w)}`);
    });
    const furi = await this.resolveFurigana(words, words);
    const parsed = furi.items.map((x) => this.parseWord(x, tz)!);
    const w = this.writes();
    const deck = this.deckResolver(w, await this.loadDecks())(deckName);
    const onConflict = opts.on_conflict ?? "skip";
    const existing = await this.existingWords(words);
    const merge = onConflict === "merge" ? await this.mergeContext(parsed.map((p) => p.kana)) : undefined;
    const out = this.planWords(w, parsed.map((p) => ({ ...p, deck })), existing, onConflict, merge);
    await this.commit(w);
    // note_id is null only for status "ambiguous" (on_conflict merge).
    return out.map(({ planned: _, ...r }, i) => ({
      ...r,
      note_id: r.note_id as string,
      ...(furi.problems[i]!.length ? { furigana_problems: furi.problems[i] } : {}),
    }));
  }

  private parseWord(w: WordInput, tz?: string) {
    const kana = cleanJa(w.kana);
    const meaning = clean(w.meaning);
    const kanji = cleanJa(w.kanji);
    if (!kana || !meaning) return null;
    if (w.directions) this.wordDirections(w.directions);
    const schedule = tz && w.schedule ? this.parseSchedule(w.schedule as unknown as ScheduleArg, tz) : null;
    return { input: w, kana, meaning, kanji, key: wordKey(kanji, kana), schedule };
  }

  /** Validate an imported schedule (times in ISO or local "YYYY-MM-DD HH:mm" in tz). */
  private parseSchedule(s: ScheduleArg, tz: string, what = "schedule"): SchedState {
    const time = (v: string | number | undefined, name: string) => {
      if (v == null || v === "") return undefined;
      const t = typeof v === "number" ? v : parseTime(v, tz);
      if (Number.isNaN(t)) throw new UserError(`${what}: bad ${name} "${v}" (ISO 8601 or 'YYYY-MM-DD HH:mm')`);
      return t;
    };
    try {
      return importedState({ ...s, due: time(s.due, "due")!, last_review: time(s.last_review, "last_review") } as ScheduleInput, this.clock());
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(`${what}: ${(e as Error).message}`);
    }
  }

  /** Existing word notes for these (kanji, kana) pairs, keyed by normalised wordKey. */
  private async existingWords(pairs: ReadonlyArray<{ kanji?: string | null; kana?: string | null }>) {
    const keys = new Set<string>();
    for (const p of pairs) {
      for (const k of new Set([clean(p.kanji) ?? "", normJa(p.kanji)])) {
        for (const a of new Set([clean(p.kana) ?? "", normJa(p.kana)])) keys.add(`${k}\t${a}`);
      }
    }
    const map = new Map<string, { id: string; planned?: boolean }>();
    if (!keys.size) return map;
    const { results } = await this.db
      .prepare(
        `SELECT id, kanji, kana FROM notes
         WHERE user_id = ? AND type = 'word' AND COALESCE(kanji, '') || char(9) || kana IN (SELECT value FROM json_each(?))`,
      )
      .bind(this.userId, JSON.stringify([...keys]))
      .all<{ id: string; kanji: string | null; kana: string }>();
    for (const r of results) map.set(wordKey(r.kanji, r.kana), { id: r.id });
    return map;
  }

  /** Word notes sharing these kana, with their cards: what on_conflict "merge" may merge into. */
  private async mergeContext(kanas: readonly (string | null | undefined)[]): Promise<MergeContext> {
    const { results } = await this.db
      .prepare(
        `SELECT n.*, d.name AS deck_name FROM notes n JOIN decks d ON d.id = n.deck_id
         WHERE n.user_id = ? AND n.type = 'word' AND n.kana IN (SELECT value FROM json_each(?))`,
      )
      .bind(this.userId, JSON.stringify(lookupKeys(kanas)))
      .all<NoteWithDeck>();
    const cards = await this.cardsOfNotes(results.map((n) => n.id));
    return { index: new NoteIndex(results), notes: new Map(results.map((n) => [n.id, n])), cards, enabled: new Map() };
  }

  /**
   * Plan word inserts. Existing words (same kanji+kana): skip, update (meaning/notes/trap set,
   * extra and tags merged), or merge: switch on the requested directions (given, else the
   * deck's defaults), merge tags, set notes/trap only when empty. With merge, a kana-only word
   * also merges into the single existing note with that kana (lookup's rule); several → ambiguous.
   * The schedule is never touched.
   */
  private planWords(
    w: Writes,
    items: { deck: DeckInfo; input: WordInput; kanji: string | null; kana: string; meaning: string; key: string; schedule?: SchedState | null }[],
    existing: Map<string, { id: string; planned?: boolean }>,
    onConflict: OnConflict,
    merge?: MergeContext,
  ) {
    const out: {
      note_id: string | null; kanji: string | null; kana: string; status: "created" | "exists" | "updated" | "merged" | "ambiguous"; cards: Direction[];
      merged_into?: ReturnType<typeof brief>; meaning_kept?: string | null; candidates?: ReturnType<typeof brief>[];
      planned?: { insert: NoteInsert; cardIds: Map<Direction, string>; deck: DeckInfo };
    }[] = [];
    for (const it of items) {
      const ex = existing.get(it.key);
      if (onConflict === "merge" && merge && !ex?.planned) {
        let target = ex ? merge.notes.get(ex.id) : undefined;
        if (!target && !it.kanji) {
          const m = merge.index.matchWord({ kana: it.kana });
          if (m.status === "ambiguous") {
            out.push({ note_id: null, kanji: it.kanji, kana: it.kana, status: "ambiguous", cards: [], candidates: dedupe(m.candidates.map(brief)) });
            continue;
          }
          if (m.status === "found") target = m.note;
        }
        if (target) {
          const requested = this.wordDirections(it.input.directions ?? it.deck.default_directions ?? DEFAULT_WORD_DIRECTIONS);
          const enabled = merge.enabled.get(target.id) ?? new Set(parseJson<Direction[]>(target.enabled_directions, []));
          requested.forEach((d) => enabled.add(d));
          merge.enabled.set(target.id, enabled);
          const list = [...enabled];
          const u: NoteFieldUpdate = { id: target.id, enabled_directions: JSON.stringify(list) };
          if (!target.notes && clean(it.input.notes)) u.notes = target.notes = clean(it.input.notes);
          if (!target.trap && clean(it.input.trap)) u.trap = target.trap = clean(it.input.trap);
          w.patchNote(u);
          w.addTags(target.id, it.input.tags);
          const cards = merge.cards.get(target.id) ?? [];
          const plan = this.planReconcile(w, target, list, cards);
          // Later items merging into the same note see these cards as existing.
          for (const d of plan.create) cards.push({ ...emptyState(this.clock()), id: "", note_id: target.id, direction: d, suspended: 0, created_at: this.clock() });
          for (const c of cards) if (plan.activate.includes(c.direction)) c.suspended = 0;
          merge.cards.set(target.id, cards);
          out.push({
            note_id: target.id, kanji: it.kanji, kana: it.kana, status: "merged", cards: [...plan.create, ...plan.activate],
            merged_into: brief(target),
            ...(normMeaningLoose(target.meaning) !== normMeaningLoose(it.meaning) ? { meaning_kept: target.meaning } : {}),
          });
          continue;
        }
      }
      if (ex) {
        if (onConflict === "update" && !ex.planned) {
          const u: NoteFieldUpdate = { id: ex.id, meaning: it.meaning };
          if (it.input.notes != null) u.notes = clean(it.input.notes);
          if (it.input.trap != null) u.trap = clean(it.input.trap);
          if (it.input.extra) u.extra_merge = JSON.stringify(it.input.extra);
          w.patchNote(u);
          w.addTags(ex.id, it.input.tags);
          out.push({ note_id: ex.id, kanji: it.kanji, kana: it.kana, status: "updated", cards: [] });
        } else {
          out.push({ note_id: ex.id, kanji: it.kanji, kana: it.kana, status: "exists", cards: [] });
        }
        continue;
      }
      const enabled = this.wordDirections(it.input.directions ?? it.deck.default_directions ?? DEFAULT_WORD_DIRECTIONS);
      const n = this.planNewNote(w, it.deck, { type: "word", kanji: it.kanji, kana: it.kana, meaning: it.meaning }, enabled, { ...it.input, schedule: it.schedule });
      existing.set(it.key, { id: n.insert.id, planned: true });
      out.push({ note_id: n.insert.id, kanji: it.kanji, kana: it.kana, status: "created", cards: [...n.cardIds.keys()], planned: { ...n, deck: it.deck } });
    }
    return out;
  }

  /** Basic notes are deduplicated on front+back without furigana markup (or external_id). */
  async addBasic(deckName: string, items: BasicInput[], opts: { tz?: string } = {}) {
    if (items.length > 100) throw new UserError("At most 100 cards per call");
    const tz = this.tz(opts.tz);
    items.forEach((b) => {
      if (!this.parseBasic(b)) throw new UserError(`Card needs front and back: ${JSON.stringify(b)}`);
    });
    const furi = await this.resolveFurigana(items.map(withAccept));
    const parsed = furi.items.map((b) => this.parseBasic(b, tz)!);
    const w = this.writes();
    const deck = this.deckResolver(w, await this.loadDecks())(deckName);
    const existing = await this.existingBasics(parsed);
    const out = this.planBasics(w, parsed.map((p) => ({ ...p, deck })), existing);
    await this.commit(w);
    return out.map(({ planned: _, ...r }, i) => (furi.problems[i]!.length ? { ...r, furigana_problems: furi.problems[i] } : r));
  }

  private parseBasic(b: BasicInput, tz?: string) {
    const front = clean(b.front);
    const back = clean(b.back);
    if (!front || !back) return null;
    const schedule = tz && b.schedule ? this.parseSchedule(b.schedule as unknown as ScheduleArg, tz) : null;
    return { input: b, front, back, key: basicKey(front, back), schedule };
  }

  private async existingBasics(items: ReadonlyArray<{ front: string; back: string; input: { external_id?: string | null } }>) {
    const map = new Map<string, { id: string }>();
    if (!items.length) return map;
    // Marked-up notes ({今日|きょう}) are compared without markup, so they are all read.
    const { results } = await this.db
      .prepare(
        `SELECT id, front, back, external_id FROM notes
         WHERE user_id = ?1 AND type = 'basic'
           AND (front || char(9) || back IN (SELECT value FROM json_each(?2))
                OR external_id IN (SELECT value FROM json_each(?3))
                OR instr(front, '{') > 0 OR instr(back, '{') > 0)`,
      )
      .bind(
        this.userId,
        JSON.stringify(items.flatMap((p) => [`${p.front}\t${p.back}`, basicKey(p.front, p.back)])),
        JSON.stringify(items.map((p) => p.input.external_id).filter(Boolean)),
      )
      .all<{ id: string; front: string; back: string; external_id: string | null }>();
    for (const f of results) {
      map.set(basicKey(f.front, f.back), { id: f.id });
      if (f.external_id) map.set(`ext:${f.external_id}`, { id: f.id });
    }
    return map;
  }

  private planBasics(
    w: Writes,
    items: { deck: DeckInfo; input: BasicInput; front: string; back: string; key: string; schedule?: SchedState | null; directions?: Direction[] }[],
    existing: Map<string, { id: string }>,
  ) {
    const out: {
      note_id: string; front: string; status: "created" | "exists"; cards: Direction[];
      planned?: { insert: NoteInsert; cardIds: Map<Direction, string>; deck: DeckInfo };
    }[] = [];
    for (const it of items) {
      const ex = existing.get(it.key) ?? (it.input.external_id ? existing.get(`ext:${it.input.external_id}`) : undefined);
      if (ex) {
        out.push({ note_id: ex.id, front: it.front, status: "exists", cards: [] });
        continue;
      }
      const enabled: Direction[] = it.directions?.length
        ? it.directions
        : it.input.reversible ? ["front>back", "back>front"] : [...DEFAULT_BASIC_DIRECTIONS];
      const n = this.planNewNote(w, it.deck, { type: "basic", front: it.front, back: it.back }, enabled, { ...it.input, schedule: it.schedule });
      existing.set(it.key, { id: n.insert.id });
      out.push({ note_id: n.insert.id, front: it.front, status: "created", cards: [...n.cardIds.keys()], planned: { ...n, deck: it.deck } });
    }
    return out;
  }

  private planNewNote(
    w: Writes,
    deck: DeckInfo,
    faces: { type: NoteType; kanji?: string | null; kana?: string | null; meaning?: string | null; front?: string | null; back?: string | null },
    enabled: Direction[],
    rest: { notes?: string | null; tags?: string[]; extra?: Record<string, unknown> | null; external_id?: string | null; trap?: string | null; schedule?: SchedState | ScheduleInput | null },
  ) {
    const insert: NoteInsert = {
      id: this.id(),
      deck_id: deck.id,
      type: faces.type,
      kanji: faces.kanji ?? null,
      kana: faces.kana ?? null,
      meaning: faces.meaning ?? null,
      front: faces.front ?? null,
      back: faces.back ?? null,
      enabled_directions: JSON.stringify(enabled),
      notes: clean(rest.notes),
      extra: rest.extra ? JSON.stringify(rest.extra) : null,
      external_id: rest.external_id ?? null,
      trap: clean(rest.trap),
    };
    w.notes.push(insert);
    w.addTags(insert.id, rest.tags);
    const cardIds = new Map<Direction, string>();
    // Only a validated state (parseSchedule) is used; raw input schedules are ignored here.
    const sched = rest.schedule && "elapsed_days" in rest.schedule ? (rest.schedule as SchedState) : null;
    for (const d of planCards(faces, enabled, []).create) {
      const cid = this.id();
      cardIds.set(d, cid);
      w.cards.push([cid, insert.id, d]);
      if (sched) w.imported.push({ id: cid, ...sched });
    }
    return { insert, cardIds };
  }

  /** Create/suspend/reactivate cards (in `w`) so they match the note's faces and enabled directions. */
  private planReconcile(w: Writes, note: Parameters<typeof planCards>[0] & { id: string }, enabled: Direction[], existing: CardRow[]) {
    const plan = planCards(note, enabled, existing.map((c) => ({ direction: c.direction, suspended: !!c.suspended })));
    const byDir = new Map(existing.map((c) => [c.direction, c.id]));
    for (const d of plan.create) w.cards.push([this.id(), note.id, d]);
    for (const d of plan.activate) w.cardFlags.push([byDir.get(d)!, 0]);
    for (const d of plan.suspend) w.cardFlags.push([byDir.get(d)!, 1]);
    return plan;
  }

  private async noteRow(noteId: string) {
    const n = await this.db
      .prepare(`SELECT * FROM notes WHERE id = ? AND user_id = ?`)
      .bind(noteId, this.userId)
      .first<NoteRow>();
    if (!n) throw new UserError(`No note ${noteId}`);
    return n;
  }

  private async cardsOf(noteId: string) {
    const { results } = await this.db
      .prepare(`SELECT * FROM cards WHERE note_id = ? AND user_id = ?`)
      .bind(noteId, this.userId)
      .all<CardRow>();
    return results;
  }

  private async notesByIds(ids: readonly string[]) {
    if (!ids.length) return [];
    const { results } = await this.db
      .prepare(
        `SELECT n.*, d.name AS deck_name FROM notes n JOIN decks d ON d.id = n.deck_id
         WHERE n.user_id = ? AND n.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(this.userId, JSON.stringify(ids))
      .all<NoteWithDeck>();
    return results;
  }

  private async cardsOfNotes(ids: readonly string[]) {
    if (!ids.length) return new Map<string, CardRow[]>();
    const { results } = await this.db
      .prepare(`SELECT * FROM cards WHERE user_id = ? AND note_id IN (SELECT value FROM json_each(?))`)
      .bind(this.userId, JSON.stringify(ids))
      .all<CardRow>();
    return groupBy(results, (c) => c.note_id);
  }

  /** Create/suspend/reactivate cards so they match the note's faces and enabled directions. */
  private async reconcile(note: NoteRow) {
    const w = this.writes();
    const plan = this.planReconcile(w, note, parseJson<Direction[]>(note.enabled_directions, []), await this.cardsOf(note.id));
    await this.commit(w);
    return plan;
  }

  async getNote(noteId: string) {
    const n = await this.noteRow(noteId);
    const [cards, tags, deck] = await Promise.all([
      this.cardsOf(noteId),
      this.db.prepare(`SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag`).bind(noteId).all<{ tag: string }>(),
      this.db.prepare(`SELECT name FROM decks WHERE id = ?`).bind(n.deck_id).first<{ name: string }>(),
    ]);
    return this.presentNote(n, deck?.name ?? null, tags.results.map((t) => t.tag), cards);
  }

  /** Several notes in the given order, presented like getNote (3 queries). */
  private async presentNotes(ids: readonly string[]) {
    const [notes, cards, tags] = await Promise.all([
      this.notesByIds(ids),
      this.cardsOfNotes(ids),
      this.db
        .prepare(`SELECT note_id, tag FROM note_tags WHERE note_id IN (SELECT value FROM json_each(?)) ORDER BY tag`)
        .bind(JSON.stringify(ids))
        .all<{ note_id: string; tag: string }>(),
    ]);
    const byId = new Map(notes.map((n) => [n.id, n]));
    const tagsBy = groupBy(tags.results, (t) => t.note_id);
    return ids
      .filter((id) => byId.has(id))
      .map((id) => {
        const n = byId.get(id)!;
        return this.presentNote(n, n.deck_name, (tagsBy.get(id) ?? []).map((t) => t.tag), cards.get(id) ?? []);
      });
  }

  private presentNote(n: NoteRow, deck: string | null, tags: string[], cards: CardRow[]) {
    const now = this.clock();
    const faces =
      n.type === "word" ? { kanji: n.kanji, kana: n.kana, meaning: n.meaning } : { front: n.front, back: n.back };
    const enabled = parseJson<Direction[]>(n.enabled_directions, []);
    const waiting = enabled
      .filter((d) => !isApplicable(n, d))
      .map((d) => ({ direction: d, needs: d.split(">").filter((f) => !(n as unknown as Record<string, unknown>)[f]) }));
    return {
      note_id: n.id,
      type: n.type,
      deck,
      ...faces,
      notes: n.notes,
      trap: n.trap ?? null,
      extra: parseJson(n.extra, null),
      tags,
      // Directions that have (or would get) an active card. Switched-on directions that need a
      // face the note doesn't have (kanji>… on a kana-only word) are listed apart: they get a
      // card as soon as the face is added.
      enabled_directions: activeDirections(n, enabled),
      ...(waiting.length ? { waiting_for_face: waiting } : {}),
      cards: cards.map((c) => ({
        card_id: c.id,
        direction: c.direction,
        suspended: !!c.suspended,
        state: STATE_NAMES[c.state],
        due: iso(c.due),
        is_due: !c.suspended && c.due <= now,
        reps: c.reps,
        lapses: c.lapses,
        stability_days: Math.round(c.stability * 10) / 10,
        recall_now: round2(retrievability(c, now)),
      })),
    };
  }

  /** Edit one note. tags are merged unless replace_tags is true (see updateNotes). */
  async updateNote(noteId: string, u: NoteUpdate) {
    return (await this.updateNotes([{ ...u, note_id: noteId }]))[0]!;
  }

  /**
   * Edit several notes in one atomic batch. Changing faces updates cards: adding
   * kanji creates the kanji cards, removing a face suspends the cards that need it.
   * tags merge into the existing tags (replace_tags: true replaces them), remove_tags removes.
   */
  async updateNotes(updates: (NoteUpdate & { note_id: string })[]) {
    if (updates.length > 100) throw new UserError("At most 100 updates per call");
    const ids = updates.map((u) => u.note_id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new UserError(`Note ${dup} is listed twice`);
    const [notes, cards, decks] = await Promise.all([
      this.notesByIds(ids),
      this.cardsOfNotes(ids),
      updates.some((u) => u.deck) ? this.loadDecks() : Promise.resolve(new Map<string, DeckInfo>()),
    ]);
    const byId = new Map(notes.map((n) => [n.id, n]));
    const w = this.writes();
    const deckFor = this.deckResolver(w, decks);
    const furi = await this.resolveFurigana(updates);
    updates = furi.items;
    for (const u of updates) {
      const orig = byId.get(u.note_id);
      if (!orig) throw new UserError(`No note ${u.note_id}`);
      const n = { ...orig } as NoteWithDeck & Record<string, unknown>;
      const upd: NoteFieldUpdate = { id: n.id };
      const faceKeys = n.type === "word" ? (["kanji", "kana", "meaning"] as const) : (["front", "back"] as const);
      for (const k of ["kanji", "kana", "meaning", "front", "back"] as const) {
        if (!(k in u) || u[k] === undefined) continue;
        if (!(faceKeys as readonly string[]).includes(k)) throw new UserError(`A ${n.type} note has no ${k}`);
        const v = k === "kanji" || k === "kana" ? cleanJa(u[k]) : clean(u[k]);
        if (k !== "kanji" && !v) throw new UserError(`${k} cannot be empty`);
        upd[k] = v;
        n[k] = v;
      }
      if ("notes" in u && u.notes !== undefined) upd.notes = clean(u.notes);
      if ("trap" in u && u.trap !== undefined) upd.trap = clean(u.trap);
      // `extra` replaces the stored extra; `accept` sets extra.alt_backs (merged, or inside the new extra).
      const alts = u.accept ? u.accept.map((a) => String(a).trim()).filter(Boolean) : null;
      if (alts && n.type !== "basic") throw new UserError("accept is for basic notes (words use extra.alt_meanings / alt_kana)");
      if ("extra" in u && u.extra !== undefined) upd.extra = u.extra || alts ? JSON.stringify({ ...(u.extra ?? {}), ...(alts ? { alt_backs: alts } : {}) }) : null;
      else if (alts) upd.extra_merge = JSON.stringify({ alt_backs: alts });
      if (u.deck) upd.deck_id = deckFor(u.deck).id;
      w.patchNote(upd);
      if (u.tags) {
        if (u.replace_tags) w.clearTags.push(n.id);
        w.addTags(n.id, u.tags);
      }
      for (const t of u.remove_tags ?? []) if (t.trim()) w.untag.push([n.id, t.trim()]);
      this.planReconcile(w, n as NoteRow, parseJson<Direction[]>(n.enabled_directions, []), cards.get(n.id) ?? []);
    }
    await this.commit(w);
    const out = await this.presentNotes(ids);
    return out.map((n) => {
      const i = ids.indexOf(n.note_id);
      return furi.problems[i]?.length ? { ...n, furigana_problems: furi.problems[i] } : n;
    });
  }

  async setDirections(noteId: string, enable: Direction[] = [], disable: Direction[] = []) {
    const n = await this.noteRow(noteId);
    [...enable, ...disable].forEach((d) => {
      this.checkDirection(d);
      if (!isDirectionForType(d, n.type)) throw new UserError(`${d} is not a ${n.type} direction`);
    });
    const cur = new Set(parseJson<Direction[]>(n.enabled_directions, []));
    enable.forEach((d) => cur.add(d));
    disable.forEach((d) => cur.delete(d));
    n.enabled_directions = JSON.stringify([...cur]);
    await this.db
      .prepare(`UPDATE notes SET enabled_directions = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .bind(n.enabled_directions, this.clock(), noteId, this.userId)
      .run();
    await this.reconcile(n);
    return this.getNote(noteId);
  }

  async deleteNote(noteId: string) {
    await this.noteRow(noteId);
    // D1 enforces foreign keys, so this cascades to cards, tags and review_log.
    await this.db.prepare(`DELETE FROM notes WHERE id = ? AND user_id = ?`).bind(noteId, this.userId).run();
    return { deleted: noteId };
  }

  /** Delete several notes (cascades to cards, tags, history); reports what was deleted. */
  async deleteNotes(noteIds: string[], opts: { confirm?: boolean } = {}) {
    if (opts.confirm !== true) throw new UserError("Not deleted: set confirm: true, and only when the learner explicitly asked to delete.");
    if (!noteIds.length) throw new UserError("Give note_ids");
    if (noteIds.length > 100) throw new UserError("At most 100 notes per call");
    const ids = [...new Set(noteIds)];
    const { results } = await this.db
      .prepare(
        `SELECT n.id, n.type, n.kanji, n.kana, n.meaning, n.front, n.back, d.name AS deck_name,
           (SELECT COUNT(*) FROM cards c WHERE c.note_id = n.id) AS cards,
           (SELECT COUNT(*) FROM review_log r JOIN cards c ON c.id = r.card_id WHERE c.note_id = n.id) AS reviews
         FROM notes n JOIN decks d ON d.id = n.deck_id
         WHERE n.user_id = ? AND n.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(this.userId, JSON.stringify(ids))
      .all<NoteWithDeck & { cards: number; reviews: number }>();
    if (results.length) {
      await this.db
        .prepare(`DELETE FROM notes WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
        .bind(this.userId, JSON.stringify(results.map((r) => r.id)))
        .run();
    }
    const found = new Set(results.map((r) => r.id));
    return {
      deleted: results.map((r) => ({ ...brief(r), cards: r.cards, reviews: r.reviews })),
      not_found: ids.filter((id) => !found.has(id)),
    };
  }

  async searchNotes(opts: { query?: string; deck?: string; tag?: string; type?: NoteType; limit?: number; offset?: number }) {
    const where = ["n.user_id = ?"];
    const vals: unknown[] = [this.userId];
    if (opts.query) {
      where.push(
        `(n.kanji LIKE ?1x ESCAPE '\\' OR n.kana LIKE ?1x ESCAPE '\\' OR n.meaning LIKE ?1x ESCAPE '\\' OR n.front LIKE ?1x ESCAPE '\\' OR n.back LIKE ?1x ESCAPE '\\' OR n.notes LIKE ?1x ESCAPE '\\')`,
      );
    }
    if (opts.deck) where.push(`d.name = ?`), vals.push(opts.deck);
    if (opts.tag) where.push(`EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.tag = ?)`), vals.push(opts.tag);
    if (opts.type) where.push(`n.type = ?`), vals.push(opts.type);
    let sql = `SELECT n.*, d.name AS deck_name FROM notes n JOIN decks d ON d.id = n.deck_id
               WHERE ${where.join(" AND ")} ORDER BY n.created_at DESC LIMIT ? OFFSET ?`;
    // Bind the LIKE pattern once per column without positional-parameter juggling.
    if (opts.query) {
      const pat = `%${opts.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const n = (sql.match(/\?1x/g) ?? []).length;
      sql = sql.replace(/\?1x/g, "?");
      vals.splice(1, 0, ...Array(n).fill(pat));
    }
    vals.push(Math.min(opts.limit ?? 50, 100), opts.offset ?? 0);
    const { results } = await this.db.prepare(sql).bind(...vals).all<NoteWithDeck>();
    if (!results.length) return [];
    // One JSON parameter instead of an IN list: D1 allows at most 100 bound parameters.
    const ids = JSON.stringify(results.map((r) => r.id));
    const [cards, tags] = await Promise.all([
      this.db
        .prepare(`SELECT * FROM cards WHERE user_id = ? AND note_id IN (SELECT value FROM json_each(?))`)
        .bind(this.userId, ids)
        .all<CardRow>(),
      this.db
        .prepare(`SELECT note_id, tag FROM note_tags WHERE note_id IN (SELECT value FROM json_each(?))`)
        .bind(ids)
        .all<{ note_id: string; tag: string }>(),
    ]);
    return results.map((n) =>
      this.presentNote(
        n,
        n.deck_name,
        tags.results.filter((t) => t.note_id === n.id).map((t) => t.tag),
        cards.results.filter((c) => c.note_id === n.id),
      ),
    );
  }

  /**
   * Batch existence check for word notes (2 queries whatever the list size).
   * Same matching rules as session_end reviews.
   */
  async lookup(opts: { deck?: string; deck_only?: boolean; words: { kanji?: string | null; kana: string }[] }) {
    if (opts.words.length > 500) throw new UserError("At most 500 words per lookup");
    const keys = lookupKeys(opts.words.map((w) => w.kana));
    const { results } = await this.db
      .prepare(
        `SELECT n.*, d.name AS deck_name FROM notes n JOIN decks d ON d.id = n.deck_id
         WHERE n.user_id = ? AND n.type = 'word' AND n.kana IN (SELECT value FROM json_each(?))`,
      )
      .bind(this.userId, JSON.stringify(keys))
      .all<NoteWithDeck>();
    const cards = new Map<string, Record<string, unknown>[]>();
    if (results.length) {
      const { results: rows } = await this.db
        .prepare(
          `SELECT c.note_id, c.direction, c.state, c.due, c.lapses, c.reps, c.suspended, c.last_review,
             (SELECT r.rating FROM review_log r WHERE r.card_id = c.id ORDER BY r.reviewed_at DESC, r.rowid DESC LIMIT 1) AS last_rating
           FROM cards c WHERE c.user_id = ? AND c.note_id IN (SELECT value FROM json_each(?))
           ORDER BY c.note_id, c.direction`,
        )
        .bind(this.userId, JSON.stringify(results.map((r) => r.id)))
        .all<{ note_id: string; direction: Direction; state: number; due: number; lapses: number; reps: number; suspended: number; last_review: number | null; last_rating: number | null }>();
      for (const c of rows) {
        const list = cards.get(c.note_id) ?? [];
        list.push({
          direction: c.direction,
          state: STATE_NAMES[c.state],
          suspended: !!c.suspended,
          last_rating: c.last_rating == null ? null : RATING_NAMES[c.last_rating],
          last_review: iso(c.last_review),
          next_due: iso(c.due),
          reps: c.reps,
          lapses: c.lapses,
        });
        cards.set(c.note_id, list);
      }
    }
    // deck_only: only notes in that deck can match; otherwise matching is global and the deck
    // only flags deck_mismatch.
    const index = new NoteIndex(opts.deck_only && opts.deck ? results.filter((n) => n.deck_name === opts.deck) : results);
    type Item = {
      query: { kanji: string | null; kana: string }; found: boolean; status: string;
      note_id?: string; kanji?: string | null; kana?: string | null; meaning?: string | null; deck?: string; trap?: string | null;
      cards?: Record<string, unknown>[]; candidates?: ReturnType<typeof brief>[]; deck_mismatch?: boolean;
    };
    const items = opts.words.map((q): Item => {
      const query = { kanji: q.kanji ?? null, kana: q.kana };
      const m = index.matchWord({ ...q, deck: opts.deck });
      if (m.status === "found") {
        const n = m.note;
        return {
          query, found: true, status: "found", ...brief(n), trap: n.trap, cards: cards.get(n.id) ?? [],
          // Exists, but in another deck than the one asked for.
          ...(m.deck_mismatch ? { deck_mismatch: true } : {}),
        };
      }
      return {
        query,
        found: false,
        status: m.status,
        ...(m.candidates.length ? { candidates: dedupe(m.candidates.map(brief)) } : {}),
      };
    });
    return { found: items.filter((i) => i.found).length, not_found: items.filter((i) => !i.found).length, words: items };
  }

  // ---------- bulk import ----------

  /**
   * Import up to 1000 rows (JSON objects or CSV text with a header line) with a
   * fixed number of statements: decks, notes, cards and tags are each inserted
   * set-based from one JSON parameter. Bad rows are reported, the rest imported.
   */
  async bulkImport(opts: { deck?: string; rows?: BulkRow[]; csv?: string; on_conflict?: OnConflict; tz?: string }) {
    const raw: BulkRow[] = opts.csv ? csvObjects(opts.csv) : (opts.rows ?? []);
    if (opts.csv && opts.rows?.length) throw new UserError("Give rows or csv, not both");
    if (!raw.length) throw new UserError("No rows to import");
    if (raw.length > 1000) throw new UserError("At most 1000 rows per import");
    const tz = this.tz(opts.tz);
    const errors: { row: number; reason: string; data: BulkRow }[] = [];
    const words: { row: number; deck: string; input: WordInput }[] = [];
    const basics: { row: number; deck: string; input: BasicInput; directions?: Direction[] }[] = [];
    raw.forEach((r, i) => {
      const row = i + 1;
      const deck = clean(r.deck) ?? clean(opts.deck);
      const tags = splitTags(r.tags);
      if (!deck) return errors.push({ row, reason: "no deck (give deck per row or as the default)", data: r });
      const tooLong = (["kanji", "kana", "meaning", "notes", "trap", "front", "back", "deck"] as const).find(
        (k) => typeof r[k] === "string" && r[k]!.length > FIELD_MAX,
      );
      if (tooLong) return errors.push({ row, reason: `${tooLong} longer than ${FIELD_MAX} characters`, data: { ...r, [tooLong]: `${r[tooLong]!.slice(0, 50)}…` } });
      const isBasic = !!(clean(r.front) || clean(r.back));
      const dirs = splitTags(r.directions ?? undefined) as Direction[];
      const badDir = dirs.find((d) => !(ALL_DIRECTIONS as readonly string[]).includes(d) || !isDirectionForType(d, isBasic ? "basic" : "word"));
      if (badDir) return errors.push({ row, reason: `"${badDir}" is not a ${isBasic ? "basic" : "word"} direction`, data: r });
      let schedule: SchedState | null = null;
      if (r.schedule) {
        try {
          // CSV: a JSON object in the schedule column.
          const sc = typeof r.schedule === "string" ? (JSON.parse(r.schedule) as ScheduleArg) : r.schedule;
          schedule = this.parseSchedule(sc, tz);
        } catch (e) {
          return errors.push({ row, reason: (e as Error).message, data: r });
        }
      }
      if (isBasic) {
        if (!clean(r.front) || !clean(r.back)) return errors.push({ row, reason: "basic row needs front and back", data: r });
        basics.push({
          row, deck, directions: dirs.length ? dirs : undefined,
          input: withAccept({ front: r.front!, back: r.back!, notes: r.notes, tags, trap: r.trap, accept: splitTags(r.accept ?? undefined), schedule: schedule as never }),
        });
        return;
      }
      if (!clean(r.kana) || !clean(r.meaning)) return errors.push({ row, reason: "needs kana and meaning", data: r });
      words.push({
        row, deck,
        input: { kanji: r.kanji, kana: r.kana!, meaning: r.meaning!, notes: r.notes, tags, trap: r.trap, directions: dirs.length ? dirs : undefined, schedule: schedule as never },
      });
    });

    const furiW = await this.resolveFurigana(words.map((x) => x.input), words.map((x) => x.input));
    const furiB = await this.resolveFurigana(basics.map((x) => x.input), words.map((x) => x.input));
    const w = this.writes();
    const deckFor = this.deckResolver(w, await this.loadDecks());
    const onConflict = opts.on_conflict ?? "skip";
    const parsedWords = words.map((x, i) => ({ row: x.row, ...this.parseWord(furiW.items[i]!)!, schedule: x.input.schedule as SchedState | null, deck: deckFor(x.deck) }));
    const parsedBasics = basics.map((x, i) => ({
      row: x.row, ...this.parseBasic(furiB.items[i]!)!, schedule: x.input.schedule as SchedState | null, directions: x.directions, deck: deckFor(x.deck),
    }));
    const [existingW, existingB, merge] = await Promise.all([
      this.existingWords(words.map((x) => x.input)),
      this.existingBasics(parsedBasics),
      onConflict === "merge" ? this.mergeContext(parsedWords.map((p) => p.kana)) : Promise.resolve(undefined),
    ]);
    const wOut = this.planWords(w, parsedWords, existingW, onConflict, merge);
    const bOut = this.planBasics(w, parsedBasics, existingB);
    const statements = await this.commit(w);
    const all = [
      ...wOut.map((o, i) => ({
        row: parsedWords[i]!.row, note_id: o.note_id, kanji: o.kanji, kana: o.kana, status: o.status,
        ...(o.status === "merged" ? { cards: o.cards, merged_into: o.merged_into } : {}),
        ...(o.candidates ? { candidates: o.candidates } : {}),
      })),
      ...bOut.map((o, i) => ({ row: parsedBasics[i]!.row, note_id: o.note_id, front: o.front, status: o.status })),
    ].sort((a, b) => a.row - b.row);
    const count = (s: string) => all.filter((x) => x.status === s).length;
    const furigana = [
      ...furiW.problems.flatMap((p, i) => p.map((x) => ({ row: words[i]!.row, ...x }))),
      ...furiB.problems.flatMap((p, i) => p.map((x) => ({ row: basics[i]!.row, ...x }))),
    ].sort((a, b) => a.row - b.row);
    return {
      rows: raw.length,
      created: count("created"),
      updated: count("updated"),
      merged: count("merged"),
      existing: count("exists"),
      ambiguous: count("ambiguous"),
      errors,
      decks_created: w.decks.map((d) => d.name),
      batch_statements: statements,
      // Only the interesting rows; created ones are summarised by the count.
      not_created: all.filter((x) => x.status !== "created").slice(0, 200),
      ...(furigana.length ? { furigana_problems: furigana.slice(0, 200) } : {}),
    };
  }

  // ---------- review ----------

  /**
   * Due cards grouped per note into prompts (see groupPrompts). A card is held
   * back when a sibling direction of the same note was reviewed within
   * `sibling_gap_hours`, so e.g. meaning>kana doesn't come right after
   * kana>meaning gave the answer away.
   */
  async getDue(opts: {
    deck?: string;
    decks?: string[];
    tag?: string;
    directions?: Direction[];
    limit?: number;
    include_new?: boolean;
    new_limit?: number;
    sibling_gap_hours?: number;
    all_prompts?: boolean;
    ask_mode?: AskMode;
    /** Practice ahead: also return cards not due yet (after the due ones), ignoring the sibling gap. */
    include_not_due?: boolean;
  }) {
    const now = this.clock();
    const gap = opts.sibling_gap_hours != null ? opts.sibling_gap_hours * HOUR : DEFAULT_SIBLING_GAP;
    const mode = opts.ask_mode ?? "grouped";
    const ahead = !!opts.include_not_due;
    // Cards with an answer waiting for grading are neither asked nor counted.
    const where = ["c.user_id = ?", "c.suspended = 0", NOT_PENDING];
    const vals: unknown[] = [this.userId];
    if (!ahead) where.push("c.due <= ?"), vals.push(now);
    if (opts.deck) where.push("d.name = ?"), vals.push(opts.deck);
    if (opts.decks) where.push("d.name IN (SELECT value FROM json_each(?))"), vals.push(JSON.stringify(opts.decks));
    if (opts.tag) where.push(`EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND t.tag = ?)`), vals.push(opts.tag);
    if (opts.directions?.length) {
      where.push(`c.direction IN (SELECT value FROM json_each(?))`);
      vals.push(JSON.stringify(opts.directions));
    }
    if (opts.include_new === false) where.push("c.state != 0");
    // Hold a card back if a sibling was reviewed recently *and after this card's
    // own last review*: siblings rated together with it (same prompt) don't
    // block its short-term relearning steps.
    // held_since: latest sibling review that holds this card back (computed, not filtered,
    // so held-back cards can be reported and the counts reconcile). The bound is our own
    // integer, inlined to keep positional parameters in WHERE order.
    const heldSince = ahead
      ? "NULL"
      : `(SELECT MAX(r.reviewed_at) FROM cards s JOIN review_log r ON r.card_id = s.id
          WHERE s.note_id = c.note_id AND s.id != c.id AND r.reviewed_at > ${Math.floor(now - gap)}
            AND r.reviewed_at > COALESCE(c.last_review, -1))`;
    // Overdue reviews first (most overdue first), then new cards in creation order,
    // then (practice ahead only) not-yet-due cards by due date.
    const { results: rows } = await this.db
      .prepare(
        `SELECT c.id AS card_id, c.direction, c.state, c.due, c.note_id, ${heldSince} AS held_since,
                n.type, n.kanji, n.kana, n.meaning, n.front, n.back, n.notes, n.trap, n.extra, d.name AS deck_name
         FROM cards c JOIN notes n ON n.id = c.note_id JOIN decks d ON d.id = n.deck_id
         WHERE ${where.join(" AND ")}
         ORDER BY (c.state != 0 AND c.due > ?), (c.state = 0), c.due, n.created_at, c.direction
         LIMIT 2000`,
      )
      .bind(...vals, now)
      .all<{
        card_id: string; direction: Direction; state: number; due: number; note_id: string; type: NoteType;
        kanji: string | null; kana: string | null; meaning: string | null; front: string | null; back: string | null;
        notes: string | null; trap: string | null; extra: string | null; deck_name: string; held_since: number | null;
      }>();
    const results = rows.filter((r) => r.held_since == null);
    const held = rows.filter((r) => r.held_since != null);

    // Named decks that don't exist are reported (an all-unknown list returns nothing, not everything).
    let unknownDecks: string[] = [];
    if (opts.decks?.length) {
      const { results: known } = await this.db
        .prepare(`SELECT name FROM decks WHERE user_id = ? AND name IN (SELECT value FROM json_each(?))`)
        .bind(this.userId, JSON.stringify(opts.decks))
        .all<{ name: string }>();
      unknownDecks = opts.decks.filter((d) => !known.some((k) => k.name === d));
    }
    const limit = opts.limit ?? 20;
    const newLimit = opts.new_limit ?? 10;
    const byNote = groupBy(results, (r) => r.note_id);
    const items: {
      note_id: string; type: NoteType; deck: string; faces: Record<string, string | null>;
      notes: string | null;
      after_answer: { trap: string | null; notes: string | null; example?: string | null; feedback?: { direction: Direction; feedback: string; rating: string; answer: string | null; reviewed_at: string | null }[] };
      display?: Record<string, string>; ruby?: Record<string, RubySpan[]>;
      is_new: boolean; ahead_of_schedule?: boolean; prompts: Prompt[];
    }[] = [];
    let newCount = 0;
    for (const [noteId, rows] of byNote) {
      if (items.length >= limit) break;
      const first = rows[0]!;
      const isNew = rows.every((r) => r.state === 0);
      if (isNew && newCount >= newLimit) continue;
      if (isNew) newCount++;
      const extra = parseJson<Record<string, unknown> | null>(first.extra, null);
      const prompts = groupPrompts({ ...first, extra }, rows.map((r) => ({ card_id: r.card_id, direction: r.direction })), mode);
      items.push({
        note_id: noteId,
        type: first.type,
        deck: first.deck_name,
        faces:
          first.type === "word"
            ? { kanji: first.kanji, kana: first.kana, meaning: first.meaning }
            : { front: first.front, back: first.back },
        notes: first.notes,
        after_answer: { trap: first.trap, notes: first.notes, ...(typeof extra?.example === "string" ? { example: extra.example } : {}) },
        is_new: isNew,
        ...(ahead && rows.every((r) => r.due > now) ? { ahead_of_schedule: true } : {}),
        // Without all_prompts: every prompt that shows the best face (one in grouped mode,
        // possibly several back-to-back in same_script/single mode).
        prompts: opts.all_prompts ? prompts : prompts.filter((p) => p.show === prompts[0]!.show),
      });
    }
    // Furigana: display text + ruby spans for every marked-up field.
    const render = await this.furiganaRenderer(
      items.flatMap((i) => [...Object.values(i.faces), i.after_answer.trap, i.after_answer.notes, i.after_answer.example]),
    );
    // Teacher feedback from the latest review of each asked card (show after the answer).
    const askedIds = items.flatMap((i) => i.prompts.flatMap((p) => p.ask.map((a) => a.card_id)));
    const fb = askedIds.length
      ? (
          await this.db
            .prepare(
              `SELECT r.card_id, c.direction, r.feedback, r.rating, r.answer, r.reviewed_at FROM review_log r JOIN cards c ON c.id = r.card_id
               WHERE r.user_id = ? AND r.card_id IN (SELECT value FROM json_each(?)) AND r.feedback IS NOT NULL
                 AND r.reviewed_at = (SELECT MAX(x.reviewed_at) FROM review_log x WHERE x.card_id = r.card_id AND x.affects_schedule = 1)`,
            )
            .bind(this.userId, JSON.stringify(askedIds))
            .all<{ card_id: string; direction: Direction; feedback: string; rating: number; answer: string | null; reviewed_at: number }>()
        ).results
      : [];
    for (const it of items) {
      const r = render({ ...it.faces, trap: it.after_answer.trap, notes: it.after_answer.notes, example: it.after_answer.example });
      if (r) Object.assign(it, r);
      const ids = new Set(it.prompts.flatMap((p) => p.ask.map((a) => a.card_id)));
      const mine = fb.filter((f) => ids.has(f.card_id));
      if (mine.length) {
        it.after_answer.feedback = mine.map((f) => ({
          direction: f.direction, feedback: f.feedback, rating: RATING_NAMES[f.rating]!, answer: f.answer, reviewed_at: iso(f.reviewed_at),
        }));
      }
    }
    // Counts use the same filters; new cards are "available", not "due".
    // due_review_cards (askable now) + held_back.due_review_cards = all due reviews (session_start's due_reviews).
    const returnedCards = items.reduce((a, i) => a + i.prompts.reduce((b, p) => b + p.ask.length, 0), 0);
    return {
      now: iso(now),
      ask_mode: mode,
      ...(unknownDecks.length ? { unknown_decks: unknownDecks } : {}),
      due_review_cards: results.filter((r) => r.state !== 0 && r.due <= now).length,
      returned_cards: returnedCards,
      held_back: {
        due_review_cards: held.filter((r) => r.state !== 0).length,
        new_cards: held.filter((r) => r.state === 0).length,
        // Only held-back due reviews are listed; held-back new cards are just counted (new_cards).
        cards: held.filter((r) => r.state !== 0).slice(0, 100).map((r) => ({
          card_id: r.card_id,
          note_id: r.note_id,
          direction: r.direction,
          ...faceFields(r),
          until: iso(r.held_since! + gap),
        })),
      },
      ...(ahead ? { not_due_cards: results.filter((r) => r.state !== 0 && r.due > now).length } : {}),
      new_cards_available: results.filter((r) => r.state === 0).length,
      notes_returned: items.length,
      items,
    };
  }

  private parseReviewTime(v: string | number | undefined, now: number, tz: string) {
    const at = v == null || v === "" ? now : parseTime(v, tz);
    if (Number.isNaN(at)) throw new UserError(`Bad reviewed_at: ${v} (use ISO 8601, e.g. 2026-11-20T15:04:00+01:00)`);
    if (at > now + 5 * 60_000) throw new UserError(`reviewed_at is in the future: ${v}`);
    return at;
  }

  /**
   * Record reviews. All validation happens before any write, and all writes go
   * in one batch (atomic). Reviews older than a card's last review trigger a
   * replay of its whole history; equal timestamps keep insertion order.
   * reviewed_at without an offset ("2026-11-20 15:04") is read in `tz`.
   */
  async rate(reviews: ReviewInput[], opts: { tz?: string } = {}) {
    if (reviews.length > 100) throw new UserError("At most 100 reviews per call");
    const now = this.clock();
    const tz = this.tz(opts.tz);
    const parsed = reviews.map((r) => {
      const rating = RATINGS[r.rating];
      if (!rating) throw new UserError(`Unknown rating "${r.rating}" (again|hard|good|easy)`);
      return { r, rating, at: this.parseReviewTime(r.reviewed_at, now, tz), timeGiven: r.reviewed_at != null && r.reviewed_at !== "" };
    });

    const ids = [...new Set(parsed.map((p) => p.r.card_id))];
    const { results: cards } = await this.db
      .prepare(`SELECT * FROM cards WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(this.userId, JSON.stringify(ids))
      .all<CardRow>();
    const byId = new Map(cards.map((c) => [c.id, c]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new UserError(`No card ${missing.join(", ")}`);

    const w = this.writes(now);
    const { final, entries } = await this.planRatings(
      w,
      parsed.map((p) => ({
        card: byId.get(p.r.card_id)!,
        rating: p.rating,
        at: p.at,
        timeGiven: p.timeGiven,
        source: p.r.source,
        defaultSource: "chat" as ReviewSource,
        answer: p.r.answer ?? null,
        session_id: p.r.session_id ?? null,
        verified: p.r.verified,
        early: p.r.early,
        feedback: p.r.feedback,
      })),
    );
    await this.commit(w);

    return parsed.map(({ r }, i) => {
      const e = entries[i]!;
      const { state, replayed } = final.get(r.card_id)!;
      return {
        card_id: r.card_id,
        direction: byId.get(r.card_id)!.direction,
        rating: r.rating,
        reviewed_at: iso(e.at),
        replayed_history: replayed,
        state: STATE_NAMES[state.state],
        next_due: iso(state.due),
        interval_days: intervalDays(state, e.at),
        ...(e.graded ? { graded_pending_answer: { answer: e.graded.answer, answered_at: iso(e.graded.answered_at) } } : {}),
        ...(r.feedback ? { feedback: r.feedback } : {}),
        ...(r.verified === false ? { verified: false } : {}),
        ...(r.early ? { early: true, schedule_changed: false } : {}),
      };
    });
  }

  /**
   * Shared core of rate and session_end: compute each card's new state and add
   * the review_log inserts and card updates to `w` (nothing is executed here
   * except reads of past history / pending answers).
   * Per card, reviews apply in time order (stable: equal times keep input order);
   * a review older than the card's last review replays its whole history.
   * Cards may be new ones planned in the same batch (last_review null).
   *
   * Grading: a scheduling review of a card with an answer waiting for grading ("grade later"
   * in the UI) grades it. Without reviewed_at/answer/source, the waiting answer's time,
   * text and source are used.
   */
  private async planRatings(
    w: Writes,
    input: {
      card: CardRow; rating: number; at: number; timeGiven: boolean; source?: ReviewSource; defaultSource: ReviewSource;
      answer: string | null; session_id: string | null;
      /** false: judged correct but unverifiable (IME kanji). Scheduled like any review. */
      verified?: boolean;
      /** true: volunteered answer to a card that wasn't asked; logged, schedule untouched. */
      early?: boolean;
      feedback?: string | null;
    }[],
  ) {
    const pending = new Map<string, { id: string; answer: string | null; answered_at: number; source: string }>();
    const cardIds = [...new Set(input.map((e) => e.card.id))];
    if (cardIds.length) {
      const { results } = await this.db
        .prepare(
          `SELECT id, card_id, answer, answered_at, source FROM pending_answers
           WHERE user_id = ? AND graded_at IS NULL AND card_id IN (SELECT value FROM json_each(?)) ORDER BY answered_at`,
        )
        .bind(this.userId, JSON.stringify(cardIds))
        .all<{ id: string; card_id: string; answer: string | null; answered_at: number; source: string }>();
      for (const p of results) if (!pending.has(p.card_id)) pending.set(p.card_id, p);
    }
    const entries = input.map((e) => {
      const p = !e.early ? pending.get(e.card.id) : undefined;
      return {
        ...e,
        at: p && !e.timeGiven ? p.answered_at : e.at,
        answer: e.answer ?? (p ? p.answer : null),
        source: e.source ?? ((p?.source as ReviewSource | undefined) ?? e.defaultSource),
        graded: undefined as undefined | { id: string; answer: string | null; answered_at: number },
        logId: this.id(),
      };
    });
    // The latest scheduling review of each card grades its waiting answer.
    for (const [cardId, p] of pending) {
      const last = entries.filter((e) => e.card.id === cardId && !e.early).sort((x, y) => x.at - y.at).at(-1);
      if (!last) continue;
      last.graded = { id: p.id, answer: p.answer, answered_at: p.answered_at };
      w.graded.push([p.id, last.logId]);
    }

    const perCard = new Map<string, typeof entries>();
    for (const e of entries) perCard.set(e.card.id, [...(perCard.get(e.card.id) ?? []), e]);
    for (const list of perCard.values()) list.sort((x, y) => x.at - y.at);
    const scheduling = (list: typeof entries) => list.filter((p) => !p.early);

    const needReplay = [...perCard]
      .filter(([, list]) => {
        const sched = scheduling(list);
        const last = list[0]!.card.last_review;
        return sched.length > 0 && last != null && sched[0]!.at < last;
      })
      .map(([id]) => id);
    const history = new Map<string, { rating: number; reviewed_at: number }[]>();
    if (needReplay.length) {
      const { results: log } = await this.db
        .prepare(
          `SELECT card_id, rating, reviewed_at FROM review_log
           WHERE user_id = ? AND affects_schedule = 1 AND card_id IN (SELECT value FROM json_each(?)) ORDER BY reviewed_at, rowid`,
        )
        .bind(this.userId, JSON.stringify(needReplay))
        .all<{ card_id: string; rating: number; reviewed_at: number }>();
      for (const l of log) history.set(l.card_id, [...(history.get(l.card_id) ?? []), l]);
    }

    const final = new Map<string, { state: SchedState; replayed: boolean }>();
    for (const [id, list] of perCard) {
      const card = list[0]!.card;
      const sched = scheduling(list);
      const replayed = needReplay.includes(id);
      let state: SchedState;
      if (replayed) {
        const initial = parseJson<SchedState | null>(card.initial_state ?? null, null);
        state = replay(card.created_at, [...(history.get(id) ?? []), ...sched.map((p) => ({ rating: p.rating, reviewed_at: p.at }))], initial);
      } else {
        state = card;
        for (const p of sched) state = applyReview(state, p.rating, p.at);
      }
      final.set(id, { state, replayed });
      for (const p of list) {
        w.logs.push({
          id: p.logId, card_id: id, rating: p.rating, reviewed_at: p.at, source: p.source, answer: p.answer, session_id: p.session_id,
          verified: p.verified === false ? 0 : 1,
          affects_schedule: p.early ? 0 : 1,
          feedback: clean(p.feedback),
        });
      }
      if (sched.length) w.states.push({ id, ...pickState(state) });
    }
    return { final, entries };
  }

  async noteHistory(noteId: string) {
    const note = await this.getNote(noteId);
    const { results } = await this.db
      .prepare(
        `SELECT c.direction, r.rating, r.reviewed_at, r.source, r.answer, r.feedback, r.verified, r.affects_schedule FROM review_log r
         JOIN cards c ON c.id = r.card_id WHERE c.note_id = ? AND r.user_id = ? ORDER BY r.reviewed_at, r.rowid`,
      )
      .bind(noteId, this.userId)
      .all<{ direction: Direction; rating: number; reviewed_at: number; source: string; answer: string | null; feedback: string | null; verified: number; affects_schedule: number }>();
    const { results: waiting } = await this.db
      .prepare(
        `SELECT p.card_id, c.direction, p.answer, p.answered_at FROM pending_answers p JOIN cards c ON c.id = p.card_id
         WHERE c.note_id = ? AND p.user_id = ? AND p.graded_at IS NULL ORDER BY p.answered_at`,
      )
      .bind(noteId, this.userId)
      .all<{ card_id: string; direction: Direction; answer: string | null; answered_at: number }>();
    return {
      ...note,
      ...(waiting.length ? { waiting_for_grading: waiting.map((x) => ({ ...x, answered_at: iso(x.answered_at) })) } : {}),
      history: results.map(({ verified, affects_schedule, feedback, ...r }) => ({
        ...r,
        ...(feedback ? { feedback } : {}),
        rating: RATING_NAMES[r.rating],
        reviewed_at: iso(r.reviewed_at),
        verified: !!verified,
        early: !affects_schedule,
      })),
    };
  }

  // ---------- grade later ----------

  /**
   * Store answers to grade later (UI "Grade later"): the schedule isn't changed and the card is
   * not asked again until a review grades it. A second answer for a card that is still waiting
   * replaces the first.
   */
  async gradeLater(items: { card_id: string; answer?: string | null; answered_at?: string | number }[], opts: { tz?: string; source?: ReviewSource } = {}) {
    if (!items.length) throw new UserError("Nothing to store");
    if (items.length > 50) throw new UserError("At most 50 answers per call");
    const now = this.clock();
    const tz = this.tz(opts.tz);
    const ids = [...new Set(items.map((i) => i.card_id))];
    const { results } = await this.db
      .prepare(`SELECT id FROM cards WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(this.userId, JSON.stringify(ids))
      .all<{ id: string }>();
    const missing = ids.filter((id) => !results.some((r) => r.id === id));
    if (missing.length) throw new UserError(`No card ${missing.join(", ")}`);
    const rows = items.map((i) => ({
      id: this.id(),
      card_id: i.card_id,
      answer: clean(i.answer)?.slice(0, FIELD_MAX) ?? null,
      answered_at: this.parseReviewTime(i.answered_at, now, tz),
    }));
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM pending_answers WHERE user_id = ? AND graded_at IS NULL AND card_id IN (SELECT json_extract(value, '$.card_id') FROM json_each(?))`,
        )
        .bind(this.userId, JSON.stringify(rows)),
      this.db
        .prepare(
          `INSERT INTO pending_answers (id, user_id, card_id, answer, answered_at, source, created_at)
           SELECT json_extract(value, '$.id'), ?2, json_extract(value, '$.card_id'), json_extract(value, '$.answer'),
                  json_extract(value, '$.answered_at'), ?3, ?4
           FROM json_each(?1)`,
        )
        .bind(JSON.stringify(rows), this.userId, opts.source ?? "ui", now),
    ]);
    return { stored: rows.map((r) => ({ card_id: r.card_id, answer: r.answer, answered_at: iso(r.answered_at) })) };
  }

  /** Answers waiting for grading, oldest first, with everything needed to grade them. */
  async pendingGrading(opts: { deck?: string; limit?: number } = {}) {
    const where = ["p.user_id = ?", "p.graded_at IS NULL"];
    const vals: unknown[] = [this.userId];
    if (opts.deck) where.push("d.name = ?"), vals.push(opts.deck);
    const sql = `FROM pending_answers p JOIN cards c ON c.id = p.card_id JOIN notes n ON n.id = c.note_id JOIN decks d ON d.id = n.deck_id
                 WHERE ${where.join(" AND ")}`;
    const [{ results }, total] = await Promise.all([
      this.db
        .prepare(
          `SELECT p.id AS pending_id, p.card_id, p.answer, p.answered_at, p.source, c.direction, c.state, n.id AS note_id, n.type,
                  n.kanji, n.kana, n.meaning, n.front, n.back, n.notes, n.trap, n.extra, d.name AS deck_name
           ${sql} ORDER BY p.answered_at LIMIT ?`,
        )
        .bind(...vals, Math.min(opts.limit ?? 50, 200))
        .all<NoteRow & { pending_id: string; card_id: string; answer: string | null; answered_at: number; source: string; direction: Direction; state: number; note_id: string; deck_name: string }>(),
      this.db.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...vals).first<{ n: number }>(),
    ]);
    const render = await this.furiganaRenderer(results.flatMap((r) => [r.front, r.back, r.notes, r.trap]));
    return {
      pending: total?.n ?? 0,
      items: results.map((r) => {
        const extra = parseJson<Record<string, unknown> | null>(r.extra, null);
        const [show, ask] = splitDirection(r.direction);
        const faces = r.type === "word" ? { kanji: r.kanji, kana: r.kana, meaning: r.meaning } : { front: r.front, back: r.back };
        return {
          card_id: r.card_id,
          note_id: r.note_id,
          deck: r.deck_name,
          type: r.type,
          direction: r.direction,
          shown: show,
          asked: ask,
          faces,
          accept: acceptedAnswers({ ...r, extra }, ask, show),
          trap: r.trap,
          notes: r.notes,
          ...(extra ? { extra } : {}),
          answer: r.answer,
          answered_at: iso(r.answered_at),
          source: r.source,
          is_new: r.state === 0,
          ...(render({ ...faces, trap: r.trap, notes: r.notes }) ?? {}),
        };
      }),
    };
  }

  /** Teacher feedback on recent reviews (for the learner's inbox in the UI). */
  async feedbackInbox(opts: { unseen_only?: boolean; limit?: number } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT r.id AS review_id, r.card_id, c.direction, r.rating, r.answer, r.feedback, r.reviewed_at, r.feedback_seen_at,
                n.id AS note_id, n.type, n.kanji, n.kana, n.meaning, n.front, n.back
         FROM review_log r JOIN cards c ON c.id = r.card_id JOIN notes n ON n.id = c.note_id
         WHERE r.user_id = ? AND r.feedback IS NOT NULL ${opts.unseen_only ? "AND r.feedback_seen_at IS NULL" : ""}
         ORDER BY r.created_at DESC, r.reviewed_at DESC LIMIT ?`,
      )
      .bind(this.userId, Math.min(opts.limit ?? 30, 100))
      .all<{ review_id: string; card_id: string; direction: Direction; rating: number; answer: string | null; feedback: string; reviewed_at: number; feedback_seen_at: number | null; note_id: string; type: NoteType; kanji: string | null; kana: string | null; meaning: string | null; front: string | null; back: string | null }>();
    const unseen = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM review_log WHERE user_id = ? AND feedback IS NOT NULL AND feedback_seen_at IS NULL`)
      .bind(this.userId)
      .first<{ n: number }>();
    return {
      unseen: unseen?.n ?? 0,
      items: results.map((r) => ({
        review_id: r.review_id,
        card_id: r.card_id,
        note_id: r.note_id,
        direction: r.direction,
        faces: r.type === "word" ? { kanji: r.kanji, kana: r.kana, meaning: r.meaning } : { front: r.front, back: r.back },
        rating: RATING_NAMES[r.rating],
        answer: r.answer,
        feedback: r.feedback,
        reviewed_at: iso(r.reviewed_at),
        seen: r.feedback_seen_at != null,
      })),
    };
  }

  async markFeedbackSeen(reviewIds: string[]) {
    if (!Array.isArray(reviewIds) || reviewIds.length > 200) throw new UserError("review_ids must be a list of at most 200");
    await this.db
      .prepare(`UPDATE review_log SET feedback_seen_at = ? WHERE user_id = ? AND feedback_seen_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
      .bind(this.clock(), this.userId, JSON.stringify(reviewIds))
      .run();
    return { ok: true };
  }

  /**
   * Set existing cards' schedules from another tool (migration). The given state becomes the
   * card's starting point; reviews logged here after its last_review are applied on top.
   */
  async setSchedule(items: { card_id: string; schedule: ScheduleArg; discard_existing_reviews?: boolean }[], opts: { tz?: string } = {}) {
    if (!items.length || items.length > 500) throw new UserError("Give 1 to 500 cards");
    const tz = this.tz(opts.tz);
    const parsed = items.map((it, i) => ({
      card_id: it.card_id, discard: !!it.discard_existing_reviews, state: this.parseSchedule(it.schedule, tz, `cards[${i}].schedule`),
    }));
    const ids = [...new Set(parsed.map((p) => p.card_id))];
    if (ids.length !== parsed.length) throw new UserError("A card is listed twice");
    const { results: cards } = await this.db
      .prepare(`SELECT * FROM cards WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(this.userId, JSON.stringify(ids))
      .all<CardRow>();
    const missing = ids.filter((id) => !cards.some((c) => c.id === id));
    if (missing.length) throw new UserError(`No card ${missing.join(", ")}`);
    const { results: log } = await this.db
      .prepare(
        `SELECT card_id, rating, reviewed_at FROM review_log
         WHERE user_id = ? AND affects_schedule = 1 AND card_id IN (SELECT value FROM json_each(?)) ORDER BY reviewed_at, rowid`,
      )
      .bind(this.userId, JSON.stringify(ids))
      .all<{ card_id: string; rating: number; reviewed_at: number }>();
    const w = this.writes();
    const out = parsed.map((p) => {
      const card = cards.find((c) => c.id === p.card_id)!;
      // discard_existing_reviews: earlier reviews here were placeholders (e.g. a "good" logged by an
      // import); they stay in history but no longer affect the schedule.
      const hist = p.discard ? [] : log.filter((l) => l.card_id === p.card_id);
      if (p.discard) {
        w.post.push(
          this.db.prepare(`UPDATE review_log SET affects_schedule = 0 WHERE user_id = ? AND card_id = ?`).bind(this.userId, p.card_id),
        );
      }
      const state = replay(card.created_at, hist, p.state);
      w.imported.push({ id: p.card_id, ...p.state });
      w.states.push({ id: p.card_id, ...pickState(state) });
      return {
        card_id: p.card_id,
        direction: card.direction,
        state: STATE_NAMES[state.state],
        next_due: iso(state.due),
        stability_days: Math.round(state.stability * 10) / 10,
        reviews_applied_after_import: hist.filter((h) => h.reviewed_at >= (p.state.last_review ?? -Infinity)).length,
      };
    });
    await this.commit(w);
    return out;
  }

  // ---------- study sessions ----------

  /**
   * Open a study session: per-deck overview since the last session (or `since`),
   * and optionally the first due prompts. The returned session_id goes to session_end.
   */
  async sessionStart(opts: {
    decks?: string[];
    since?: string | number;
    tz?: string;
    kind?: "text" | "voice";
    include_due?: boolean;
    due_limit?: number;
    ask_mode?: AskMode;
  }) {
    const now = this.clock();
    const tz = this.tz(opts.tz);
    const allDecks = await this.listDecks();
    const wanted = opts.decks?.length ? opts.decks.map((d) => d.trim()) : null;
    const unknown = wanted ? wanted.filter((d) => !allDecks.some((x) => x.name === d)) : [];
    const decks = wanted ? allDecks.filter((d) => wanted.includes(d.name)) : allDecks;

    // Sessions never closed with session_end: older than 12 h are closed here (at their last
    // logged review, else their start); younger ones are reported so the agent can close them.
    await this.db
      .prepare(
        `UPDATE study_sessions SET closed_by = 'auto',
           ended_at = MAX(started_at, COALESCE((SELECT MAX(r.reviewed_at) FROM review_log r WHERE r.session_id = study_sessions.id AND r.user_id = study_sessions.user_id), started_at))
         WHERE user_id = ? AND ended_at IS NULL AND started_at < ?`,
      )
      .bind(this.userId, now - OPEN_SESSION_MAX)
      .run();
    const { results: openRows } = await this.db
      .prepare(`SELECT id, kind, started_at FROM study_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at`)
      .bind(this.userId)
      .all<{ id: string; kind: string | null; started_at: number }>();
    const openSessions = openRows.map((o) => ({
      session_id: o.id,
      started_at: iso(o.started_at),
      age_hours: Math.round(((now - o.started_at) / HOUR) * 10) / 10,
      kind: o.kind,
    }));
    // Sessions closed in the last 24 h, and how (session_end call or auto-close).
    const { results: closedRows } = await this.db
      .prepare(
        `SELECT id, kind, started_at, ended_at, closed_by, summary FROM study_sessions
         WHERE user_id = ? AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at DESC LIMIT 10`,
      )
      .bind(this.userId, now - 24 * HOUR)
      .all<{ id: string; kind: string | null; started_at: number; ended_at: number; closed_by: string | null; summary: string | null }>();
    const recentlyClosed = closedRows.map((o) => ({
      session_id: o.id,
      kind: o.kind,
      started_at: iso(o.started_at),
      ended_at: iso(o.ended_at),
      ...endedBy(o.closed_by),
      ...(o.summary ? { summary: parseJson(o.summary, null) } : {}),
    }));

    let since: number;
    let sinceSource: string;
    if (opts.since != null && opts.since !== "") {
      since = parseTime(opts.since, tz);
      if (Number.isNaN(since)) throw new UserError(`Bad since: ${opts.since}`);
      sinceSource = "given";
    } else {
      const last = await this.db
        .prepare(`SELECT MAX(ended_at) AS t FROM study_sessions WHERE user_id = ? AND ended_at IS NOT NULL`)
        .bind(this.userId)
        .first<{ t: number | null }>();
      since = last?.t ?? now - 7 * DAY;
      sinceSource = last?.t != null ? "last_session_end" : "default_7_days";
    }

    const sessionId = this.id();
    await this.db
      .prepare(`INSERT INTO study_sessions (id, user_id, kind, decks, since, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, this.userId, opts.kind ?? null, wanted ? JSON.stringify(wanted) : null, since, now)
      .run();

    const deckIds = JSON.stringify(decks.map((d) => d.id));
    const join = `JOIN notes n ON n.id = c.note_id JOIN decks d ON d.id = n.deck_id`;
    const inDecks = `d.id IN (SELECT value FROM json_each(?))`;
    const [counts, struggled, hardest, bySource, pendingRows] = await Promise.all([
      this.db
        .prepare(
          `SELECT d.name AS deck, c.direction,
             SUM(c.state != 0 AND c.due <= ?1) AS due_reviews,
             SUM(c.state = 0) AS new_available,
             SUM(c.state IN (1, 3)) AS learning,
             SUM(c.state != 0 AND c.due <= ?1 AND EXISTS (
               SELECT 1 FROM cards s JOIN review_log r ON r.card_id = s.id
               WHERE s.note_id = c.note_id AND s.id != c.id AND r.reviewed_at > ?4
                 AND r.reviewed_at > COALESCE(c.last_review, -1))) AS held_back
           FROM cards c ${join}
           WHERE c.user_id = ?2 AND c.suspended = 0 AND ${NOT_PENDING} AND ${inDecks.replace("?", "?3")}
           GROUP BY d.id, c.direction ORDER BY c.direction`,
        )
        .bind(now, this.userId, deckIds, now - DEFAULT_SIBLING_GAP)
        .all<{ deck: string; direction: Direction; due_reviews: number; new_available: number; learning: number; held_back: number }>(),
      this.db
        .prepare(
          `SELECT d.name AS deck, n.id AS note_id, n.type, n.kanji, n.kana, n.meaning, n.front, n.trap,
             c.id AS card_id, c.direction, c.lapses, c.due,
             SUM(r.rating = 1) AS again, SUM(r.rating = 2) AS hard, MAX(r.reviewed_at) AS last_failed_at,
             (SELECT x.rating FROM review_log x WHERE x.card_id = c.id ORDER BY x.reviewed_at DESC, x.rowid DESC LIMIT 1) AS latest_rating
           FROM review_log r JOIN cards c ON c.id = r.card_id ${join}
           WHERE r.user_id = ?1 AND r.reviewed_at >= ?2 AND r.rating <= 2 AND ${inDecks.replace("?", "?3")}
           GROUP BY c.id ORDER BY again DESC, last_failed_at DESC LIMIT 300`,
        )
        .bind(this.userId, since, deckIds)
        .all<Record<string, unknown> & { deck: string; type: NoteType; direction: Direction; latest_rating: number; due: number; last_failed_at: number }>(),
      this.db
        .prepare(
          `SELECT * FROM (
             SELECT d.name AS deck, n.id AS note_id, n.type, n.kanji, n.kana, n.meaning, n.front, n.trap,
               SUM(c.lapses) AS lapses, ROUND(MIN(c.stability), 2) AS min_stability_days,
               GROUP_CONCAT(c.direction || ' (lapses ' || c.lapses || ', stability ' || ROUND(c.stability, 1) || 'd)', '; ') AS directions,
               ROW_NUMBER() OVER (PARTITION BY d.id ORDER BY SUM(c.lapses) DESC, MIN(c.stability) ASC) AS rk
             FROM cards c ${join}
             WHERE c.user_id = ?1 AND c.suspended = 0 AND c.state != 0 AND ${inDecks.replace("?", "?2")}
             GROUP BY n.id HAVING ${STRUGGLING.replace("?", "?3")}
           ) WHERE rk <= 15 ORDER BY deck, rk`,
        )
        .bind(this.userId, deckIds, since)
        .all<Record<string, unknown> & { deck: string; rk: number }>(),
      this.db
        .prepare(
          `SELECT d.name AS deck, r.source, COUNT(*) AS reviews FROM review_log r JOIN cards c ON c.id = r.card_id ${join}
           WHERE r.user_id = ?1 AND r.reviewed_at >= ?2 AND ${inDecks.replace("?", "?3")} GROUP BY d.id, r.source`,
        )
        .bind(this.userId, since, deckIds)
        .all<{ deck: string; source: string; reviews: number }>(),
      this.db
        .prepare(
          `SELECT d.name AS deck, COUNT(*) AS n FROM pending_answers p JOIN cards c ON c.id = p.card_id ${join}
           WHERE p.user_id = ?1 AND p.graded_at IS NULL AND ${inDecks.replace("?", "?2")} GROUP BY d.id`,
        )
        .bind(this.userId, deckIds)
        .all<{ deck: string; n: number }>(),
    ]);

    const perDeck = decks.map((d) => {
      const dirs = counts.results.filter((c) => c.deck === d.name).map(({ deck: _, ...c }) => c);
      const sum = (k: "due_reviews" | "new_available" | "learning" | "held_back") => dirs.reduce((a, c) => a + (c[k] ?? 0), 0);
      return {
        deck: d.name,
        description: d.description,
        default_directions: d.default_directions ?? [...DEFAULT_WORD_DIRECTIONS],
        // due_reviews = available_now + held_back (held back by the sibling gap after a sibling was just reviewed).
        due: {
          due_reviews: sum("due_reviews"),
          available_now: sum("due_reviews") - sum("held_back"),
          held_back: sum("held_back"),
          new_available: sum("new_available"),
          learning: sum("learning"),
          by_direction: dirs,
        },
        struggled_since: struggled.results
          .filter((s) => s.deck === d.name)
          .slice(0, 40)
          .map(({ deck: _, type, front, kanji, kana, meaning, latest_rating, due, last_failed_at, ...s }) => ({
            ...((type === "word" ? { kanji, kana, meaning } : { front }) as { kanji?: string | null; kana?: string | null; meaning?: string | null; front?: string | null }),
            ...s,
            last_failed_at: iso(last_failed_at),
            latest_rating: RATING_NAMES[latest_rating],
            next_due: iso(due),
          })),
        hardest_notes: hardest.results
          .filter((h) => h.deck === d.name)
          .map(({ deck: _, rk: __, type, front, kanji, kana, meaning, ...h }) => ({
            ...(type === "word" ? { kanji, kana, meaning } : { front }),
            ...h,
          })),
        reviews_since_by_source: Object.fromEntries(bySource.results.filter((s) => s.deck === d.name).map((s) => [s.source, s.reviews])),
        // Answers typed in the UI with "Grade later": read them with get_pending_grading, grade with rate/session_end.
        pending_grading: pendingRows.results.find((p) => p.deck === d.name)?.n ?? 0,
      };
    });

    const includeDue = opts.include_due ?? true;
    const due = includeDue
      ? await this.getDue({ decks: decks.map((d) => d.name), limit: opts.due_limit ?? 20, ask_mode: opts.ask_mode })
      : null;
    return {
      session_id: sessionId,
      now: iso(now),
      tz,
      since: iso(since),
      since_source: sinceSource,
      ...(unknown.length ? { unknown_decks: unknown } : {}),
      open_sessions: openSessions,
      recently_closed_sessions: recentlyClosed,
      pending_grading: perDeck.reduce((a, d) => a + d.pending_grading, 0),
      decks: perDeck,
      ...(due ? { due } : {}),
    };
  }

  /**
   * Close a study session in ONE atomic batch: add_words / add_basic, then all
   * reviews (by card_id or by content), then mark the session ended.
   *
   * Validation errors (bad rating/time/direction, missing fields, unknown or
   * already-ended session) abort everything. Entries that cannot be matched
   * (ambiguous, unknown without meaning, direction not applicable) are reported
   * in `problems` and skipped; the rest is written.
   */
  async sessionEnd(
    sessionId: string,
    input: {
      reviews?: SessionReviewInput[];
      add_words?: (WordInput & { deck?: string })[];
      add_basic?: (BasicInput & { deck?: string })[];
      deck?: string;
      on_conflict?: OnConflict;
      source?: ReviewSource;
      tz?: string;
      /** Apply this batch to a session already closed by session_end (exact duplicate reviews are skipped). */
      append?: boolean;
    },
  ) {
    const now = this.clock();
    const tz = this.tz(input.tz);
    const requestHash = await sha256Hex(stableJson({ sessionId, ...input }));
    const reviews = input.reviews ?? [];
    let addWords = input.add_words ?? [];
    let addBasic = input.add_basic ?? [];
    if (reviews.length > 300) throw new UserError("At most 300 reviews per session_end");
    if (addWords.length > 200 || addBasic.length > 200) throw new UserError("At most 200 add_words and 200 add_basic per session_end");

    const session = await this.db
      .prepare(`SELECT * FROM study_sessions WHERE id = ? AND user_id = ?`)
      .bind(sessionId, this.userId)
      .first<{ id: string; kind: string | null; decks: string | null; since: number; started_at: number; ended_at: number | null; closed_by: string | null; summary: string | null; end_request_hash: string | null }>();
    if (!session) throw new UserError(`No study session ${sessionId} (call session_start first)`);
    // An auto-closed session (no session_end ever recorded) may still be ended once; the guard below keeps that single-shot.
    let appending = false;
    if (session.ended_at != null && session.closed_by !== "auto") {
      const how = endedBy(session.closed_by);
      if (session.closed_by === "session_end" && session.end_request_hash === requestHash) {
        // The same call again (a client retry after a lost response): it was applied once, report that.
        return {
          session_id: sessionId,
          duplicate_request: true,
          note: "This exact session_end was already applied; nothing was written again.",
          started_at: iso(session.started_at),
          ended_at: iso(session.ended_at),
          ...how,
          summary: parseJson<Record<string, unknown>>(session.summary, {}),
          reviews: [],
          problems: [],
          notes_created: [],
          add_words: [],
          add_basic: [],
        };
      }
      if (!input.append) {
        throw new UserError(
          `Session ${sessionId} already ended at ${iso(session.ended_at)} (ended_by: ${how.ended_by}: ${how.ended_reason}; ` +
            `what it saved: ${session.summary ?? "no summary"}). Nothing was written. To add these reviews anyway, call session_end again with append: true ` +
            `(reviews identical to ones already saved in this session are skipped), or start a new session.`,
        );
      }
      appending = true;
    }
    const defaultSource: ReviewSource = input.source ?? (session.kind === "voice" ? "lesson" : "chat");

    // ---- validation (throws, nothing written) ----
    const parsedReviews = reviews.map((r, i) => {
      const rating = RATINGS[r.rating];
      if (!rating) throw new UserError(`reviews[${i}]: unknown rating "${r.rating}" (again|hard|good|easy)`);
      let at: number;
      try {
        at = this.parseReviewTime(r.reviewed_at, now, tz);
      } catch (e) {
        throw new UserError(`reviews[${i}]: ${(e as Error).message}`);
      }
      const kind = r.card_id ? "card" : clean(r.front) ? "basic" : clean(r.kana) ? "word" : null;
      if (!kind) throw new UserError(`reviews[${i}]: give card_id, kana (+kanji) for a word, or front for a basic note`);
      let direction = r.direction;
      if (direction) this.checkDirection(direction);
      if (kind === "word") {
        if (!direction) throw new UserError(`reviews[${i}]: direction is required for a word (e.g. "kanji>kana")`);
        if (!isDirectionForType(direction, "word")) throw new UserError(`reviews[${i}]: ${direction} is not a word direction`);
      }
      if (kind === "basic") {
        direction ??= "front>back";
        if (!isDirectionForType(direction, "basic")) throw new UserError(`reviews[${i}]: ${direction} is not a basic direction`);
      }
      return { i, r, rating, at, timeGiven: r.reviewed_at != null && r.reviewed_at !== "", kind, direction };
    });
    addWords.forEach((w, i) => {
      if (!this.parseWord(w)) throw new UserError(`add_words[${i}]: needs kana and meaning`);
    });
    addBasic.forEach((b, i) => {
      if (!this.parseBasic(b)) throw new UserError(`add_basic[${i}]: needs front and back`);
    });
    // Furigana: bare {漢字} spans get the reading of the single word note written that way.
    const newWords = [...addWords, ...reviews.filter((r) => r.meaning && r.kana)];
    const [furiW, furiB, furiR] = await Promise.all([
      this.resolveFurigana(addWords, newWords),
      this.resolveFurigana(addBasic.map(withAccept), newWords),
      this.resolveFurigana(reviews.map((r) => ({ back: r.back, notes: r.notes, trap: r.trap })), newWords),
    ]);
    addWords = furiW.items;
    addBasic = furiB.items;
    parsedReviews.forEach((p, i) => {
      const f = furiR.items[i]!;
      p.r = { ...p.r, back: f.back ?? p.r.back, notes: f.notes ?? p.r.notes, trap: f.trap ?? p.r.trap };
    });
    const words = addWords.map((w) => ({ ...this.parseWord(w)!, deckName: clean(w.deck) }));
    const basics = addBasic.map((b) => ({ ...this.parseBasic(b)!, deckName: clean(b.deck) }));

    // ---- reads ----
    const decks = await this.loadDecks();
    const w = this.writes(now);
    const deckFor = this.deckResolver(w, decks);
    const sessionDecks = parseJson<string[] | null>(session.decks, null);
    const defaultDeckName =
      clean(input.deck) ?? (sessionDecks?.length === 1 ? sessionDecks[0]! : decks.size === 1 ? [...decks.keys()][0]! : null);
    const needDeck = (name: string | null, what: string) => {
      const n = name ?? defaultDeckName;
      if (!n) throw new UserError(`${what}: no deck given (set deck on the entry or session_end.deck)`);
      return deckFor(n);
    };
    const wordItems = words.map((x, i) => ({ ...x, deck: needDeck(x.deckName, `add_words[${i}]`) }));
    const basicItems = basics.map((x, i) => ({ ...x, deck: needDeck(x.deckName, `add_basic[${i}]`) }));

    const kanaKeys = lookupKeys([...parsedReviews.map((p) => p.r.kana), ...addWords.map((x) => x.kana)]);
    const frontKeys = lookupKeys([...parsedReviews.map((p) => p.r.front), ...addBasic.map((x) => x.front)]);
    const cardIds = parsedReviews.filter((p) => p.kind === "card").map((p) => p.r.card_id!);
    const [candidates, idCards] = await Promise.all([
      this.db
        .prepare(
          `SELECT n.*, d.name AS deck_name FROM notes n JOIN decks d ON d.id = n.deck_id
           WHERE n.user_id = ?1 AND ((n.type = 'word' AND n.kana IN (SELECT value FROM json_each(?2)))
                                  OR (n.type = 'basic' AND (n.front IN (SELECT value FROM json_each(?3)) OR instr(n.front, '{') > 0)))`,
        )
        .bind(this.userId, JSON.stringify(kanaKeys), JSON.stringify(frontKeys))
        .all<NoteWithDeck>()
        .then((r) => r.results),
      cardIds.length
        ? this.db
            .prepare(`SELECT * FROM cards WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`)
            .bind(this.userId, JSON.stringify(cardIds))
            .all<CardRow>()
            .then((r) => r.results)
        : Promise.resolve([] as CardRow[]),
    ]);
    const notes = new Map<string, NoteWithDeck>(candidates.map((n) => [n.id, n]));
    const extraIds = [...new Set(idCards.map((c) => c.note_id))].filter((id) => !notes.has(id));
    for (const n of await this.notesByIds(extraIds)) notes.set(n.id, n);
    const cardsByNote = new Map<string, Map<Direction, CardRow>>();
    const addCard = (c: CardRow) => {
      const m = cardsByNote.get(c.note_id) ?? new Map<Direction, CardRow>();
      m.set(c.direction, c);
      cardsByNote.set(c.note_id, m);
    };
    for (const list of (await this.cardsOfNotes([...notes.keys()])).values()) list.forEach(addCard);
    const cardById = new Map<string, CardRow>();
    for (const m of cardsByNote.values()) for (const c of m.values()) cardById.set(c.id, c);

    // ---- plan: new notes first, so reviews can refer to them ----
    const index = new NoteIndex<NoteWithDeck>(notes.values());
    // Backstop for creation: existence is checked per user (like the unique index), never per deck.
    const globalKeys = new Map<string, NoteWithDeck>();
    const keyOf = (n: NoteRow) => (n.type === "word" ? `w:${wordKey(n.kanji, n.kana)}` : `b:${basicKey(n.front, n.back)}`);
    for (const n of notes.values()) globalKeys.set(keyOf(n), n);
    const createdNotes: { note_id: string; deck: string; via: string; kanji?: string | null; kana?: string | null; meaning?: string | null; front?: string | null; cards: Direction[] }[] = [];
    const plannedInserts = new Map<string, NoteInsert>();
    const registerPlanned = (p: { insert: NoteInsert; cardIds: Map<Direction, string>; deck: DeckInfo }, via: string) => {
      const row: NoteWithDeck = { ...p.insert, deck_name: p.deck.name, created_at: now, updated_at: now };
      notes.set(row.id, row);
      index.add(row);
      globalKeys.set(keyOf(row), row);
      plannedInserts.set(row.id, p.insert);
      for (const [d, cid] of p.cardIds) {
        const c: CardRow = { ...emptyState(now), id: cid, note_id: row.id, direction: d, suspended: 0, created_at: now };
        addCard(c);
        cardById.set(cid, c);
      }
      createdNotes.push({ note_id: row.id, deck: p.deck.name, via, ...faceFields(row), cards: [...p.cardIds.keys()] });
    };
    const onConflict = input.on_conflict ?? "skip";
    const merge = onConflict === "merge" ? await this.mergeContext(wordItems.map((x) => x.kana)) : undefined;
    const wordsOut = this.planWords(w, wordItems, await this.existingWordsFrom(notes.values()), onConflict, merge);
    wordsOut.forEach((o) => o.planned && registerPlanned(o.planned, "add_words"));
    const basicsOut = this.planBasics(w, basicItems, this.existingBasicsFrom(notes.values()));
    basicsOut.forEach((o) => o.planned && registerPlanned(o.planned, "add_basic"));

    // ---- resolve reviews ----
    type Problem = { index: number; status: string; reason: string; input: Record<string, unknown>; candidates?: unknown[] };
    const problems: Problem[] = [];
    const resolved: {
      p: (typeof parsedReviews)[number]; card: CardRow; note: NoteWithDeck; noteCreated: boolean; cardCreated: boolean; deckMismatch?: boolean;
    }[] = [];
    const enabledPatch = new Map<string, Set<Direction>>();
    const echo = (r: SessionReviewInput) =>
      Object.fromEntries(Object.entries({ card_id: r.card_id, deck: r.deck, kanji: r.kanji, kana: r.kana, front: r.front, direction: r.direction, rating: r.rating }).filter(([, v]) => v != null));

    for (const p of parsedReviews) {
      const { r } = p;
      let note: NoteWithDeck | undefined;
      let noteCreated = false;
      if (p.kind === "card") {
        const c = cardById.get(r.card_id!);
        if (!c) {
          problems.push({ index: p.i, status: "unmatched", reason: `no card ${r.card_id}`, input: echo(r) });
          continue;
        }
        resolved.push({ p, card: c, note: notes.get(c.note_id)!, noteCreated: false, cardCreated: false });
        continue;
      }
      const m = p.kind === "word" ? index.matchWord({ kanji: r.kanji, kana: r.kana!, deck: r.deck, meaning: r.meaning }) : index.matchBasic({ front: r.front!, deck: r.deck });
      if (m.status === "ambiguous") {
        problems.push({ index: p.i, status: "ambiguous", reason: "several notes match; retry with kanji, deck or card_id", input: echo(r), candidates: m.candidates.map(brief) });
        continue;
      }
      let deckMismatch = false;
      const existingByKey =
        m.status === "not_found"
          ? globalKeys.get(p.kind === "word" ? `w:${wordKey(r.kanji, r.kana)}` : `b:${basicKey(r.front, r.back)}`)
          : undefined;
      if (m.status === "found") {
        note = m.note;
        deckMismatch = !!m.deck_mismatch;
      } else if (existingByKey) {
        note = existingByKey;
        deckMismatch = !!r.deck && existingByKey.deck_name !== r.deck;
      } else {
        // Unknown: create it when we have what a note needs.
        const deckName = clean(r.deck) ?? defaultDeckName;
        const missing = p.kind === "word" ? (!clean(r.meaning) ? "meaning" : null) : !clean(r.back) ? "back" : null;
        if (missing || !deckName) {
          problems.push({
            index: p.i,
            status: "unmatched",
            reason: missing ? `no such note; give ${missing} to create it` : "no such note and no deck to create it in",
            input: echo(r),
            ...(m.candidates.length ? { candidates: m.candidates.map(brief) } : {}),
          });
          continue;
        }
        const deck = deckFor(deckName);
        const dir = p.direction!;
        if (p.kind === "word") {
          const faces = { type: "word" as const, kanji: cleanJa(r.kanji), kana: cleanJa(r.kana)!, meaning: clean(r.meaning)! };
          if (!isApplicable(faces, dir)) {
            problems.push({ index: p.i, status: "not_applicable", reason: `${dir} needs a face this word doesn't have`, input: echo(r) });
            continue;
          }
          const defaults = deck.default_directions ?? DEFAULT_WORD_DIRECTIONS;
          const enabled = [...new Set([...defaults, dir])];
          registerPlanned({ ...this.planNewNote(w, deck, faces, enabled, r), deck }, "review");
        } else {
          const enabled: Direction[] = [...new Set<Direction>(["front>back", dir])];
          const faces = { type: "basic" as const, front: clean(r.front)!, back: clean(r.back)! };
          registerPlanned({ ...this.planNewNote(w, deck, faces, enabled, r), deck }, "review");
        }
        note = notes.get(createdNotes.at(-1)!.note_id)!;
        noteCreated = true;
      }
      // Find or create the card for the requested direction.
      const dir = p.direction!;
      let card = cardsByNote.get(note.id)?.get(dir);
      let cardCreated = false;
      if (!card) {
        if (!isApplicable(note, dir)) {
          problems.push({ index: p.i, status: "not_applicable", reason: `${dir} needs a face this note doesn't have`, input: echo(r), candidates: [brief(note)] });
          continue;
        }
        card = { ...emptyState(now), id: this.id(), note_id: note.id, direction: dir, suspended: 0, created_at: now };
        w.cards.push([card.id, note.id, dir]);
        addCard(card);
        cardById.set(card.id, card);
        cardCreated = true;
        const planned = plannedInserts.get(note.id);
        if (planned) {
          planned.enabled_directions = JSON.stringify([...new Set([...JSON.parse(planned.enabled_directions), dir])]);
        } else {
          const set = enabledPatch.get(note.id) ?? new Set(parseJson<Direction[]>(note.enabled_directions, []));
          set.add(dir);
          enabledPatch.set(note.id, set);
        }
      }
      resolved.push({ p, card, note, noteCreated, cardCreated, deckMismatch });
    }
    for (const [id, set] of enabledPatch) w.patchNote({ id, enabled_directions: JSON.stringify([...set]) });

    // append: skip reviews already saved in this session (same card, rating and time).
    if (appending) {
      const { results: done } = await this.db
        .prepare(`SELECT card_id, rating, reviewed_at FROM review_log WHERE user_id = ? AND session_id = ?`)
        .bind(this.userId, sessionId)
        .all<{ card_id: string; rating: number; reviewed_at: number }>();
      const seen = new Set(done.map((d) => `${d.card_id}|${d.rating}|${d.reviewed_at}`));
      for (let k = resolved.length - 1; k >= 0; k--) {
        const x = resolved[k]!;
        if (x.p.timeGiven && seen.has(`${x.card.id}|${x.p.rating}|${x.p.at}`)) {
          problems.push({ index: x.p.i, status: "duplicate", reason: "already saved in this session (same card, rating and time); skipped", input: echo(x.p.r) });
          resolved.splice(k, 1);
        }
      }
      problems.sort((a, b) => a.index - b.index);
    }

    const { final, entries } = await this.planRatings(
      w,
      resolved.map(({ p, card }) => ({
        card,
        rating: p.rating,
        at: p.at,
        timeGiven: p.timeGiven,
        source: p.r.source ?? input.source,
        defaultSource,
        answer: p.r.answer ?? null,
        session_id: sessionId,
        verified: p.r.verified,
        early: p.r.early,
        feedback: p.r.feedback,
      })),
    );
    const furiganaProblems = [
      ...furiW.problems.flatMap((ps, i) => ps.map((x) => ({ where: `add_words[${i}]`, ...x }))),
      ...furiB.problems.flatMap((ps, i) => ps.map((x) => ({ where: `add_basic[${i}]`, ...x }))),
      ...furiR.problems.flatMap((ps, i) => ps.map((x) => ({ where: `reviews[${i}]`, ...x }))),
    ];

    const ratingCounts = { again: 0, hard: 0, good: 0, easy: 0 };
    resolved.forEach(({ p }) => ratingCounts[p.r.rating]++);
    const summary = {
      reviews_applied: resolved.length,
      ratings: ratingCounts,
      notes_created: createdNotes.length,
      problems: problems.length,
      deck_mismatch: resolved.filter((x) => x.deckMismatch).length,
      graded_pending: entries.filter((e) => e.graded).length,
      ...(appending ? { appended: true, previous: parseJson(session.summary, null) } : {}),
    };
    // Close the session FIRST in the batch, then abort the batch if that changed
    // nothing (already ended by a concurrent or retried call): the guard re-inserts
    // the session's own primary key only when changes() = 0, which fails the
    // whole transaction with a UNIQUE error -> nothing is written twice.
    // The update only applies if the session is still as read above (open, auto-closed, or for
    // append the same end), so concurrent calls can't both write.
    w.first.push(
      this.db
        .prepare(
          `UPDATE study_sessions SET ended_at = ?1, summary = ?2, closed_by = 'session_end', end_request_hash = ?3
           WHERE id = ?4 AND user_id = ?5 AND COALESCE(ended_at, -1) = ?6 AND COALESCE(closed_by, '') = ?7`,
        )
        .bind(now, JSON.stringify(summary), requestHash, sessionId, this.userId, session.ended_at ?? -1, session.closed_by ?? ""),
      this.db
        .prepare(`INSERT INTO study_sessions (id, user_id, since, started_at) SELECT ?, ?, 0, 0 WHERE changes() = 0`)
        .bind(sessionId, this.userId),
    );
    await this.commit(w);

    return {
      session_id: sessionId,
      started_at: iso(session.started_at),
      ended_at: iso(now),
      ...(appending ? { appended_to_ended_session: true } : {}),
      ...(session.closed_by === "auto" ? { was_auto_closed: true } : {}),
      summary,
      reviews: resolved.map(({ p, card, note, noteCreated, cardCreated, deckMismatch }, k) => {
        const { state, replayed } = final.get(card.id)!;
        const e = entries[k]!;
        return {
          index: p.i,
          card_id: card.id,
          ...faceFields(note),
          note_id: note.id,
          direction: card.direction,
          rating: p.r.rating,
          reviewed_at: iso(e.at),
          replayed_history: replayed,
          state: STATE_NAMES[state.state],
          next_due: iso(state.due),
          interval_days: intervalDays(state, e.at),
          ...(e.graded ? { graded_pending_answer: { answer: e.graded.answer, answered_at: iso(e.graded.answered_at) } } : {}),
          ...(p.r.feedback ? { feedback: p.r.feedback } : {}),
          ...(noteCreated ? { note_created: true } : {}),
          ...(cardCreated && !noteCreated ? { card_created: true } : {}),
          ...(card.suspended ? { suspended: true } : {}),
          ...(p.r.verified === false ? { verified: false } : {}),
          ...(p.r.early ? { early: true, schedule_changed: false } : {}),
          // The entry named another deck than the note's: rated anyway (deck only narrows).
          ...(deckMismatch ? { deck_mismatch: { requested: p.r.deck, actual: note.deck_name } } : {}),
        };
      }),
      problems,
      ...(furiganaProblems.length ? { furigana_problems: furiganaProblems } : {}),
      notes_created: createdNotes,
      add_words: wordsOut.map(({ planned: _, ...o }) => o),
      add_basic: basicsOut.map(({ planned: _, ...o }) => o),
    };
  }

  private async existingWordsFrom(notes: Iterable<NoteRow>) {
    const map = new Map<string, { id: string; planned?: boolean }>();
    for (const n of notes) if (n.type === "word") map.set(wordKey(n.kanji, n.kana), { id: n.id });
    return map;
  }

  private existingBasicsFrom(notes: Iterable<NoteRow>) {
    const map = new Map<string, { id: string }>();
    for (const n of notes) {
      if (n.type !== "basic") continue;
      map.set(basicKey(n.front, n.back), { id: n.id });
      if (n.external_id) map.set(`ext:${n.external_id}`, { id: n.id });
    }
    return map;
  }

  // ---------- stats ----------

  async stats(opts: { deck?: string; days?: number }) {
    const now = this.clock();
    const since = now - (opts.days ?? 30) * DAY;
    const deckJoin = `JOIN notes n ON n.id = c.note_id JOIN decks d ON d.id = n.deck_id`;
    const deckWhere = opts.deck ? `AND d.name = ?` : "";
    const deckVal = opts.deck ? [opts.deck] : [];

    const perDirection = await this.db
      .prepare(
        `SELECT c.direction,
           COUNT(*) AS cards,
           SUM(c.state = 0) AS new,
           SUM(c.state IN (1, 3)) AS learning,
           SUM(c.state = 2) AS review,
           SUM(c.state != 0 AND c.due <= ?) AS due_reviews,
           SUM(c.lapses) AS lapses,
           AVG(CASE WHEN c.state = 2 THEN c.stability END) AS avg_stability_days
         FROM cards c ${deckJoin}
         WHERE c.user_id = ? AND c.suspended = 0 ${deckWhere}
         GROUP BY c.direction ORDER BY c.direction`,
      )
      .bind(now, this.userId, ...deckVal)
      .all<{ direction: string; avg_stability_days: number | null }>();

    // Retention = share of scheduling reviews in the window not rated "again".
    // Unverified (IME) and early (not asked, no schedule effect) reviews are counted separately.
    const retention = await this.db
      .prepare(
        `SELECT c.direction,
           SUM(r.affects_schedule = 1) AS reviews,
           AVG(CASE WHEN r.affects_schedule = 1 THEN r.rating > 1 END) AS retention,
           SUM(r.affects_schedule = 1 AND r.verified = 0) AS reviews_unverified,
           AVG(CASE WHEN r.affects_schedule = 1 AND r.verified = 1 THEN r.rating > 1 END) AS retention_verified,
           SUM(r.affects_schedule = 0) AS reviews_early
         FROM review_log r JOIN cards c ON c.id = r.card_id ${deckJoin}
         WHERE r.user_id = ? AND r.reviewed_at >= ? ${deckWhere}
         GROUP BY c.direction`,
      )
      .bind(this.userId, since, ...deckVal)
      .all<{ direction: string; reviews: number; retention: number | null; reviews_unverified: number; retention_verified: number | null; reviews_early: number }>();

    const hardest = await this.db
      .prepare(
        `SELECT n.id AS note_id, n.kanji, n.kana, n.meaning, n.front, SUM(c.lapses) AS lapses,
           ROUND(MIN(CASE WHEN c.state != 0 THEN c.stability END), 2) AS min_stability_days,
           GROUP_CONCAT(CASE WHEN c.lapses > 0 THEN c.direction || ':' || c.lapses END) AS by_direction
         FROM cards c ${deckJoin}
         WHERE c.user_id = ? AND c.suspended = 0 ${deckWhere}
         GROUP BY n.id HAVING ${STRUGGLING} ORDER BY lapses DESC, MIN(CASE WHEN c.state != 0 THEN c.stability END) LIMIT 15`,
      )
      .bind(this.userId, ...deckVal, since)
      .all();

    const bySource = await this.db
      .prepare(
        `SELECT r.source, COUNT(*) AS reviews FROM review_log r JOIN cards c ON c.id = r.card_id ${deckJoin}
         WHERE r.user_id = ? AND r.reviewed_at >= ? ${deckWhere} GROUP BY r.source`,
      )
      .bind(this.userId, since, ...deckVal)
      .all();

    const ret = new Map(retention.results.map((r) => [r.direction, r]));
    return {
      deck: opts.deck ?? "(all)",
      window_days: opts.days ?? 30,
      by_direction: perDirection.results.map((d) => ({
        ...d,
        avg_stability_days: round2(d.avg_stability_days),
        reviews_in_window: ret.get(d.direction)?.reviews ?? 0,
        retention_in_window: round2(ret.get(d.direction)?.retention ?? null),
        reviews_unverified_in_window: ret.get(d.direction)?.reviews_unverified ?? 0,
        retention_verified_in_window: round2(ret.get(d.direction)?.retention_verified ?? null),
        reviews_early_in_window: ret.get(d.direction)?.reviews_early ?? 0,
      })),
      reviews_by_source: bySource.results,
      hardest_notes: hardest.results,
    };
  }
}

/** Name the constraint behind a UNIQUE failure (nothing was written). */
export function uniqueMessage(msg: string) {
  const why = msg.includes("study_sessions.id")
    ? "This study session was already ended (by another or a retried session_end); start a new session"
    : msg.includes("notes_word_unique")
      ? "Another word with the same kanji and kana already exists"
      : msg.includes("notes.external_id") || msg.includes("notes_external")
        ? "Another note already has this external_id"
        : msg.includes("decks.")
          ? "A deck with this name was created at the same time; retry"
          : msg.includes("cards.")
            ? "That card already exists (concurrent change); retry"
            : msg.includes("note_tags")
              ? "Duplicate tag"
              : `Duplicate value (${msg.replace(/^Error:\s*/, "").slice(0, 200)})`;
  return `${why}. Nothing was written.`;
}

/** Days from the review to the next due date (from the card's last scheduling review). */
function intervalDays(state: SchedState, at: number) {
  const from = state.last_review ?? at;
  return Math.round(((state.due - from) / DAY) * 10) / 10;
}

/** Stable JSON (sorted keys) for request hashing. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

async function sha256Hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** How a study session was closed, for the agent. */
function endedBy(closedBy: string | null) {
  return closedBy === "auto"
    ? { ended_by: "auto", ended_reason: "auto-closed by a later session_start: open for more than 12 h without session_end (closed at its last logged review); one session_end is still accepted" }
    : closedBy === "session_end"
      ? { ended_by: "session_end", ended_reason: "closed by a session_end call (possibly a retried/duplicated call: the same reviews are already saved)" }
      : { ended_by: "unknown", ended_reason: "closed before the close reason was recorded" };
}

function round2(v: number | null | undefined) {
  return v == null ? null : Math.round(v * 100) / 100;
}

function groupBy<T>(xs: readonly T[], key: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

function dedupe<T extends { note_id: string }>(xs: T[]) {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.note_id) && seen.add(x.note_id));
}

function faceFields(n: { type: NoteType; kanji: string | null; kana: string | null; meaning: string | null; front: string | null }) {
  return n.type === "word" ? { kanji: n.kanji, kana: n.kana, meaning: n.meaning } : { front: n.front };
}

function pickState(s: SchedState): SchedState {
  return {
    due: s.due,
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.last_review,
  };
}

/** What on_conflict "merge" may merge into (see Store.mergeContext). */
interface MergeContext {
  index: NoteIndex<NoteWithDeck>;
  notes: Map<string, NoteWithDeck>;
  cards: Map<string, CardRow[]>;
  /** Directions switched on so far in this batch, per note. */
  enabled: Map<string, Set<Direction>>;
}

const normMeaningLoose = (m: string | null | undefined) => (m ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** BasicInput.accept → extra.alt_backs. */
function withAccept<T extends { accept?: string[] | null; extra?: Record<string, unknown> | null }>(b: T): T {
  if (!b.accept?.length) return b;
  const alts = b.accept.map((a) => String(a).trim()).filter(Boolean);
  return { ...b, extra: { ...(b.extra ?? {}), alt_backs: alts } };
}
