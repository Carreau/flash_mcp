import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, UserError } from "../src/db/store";

const DAY = 86_400_000;
let now = Date.parse("2026-11-01T09:00:00Z");
const clock = () => now;

async function makeUser(email: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', 0)`).bind(id, email).run();
  return new Store(env.DB, id, clock);
}

let store: Store;
beforeEach(async () => {
  now = Date.parse("2026-11-01T09:00:00Z");
  store = await makeUser(`u${crypto.randomUUID()}@example.com`);
});

describe("notes", () => {
  it("creates word notes with the right cards and dedupes", async () => {
    const [inu, satou] = await store.addWords("Japanese", [
      { kanji: "犬", kana: "いぬ", meaning: "dog", tags: ["animals"] },
      { kana: "さとう", meaning: "sugar" },
    ]);
    expect(inu!.cards).toHaveLength(4);
    expect(satou!.cards).toEqual(["kana>meaning", "meaning>kana"]);
    const again = await store.addWords("Japanese", [{ kanji: "犬", kana: "いぬ", meaning: "dog!" }]);
    expect(again[0]).toMatchObject({ status: "exists", note_id: inu!.note_id });
    const decks = await store.listDecks();
    expect(decks).toMatchObject([{ name: "Japanese", notes: 2, cards: 6, due_reviews: 0, new_cards: 6 }]);
  });

  it("adds basic notes, reversible ones get two cards", async () => {
    const out = await store.addBasic("Grammar", [
      { front: "さわっても いい?", back: "Can I touch it?" },
      { front: "once more, please", back: "もういちど おねがいします", reversible: true },
    ]);
    expect(out.map((o) => o.cards)).toEqual([["front>back"], ["front>back", "back>front"]]);
  });

  it("adding kanji to a kana-only word creates kanji cards; set_directions suspends", async () => {
    const [w] = await store.addWords("Japanese", [{ kana: "さとう", meaning: "sugar" }]);
    const updated = await store.updateNote(w!.note_id, { kanji: "砂糖" });
    expect(updated.cards.map((c) => c.direction).sort()).toEqual(
      ["kana>meaning", "kanji>kana", "kanji>meaning", "meaning>kana"].sort(),
    );
    const after = await store.setDirections(w!.note_id, [], ["kanji>meaning"]);
    expect(after.cards.find((c) => c.direction === "kanji>meaning")!.suspended).toBe(true);
    expect(after.enabled_directions).not.toContain("kanji>meaning");
  });

  it("rejects a word direction on a basic note", async () => {
    const [b] = await store.addBasic("Grammar", [{ front: "a", back: "b" }]);
    await expect(store.setDirections(b!.note_id, ["kanji>kana"])).rejects.toBeInstanceOf(UserError);
  });

  it("search matches kanji, kana and meaning", async () => {
    await store.addWords("Japanese", [
      { kanji: "犬", kana: "いぬ", meaning: "dog" },
      { kanji: "猫", kana: "ねこ", meaning: "cat" },
    ]);
    expect((await store.searchNotes({ query: "ねこ" })).map((n) => n.kanji)).toEqual(["猫"]);
    expect((await store.searchNotes({ query: "dog" })).map((n) => n.kanji)).toEqual(["犬"]);
    expect(await store.searchNotes({ query: "犬", deck: "Nope" })).toEqual([]);
  });

  it("users cannot see each other's data", async () => {
    const [w] = await store.addWords("Japanese", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const other = await makeUser("other@example.com");
    expect(await other.listDecks()).toEqual([]);
    expect(await other.searchNotes({})).toEqual([]);
    await expect(other.getNote(w!.note_id)).rejects.toBeInstanceOf(UserError);
    const due = await store.getDue({});
    await expect(other.rate([{ card_id: due.items[0]!.prompts[0]!.ask[0]!.card_id, rating: "good" }])).rejects.toBeInstanceOf(UserError);
    // Same word for another user is not a duplicate.
    expect((await other.addWords("Japanese", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]))[0]!.status).toBe("created");
  });
});

describe("review", () => {
  it("get_due groups a new word into one prompt: show kanji, ask kana + meaning", async () => {
    await store.addWords("Japanese", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const due = await store.getDue({});
    expect(due.items).toHaveLength(1);
    const [p] = due.items[0]!.prompts;
    expect(p!.show).toBe("kanji");
    expect(p!.ask.map((a) => a.face)).toEqual(["kana", "meaning"]);
  });

  it("rating some directions holds back siblings for the gap, then they come due", async () => {
    await store.addWords("Japanese", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const p = (await store.getDue({})).items[0]!.prompts[0]!;
    const res = await store.rate(p.ask.map((a) => ({ card_id: a.card_id, rating: "good" as const })));
    expect(res.every((r) => Date.parse(r.next_due!) > now)).toBe(true);
    expect((await store.getDue({})).items).toEqual([]);
    now += 7 * 3_600_000;
    // The kanji cards are back too: "good" on a new card is a short learning step.
    const all = await store.getDue({ all_prompts: true });
    expect(all.items[0]!.prompts.map((x) => x.show).sort()).toEqual(["kana", "kanji", "meaning"]);
  });

  it("a backdated lesson rating replays history to the same result as in-order rating", async () => {
    const [a] = await store.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const [b] = await (await makeUser("b@example.com")).addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    void b;
    const cardA = (await store.getNote(a!.note_id)).cards.find((c) => c.direction === "kanji>kana")!.card_id;

    const t1 = now + 1 * DAY;
    const t2 = now + 2 * DAY;
    // Out of order: today's self review first, then yesterday's lesson.
    now = t2;
    await store.rate([{ card_id: cardA, rating: "good", source: "self" }]);
    const res = await store.rate([{ card_id: cardA, rating: "again", reviewed_at: new Date(t1).toISOString(), source: "lesson" }]);
    expect(res[0]!.replayed_history).toBe(true);
    const outOfOrder = (await store.getNote(a!.note_id)).cards.find((c) => c.direction === "kanji>kana")!;

    // In order on a fresh copy.
    const s2 = await makeUser("c@example.com");
    const [c] = await s2.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const cardC = (await s2.getNote(c!.note_id)).cards.find((x) => x.direction === "kanji>kana")!.card_id;
    await s2.rate([{ card_id: cardC, rating: "again", reviewed_at: t1 }]);
    await s2.rate([{ card_id: cardC, rating: "good", reviewed_at: t2 }]);
    const inOrder = (await s2.getNote(c!.note_id)).cards.find((x) => x.direction === "kanji>kana")!;

    expect({ ...outOfOrder, card_id: "" }).toEqual({ ...inOrder, card_id: "" });
  });

  it("rejects future timestamps and unknown ratings", async () => {
    const [w] = await store.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    await expect(store.rate([{ card_id: card, rating: "good", reviewed_at: now + DAY }])).rejects.toThrow(/future/);
    await expect(store.rate([{ card_id: card, rating: "meh" as never }])).rejects.toThrow(/rating/);
  });

  it("stats are per direction and history is per note", async () => {
    const [w] = await store.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const note = await store.getNote(w!.note_id);
    const byDir = Object.fromEntries(note.cards.map((c) => [c.direction, c.card_id]));
    await store.rate([
      { card_id: byDir["kanji>kana"]!, rating: "good", answer: "いぬ" },
      { card_id: byDir["kanji>meaning"]!, rating: "again", answer: "cat" },
    ]);
    const stats = await store.stats({});
    const kk = stats.by_direction.find((d) => d.direction === "kanji>kana")!;
    const km = stats.by_direction.find((d) => d.direction === "kanji>meaning")!;
    expect(kk).toMatchObject({ reviews_in_window: 1, retention_in_window: 1 });
    expect(km).toMatchObject({ reviews_in_window: 1, retention_in_window: 0 });
    const hist = await store.noteHistory(w!.note_id);
    expect(hist.history.map((h) => [h.direction, h.rating, h.answer])).toEqual([
      ["kanji>kana", "good", "いぬ"],
      ["kanji>meaning", "again", "cat"],
    ]);
  });

  it("deleting a note removes its cards and history", async () => {
    const [w] = await store.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    await store.rate([{ card_id: card, rating: "good" }]);
    await store.deleteNote(w!.note_id);
    const left = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM cards WHERE note_id = ?1) + (SELECT COUNT(*) FROM review_log WHERE card_id = ?2) AS n`)
      .bind(w!.note_id, card)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("search returns up to 100 notes (no D1 parameter-limit crash) and escapes LIKE wildcards", async () => {
    const words = Array.from({ length: 100 }, (_, i) => ({ kana: `か${i}`, meaning: `w${i}` }));
    await store.addWords("Big", words);
    await store.addWords("Big", words.map((w) => ({ ...w, kana: `き${w.kana}` })));
    expect(await store.searchNotes({ limit: 100 })).toHaveLength(100);
    await store.addBasic("Big", [{ front: "100% sure", back: "x" }]);
    expect((await store.searchNotes({ query: "%" })).map((n) => n.front)).toEqual(["100% sure"]);
  });

  it("a card failed together with its sibling still comes back for relearning within minutes", async () => {
    await store.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const p = (await store.getDue({})).items[0]!.prompts[0]!;
    // Get both past the new state first, a day apart.
    await store.rate(p.ask.map((a) => ({ card_id: a.card_id, rating: "good" as const })));
    now += 3 * DAY;
    const kana = p.ask.find((a) => a.face === "kana")!.card_id;
    const meaning = p.ask.find((a) => a.face === "meaning")!.card_id;
    await store.rate([
      { card_id: kana, rating: "again" },
      { card_id: meaning, rating: "good" },
    ]);
    now += 15 * 60_000;
    const due = await store.getDue({ all_prompts: true });
    const asked = due.items.flatMap((i) => i.prompts.flatMap((x) => x.ask.map((a) => a.card_id)));
    expect(asked).toContain(kana);
    expect(asked).not.toContain(meaning);
  });

  it("rate is all-or-nothing and keeps input order for equal timestamps", async () => {
    const [w] = await store.addWords("A", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    await expect(
      store.rate([
        { card_id: card, rating: "good" },
        { card_id: "missing", rating: "good" },
      ]),
    ).rejects.toThrow(/No card missing/);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM review_log WHERE card_id = ?`).bind(card).first<{ n: number }>();
    expect(n!.n).toBe(0);

    // Lesson: again then good at the same time, entered after a later self review -> replay.
    now += 2 * DAY;
    await store.rate([{ card_id: card, rating: "good" }]);
    const lesson = new Date(now - DAY).toISOString();
    const res = await store.rate([
      { card_id: card, rating: "again", reviewed_at: lesson, source: "lesson" },
      { card_id: card, rating: "good", reviewed_at: lesson, source: "lesson" },
    ]);
    expect(res.every((r) => r.replayed_history)).toBe(true);
    const hist = await store.noteHistory(w!.note_id);
    expect(hist.history.map((h) => h.rating)).toEqual(["again", "good", "good"]);
  });
});
