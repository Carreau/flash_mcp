import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, UserError, uniqueMessage } from "../src/db/store";

// Teaching-agent features: session_start/session_end, lookup, bulk_import,
// ask_mode, upsert/tags, deck directions, trap notes, delete safety.

const iso = (t: number) => new Date(t).toISOString();
const DAY = 86_400_000;
const HOUR = 3_600_000;
let now = Date.parse("2026-11-01T09:00:00Z");
const clock = () => now;

/** Counts statements prepared / executed through the store (D1 query budget). */
function counting(db: D1Database) {
  const c = { prepared: 0, batches: 0, batchStatements: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "prepare") return (sql: string) => (c.prepared++, target.prepare(sql));
      if (prop === "batch") return (s: D1PreparedStatement[]) => (c.batches++, (c.batchStatements += s.length), target.batch(s));
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy, c };
}

async function makeUser(db: D1Database = env.DB) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', 0)`).bind(id, `${id}@example.com`).run();
  return new Store(db, id, clock);
}

const count = async (sql: string, ...args: unknown[]) =>
  (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

let store: Store;
beforeEach(async () => {
  now = Date.parse("2026-11-01T09:00:00Z");
  store = await makeUser();
});

describe("session_end", () => {
  it("rates by content, creates unknown words, reports ambiguous/unmatched, and closes the session", async () => {
    await store.createDeck("JP", null, ["kanji>kana", "kanji>meaning"]);
    await store.addWords("JP", [
      { kanji: "犬", kana: "いぬ", meaning: "dog" },
      { kanji: "紙", kana: "かみ", meaning: "paper" },
      { kanji: "髪", kana: "かみ", meaning: "hair" },
      { kana: "さとう", meaning: "sugar", directions: ["kana>meaning", "meaning>kana"] },
    ]);
    const s = await store.sessionStart({ kind: "voice", include_due: false });
    now += HOUR;
    const lesson = "2026-11-01 10:30"; // local Paris time = 09:30Z
    const res = await store.sessionEnd(s.session_id, {
      reviews: [
        { kanji: "犬", kana: "いぬ", direction: "kanji>kana", rating: "good", reviewed_at: lesson },
        { kana: "さとう", direction: "kana>meaning", rating: "again" },
        { kana: "かみ", direction: "kanji>kana", rating: "good" }, // ambiguous
        { kana: "かみ", meaning: "hair", direction: "kanji>meaning", rating: "hard" }, // meaning disambiguates
        { kanji: "猫", kana: "ねこ", meaning: "cat", direction: "meaning>kana", rating: "again" }, // unknown -> created
        { kanji: "猫", kana: "ねこ", direction: "kanji>kana", rating: "good" }, // same new note
        { kana: "とり", direction: "kana>meaning", rating: "good" }, // unknown, no meaning
        { kana: "さとう", direction: "kanji>kana", rating: "good" }, // no kanji face
      ],
      add_words: [{ kanji: "鳥", kana: "とり", meaning: "bird" }],
    });

    expect(res.reviews.map((r) => [r.index, r.direction, r.rating])).toEqual([
      [0, "kanji>kana", "good"],
      [1, "kana>meaning", "again"],
      [3, "kanji>meaning", "hard"],
      [4, "meaning>kana", "again"],
      [5, "kanji>kana", "good"],
      [6, "kana>meaning", "good"],
    ]);
    expect(res.reviews[0]!.reviewed_at).toBe("2026-11-01T09:30:00.000Z");
    expect(res.reviews[2]!.meaning).toBe("hair");
    // とり was added by add_words in the same call (deck default: kanji directions only), so kana>meaning got a new card.
    expect(res.reviews[5]).toMatchObject({ kanji: "鳥", card_created: true });
    expect(res.problems.map((p) => [p.index, p.status])).toEqual([
      [2, "ambiguous"],
      [7, "not_applicable"],
    ]);
    expect((res.problems[0]!.candidates as { meaning: string }[]).map((c) => c.meaning).sort()).toEqual(["hair", "paper"]);
    expect(res.notes_created.map((n) => [n.kanji, n.via])).toEqual([
      ["鳥", "add_words"],
      ["猫", "review"],
    ]);
    // 猫 got the deck defaults plus the reviewed meaning>kana.
    const neko = res.notes_created.find((n) => n.kanji === "猫")!;
    expect(neko.cards.sort()).toEqual(["kanji>kana", "kanji>meaning", "meaning>kana"]);
    const nekoNote = await store.getNote(neko.note_id);
    expect(nekoNote.enabled_directions.sort()).toEqual(["kanji>kana", "kanji>meaning", "meaning>kana"]);

    // Logged with the session id and source 'lesson' (voice session).
    expect(await count(`SELECT COUNT(*) AS n FROM review_log WHERE session_id = ? AND source = 'lesson'`, s.session_id)).toBe(6);
    const row = await env.DB.prepare(`SELECT ended_at, summary FROM study_sessions WHERE id = ?`).bind(s.session_id).first<{ ended_at: number; summary: string }>();
    expect(row!.ended_at).toBe(now);
    expect(JSON.parse(row!.summary)).toMatchObject({ reviews_applied: 6, notes_created: 2, problems: 2 });

    // Ending twice is refused; the next session starts from this end.
    await expect(store.sessionEnd(s.session_id, { reviews: [] })).rejects.toThrow(/already ended/);
    now += DAY;
    const s2 = await store.sessionStart({ include_due: false });
    expect(s2).toMatchObject({ since: new Date(row!.ended_at).toISOString(), since_source: "last_session_end" });
    const jp = s2.decks.find((d) => d.deck === "JP")!;
    expect(jp.struggled_since.map((x) => [x.kana, x.direction]).sort()).toEqual([
      ["かみ", "kanji>meaning"],
      ["さとう", "kana>meaning"],
      ["ねこ", "meaning>kana"],
    ].sort());
  });

  it("validation errors abort the whole batch", async () => {
    await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const s = await store.sessionStart({ include_due: false });
    for (const bad of [
      { kanji: "犬", kana: "いぬ", direction: "kanji>kana" as const, rating: "meh" as never },
      { kanji: "犬", kana: "いぬ", rating: "good" as const }, // no direction
      { kanji: "犬", kana: "いぬ", direction: "kanji>kana" as const, rating: "good" as const, reviewed_at: "tomorrow-ish" },
      { kanji: "犬", kana: "いぬ", direction: "front>back" as const, rating: "good" as const },
    ]) {
      await expect(
        store.sessionEnd(s.session_id, {
          reviews: [{ kanji: "犬", kana: "いぬ", direction: "kanji>meaning", rating: "good" }, bad],
          add_words: [{ kana: "ねこ", meaning: "cat" }],
        }),
      ).rejects.toBeInstanceOf(UserError);
    }
    expect(await count(`SELECT COUNT(*) AS n FROM review_log WHERE user_id = ?`, store.userId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?`, store.userId)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM study_sessions WHERE id = ? AND ended_at IS NULL`, s.session_id)).toBe(1);
    await expect(store.sessionEnd("nope", { reviews: [] })).rejects.toThrow(/No study session/);
  });

  it("applies reviews per card in reviewed_at order and replays backdated ones, like rate", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards.find((c) => c.direction === "kanji>kana")!.card_id;
    now += 2 * DAY;
    await store.rate([{ card_id: card, rating: "good", source: "self" }]);
    now += HOUR;
    const s = await store.sessionStart({ include_due: false });
    const t1 = new Date(now - DAY - HOUR).toISOString();
    const t2 = new Date(now - DAY).toISOString();
    const res = await store.sessionEnd(s.session_id, {
      reviews: [
        // Given out of order and before the self review: replayed in time order.
        { kanji: "犬", kana: "いぬ", direction: "kanji>kana", rating: "good", reviewed_at: t2 },
        { card_id: card, rating: "again", reviewed_at: t1 },
      ],
    });
    expect(res.reviews.every((r) => r.replayed_history)).toBe(true);
    const hist = await store.noteHistory(w!.note_id);
    expect(hist.history.map((h) => [h.rating, h.source])).toEqual([
      ["again", "chat"],
      ["good", "chat"],
      ["good", "self"],
    ]);
    // Same final state as rating in order on another user.
    const other = await makeUser();
    now -= 2 * DAY + HOUR;
    const [w2] = await other.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card2 = (await other.getNote(w2!.note_id)).cards.find((c) => c.direction === "kanji>kana")!.card_id;
    now += 2 * DAY + HOUR;
    await other.rate([
      { card_id: card2, rating: "again", reviewed_at: t1 },
      { card_id: card2, rating: "good", reviewed_at: t2 },
      { card_id: card2, rating: "good", reviewed_at: now - HOUR },
    ]);
    const a = (await store.getNote(w!.note_id)).cards.find((c) => c.direction === "kanji>kana")!;
    const b = (await other.getNote(w2!.note_id)).cards.find((c) => c.direction === "kanji>kana")!;
    expect({ ...a, card_id: "" }).toEqual({ ...b, card_id: "" });
  });
});

describe("session_start", () => {
  it("defaults since to 7 days ago, reports per-deck counts, hardest notes and reviews by source", async () => {
    await store.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    await store.addWords("B", [{ kana: "さとう", meaning: "sugar" }]);
    const due = await store.getDue({ deck: "A" });
    const ids = due.items[0]!.prompts[0]!.ask.map((a) => a.card_id);
    await store.rate([{ card_id: ids[0]!, rating: "again", source: "ui" }, { card_id: ids[1]!, rating: "good", source: "lesson" }]);
    now += HOUR;
    const s = await store.sessionStart({ decks: ["A", "Nope"], due_limit: 5 });
    expect(s.since).toBe(new Date(now - 7 * DAY).toISOString());
    expect(s.since_source).toBe("default_7_days");
    expect(s.unknown_decks).toEqual(["Nope"]);
    expect(s.decks.map((d) => d.deck)).toEqual(["A"]);
    const a = s.decks[0]!;
    expect(a.due.new_available).toBe(2);
    expect(a.due.by_direction.find((d) => d.direction === "kanji>kana")).toBeTruthy();
    expect(a.reviews_since_by_source).toEqual({ ui: 1, lesson: 1 });
    expect(a.struggled_since).toHaveLength(1);
    expect(a.struggled_since[0]).toMatchObject({ kanji: "犬", again: 1, latest_rating: "again" });
    expect(a.hardest_notes[0]).toMatchObject({ kanji: "犬" });
    expect(s.due!.items.every((i) => i.deck === "A")).toBe(true);
    expect(await count(`SELECT COUNT(*) AS n FROM study_sessions WHERE id = ?`, s.session_id)).toBe(1);
  });
});

describe("get_due ask_mode", () => {
  it("same_script splits kanji>kana and kanji>meaning into back-to-back prompts; siblings stay held back", async () => {
    await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog", trap: "犬 dog, not 大 big", notes: "counter: 匹" }]);
    const grouped = await store.getDue({});
    expect(grouped.items[0]!.prompts).toHaveLength(1);
    expect(grouped.items[0]!.after_answer).toEqual({ trap: "犬 dog, not 大 big", notes: "counter: 匹" });

    const same = await store.getDue({ ask_mode: "same_script" });
    const ps = same.items[0]!.prompts;
    expect(ps.map((p) => [p.show, p.ask.map((a) => a.face)])).toEqual([
      ["kanji", ["kana"]],
      ["kanji", ["meaning"]],
    ]);
    // Reverse directions (kana>meaning, meaning>kana) show other faces: not returned now...
    const all = await store.getDue({ ask_mode: "same_script", all_prompts: true });
    expect(all.items[0]!.prompts.map((p) => p.show)).toEqual(["kanji", "kanji", "meaning", "kana"]);
    // ...and held back by the sibling gap after the kanji prompts are rated.
    await store.rate(ps.flatMap((p) => p.ask.map((a) => ({ card_id: a.card_id, rating: "good" as const }))));
    now += HOUR;
    // (the kanji cards themselves are back from their short learning step)
    const later = await store.getDue({ ask_mode: "same_script", all_prompts: true });
    expect(later.items.flatMap((i) => i.prompts.map((p) => p.show))).toEqual(["kanji", "kanji"]);

    const single = await store.getDue({ ask_mode: "single", include_not_due: true, all_prompts: true });
    expect(single.items[0]!.prompts.every((p) => p.ask.length === 1)).toBe(true);
  });

  it("include_not_due returns not-yet-due cards after the due ones", async () => {
    const [a, b] = await store.addWords("JP", [
      { kana: "いぬ", meaning: "dog" },
      { kana: "ねこ", meaning: "cat" },
    ]);
    const cardsA = (await store.getNote(a!.note_id)).cards.map((c) => c.card_id);
    await store.rate(cardsA.map((card_id) => ({ card_id, rating: "easy" as const })));
    now += HOUR;
    expect((await store.getDue({})).items.map((i) => i.note_id)).toEqual([b!.note_id]);
    const ahead = await store.getDue({ include_not_due: true });
    expect(ahead.items.map((i) => i.note_id)).toEqual([b!.note_id, a!.note_id]);
    expect(ahead.items[1]!.ahead_of_schedule).toBe(true);
    expect(ahead.not_due_cards).toBe(2);
  });
});

describe("lookup", () => {
  it("checks 300 words in a constant number of queries", async () => {
    const words = Array.from({ length: 300 }, (_, i) => ({ kanji: `字${i}`, kana: `よみ${i}`, meaning: `m${i}` }));
    await store.bulkImport({ deck: "Big", rows: words.slice(0, 150) });
    const { db, c } = counting(env.DB);
    const s = new Store(db, store.userId, clock);
    const res = await s.lookup({ words: words.map(({ kanji, kana }) => ({ kanji, kana })) });
    expect(c.prepared).toBeLessThanOrEqual(2);
    expect(res.found).toBe(150);
    expect(res.words[0]).toMatchObject({ found: true, kanji: "字0", meaning: "m0", cards: expect.any(Array) });
    expect(res.words[0]!.cards).toHaveLength(4);
    expect(res.words[299]).toMatchObject({ found: false, status: "not_found" });
  });

  it("reports last rating, ambiguity and NFKC matches", async () => {
    await store.addWords("JP", [
      { kanji: "紙", kana: "かみ", meaning: "paper" },
      { kanji: "髪", kana: "かみ", meaning: "hair" },
      { kana: "ｶﾒﾗ", meaning: "camera" }, // stored NFKC: カメラ
    ]);
    const n = (await store.searchNotes({ query: "paper" }))[0]!;
    await store.rate([{ card_id: n.cards[0]!.card_id, rating: "hard" }]);
    const res = await store.lookup({ words: [{ kanji: "紙", kana: "かみ" }, { kana: "かみ" }, { kana: "カメラ" }, { kana: " ｶﾒﾗ " }] });
    expect(res.words[0]!.cards!.find((c) => c.direction === n.cards[0]!.direction)!.last_rating).toBe("hard");
    expect(res.words[1]).toMatchObject({ found: false, status: "ambiguous" });
    expect(res.words[1]!.candidates).toHaveLength(2);
    expect(res.words[2]).toMatchObject({ found: true, kana: "カメラ" });
    expect(res.words[3]).toMatchObject({ found: true, kana: "カメラ" });
  });
});

describe("bulk_import", () => {
  it("imports 500 CSV rows with a handful of statements, reporting bad rows", async () => {
    const lines = ["deck,kanji,kana,meaning,notes,tags,trap"];
    for (let i = 0; i < 500; i++) lines.push(`${i % 2 ? "Odd" : ""},字${i},よみ${i},"meaning, ${i}",,lesson-1;n5|extra,`);
    lines.push(`,,,no kana,,,`);
    lines.push(`,"","かな","",,,`);
    const { db, c } = counting(env.DB);
    const s = new Store(db, store.userId, clock);
    const res = await s.bulkImport({ deck: "Even", csv: lines.join("\n") });
    expect(res).toMatchObject({ rows: 502, created: 500, existing: 0 });
    expect(res.errors.map((e) => e.row)).toEqual([501, 502]);
    expect(res.decks_created.sort()).toEqual(["Even", "Odd"]);
    expect(c.batches).toBe(1);
    expect(c.batchStatements).toBeLessThanOrEqual(10);
    expect(c.prepared).toBeLessThanOrEqual(15);
    expect(await count(`SELECT COUNT(*) AS n FROM cards WHERE user_id = ?`, store.userId)).toBe(2000);
    expect(await count(`SELECT COUNT(*) AS n FROM note_tags t JOIN notes n ON n.id = t.note_id WHERE n.user_id = ?`, store.userId)).toBe(1500);
    const one = (await store.lookup({ words: [{ kanji: "字1", kana: "よみ1" }] })).words[0]!;
    expect(one).toMatchObject({ deck: "Odd", meaning: "meaning, 1" });

    // Re-import: duplicates skipped, or updated with on_conflict update.
    const again = await store.bulkImport({ deck: "Even", rows: [{ kanji: "字0", kana: "よみ0", meaning: "new", trap: "t", tags: "x" }, { front: "f", back: "b" }], on_conflict: "update" });
    expect(again).toMatchObject({ created: 1, updated: 1 });
    const n0 = (await store.searchNotes({ query: "字0" })).find((n) => n.kanji === "字0")!;
    expect(n0).toMatchObject({ meaning: "new", trap: "t" });
    expect(n0.tags).toEqual(["extra", "lesson-1", "n5", "x"]);
  });
});

describe("notes editing", () => {
  it("add_words on_conflict update merges tags and extra and keeps the schedule", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog", tags: ["a"], extra: { pos: "noun" } }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!;
    await store.rate([{ card_id: card.card_id, rating: "good" }]);
    const skip = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "hound" }]);
    expect(skip[0]!.status).toBe("exists");
    const up = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog, hound", tags: ["b"], extra: { alt_meanings: ["canine"] }, trap: "not 大" }], { on_conflict: "update" });
    expect(up[0]).toMatchObject({ status: "updated", note_id: w!.note_id });
    const n = await store.getNote(w!.note_id);
    expect(n).toMatchObject({ meaning: "dog, hound", trap: "not 大", tags: ["a", "b"], extra: { pos: "noun", alt_meanings: ["canine"] } });
    expect(n.cards.find((c) => c.card_id === card.card_id)!.reps).toBe(1);
  });

  it("update_note merges tags by default, replace_tags replaces, remove_tags removes; update_notes is atomic", async () => {
    const [a, b] = await store.addWords("JP", [
      { kanji: "犬", kana: "いぬ", meaning: "dog", tags: ["animals"] },
      { kanji: "猫", kana: "ねこ", meaning: "cat", tags: ["animals"] },
    ]);
    expect((await store.updateNote(a!.note_id, { tags: ["n5"] })).tags).toEqual(["animals", "n5"]);
    expect((await store.updateNote(a!.note_id, { remove_tags: ["animals"] })).tags).toEqual(["n5"]);
    expect((await store.updateNote(a!.note_id, { tags: ["x"], replace_tags: true })).tags).toEqual(["x"]);

    const res = await store.updateNotes([
      { note_id: a!.note_id, trap: "犬 not 大" },
      { note_id: b!.note_id, meaning: "cat (animal)", tags: ["pets"] },
    ]);
    expect(res.map((n) => [n.trap, n.meaning, n.tags])).toEqual([
      ["犬 not 大", "dog", ["x"]],
      [null, "cat (animal)", ["animals", "pets"]],
    ]);
    // Making 猫 identical to 犬 violates uniqueness: nothing is applied.
    await expect(
      store.updateNotes([
        { note_id: a!.note_id, meaning: "changed" },
        { note_id: b!.note_id, kanji: "犬", kana: "いぬ" },
      ]),
    ).rejects.toBeInstanceOf(UserError);
    expect((await store.getNote(a!.note_id)).meaning).toBe("dog");
  });

  it("update_deck applies new default directions to existing notes by suspending, never deleting", async () => {
    await store.addWords("Kanji", [
      { kanji: "犬", kana: "いぬ", meaning: "dog" },
      { kana: "さとう", meaning: "sugar" },
    ]);
    const res = await store.updateDeck("Kanji", { default_directions: ["kanji>kana", "kanji>meaning"], apply_to_existing: true });
    expect(res.applied_to_existing).toEqual({ word_notes: 2, cards_created: 0, cards_suspended: 4, cards_reactivated: 0 });
    expect(res.default_directions).toEqual(["kanji>kana", "kanji>meaning"]);
    expect(await count(`SELECT COUNT(*) AS n FROM cards WHERE user_id = ?`, store.userId)).toBe(6);
    expect((await store.getDue({})).items.map((i) => i.faces.kanji)).toEqual(["犬"]);
    // New notes follow the deck defaults.
    const [w] = await store.addWords("Kanji", [{ kanji: "猫", kana: "ねこ", meaning: "cat" }]);
    expect(w!.cards).toEqual(["kanji>kana", "kanji>meaning"]);
  });

  it("delete_notes requires confirm and reports what was deleted", async () => {
    const [a, b] = await store.addWords("JP", [
      { kanji: "犬", kana: "いぬ", meaning: "dog" },
      { kana: "さとう", meaning: "sugar" },
    ]);
    const card = (await store.getNote(a!.note_id)).cards[0]!.card_id;
    await store.rate([{ card_id: card, rating: "good" }]);
    await expect(store.deleteNotes([a!.note_id])).rejects.toThrow(/confirm/);
    const res = await store.deleteNotes([a!.note_id, b!.note_id, "missing"], { confirm: true });
    expect(res.deleted.map((d) => [d.kanji, d.kana, d.cards, d.reviews]).sort()).toEqual([
      [null, "さとう", 2, 0],
      ["犬", "いぬ", 4, 1],
    ]);
    expect(res.not_found).toEqual(["missing"]);
    expect(await count(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?`, store.userId)).toBe(0);
  });
});

describe("review fixes", () => {
  it("session_end: a wrong deck only narrows; the word is rated in its real deck, never re-created", async () => {
    await store.addWords("L3", [
      { kanji: "犬", kana: "いぬ", meaning: "dog" },
      { kana: "さとう", meaning: "sugar" },
    ]);
    await store.addWords("L5", [{ kanji: "猫", kana: "ねこ", meaning: "cat" }]);
    const s = await store.sessionStart({ include_due: false });
    const res = await store.sessionEnd(s.session_id, {
      reviews: [
        { kanji: "犬", kana: "いぬ", meaning: "dog", deck: "L5", direction: "kanji>kana", rating: "good" },
        { kana: "さとう", meaning: "sugar", deck: "L5", direction: "kana>meaning", rating: "hard" },
        { kanji: "猫", kana: "ねこ", direction: "kanji>kana", rating: "again", deck: "L5" },
      ],
    });
    expect(res.problems).toEqual([]);
    expect(res.notes_created).toEqual([]);
    expect(res.reviews.map((r) => r.deck_mismatch ?? null)).toEqual([
      { requested: "L5", actual: "L3" },
      { requested: "L5", actual: "L3" },
      null,
    ]);
    expect(res.summary.deck_mismatch).toBe(2);
    expect(await count(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?`, store.userId)).toBe(3);
    expect(await count(`SELECT COUNT(*) AS n FROM review_log WHERE user_id = ?`, store.userId)).toBe(3);
    // lookup follows the same rule.
    const l = await store.lookup({ deck: "L5", words: [{ kanji: "犬", kana: "いぬ" }] });
    expect(l.words[0]).toMatchObject({ found: true, deck: "L3", deck_mismatch: true });
  });

  it("session_end: a concurrent/retried close aborts the whole batch (guard verified inside D1's batch)", async () => {
    await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const s = await store.sessionStart({ include_due: false });
    const end = (st: Store) =>
      st.sessionEnd(s.session_id, {
        reviews: [{ kanji: "犬", kana: "いぬ", direction: "kanji>kana", rating: "good" }],
        add_words: [{ kana: "ねこ", meaning: "cat" }],
      });
    await end(store);
    // A racing call that read the session before it was closed: make the pre-check
    // see ended_at = NULL, so only the in-batch guard can stop it.
    const stale = new Proxy(env.DB, {
      get(target, prop, recv) {
        if (prop === "prepare") {
          return (sql: string) =>
            target.prepare(
              sql.startsWith("SELECT * FROM study_sessions WHERE id")
                ? "SELECT id, user_id, kind, decks, since, started_at, NULL AS ended_at, summary FROM study_sessions WHERE id = ? AND user_id = ?"
                : sql,
            );
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await expect(end(new Store(stale, store.userId, clock))).rejects.toThrow(/already ended.*Nothing was written/);
    expect(await count(`SELECT COUNT(*) AS n FROM review_log WHERE user_id = ?`, store.userId)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ?`, store.userId)).toBe(2);
    // Truly concurrent calls: exactly one wins.
    const s2 = await store.sessionStart({ include_due: false });
    const both = await Promise.allSettled([1, 2].map(() => store.sessionEnd(s2.session_id, { reviews: [{ kana: "ねこ", direction: "kana>meaning", rating: "good" }] })));
    expect(both.map((b) => b.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await count(`SELECT COUNT(*) AS n FROM review_log WHERE session_id = ?`, s2.session_id)).toBe(1);
  });

  it("decks[] with only unknown names returns nothing, not everything", async () => {
    await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const due = await store.getDue({ decks: ["Nope"] });
    expect(due.items).toEqual([]);
    expect(due.unknown_decks).toEqual(["Nope"]);
    const s = await store.sessionStart({ decks: ["Nope"] });
    expect(s.decks).toEqual([]);
    expect(s.unknown_decks).toEqual(["Nope"]);
    expect(s.due!.items).toEqual([]);
  });

  it("UNIQUE failures name the constraint", async () => {
    const [a, b] = await store.addWords("JP", [
      { kanji: "犬", kana: "いぬ", meaning: "dog" },
      { kanji: "猫", kana: "ねこ", meaning: "cat" },
    ]);
    void a;
    await expect(store.updateNote(b!.note_id, { kanji: "犬", kana: "いぬ" })).rejects.toThrow(/same kanji and kana.*Nothing was written/);
    // Real SQLite messages for the other constraints.
    const msg = async (sql: string, ...args: unknown[]) => {
      try {
        await env.DB.prepare(sql).bind(...args).run();
      } catch (e) {
        return uniqueMessage(String(e));
      }
      throw new Error("expected a UNIQUE failure");
    };
    await store.addBasic("G", [{ front: "a", back: "b", external_id: "k1" }]);
    const [c] = await store.addBasic("G", [{ front: "c", back: "d" }]);
    expect(await msg(`UPDATE notes SET external_id = 'k1' WHERE id = ?`, c!.note_id)).toMatch(/external_id/);
    expect(await msg(`INSERT INTO decks (id, user_id, name, created_at) VALUES ('x', ?, 'G', 0)`, store.userId)).toMatch(/deck with this name/);
    const s = await store.sessionStart({ include_due: false });
    expect(await msg(`INSERT INTO study_sessions (id, user_id, since, started_at) VALUES (?, ?, 0, 0)`, s.session_id, store.userId)).toMatch(/already ended/);
  });

  it("bulk_import rejects over-long fields per row and splits large payloads into several statements", async () => {
    const long = "x".repeat(1900);
    const rows = Array.from({ length: 600 }, (_, i) => ({ kana: `よみ${i}`, meaning: long, notes: long, trap: long }));
    rows.push({ kana: "ながい", meaning: "y".repeat(2001), notes: "", trap: "" });
    const { db, c } = counting(env.DB);
    const res = await new Store(db, store.userId, clock).bulkImport({ deck: "Big", rows });
    expect(res.created).toBe(600);
    expect(res.errors.map((e) => [e.row, e.reason])).toEqual([[601, "meaning longer than 2000 characters"]]);
    // 600 notes x ~5.7KB of text: split by bytes, still a fixed handful of statements.
    expect(c.batchStatements).toBeGreaterThan(4);
    expect(c.batchStatements).toBeLessThanOrEqual(12);
  });
});

describe("teacher feedback round 2", () => {
  it("held_back makes due counts reconcile between session_start and get_due", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const cards = (await store.getNote(w!.note_id)).cards;
    await store.rate(cards.map((c) => ({ card_id: c.card_id, rating: "good" as const })));
    now += 30 * DAY; // all 4 due
    const p = (await store.getDue({})).items[0]!.prompts[0]!;
    expect(p.show).toBe("kanji");
    await store.rate(p.ask.map((a) => ({ card_id: a.card_id, rating: "good" as const })));
    now += 60_000;
    const due = await store.getDue({});
    expect(due.items).toEqual([]);
    expect(due.due_review_cards).toBe(0);
    expect(due.held_back.due_review_cards).toBe(2);
    expect(due.held_back.cards.map((c) => c.direction).sort()).toEqual(["kana>meaning", "meaning>kana"]);
    expect(Date.parse(due.held_back.cards[0]!.until!)).toBe(now - 60_000 + 6 * HOUR);
    const s = await store.sessionStart({});
    expect(s.decks[0]!.due).toMatchObject({ due_reviews: 2, held_back: 2, available_now: 0 });
    expect(s.decks[0]!.due.due_reviews).toBe(s.due!.due_review_cards + s.due!.held_back.due_review_cards);
  });

  it("hardest notes only lists struggling notes (may be empty)", async () => {
    const [ok, bad] = await store.addWords("JP", [
      { kanji: "犬", kana: "いぬ", meaning: "dog" },
      { kanji: "猫", kana: "ねこ", meaning: "cat" },
    ]);
    const ids = async (id: string) => (await store.getNote(id)).cards.map((c) => c.card_id);
    await store.rate((await ids(ok!.note_id)).map((card_id) => ({ card_id, rating: "easy" as const })));
    expect((await store.stats({})).hardest_notes).toEqual([]);
    expect((await store.sessionStart({ include_due: false })).decks[0]!.hardest_notes).toEqual([]);
    await store.rate([{ card_id: (await ids(bad!.note_id))[0]!, rating: "hard" }]);
    expect((await store.stats({})).hardest_notes.map((h) => (h as { kanji: string }).kanji)).toEqual(["猫"]);
    expect((await store.sessionStart({ include_due: false, since: "2026-10-01" })).decks[0]!.hardest_notes.map((h) => (h as { kanji?: unknown }).kanji)).toEqual(["猫"]);
  });

  it("verified:false is scheduled normally but counted apart; early:true is history only and skipped by replay", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "水", kana: "みず", meaning: "water" }]);
    const byDir = Object.fromEntries((await store.getNote(w!.note_id)).cards.map((c) => [c.direction, c.card_id]));
    const kk = byDir["kanji>kana"]!;
    const km = byDir["kanji>meaning"]!;
    const before = (await store.getNote(w!.note_id)).cards.find((c) => c.card_id === km)!;
    const r = await store.rate([
      { card_id: kk, rating: "good", answer: "見ず", verified: false },
      { card_id: km, rating: "again", answer: "water", early: true },
    ]);
    expect(r[0]).toMatchObject({ verified: false, state: "learning" });
    expect(r[1]).toMatchObject({ early: true, schedule_changed: false, state: "new" });
    const after = await store.getNote(w!.note_id);
    expect(after.cards.find((c) => c.card_id === km)).toEqual(before);
    const hist = await store.noteHistory(w!.note_id);
    expect(hist.history.map((h) => [h.direction, h.verified, h.early])).toEqual([
      ["kanji>kana", false, false],
      ["kanji>meaning", true, true],
    ]);
    const kkStats = (await store.stats({})).by_direction.find((d) => d.direction === "kanji>kana")!;
    expect(kkStats).toMatchObject({ reviews_in_window: 1, reviews_unverified_in_window: 1, retention_verified_in_window: null });
    const kmStats = (await store.stats({})).by_direction.find((d) => d.direction === "kanji>meaning")!;
    expect(kmStats).toMatchObject({ reviews_in_window: 0, reviews_early_in_window: 1 });

    // Replay ignores early rows: same state as a twin without them.
    now += 2 * DAY;
    await store.rate([{ card_id: km, rating: "good" }]);
    await store.rate([{ card_id: km, rating: "hard", reviewed_at: now - DAY }]); // backdated -> replay
    const twin = await makeUser();
    now -= 2 * DAY;
    const [t] = await twin.addWords("JP", [{ kanji: "水", kana: "みず", meaning: "water" }]);
    const tkm = (await twin.getNote(t!.note_id)).cards.find((c) => c.direction === "kanji>meaning")!.card_id;
    now += 2 * DAY;
    await twin.rate([{ card_id: tkm, rating: "hard", reviewed_at: now - DAY }, { card_id: tkm, rating: "good" }]);
    const a = (await store.getNote(w!.note_id)).cards.find((c) => c.card_id === km)!;
    const b = (await twin.getNote(t!.note_id)).cards.find((c) => c.card_id === tkm)!;
    expect({ ...a, card_id: "" }).toEqual({ ...b, card_id: "" });

    // session_end carries the same flags.
    const s = await store.sessionStart({ include_due: false });
    const end = await store.sessionEnd(s.session_id, {
      reviews: [
        { kanji: "水", kana: "みず", direction: "kana>meaning", rating: "good", early: true },
        { kanji: "水", kana: "みず", direction: "meaning>kana", rating: "good", verified: false },
      ],
    });
    expect(end.reviews.map((x) => [x.early ?? false, x.verified ?? true])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect((await store.getNote(w!.note_id)).cards.find((c) => c.direction === "kana>meaning")!.reps).toBe(0);
  });

  it("held_back lists only due reviews; held-back new cards are a count", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const cards = (await store.getNote(w!.note_id)).cards;
    await store.rate([{ card_id: cards.find((c) => c.direction === "kanji>kana")!.card_id, rating: "good" }]);
    now += 60_000;
    const due = await store.getDue({});
    expect(due.held_back.new_cards).toBe(3);
    expect(due.held_back.cards).toEqual([]);
    expect(due.held_back.due_review_cards).toBe(0);
  });
});

describe("unclosed sessions", () => {
  const sessionRow = (id: string) =>
    env.DB.prepare(`SELECT ended_at, closed_by FROM study_sessions WHERE id = ?`).bind(id).first<{ ended_at: number | null; closed_by: string | null }>();

  it("auto-closes sessions older than 12h at their last review, lists younger ones, since uses the latest end", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    const old = await store.sessionStart({ include_due: false });
    now += HOUR;
    const reviewedAt = now;
    await store.rate([{ card_id: card, rating: "good", session_id: old.session_id }]);
    const empty = await store.sessionStart({ include_due: false, kind: "voice" }); // no reviews -> closed at started_at
    now += 5 * HOUR;
    const young = await store.sessionStart({ include_due: false, kind: "text" });
    expect(young.open_sessions.map((o) => o.session_id).sort()).toEqual([old.session_id, empty.session_id].sort());
    now += 8 * HOUR; // old/empty are now 14h old, young is 8h
    const s = await store.sessionStart({ include_due: false });
    expect(await sessionRow(old.session_id)).toEqual({ ended_at: reviewedAt, closed_by: "auto" });
    const e = await env.DB.prepare(`SELECT started_at FROM study_sessions WHERE id = ?`).bind(empty.session_id).first<{ started_at: number }>();
    expect(await sessionRow(empty.session_id)).toEqual({ ended_at: e!.started_at, closed_by: "auto" });
    expect(await sessionRow(young.session_id)).toEqual({ ended_at: null, closed_by: null });
    expect(s.open_sessions).toEqual([{ session_id: young.session_id, started_at: iso(now - 8 * HOUR), age_hours: 8, kind: "text" }]);
    expect(s.since).toBe(iso(reviewedAt)); // latest ended_at among closed sessions
    expect(s.since_source).toBe("last_session_end");
  });

  it("accepts session_end on an auto-closed session once, still rejects a second", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    const a = await store.sessionStart({ include_due: false });
    now += 13 * HOUR;
    await store.sessionStart({ include_due: false });
    expect((await sessionRow(a.session_id))!.closed_by).toBe("auto");
    const res = await store.sessionEnd(a.session_id, { reviews: [{ card_id: card, rating: "good" }] });
    expect(res.summary.reviews_applied).toBe(1);
    expect(await sessionRow(a.session_id)).toEqual({ ended_at: now, closed_by: "session_end" });
    // The identical call again (client retry) is reported as a duplicate, nothing written.
    const again = await store.sessionEnd(a.session_id, { reviews: [{ card_id: card, rating: "good" }] });
    expect(again).toMatchObject({ duplicate_request: true, ended_by: "session_end" });
    // A different batch is refused, naming how the session was closed.
    await expect(store.sessionEnd(a.session_id, { reviews: [{ card_id: card, rating: "hard" }] })).rejects.toThrow(/already ended.*ended_by: session_end/);
    expect(await count(`SELECT COUNT(*) AS n FROM review_log WHERE card_id = ?`, card)).toBe(1);
  });

  it("a normally ended session is never reopened; append adds to it and skips duplicates", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    const a = await store.sessionStart({ include_due: false });
    const at = iso(now - 10 * 60_000);
    await store.sessionEnd(a.session_id, { reviews: [{ card_id: card, rating: "good", reviewed_at: at }] });
    now += HOUR;
    await expect(store.sessionEnd(a.session_id, {})).rejects.toThrow(/already ended/);
    const res = await store.sessionEnd(a.session_id, {
      append: true,
      reviews: [
        { card_id: card, rating: "good", reviewed_at: at }, // already saved
        { kanji: "犬", kana: "いぬ", direction: "kanji>meaning", rating: "hard", reviewed_at: iso(now - 30 * 60_000) },
      ],
    });
    expect(res.reviews.map((r) => r.direction)).toEqual(["kanji>meaning"]);
    expect(res.problems.map((p) => [p.index, p.status])).toEqual([[0, "duplicate"]]);
    expect(res.summary).toMatchObject({ appended: true, reviews_applied: 1 });
    expect(await count(`SELECT COUNT(*) AS n FROM review_log WHERE session_id = ?`, a.session_id)).toBe(2);
    const s2 = await store.sessionStart({ include_due: false });
    expect(s2.recently_closed_sessions[0]).toMatchObject({ session_id: a.session_id, ended_by: "session_end" });
  });
});
