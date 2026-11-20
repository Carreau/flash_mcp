/**
 * Kuliko -> flash-mcp import.
 *
 *   npx tsx scripts/import-kuliko.ts classify import/kuliko-raw.json import/import.json
 *   npx tsx scripts/import-kuliko.ts sql import/import.json --email you@example.com [--deck Japanese] > import/import.sql
 *   npx wrangler d1 execute flash-mcp --remote --file import/import.sql
 *
 * Step 1 turns Kuliko question/answer cards into word notes (kanji/kana/meaning)
 * and basic notes (front/back), writing a file you can review and edit by hand.
 * Step 2 turns that file into idempotent SQL: ids are derived from
 * email + Kuliko id and every insert is OR IGNORE, so re-running is a no-op.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DEFAULT_BASIC_DIRECTIONS, DEFAULT_WORD_DIRECTIONS, type Direction, activeDirections } from "../src/model/directions";
import { emptyState } from "../src/model/scheduler";

// ---------- types ----------

export interface KulikoCard {
  id: string;
  question: string;
  answer: string;
  tags?: string[];
  source_display_name?: string;
}

export interface ImportWord {
  kanji?: string;
  kana: string;
  meaning: string;
  notes?: string;
  tags: string[];
  external_id: string;
  extra?: { kuliko_ids?: string[]; alt_meanings?: string[] };
  /** Original card(s), for review only; ignored by the sql step. */
  kuliko?: string[];
}

export interface ImportBasic {
  front: string;
  back: string;
  notes?: string;
  tags: string[];
  external_id: string;
  kuliko?: string[];
}

export interface ImportFile {
  words: ImportWord[];
  basic: ImportBasic[];
}

export interface ClassifyResult extends ImportFile {
  unsure: string[];
  merges: string[];
}

// ---------- reading the Kuliko dump ----------

/** Accepts the connector dump ({result: "<json>"}), the inner object ({data: [...]}) or a plain array. */
export function parseKulikoDump(text: string): KulikoCard[] {
  let v: unknown = JSON.parse(text);
  if (v && typeof v === "object" && "result" in v && typeof (v as { result: unknown }).result === "string") {
    v = JSON.parse((v as { result: string }).result);
  }
  const items: unknown[] = Array.isArray(v) ? v : ((v as { data?: unknown[] })?.data ?? []);
  const cards: KulikoCard[] = [];
  for (const it of items) {
    const o = it as { type?: string; data?: unknown };
    const c = (o.type === "flashcards" && o.data ? o.data : it) as Partial<KulikoCard>;
    if (typeof c.id === "string" && typeof c.question === "string" && typeof c.answer === "string") {
      cards.push({ id: c.id, question: c.question, answer: c.answer, tags: c.tags ?? [], source_display_name: c.source_display_name });
    }
  }
  return cards;
}

// ---------- classification ----------

const KANA = "\\p{Script=Hiragana}\\p{Script=Katakana}ー・";
const KANJI = "\\p{Script=Han}々";
const reKanaWord = new RegExp(`^[${KANA}]+$`, "u");
const reKanjiWord = new RegExp(`^[${KANJI}${KANA}]*[${KANJI}][${KANJI}${KANA}]*$`, "u");
const reJapanese = new RegExp(`[${KANA}${KANJI}]`, "u");
const reKanjiRun = new RegExp(`[${KANJI}]+`, "gu");

/** 履きます / はきます: the kana parts of the kanji form must line up with the reading. */
export function readingMatches(kanji: string, kana: string): boolean {
  const pattern = kanji
    .split(reKanjiRun)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${pattern}$`, "u").test(kana);
}

/** Splits "meaning (explanation)" when the parenthetical is an explanation rather than part of the gloss. */
function splitGloss(s: string): { meaning: string; notes?: string } {
  const m = /^(.*?)\s*\(([^()]*)\)$/u.exec(s.trim());
  if (m && m[1] && (reJapanese.test(m[2]!) || /^also\b/i.test(m[2]!))) return { meaning: m[1].trim(), notes: m[2]!.trim() };
  return { meaning: s.trim() };
}

// Glosses that read as a sentence / phrase rather than a dictionary entry.
const PHRASE_START = /^(i|i'm|i'll|it|it's|is|let's|please|see|one|once|slowly|yesterday|how|what|where|my|the|this|on|if|\(.*?\))(\s|$)/i;
// Answers in a conjugated / sentence-final form.
const SENTENCE_END = /(ました|ません|ましょう|ですか|です|ています|ましたか)$/u;

type Classified =
  | { kind: "word"; word: Omit<ImportWord, "tags" | "external_id"> }
  | { kind: "basic"; unsure?: string };

function classifyRead(q: string, a: string): Classified {
  const kanji = q.slice("Read: ".length).trim();
  const m = new RegExp(`^([${KANA}]+)\\s*[:：]\\s*(.+)$`, "u").exec(a.trim());
  if (!reKanjiWord.test(kanji) || !m) return { kind: "basic", unsure: "Read card not in 'kana: meaning' form" };
  const kana = m[1]!;
  if (!readingMatches(kanji, kana)) return { kind: "basic", unsure: `reading ${kana} does not line up with ${kanji}` };
  const g = splitGloss(m[2]!);
  return { kind: "word", word: { kanji, kana, ...g } };
}

function classifySay(q: string, a: string): Classified {
  let gloss = q.slice("Say in Japanese: ".length).trim();
  const answer = a.trim();
  const am = new RegExp(`^([${KANA}]+)(?:\\s*\\(([^()]*)\\))?(?:\\s*;\\s*([^;]+))?$`, "u").exec(answer);
  // Not a single kana token (spaces, punctuation, several items): a phrase or sentence.
  if (!am) return { kind: "basic" };
  const kana = am[1]!;
  const notes: string[] = [];
  const g = splitGloss(gloss);
  gloss = g.meaning;
  if (g.notes) notes.push(g.notes);

  const why = [
    /[/?!:;"]/.test(gloss) && "gloss has / ? ! : ;",
    reJapanese.test(gloss) && "gloss contains Japanese",
    PHRASE_START.test(gloss) && "gloss reads like a phrase",
    gloss.replace(/\(.*?\)/g, "").split(",").some((p) => p.trim().split(/\s+/).length > 4) && "gloss is long",
    SENTENCE_END.test(kana) && "answer is a conjugated form",
    kana.includes("・") && "answer contains ・",
  ].filter(Boolean);
  if (why.length) return { kind: "basic", unsure: `single-token answer kept as basic (${why.join(", ")})` };

  let kanji: string | undefined;
  if (am[2]) {
    const parts = am[2].split(/\s*;\s*/);
    const first = parts[0]!.trim();
    if (reKanjiWord.test(first)) {
      if (!readingMatches(first, kana)) return { kind: "basic", unsure: `kanji ${first} does not line up with ${kana}` };
      kanji = first;
      parts.shift();
    }
    if (parts.length) notes.push(parts.join("; "));
  }
  if (am[3]) notes.push(am[3].trim());
  return { kind: "word", word: { ...(kanji ? { kanji } : {}), kana, meaning: gloss, ...(notes.length ? { notes: notes.join("; ") } : {}) } };
}

function classifyOne(c: KulikoCard): Classified {
  const q = c.question.trim();
  if (q.startsWith("Read: ")) return classifyRead(q, c.answer);
  if (q.startsWith("Say in Japanese: ")) return classifySay(q, c.answer);
  return { kind: "basic" };
}

/** "to wear (a hat)", "Wear" -> {"wear"}; used to decide whether two cards are the same word. */
function meaningKeys(m: string): Set<string> {
  return new Set(
    m
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .split(/[,;]/)
      .map((s) => s.replace(/^\s*(to|a|an|the)\s+/, "").replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}
const overlaps = (a: string, b: string) => {
  const kb = meaningKeys(b);
  return [...meaningKeys(a)].some((k) => kb.has(k));
};

function mergeInto(target: ImportWord, w: ImportWord) {
  target.tags = [...new Set([...target.tags, ...w.tags])];
  const extra = (target.extra ??= {});
  extra.kuliko_ids = [...(extra.kuliko_ids ?? []), w.external_id, ...(w.extra?.kuliko_ids ?? [])];
  const known = new Set([target.meaning, ...(extra.alt_meanings ?? [])].map((m) => m.toLowerCase()));
  for (const m of [w.meaning, ...(w.extra?.alt_meanings ?? [])]) {
    if (!known.has(m.toLowerCase())) (extra.alt_meanings ??= []).push(m), known.add(m.toLowerCase());
  }
  if (w.notes && w.notes !== target.notes) target.notes = target.notes ? `${target.notes}; ${w.notes}` : w.notes;
  if (!target.kanji && w.kanji) target.kanji = w.kanji;
  target.kuliko = [...(target.kuliko ?? []), ...(w.kuliko ?? [])];
}

const wordKey = (w: { kanji?: string | null; kana: string }) => `${w.kanji ?? ""}|${w.kana}`;

export function classify(cards: KulikoCard[]): ClassifyResult {
  const words: ImportWord[] = [];
  const basic: ImportBasic[] = [];
  const unsure: string[] = [];
  const merges: string[] = [];
  const show = (c: KulikoCard) => `${c.question} => ${c.answer}`;

  for (const c of cards) {
    const tags = [...new Set((c.tags ?? []).map((t) => t.trim()).filter(Boolean))];
    const r = classifyOne(c);
    if (r.kind === "basic") {
      basic.push({ front: c.question.trim(), back: c.answer.trim(), tags, external_id: c.id, kuliko: [show(c)] });
      if (r.unsure) unsure.push(`[basic] ${show(c)}  -- ${r.unsure}`);
      continue;
    }
    const w: ImportWord = { ...r.word, tags, external_id: c.id, kuliko: [show(c)] };
    // Same (kanji, kana): always the same note (that's the DB uniqueness rule).
    let target = words.find((x) => wordKey(x) === wordKey(w));
    // Same reading, one side without kanji, overlapping meaning: the same word
    // written two ways (かいしゃ "office, company" vs 会社 "company, office").
    if (!target) {
      target = words.find(
        (x) => x.kana === w.kana && (!x.kanji || !w.kanji) && overlaps(x.meaning, w.meaning),
      );
      // Don't let a kana-only note pick up a kanji that another note already has.
      if (target && !target.kanji && w.kanji && words.some((x) => wordKey(x) === wordKey(w))) target = undefined;
      if (target) unsure.push(`[merged by reading+meaning] ${target.kuliko?.[0]}  <=  ${show(c)}`);
    }
    if (target) {
      mergeInto(target, w);
      merges.push(`${target.kanji ?? ""}${target.kanji ? " " : ""}${target.kana}: ${target.external_id} + ${w.external_id}`);
    } else {
      words.push(w);
    }
  }
  return { words, basic, unsure, merges };
}

// ---------- SQL ----------

export const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sqlValue = (v: string | number | null | undefined) =>
  v == null ? "NULL" : typeof v === "number" ? String(v) : sqlString(v);

/** UUID-shaped id derived from the inputs, so the same import always gets the same ids. */
export function stableId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function toSql(file: ImportFile, opts: { email: string; deck?: string; now?: number }): string {
  const email = opts.email.trim();
  const deck = (opts.deck ?? "Japanese").trim();
  const now = opts.now ?? Date.now();
  const user = `(SELECT id FROM users WHERE email = ${sqlString(email)})`;
  const deckId = `(SELECT id FROM decks WHERE user_id = ${user} AND name = ${sqlString(deck)})`;
  const s = emptyState(now);
  const out: string[] = [
    `-- flash-mcp import from Kuliko for ${email.replace(/\n/g, " ")}, deck "${deck.replace(/\n/g, " ")}"`,
    `-- ${file.words.length} words, ${file.basic.length} basic notes. Safe to run more than once.`,
    // Plain upsert (not OR IGNORE): fails loudly with NOT NULL if the user doesn't exist.
    `INSERT INTO decks (id, user_id, name, description, default_directions, created_at) VALUES (${sqlString(stableId(email, "deck", deck))}, ${user}, ${sqlString(deck)}, NULL, NULL, ${now}) ON CONFLICT DO NOTHING;`,
  ];

  const emit = (
    externalId: string,
    faces: { type: "word" | "basic"; kanji?: string | null; kana?: string | null; meaning?: string | null; front?: string | null; back?: string | null },
    enabled: readonly Direction[],
    notes: string | undefined,
    extra: Record<string, unknown> | undefined,
    tags: string[],
  ) => {
    const id = stableId(email, "note", externalId);
    out.push(
      `INSERT OR IGNORE INTO notes (id, user_id, deck_id, type, kanji, kana, meaning, front, back, enabled_directions, notes, extra, external_id, created_at, updated_at) VALUES (${[
        sqlString(id), user, deckId, sqlString(faces.type),
        sqlValue(faces.kanji), sqlValue(faces.kana), sqlValue(faces.meaning), sqlValue(faces.front), sqlValue(faces.back),
        sqlString(JSON.stringify(enabled)), sqlValue(notes?.trim() || null),
        sqlValue(extra && Object.keys(extra).length ? JSON.stringify(extra) : null),
        sqlString(externalId), now, now,
      ].join(", ")});`,
    );
    // Tags and cards hang off the note row; if the note was skipped (e.g. the
    // word already existed under another id) these select nothing.
    for (const t of [...new Set([...tags, "kuliko"].map((x) => x.trim()).filter(Boolean))]) {
      out.push(`INSERT OR IGNORE INTO note_tags (note_id, tag) SELECT id, ${sqlString(t)} FROM notes WHERE id = ${sqlString(id)};`);
    }
    for (const d of activeDirections(faces, enabled)) {
      out.push(
        `INSERT OR IGNORE INTO cards (id, user_id, note_id, direction, suspended, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) SELECT ${[
          sqlString(stableId(email, "card", externalId, d)), "user_id", "id", sqlString(d), 0,
          s.due, s.stability, s.difficulty, s.elapsed_days, s.scheduled_days, s.learning_steps, s.reps, s.lapses, s.state,
          sqlValue(s.last_review), now,
        ].join(", ")} FROM notes WHERE id = ${sqlString(id)};`,
      );
    }
  };

  const seen = new Set<string>();
  for (const w of file.words) {
    const kana = w.kana?.trim();
    const meaning = w.meaning?.trim();
    const kanji = w.kanji?.trim() || null;
    if (!kana || !meaning || !w.external_id) throw new Error(`word needs kana, meaning, external_id: ${JSON.stringify(w)}`);
    const key = wordKey({ kanji, kana });
    if (seen.has(key)) throw new Error(`duplicate word ${key} in import file; merge them first`);
    seen.add(key);
    emit(w.external_id, { type: "word", kanji, kana, meaning }, DEFAULT_WORD_DIRECTIONS, w.notes, w.extra, w.tags ?? []);
  }
  for (const b of file.basic) {
    const front = b.front?.trim();
    const back = b.back?.trim();
    if (!front || !back || !b.external_id) throw new Error(`basic needs front, back, external_id: ${JSON.stringify(b)}`);
    emit(b.external_id, { type: "basic", front, back }, DEFAULT_BASIC_DIRECTIONS, b.notes, undefined, b.tags ?? []);
  }
  return out.join("\n") + "\n";
}

// ---------- CLI ----------

function usage(): never {
  console.error(
    "usage:\n  import-kuliko.ts classify <kuliko-raw.json> <import.json>\n  import-kuliko.ts sql <import.json> --email <email> [--deck <name>] > import.sql",
  );
  process.exit(2);
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flags = new Map<string, string>();
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) flags.set(a.slice(2), rest[++i] ?? usage());
    else pos.push(a);
  }
  if (cmd === "classify" && pos.length === 2) {
    const r = classify(parseKulikoDump(readFileSync(pos[0]!, "utf8")));
    const file: ImportFile = { words: r.words, basic: r.basic };
    writeFileSync(pos[1]!, JSON.stringify(file, null, 2) + "\n");
    const withKanji = r.words.filter((w) => w.kanji).length;
    console.log(`wrote ${pos[1]}`);
    console.log(`words: ${r.words.length} (${withKanji} with kanji, ${r.words.length - withKanji} kana-only)`);
    console.log(`basic: ${r.basic.length}`);
    console.log(`merged duplicates: ${r.merges.length}`);
    r.merges.forEach((m) => console.log(`  ${m}`));
    console.log(`unsure: ${r.unsure.length}`);
    r.unsure.forEach((u) => console.log(`  ${u}`));
  } else if (cmd === "sql" && pos.length === 1) {
    const email = flags.get("email") ?? usage();
    const file = JSON.parse(readFileSync(pos[0]!, "utf8")) as ImportFile;
    process.stdout.write(toSql(file, { email, deck: flags.get("deck") }));
  } else {
    usage();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
