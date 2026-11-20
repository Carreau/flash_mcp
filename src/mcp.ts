import { McpServer } from "@modelcontextprotocol/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { ALL_DIRECTIONS, ASK_MODES, BASIC_DIRECTIONS, WORD_DIRECTIONS } from "./model/directions";
import { FALLBACK_TZ, addLocalTimes, isValidTz } from "./model/time";
import { FIELD_MAX, Store, UserError } from "./db/store";

// Length limits keep every value (and every set-based insert chunk) far below D1's limits.
const text = () => z.string().max(FIELD_MAX);
const short = () => z.string().max(200);
const EXTRA_MAX = 4000;
const extra = () =>
  z
    .record(z.string(), z.unknown())
    .refine((v) => JSON.stringify(v).length <= EXTRA_MAX, `extra must be at most ${EXTRA_MAX} characters as JSON`)
    .nullish();
const tags = () => z.array(short()).max(50);

const direction = z.enum(ALL_DIRECTIONS as unknown as [string, ...string[]]);
const wordDirection = z.enum(WORD_DIRECTIONS);
const rating = z.enum(["again", "hard", "good", "easy"]);
const source = z.enum(["chat", "lesson", "self", "ui"]);
const onConflict = z
  .enum(["skip", "update", "merge"])
  .optional()
  .describe(
    "When the word already exists: skip (default; same kanji+kana); update (meaning/notes/trap set, extra and tags merged); " +
      "merge (switch on this word's directions (given, else the deck's defaults) on the existing note, merge tags, set notes/trap only if empty; " +
      "a word given with kana only also merges into the single existing note with that kana, e.g. りょうしん → 両親/りょうしん in another deck; several matches → status 'ambiguous' with candidates). " +
      "The schedule is always kept.",
  );
const furiganaNote =
  "Furigana: write {今日|きょう} in front/back/notes/trap/extra.example; {漢字} alone takes the reading of the single word note written 漢字 (else kept bare and listed in furigana_problems).";
const scheduleSchema = z
  .object({
    state: z.enum(["new", "learning", "review", "relearning"]).optional().describe("Default review"),
    due: z.string().describe("Next due time (ISO, or local 'YYYY-MM-DD HH:mm')"),
    last_review: z.string().optional().describe("Last review in the other tool (default: due - stability, at most now)"),
    stability: z.number().positive().max(36500).optional().describe("Days (default: the interval last_review → due)"),
    difficulty: z.number().min(1).max(10).optional().describe("FSRS difficulty 1-10 (default 5)"),
    reps: z.number().int().min(0).optional(),
    lapses: z.number().int().min(0).optional(),
  })
  .describe("Schedule carried over from another tool, so imported cards keep their interval instead of restarting");
const askMode = z
  .enum(ASK_MODES)
  .optional()
  .describe(
    "grouped (default): one prompt asks every due face for the shown face (show 犬 → 'いぬ, dog'). " +
      "same_script: never mixes a Japanese answer (kana/kanji) with a meaning answer in one prompt; e.g. show 犬 → prompt 1 asks the kana, prompt 2 (same face shown) asks the meaning. Best for phone answers (no keyboard switching). " +
      "single: one card per prompt.",
  );
const trap = text()
  .nullish()
  .describe("Short pitfall for this note, e.g. 'ともだちに, not を' or '午 noon, not 牛 cow'. Shown only AFTER the learner answered.");

function tzSchema() {
  return z.string().optional().describe("IANA time zone for the *_local times in the output and for reviewed_at/since given without offset (default: the learner's zone)");
}

/**
 * Date part of server_version: bump on release. The rest is tools_hash (see below), so a changed
 * tool schema always changes server_version without anyone remembering. claude.ai caches
 * tools/list until the connector is reconnected, and this stateless server can't push
 * tools/list_changed, so session_start reports both and the instructions say what to do.
 */
export const SERVER_DATE = "2026-11-22";

/** Stable JSON: object keys sorted, so the hash doesn't depend on property order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

/** First 12 hex chars of the sha-256 of the tool definitions (names, descriptions, input JSON schemas), order-independent. */
export async function hashToolDefs(defs: readonly ToolDef[]): Promise<string> {
  const sorted = [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const bytes = new TextEncoder().encode(stableJson(sorted));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** Tool definitions as tools/list lists them (input schemas as JSON Schema). */
export function listToolDefs(server: McpServer): ToolDef[] {
  const reg = (server as unknown as {
    _registeredTools: Record<string, { description?: string; inputSchema?: z.ZodType; annotations?: unknown; enabled: boolean }>;
  })._registeredTools;
  return Object.entries(reg)
    .filter(([, t]) => t.enabled)
    .map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema ? z.toJSONSchema(t.inputSchema, { io: "input" }) : { type: "object", properties: {} },
      annotations: t.annotations,
    }));
}

const reviewFlags = {
  verified: z
    .boolean()
    .optional()
    .describe(
      "false = judged correct but the reading couldn't be checked (the answer was the shown kanji, or another kanji with the same reading from IME, e.g. 見ず for 水). Schedules like a normal review. Default true",
    ),
  early: z
    .boolean()
    .optional()
    .describe("true = the learner volunteered this answer for a card that wasn't asked/due: kept in history, schedule NOT changed"),
};

const feedback = text()
  .nullish()
  .describe("Short feedback for the learner on this answer (shown in the review UI on this card and in their feedback inbox), e.g. the corrected sentence");

const DEFAULT_TZ = (() => {
  const t = (env as unknown as { DEFAULT_TZ?: string }).DEFAULT_TZ;
  return t && isValidTz(t) ? t : FALLBACK_TZ;
})();

const INSTRUCTIONS = `Personal flashcards with spaced repetition (FSRS), built for Japanese. You are usually acting as the learner's Japanese teacher.

Decks are referenced by exact, case-sensitive name and are created automatically on first use, so call list_decks first and reuse existing names.

Model: a *note* is what you learn; each note has one *card* per direction, each with its own schedule.
- word notes have up to three faces: kanji, kana, meaning. Directions: ${WORD_DIRECTIONS.join(", ")}.
  Defaults: kanji>kana (reading), kanji>meaning, kana>meaning, meaning>kana (production).
  A word without kanji only gets kana>meaning and meaning>kana.
  Each deck has default_directions for NEW notes (e.g. a kanji-reading deck with only kanji>kana + kanji>meaning); change them with update_deck.
- basic notes (sentences, grammar, anything else): front>back, optionally back>front.

Session workflow (one call at the start, one at the end):
1. session_start(decks?, kind) → session_id, per-deck due counts, what went wrong since last time (struggled_since), hardest notes, and the first due prompts. Use it to plan the lesson.
2. Quiz.
   - Text session: use the due prompts (or get_due) and quiz live. Show the prompt face ("show"), ask the "ask" faces, judge each part separately against "accept". Rate as you go with rate, or collect ratings for session_end.
   - Voice lesson: you cannot call tools while talking. Keep a log of every word asked: kanji/kana, direction, rating, approximate time, and new words / failed sentences.
3. session_end(session_id, reviews[], add_words?, add_basic?) → writes everything in ONE atomic batch. Reviews may name the card by content ({kanji?, kana, direction, rating} or {front}) instead of card_id; unknown words are created when you give meaning. Read "problems" in the result: ambiguous or unmatched entries were skipped, fix them with card_id or kanji and rate them via rate.

Prompts: get_due ask_mode "grouped" (default) asks all faces at once; "same_script" never mixes a Japanese answer with a meaning answer (best when the learner answers on a phone); "single" asks one card at a time. With same_script/single, several prompts may share the same shown face: ask them back-to-back. Reverse directions are held back for sibling_gap_hours so answers don't leak.
After the answer (never with the prompt): show the item's after_answer.trap and after_answer.notes (the trap is the specific pitfall to remember).
Kana faces: only the reading matters. Answers in romaji (neko) or kanji produced by IME completion are acceptable: rate them as correct and mention it briefly. Each ask entry lists "accept"; "accept_with_warning" (e.g. the shown kanji itself, for kanji>kana, which the IME produces from the typed reading) is also correct, but the reading couldn't be verified: rate it as correct and say so in one short sentence.
Rate honestly: again = not recalled, hard = recalled with effort, good = recalled, easy = instant.
Unverifiable readings: when a kanji>kana answer is the shown kanji itself (accept_with_warning) or a different kanji with the same reading produced by IME (e.g. 見ず for 水), count it as correct but send verified: false with the rating.
Volunteered answers: when the learner also answers faces whose cards weren't asked (or aren't due), either leave them out or send them with early: true (preferred: kept in history, schedule unchanged). Never rate them as normal reviews.
Counts: due_reviews = available now + held_back (held back for a few hours after a sibling direction was reviewed). held_back.cards lists only held-back due REVIEWS (with "until"); held-back new cards are just a count (held_back.new_cards). Don't tell the learner cards are missing when they are only held back.

Times: every timestamp is ISO UTC plus a "<field>_local" version in the learner's time zone (tz parameter, default ${DEFAULT_TZ}). reviewed_at accepts ISO with offset (2026-11-20T15:04+01:00) or local "YYYY-MM-DD HH:mm" read in tz. Past times are fine (lesson ratings entered later replay the history).

Versions: session_start returns server_version and tools_hash. If server_version/tools_hash differs from the one seen earlier in this conversation or in your notes, the tool schemas changed: ask the user to reconnect the connector (Settings → Connectors) so the new fields become available. Same if a tool these instructions mention seems missing.
Unclosed sessions: session_start auto-closes the learner's sessions open for over 12 h and lists younger ones as open_sessions; close or ignore them. "since" starts at the latest end of any closed session.

Grade later: the learner can type an answer in the phone UI and press "Grade later" (free answers: sentences, "Say in Japanese" builds). That card is then neither asked nor counted as due until graded. session_start returns pending_grading per deck; get_pending_grading lists them (faces, accept, trap, notes, the learner's answer, answered_at). Grade each with rate (or session_end): card_id + rating; reviewed_at, answer and source default to the waiting answer's, so you can omit them. Add "feedback" (a short correction or encouragement, e.g. the natural sentence) whenever useful: the learner sees it in the UI.

Furigana: in front, back, notes, trap and extra.example write {今日|きょう} (base|reading) over words the learner may not read yet. {漢字} without a reading takes the reading of the one word note whose kanji face is exactly that text; none or several → kept bare and returned in furigana_problems (then write the reading yourself). Readings change inside compounds (今日 きょう, 日 ひ/にち), so prefer explicit readings. Prompts return the raw text (with markup) plus display (readings in brackets, only those still needed: a reading is hidden once the word's kanji>kana card is in review with stability ≥ the learner's furigana_known_days setting) and ruby spans {text, reading, show}. Show the asked face (e.g. the Japanese model answer of a production card) only AFTER the learner answered. accept compares without markup; the kana reading of the whole sentence is accepted too.

Editing: add_words with on_conflict "update" upserts, "merge" adds directions to an existing note (a kana-only word merges into the note with that kana, e.g. in another deck: no need to call lookup first); update_note / update_notes merge tags (replace_tags to replace, remove_tags to remove); bulk_import for large lists; lookup to check which words already exist (matching is global; deck only flags deck_mismatch unless deck_only: true). Imported cards: bulk_import rows (or set_schedule for existing cards) take a schedule from the other tool so they keep their interval. Only delete notes when the learner explicitly asks.`;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
}

/** Run a tool, add *_local times in the requested zone, turn UserErrors into tool errors. */
function wrap<A extends object>(fn: (args: A, tz: string) => Promise<unknown>) {
  return async (args: A) => {
    try {
      const tz = (args as { tz?: string }).tz || DEFAULT_TZ;
      if (!isValidTz(tz)) throw new UserError(`Unknown time zone "${tz}" (use an IANA name like Europe/Paris)`);
      return ok(addLocalTimes(await fn(args, tz), tz));
    } catch (e) {
      if (e instanceof UserError) return { content: [{ type: "text" as const, text: e.message }], isError: true };
      throw e;
    }
  };
}

const wordFields = {
  kanji: short().nullish().describe("Omit for kana-only words"),
  kana: short().describe("Reading in hiragana/katakana"),
  meaning: text(),
  notes: text().nullish().describe("Explanation/usage; shown after the answer"),
  trap,
  tags: tags().optional(),
  directions: z.array(wordDirection).optional().describe("Override the deck's default directions for this new note"),
  extra: extra().describe("alt_kana / alt_kanji / alt_meanings arrays, pos, example"),
};
const basicFields = {
  front: text(),
  back: text(),
  accept: z.array(text()).max(20).optional().describe("Other correct answers for the back (stored as extra.alt_backs), e.g. another natural phrasing"),
  reversible: z.boolean().optional().describe("Also create a back>front card"),
  notes: text().nullish(),
  trap,
  tags: tags().optional(),
  extra: extra(),
};
const noteEdit = {
  deck: short().optional().describe("Move to this deck (created if it doesn't exist)"),
  kanji: short().nullish().describe("null removes the kanji (its cards are suspended)"),
  kana: short().optional(),
  meaning: text().optional(),
  front: text().optional(),
  back: text().optional(),
  notes: text().nullish(),
  trap,
  extra: extra().describe("Replaces extra"),
  accept: z.array(text()).max(20).optional().describe("Basic notes: other correct backs (sets extra.alt_backs)"),
  tags: tags().optional().describe("Added to the existing tags (or replaces them with replace_tags: true)"),
  replace_tags: z.boolean().optional().describe("tags replaces all existing tags"),
  remove_tags: tags().optional(),
};

export function buildServer(store: Store): McpServer {
  const server = new McpServer({ name: "flash-mcp", version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, store);
  return server;
}

function registerTools(server: McpServer, store: Store): void {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    "session_start",
    {
      description:
        "Open a study session (call once at the start of every lesson/quiz). Returns session_id (pass it to session_end), and per deck: due counts per direction " +
        "(due reviews, new available, learning), cards rated again/hard since `since` (default: the latest end of any closed session, auto-closed ones included, else 7 days ago) with their latest rating, " +
        "the struggling notes (lapses, again/hard since `since`, or fragile after 2+ reviews; up to 15, often fewer), reviews since grouped by source (chat/lesson/self/ui), and the first due prompts (like get_due). " +
        "Counts: decks[].due.due_reviews = available_now + held_back (cards held back for a few hours because a sibling direction was just reviewed). " +
        "server_version / tools_hash: compare with earlier calls in this conversation (see instructions). " +
        "open_sessions: sessions younger than 12 h that were never closed (session_id, started_at, age_hours, kind): close them with session_end (pass their reviews) or ignore them; older unclosed sessions are auto-closed here (closed at their last logged review) and a later session_end on one is still accepted. " +
        "recently_closed_sessions: sessions closed in the last 24 h with ended_by (session_end | auto) and ended_reason. " +
        "pending_grading (total and per deck): answers the learner typed in the UI with 'Grade later'; read them with get_pending_grading and grade them. Cards waiting for grading are not counted as due.",
      inputSchema: z.object({
        decks: z.array(short()).max(50).optional().describe("Deck names; all decks when omitted"),
        kind: z.enum(["text", "voice"]).optional().describe("voice: reviews in session_end default to source 'lesson'; text: 'chat'"),
        since: z.string().optional().describe("Override the 'since last time' window start (ISO, or local 'YYYY-MM-DD HH:mm')"),
        include_due: z.boolean().optional().describe("Include due prompts (default true)"),
        due_limit: z.number().int().min(1).max(100).optional().describe("Max notes in the due list (default 20)"),
        ask_mode: askMode,
        tz: tzSchema(),
      }),
      annotations: rw,
    },
    wrap(async (a, tz) => ({ server_version: SERVER_VERSION, tools_hash: TOOLS_HASH, ...(await store.sessionStart({ ...a, tz })) })),
  );

  server.registerTool(
    "session_end",
    {
      description:
        "Close a study session (also accepted for one that session_start auto-closed after 12 h; ending twice is rejected) and write everything in ONE atomic batch: add_words / add_basic first, then all reviews, then the session's end time (used as `since` by the next session_start). " +
        "Each review names its card by card_id, or by content: a word {kanji?, kana, direction, rating} (kanji+kana must match exactly; kana alone matches the kana-only note or the single note with that kana; deck narrows), " +
        "or a basic note {front, direction?}. An unknown word is created first when meaning is given (deck's default directions plus the reviewed direction), an unknown basic note when back is given. " +
        "Several reviews of one card apply in reviewed_at order (older than its last review → history replayed). " +
        "Validation errors (bad rating/time/direction, missing kana/direction, unknown session) abort everything. Ambiguous or unmatched entries are skipped and listed in `problems` with candidates (note_id, kanji, kana, meaning): fix them with rate. " +
        "A review of a card waiting for grading grades it (reviewed_at/answer/source default to the waiting answer's). feedback is shown to the learner. " +
        "Retries: the exact same call again returns duplicate_request: true and writes nothing. A session already closed by session_end is refused (the error says when and what it saved) unless append: true, which adds this batch and skips reviews identical to ones already saved. " +
        `${furiganaNote} ` +
        "Returns per review the rating applied, next due and interval_days (next due − reviewed_at), notes created, and problems.",
      inputSchema: z.object({
        session_id: z.string(),
        reviews: z
          .array(
            z.object({
              card_id: z.string().optional().describe("Exact card (from get_due/session_start); otherwise identify by content"),
              deck: short().optional().describe("Narrows matching; deck for creating an unknown word"),
              kanji: short().nullish(),
              kana: short().optional(),
              meaning: text().optional().describe("Needed to create an unknown word; also disambiguates homophones"),
              front: text().optional().describe("Basic note front (instead of kana)"),
              back: text().optional().describe("Needed to create an unknown basic note"),
              direction: direction.optional().describe("Required for words, e.g. kanji>kana; basic defaults to front>back"),
              rating,
              reviewed_at: z.string().optional().describe("When it was asked: ISO with offset, or local 'YYYY-MM-DD HH:mm' in tz. Default now"),
              answer: text().nullish().describe("What the learner actually said/typed"),
              source: source.optional().describe("Default: 'lesson' for voice sessions, else 'chat'"),
              notes: text().nullish().describe("Only used when the note is created"),
              trap,
              tags: tags().optional().describe("Only used when the note is created"),
              feedback,
              ...reviewFlags,
            }),
          )
          .max(300)
          .optional(),
        add_words: z
          .array(z.object({ deck: short().optional(), ...wordFields }))
          .max(200)
          .optional()
          .describe("New words from the lesson (same as add_words)"),
        add_basic: z
          .array(z.object({ deck: short().optional(), ...basicFields }))
          .max(200)
          .optional()
          .describe("New sentences/grammar, e.g. failed sentences (same as add_basic)"),
        deck: short().optional().describe("Default deck for created notes (else the session's single deck, else your only deck)"),
        on_conflict: onConflict,
        source: source.optional().describe("Default source for all reviews"),
        append: z.boolean().optional().describe("Add this batch to a session that a session_end already closed (identical reviews skipped)"),
        tz: tzSchema(),
      }),
      annotations: rw,
    },
    wrap(async ({ session_id, ...a }, tz) => store.sessionEnd(session_id, { ...a, tz } as never)),
  );

  server.registerTool(
    "list_decks",
    { description: "List decks with note, card and due counts and their default directions.", inputSchema: z.object({ tz: tzSchema() }), annotations: ro },
    wrap(async () => store.listDecks()),
  );

  server.registerTool(
    "create_deck",
    {
      description:
        "Create a deck (decks are also created automatically on first add). default_directions are the directions NEW word notes in this deck get, " +
        "e.g. a kanji-reading deck with only ['kanji>kana', 'kanji>meaning']. Default: kanji>kana, kanji>meaning, kana>meaning, meaning>kana. Change later with update_deck.",
      inputSchema: z.object({
        name: short(),
        description: text().optional(),
        default_directions: z.array(wordDirection).optional(),
      }),
      annotations: rw,
    },
    wrap(async (a) => store.createDeck(a.name, a.description, a.default_directions)),
  );

  server.registerTool(
    "update_deck",
    {
      description:
        "Change a deck's description or default_directions. Defaults apply to notes added later. apply_to_existing: true also sets the directions of every existing word note in the deck " +
        "and reconciles cards: directions switched off are suspended (history kept, never deleted), switched-on ones are created or reactivated.",
      inputSchema: z.object({
        name: short(),
        default_directions: z.array(wordDirection).min(1).optional(),
        description: text().nullish(),
        apply_to_existing: z.boolean().optional(),
      }),
      annotations: rw,
    },
    wrap(async ({ name, ...a }) => store.updateDeck(name, a as never)),
  );

  server.registerTool(
    "add_words",
    {
      description:
        "Add Japanese vocabulary as word notes. kana is the reading (hiragana/katakana); kanji is optional (omit for kana-only words). " +
        "New notes get the deck's default_directions (see create_deck/update_deck) unless `directions` is given. " +
        "Existing words (same kanji+kana) are skipped, updated with on_conflict 'update', or merged with 'merge' (directions switched on; a kana-only word merges into the single note with that kana, e.g. in another deck). " +
        `trap: a short pitfall shown after the answer. ${furiganaNote}`,
      inputSchema: z.object({
        deck: short(),
        words: z.array(z.object(wordFields)).min(1).max(100),
        on_conflict: onConflict,
      }),
      annotations: rw,
    },
    wrap(async (a, tz) => store.addWords(a.deck, a.words, { on_conflict: a.on_conflict, tz })),
  );

  server.registerTool(
    "add_basic",
    {
      description:
        "Add free-form front/back notes (sentences, grammar, phrases). reversible adds a back>front card. " +
        "A note with the same front and back as an existing one (compared without furigana markup) is not duplicated. accept: other correct answers. " +
        furiganaNote,
      inputSchema: z.object({
        deck: short(),
        cards: z.array(z.object(basicFields)).min(1).max(100),
      }),
      annotations: rw,
    },
    wrap(async (a, tz) => store.addBasic(a.deck, a.cards, { tz })),
  );

  server.registerTool(
    "bulk_import",
    {
      description:
        "Import many words at once (up to 1000 rows, e.g. a vocabulary list). Either rows (JSON objects) or csv (text with a header line; columns deck, kanji, kana, meaning, notes, tags, trap; tags separated by ; or |). " +
        "Rows with front+back become basic notes. Rows without kana+meaning (or without a deck) are reported in errors; the rest is imported. Same duplicate rules as add_words (on_conflict, incl. merge). " +
        "Per row: directions (word or basic directions; CSV: separated by ;), accept (basic: other correct backs), schedule (another tool's schedule for the new cards, so they keep their interval; CSV: JSON). " +
        `Without schedule new cards start as new. ${furiganaNote}`,
      inputSchema: z.object({
        deck: short().optional().describe("Default deck for rows without one"),
        rows: z
          .array(
            z.object({
              deck: short().optional(),
              kanji: short().nullish(),
              kana: short().nullish(),
              meaning: text().nullish(),
              notes: text().nullish(),
              tags: z.union([tags(), text()]).optional(),
              trap: text().nullish(),
              front: text().nullish(),
              back: text().nullish(),
              directions: z.array(direction).max(8).optional().describe("This row's directions (else the deck's defaults; basic: front>back)"),
              accept: z.array(text()).max(20).optional().describe("Basic rows: other correct backs"),
              schedule: scheduleSchema.optional(),
            }),
          )
          .max(1000)
          .optional(),
        csv: z.string().max(1_500_000).optional().describe("CSV text with a header line (at most ~1.5 MB)"),
        on_conflict: onConflict,
        tz: tzSchema(),
      }),
      annotations: rw,
    },
    wrap(async (a, tz) => store.bulkImport({ ...a, tz } as never)),
  );

  server.registerTool(
    "lookup",
    {
      description:
        "Check which words already exist (up to 500 per call; one call for a whole lesson's vocabulary). Per word: found, note_id, meaning, trap, and each card's direction, state, last rating, next due, lapses, suspended. " +
        "Matching: kanji+kana exact; kana alone matches the kana-only note or the single note with that kana, otherwise 'ambiguous' with candidates. " +
        "Matching is global: deck only prefers that deck and flags deck_mismatch when the word is found elsewhere; deck_only: true restricts matching to the deck.",
      inputSchema: z.object({
        deck: short().optional(),
        deck_only: z.boolean().optional().describe("Only notes in `deck` can match"),
        words: z.array(z.object({ kanji: short().nullish(), kana: short() })).min(1).max(500),
        tz: tzSchema(),
      }),
      annotations: ro,
    },
    wrap(async ({ tz: _, ...a }) => store.lookup(a)),
  );

  server.registerTool(
    "search_notes",
    {
      description: "Find notes by text (matches kanji, kana, meaning, front, back, notes), deck, tag or type. Returns cards with their schedule.",
      inputSchema: z.object({
        query: z.string().optional(),
        deck: short().optional(),
        tag: z.string().optional(),
        type: z.enum(["word", "basic"]).optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 50, max 100; page with offset"),
        offset: z.number().int().min(0).optional(),
        tz: tzSchema(),
      }),
      annotations: ro,
    },
    wrap(async ({ tz: _, ...a }) => store.searchNotes(a)),
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Edit a note. Changing faces updates its cards: adding kanji to a kana-only word creates the kanji cards; removing a face suspends the cards that need it (history is kept). " +
        "tags are MERGED into the existing tags; use replace_tags: true to replace them, remove_tags to remove some. trap is shown after the answer. " +
        "enabled_directions lists directions with an active card; switched-on directions needing a missing face are in waiting_for_face. " +
        furiganaNote,
      inputSchema: z.object({ note_id: z.string(), ...noteEdit, tz: tzSchema() }),
      annotations: rw,
    },
    wrap(async ({ note_id, tz: _, ...fields }) => store.updateNote(note_id, fields)),
  );

  server.registerTool(
    "update_notes",
    {
      description: "Edit several notes in one atomic call (same fields and tag semantics as update_note). Any error aborts all edits.",
      inputSchema: z.object({
        updates: z.array(z.object({ note_id: z.string(), ...noteEdit })).min(1).max(100),
        tz: tzSchema(),
      }),
      annotations: rw,
    },
    wrap(async (a) => store.updateNotes(a.updates)),
  );

  server.registerTool(
    "set_directions",
    {
      description: `Switch directions on or off for a note. Off = card suspended, history kept. Word: ${WORD_DIRECTIONS.join(", ")}. Basic: ${BASIC_DIRECTIONS.join(", ")}.`,
      inputSchema: z.object({
        note_id: z.string(),
        enable: z.array(direction).optional(),
        disable: z.array(direction).optional(),
        tz: tzSchema(),
      }),
      annotations: rw,
    },
    wrap(async (a) => store.setDirections(a.note_id, a.enable as never, a.disable as never)),
  );

  server.registerTool(
    "delete_note",
    {
      description:
        "Permanently delete notes with all their cards and review history. ONLY when the learner explicitly asks to delete; to pause a card use set_directions instead. " +
        "Requires confirm: true. Returns what was deleted (faces, card and review counts).",
      inputSchema: z.object({
        note_ids: z.array(z.string()).min(1).max(100).optional(),
        note_id: z.string().optional().describe("Single note (older form of note_ids)"),
        confirm: z.boolean().describe("Must be true: the learner explicitly asked for this deletion"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    wrap(async (a) => {
      const ids = [...(a.note_ids ?? []), ...(a.note_id ? [a.note_id] : [])];
      return store.deleteNotes(ids, { confirm: a.confirm });
    }),
  );

  server.registerTool(
    "get_due",
    {
      description:
        "Get cards due for review, grouped per note into prompts: show the `show` face and ask for the faces in `ask`, grading each card_id separately. " +
        "ask_mode: grouped (default, all faces at once), same_script (never mixes a Japanese answer with a meaning answer; best for phone answers), single (one card per prompt). " +
        "By default only the prompts showing the best face are returned per note (with same_script/single there may be several: ask them back-to-back) and other directions are held back " +
        "for sibling_gap_hours after a sibling was reviewed, so answers don't leak. " +
        "after_answer {trap, notes, example?, feedback?}: show it only AFTER the learner answered, never with the prompt (the top-level `notes` is the same after-answer material; feedback = your last feedback on that card). " +
        "Furigana: fields with markup ({今日|きょう}) also come as display[field] (readings still needed, in brackets) and ruby[field] spans {text, reading, show}; show the asked face's display only after the answer. " +
        "Cards waiting for grading (UI 'Grade later') are not returned. " +
        "include_not_due: practice ahead of schedule (not-yet-due cards after the due ones); rating such cards counts as an early review. " +
        "Counts: due_review_cards = due reviews askable now (all of them, also those beyond limit); held_back.cards lists due reviews held back by the sibling gap (with `until`; new cards held back are only counted in held_back.new_cards); " +
        "due_review_cards + held_back.due_review_cards = all due reviews (session_start's due_reviews). returned_cards = cards in the returned prompts.",
      inputSchema: z.object({
        deck: short().optional(),
        decks: z.array(short()).max(50).optional().describe("Several decks"),
        tag: z.string().optional(),
        directions: z.array(direction).optional().describe("Only these directions, e.g. ['meaning>kana'] to drill production"),
        ask_mode: askMode,
        limit: z.number().int().min(1).max(200).optional().describe("Max notes (default 20)"),
        include_new: z.boolean().optional().describe("Include never-reviewed cards (default true)"),
        new_limit: z.number().int().min(0).max(200).optional().describe("Max new notes (default 10)"),
        sibling_gap_hours: z
          .number()
          .min(0)
          .max(72)
          .optional()
          .describe("Hold back a card for this long after another direction of the same word was reviewed (default 6)"),
        all_prompts: z
          .boolean()
          .optional()
          .describe("Return every due prompt per note instead of only those for the best shown face (answers may leak between them)"),
        include_not_due: z.boolean().optional().describe("Practice ahead: also return cards not due yet, ignoring the sibling gap (default false)"),
        tz: tzSchema(),
      }),
      annotations: ro,
    },
    wrap(async ({ tz: _, ...a }) => store.getDue({ ...a, directions: a.directions as never })),
  );

  server.registerTool(
    "rate",
    {
      description:
        "Record review results, one entry per card_id (for content-addressed ratings at the end of a lesson use session_end). " +
        "reviewed_at may be in the past, e.g. for ratings from a lesson; out-of-order history is replayed. Accepts ISO with offset or local 'YYYY-MM-DD HH:mm' in tz. " +
        "answer: what the learner actually said/typed (optional, kept in history). feedback: shown to the learner in the UI. " +
        "Grading answers from get_pending_grading: card_id + rating (+ feedback); reviewed_at, answer and source default to the waiting answer's. " +
        "interval_days = next due − reviewed_at.",
      inputSchema: z.object({
        reviews: z
          .array(
            z.object({
              card_id: z.string(),
              rating,
              reviewed_at: z.string().optional().describe("Default now (or, for a card waiting for grading, when the learner answered)"),
              source: source.optional().describe("Default 'chat' ('ui' for an answer waiting for grading)"),
              answer: text().nullish(),
              session_id: z.string().nullish().describe("study session id from session_start, if any"),
              feedback,
              ...reviewFlags,
            }),
          )
          .min(1)
          .max(100),
        tz: tzSchema(),
      }),
      annotations: rw,
    },
    wrap(async (a, tz) => store.rate(a.reviews, { tz })),
  );

  server.registerTool(
    "stats",
    {
      description: "Progress per direction (due, new, learning, review, lapses, retention), reviews by source, and the hardest notes.",
      inputSchema: z.object({ deck: short().optional(), days: z.number().int().min(1).max(3650).optional(), tz: tzSchema() }),
      annotations: ro,
    },
    wrap(async ({ tz: _, ...a }) => store.stats(a)),
  );

  server.registerTool(
    "note_history",
    {
      description: "A note with its cards and full review history per direction.",
      inputSchema: z.object({ note_id: z.string(), tz: tzSchema() }),
      annotations: ro,
    },
    wrap(async (a) => store.noteHistory(a.note_id)),
  );

  server.registerTool(
    "get_pending_grading",
    {
      description:
        "Answers the learner typed in the phone UI and sent with 'Grade later' (sentences, free production the UI can't check), oldest first. " +
        "Per item: card_id, note_id, deck, direction (shown>asked), faces (front/back or kanji/kana/meaning, raw with furigana markup, plus display/ruby), accept, trap, notes, extra, the learner's answer, answered_at. " +
        "Grade each with rate (card_id, rating, optional feedback; reviewed_at/answer/source default to the waiting answer's) or in session_end. Until graded, the card is not asked again.",
      inputSchema: z.object({
        deck: short().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
        tz: tzSchema(),
      }),
      annotations: ro,
    },
    wrap(async (a) => store.pendingGrading(a)),
  );

  server.registerTool(
    "set_schedule",
    {
      description:
        "Set existing cards' schedules from another tool (migration), e.g. cards imported earlier that restarted as new or in a 10-minute learning step. " +
        "The given schedule becomes the card's starting point; reviews logged here after its last_review are applied on top (unless discard_existing_reviews). Find card_ids with search_notes or lookup.",
      inputSchema: z.object({
        cards: z
          .array(
            z.object({
              card_id: z.string(),
              schedule: scheduleSchema,
              discard_existing_reviews: z
                .boolean()
                .optional()
                .describe("true: reviews already logged for this card were placeholders (e.g. a 'good' written by an earlier import): keep them in history but stop applying them"),
            }),
          )
          .min(1)
          .max(500),
        tz: tzSchema(),
      }),
      annotations: rw,
    },
    wrap(async (a, tz) => store.setSchedule(a.cards as never, { tz })),
  );

  server.registerTool(
    "settings",
    {
      description:
        "Read or change the learner's settings. furigana_known_days: a furigana reading is hidden once the word's kanji>kana card is in review with at least this stability (days; default 7). " +
        "Call without fields to read.",
      inputSchema: z.object({
        furigana_known_days: z.number().min(0).max(3650).optional(),
      }),
      annotations: rw,
    },
    wrap(async (a) => (a.furigana_known_days === undefined ? store.getSettings() : store.updateSettings(a))),
  );
}

// Computed once per isolate from the real tool definitions (handlers are never called on the probe).
export const TOOLS_HASH = await hashToolDefs(
  (() => {
    const probe = new McpServer({ name: "flash-mcp", version: "probe" });
    registerTools(probe, undefined as unknown as Store);
    return listToolDefs(probe);
  })(),
);
/** `<date>+<tools_hash>`: changes whenever a tool name, description or input schema changes. */
export const SERVER_VERSION = `${SERVER_DATE}+${TOOLS_HASH}`;
