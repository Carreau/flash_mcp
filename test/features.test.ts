import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store";
import { acceptedAnswers } from "../src/model/directions";
import { displayText, parseMarkup, plainText, readingText, rubySpans } from "../src/model/furigana";
import { checkAnswer } from "../src/model/grading";

// Teacher feedback round 4: grade later, furigana, merge, per-row directions,
// imported schedules, interval_days, enabled_directions, session retries.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
let now = Date.parse("2026-11-20T09:00:00Z");
const clock = () => now;

async function makeUser() {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', 0)`).bind(id, `${id}@example.com`).run();
  return new Store(env.DB, id, clock);
}
const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;

let store: Store;
beforeEach(async () => {
  now = Date.parse("2026-11-20T09:00:00Z");
  store = await makeUser();
});

describe("furigana markup", () => {
  it("parses, strips and reads", () => {
    const s = "{今日|きょう}は{雨|あめ}です。{noun}を";
    expect(parseMarkup(s).filter((x) => "base" in x)).toHaveLength(2); // {noun} has no kanji: literal text
    expect(plainText(s)).toBe("今日は雨です。{noun}を");
    expect(readingText("{今日|きょう}は{雨|あめ}です")).toBe("きょうはあめです");
    expect(readingText("{今日}は")).toBeNull();
    const spans = rubySpans("{今日|きょう}は{雨|あめ}", (b) => b === "雨");
    expect(spans).toEqual([
      { text: "今日", reading: "きょう", show: true },
      { text: "は", reading: null, show: false },
      { text: "雨", reading: "あめ", show: false },
    ]);
    expect(displayText(spans)).toBe("今日(きょう)は雨");
  });

  it("accept lists compare without markup, and the kana reading is accepted", () => {
    const note = { type: "basic" as const, front: "It rains today", back: "{今日|きょう}は{雨|あめ}です", extra: { alt_backs: ["{今日|きょう}、{雨|あめ}が{降|ふ}ります"] } };
    const accept = acceptedAnswers(note, "back", "front");
    expect(accept).toEqual(["今日は雨です", "きょうはあめです", "今日、雨が降ります", "きょう、あめがふります"]);
    expect(checkAnswer("back", "きょうはあめです", accept).correct).toBe(true);
    expect(checkAnswer("back", "kyouhaamedesu", accept).correct).toBe(true);
    expect(checkAnswer("back", "今日、雨が降ります", accept).correct).toBe(true);
  });

  it("resolves bare {漢字} from the single word note, reports none/several, never guesses", async () => {
    await store.addWords("JP", [
      { kanji: "雨", kana: "あめ", meaning: "rain" },
      { kanji: "日", kana: "ひ", meaning: "day, sun" },
      { kanji: "日", kana: "にち", meaning: "day (counter)" },
    ]);
    const [b] = await store.addBasic("Sentences", [{ front: "{今日}は{雨}です", back: "It rains today", notes: "{日} again" }]);
    const note = await store.getNote(b!.note_id);
    expect(note.front).toBe("{今日}は{雨|あめ}です");
    expect((b as { furigana_problems?: { text: string; status: string }[] }).furigana_problems!.map((p) => [p.text, p.status])).toEqual([
      ["今日", "no_word"],
      ["日", "ambiguous"],
    ]);
    // A word added in the same call counts.
    const [w] = await store.addWords("JP", [{ kanji: "天気", kana: "てんき", meaning: "weather", notes: "{天気}がいい" }]);
    expect((await store.getNote(w!.note_id)).notes).toBe("{天気|てんき}がいい");
  });

  it("get_due returns display + ruby, and hides a reading once the kanji>kana card is known", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "雨", kana: "あめ", meaning: "rain" }]);
    await store.addBasic("Sentences", [{ front: "{今日|きょう}は{雨}です", back: "It rains today" }]);
    let due = await store.getDue({ deck: "Sentences" });
    const item = due.items[0]!;
    expect(item.faces.front).toBe("{今日|きょう}は{雨|あめ}です");
    expect(item.display!.front).toBe("今日(きょう)は雨(あめ)です");
    expect(item.ruby!.front![0]).toEqual({ text: "今日", reading: "きょう", show: true });
    expect(item.prompts[0]!.ask[0]!.accept).toEqual(["It rains today"]);

    // 雨 kanji>kana in review with 10 days stability: its furigana fades.
    const card = (await store.getNote(w!.note_id)).cards.find((c) => c.direction === "kanji>kana")!;
    await env.DB.prepare(`UPDATE cards SET state = 2, stability = 10 WHERE id = ?`).bind(card.card_id).run();
    due = await store.getDue({ deck: "Sentences" });
    expect(due.items[0]!.display!.front).toBe("今日(きょう)は雨です");
    // The threshold is a setting.
    await store.updateSettings({ furigana_known_days: 30 });
    due = await store.getDue({ deck: "Sentences" });
    expect(due.items[0]!.display!.front).toBe("今日(きょう)は雨(あめ)です");
  });

  it("matches and deduplicates basic notes without the markup", async () => {
    await store.addBasic("S", [{ front: "{今日|きょう}は雨です", back: "It rains today" }]);
    const again = await store.addBasic("S", [{ front: "今日は雨です", back: "It rains today" }]);
    expect(again[0]!.status).toBe("exists");
    const s = await store.sessionStart({ include_due: false });
    const res = await store.sessionEnd(s.session_id, { reviews: [{ front: "今日は雨です", rating: "good" }] });
    expect(res.reviews).toHaveLength(1);
  });
});

describe("grade later", () => {
  it("stores the answer, hides the card until graded, and the grading review uses the answer's time", async () => {
    const [b] = await store.addBasic("S", [{ front: "Say: I want to eat sushi", back: "{寿司|すし}が{食|た}べたいです", trap: "が, not を" }]);
    const card = (await store.getNote(b!.note_id)).cards[0]!.card_id;
    expect((await store.getDue({})).items).toHaveLength(1);

    const answeredAt = now;
    await store.gradeLater([{ card_id: card, answer: "すしをたべたい" }]);
    expect((await store.getDue({})).items).toHaveLength(0);
    expect((await store.listDecks())[0]).toMatchObject({ pending_grading: 1, new_cards: 0 });

    now += 5 * HOUR;
    const s = await store.sessionStart({ include_due: false });
    expect(s.pending_grading).toBe(1);
    expect(s.decks[0]!.pending_grading).toBe(1);

    const pending = await store.pendingGrading({});
    expect(pending.pending).toBe(1);
    expect(pending.items[0]).toMatchObject({
      card_id: card, direction: "front>back", answer: "すしをたべたい", answered_at: iso(answeredAt), trap: "が, not を",
      accept: ["寿司が食べたいです", "すしがたべたいです"],
    });
    expect(pending.items[0]!.display!.back).toBe("寿司(すし)が食(た)べたいです");

    const [r] = await store.rate([{ card_id: card, rating: "hard", feedback: "Use が with たい: すしがたべたい" }]);
    expect(r).toMatchObject({ reviewed_at: iso(answeredAt), graded_pending_answer: { answer: "すしをたべたい" } });
    expect(r!.interval_days).toBeGreaterThanOrEqual(0);
    const log = await env.DB.prepare(`SELECT source, answer, feedback, reviewed_at FROM review_log WHERE card_id = ?`).bind(card).first();
    expect(log).toMatchObject({ source: "ui", answer: "すしをたべたい", reviewed_at: answeredAt, feedback: "Use が with たい: すしがたべたい" });
    expect((await store.pendingGrading({})).pending).toBe(0);

    // Feedback reaches the learner: inbox, and on the card next time it comes up.
    const inbox = await store.feedbackInbox({ unseen_only: true });
    expect(inbox.unseen).toBe(1);
    await store.markFeedbackSeen(inbox.items.map((i) => i.review_id));
    expect((await store.feedbackInbox({ unseen_only: true })).unseen).toBe(0);
    now += 30 * DAY;
    const due = await store.getDue({});
    expect(due.items[0]!.after_answer.feedback![0]).toMatchObject({ feedback: "Use が with たい: すしがたべたい", rating: "hard" });
    expect((await store.noteHistory(b!.note_id)).history[0]).toMatchObject({ feedback: "Use が with たい: すしがたべたい" });
  });

  it("session_end grades a waiting answer by content", async () => {
    const [b] = await store.addBasic("S", [{ front: "Say: good morning", back: "おはようございます" }]);
    const card = (await store.getNote(b!.note_id)).cards[0]!.card_id;
    await store.gradeLater([{ card_id: card, answer: "おはよう" }]);
    now += HOUR;
    const s = await store.sessionStart({ include_due: false });
    const res = await store.sessionEnd(s.session_id, { reviews: [{ front: "Say: good morning", rating: "good", feedback: "Polite form: ございます" }] });
    expect(res.reviews[0]).toMatchObject({ graded_pending_answer: { answer: "おはよう" }, reviewed_at: iso(now - HOUR) });
    expect(res.summary).toMatchObject({ graded_pending: 1 });
    expect(await count(`SELECT COUNT(*) AS n FROM pending_answers WHERE card_id = ? AND graded_at IS NOT NULL`, card)).toBe(1);
  });
});

describe("add_words on_conflict merge", () => {
  it("merges a kana-only word into the single note with that kana (other deck), switching on the directions", async () => {
    await store.createDeck("Kanji reading", null, ["kanji>kana", "kanji>meaning"]);
    const [orig] = await store.addWords("Kanji reading", [{ kanji: "両親", kana: "りょうしん", meaning: "parents" }]);
    await store.addWords("Kanji reading", [
      { kanji: "紙", kana: "かみ", meaning: "paper" },
      { kanji: "髪", kana: "かみ", meaning: "hair" },
    ]);
    const res = await store.addWords(
      "Japanese",
      [
        { kana: "りょうしん", meaning: "(my) parents", tags: ["lesson-12"], trap: "not しんせき" },
        { kana: "かみ", meaning: "paper" },
        { kana: "ねこ", meaning: "cat" },
      ],
      { on_conflict: "merge" },
    );
    expect(res.map((r) => r.status)).toEqual(["merged", "ambiguous", "created"]);
    expect(res[0]).toMatchObject({ note_id: orig!.note_id, meaning_kept: "parents" });
    expect(res[0]!.cards.sort()).toEqual(["kana>meaning", "meaning>kana"]);
    expect((res[1] as { candidates: unknown[] }).candidates).toHaveLength(2);
    const n = await store.getNote(orig!.note_id);
    expect(n.cards.map((c) => c.direction).sort()).toEqual(["kana>meaning", "kanji>kana", "kanji>meaning", "meaning>kana"]);
    expect(n).toMatchObject({ deck: "Kanji reading", trap: "not しんせき", tags: ["lesson-12"] });
    expect(await count(`SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND kana = 'りょうしん'`, store.userId)).toBe(1);
  });
});

describe("bulk_import", () => {
  it("takes per-row directions, accept and an imported schedule", async () => {
    const res = await store.bulkImport({
      deck: "Japanese",
      rows: [
        { kanji: "会社", kana: "かいしゃ", meaning: "company", directions: ["kanji>kana", "kanji>meaning"] },
        { kanji: "電車", kana: "でんしゃ", meaning: "train", schedule: { due: "2026-12-10T09:00:00Z", last_review: "2026-11-10T09:00:00Z", stability: 30 } },
        { front: "Update the document, please", back: "書類を更新してください", accept: ["書類のアップデートをお願いします"], directions: "front>back;back>front" },
        { kanji: "x", kana: "x", meaning: "x", directions: ["front>back"] },
      ],
    });
    expect(res).toMatchObject({ created: 3, errors: [{ row: 4 }] });
    const notes = await store.searchNotes({ deck: "Japanese" });
    const kaisha = notes.find((n) => n.kanji === "会社")!;
    expect(kaisha.cards.map((c) => c.direction).sort()).toEqual(["kanji>kana", "kanji>meaning"]);
    const densha = notes.find((n) => n.kanji === "電車")!;
    expect(densha.cards.every((c) => c.state === "review" && c.due === "2026-12-10T09:00:00.000Z" && c.stability_days === 30)).toBe(true);
    const basic = notes.find((n) => n.type === "basic")!;
    expect(basic.cards.map((c) => c.direction).sort()).toEqual(["back>front", "front>back"]);
    expect(basic.extra).toMatchObject({ alt_backs: ["書類のアップデートをお願いします"] });

    // A backdated review replays from the imported state, not from a new card.
    const card = densha.cards.find((c) => c.direction === "kanji>kana")!.card_id;
    await store.rate([{ card_id: card, rating: "good" }]);
    const [r] = await store.rate([{ card_id: card, rating: "good", reviewed_at: iso(now - HOUR) }]);
    expect(r!.replayed_history).toBe(true);
    expect(r!.state).toBe("review");
    expect(r!.interval_days).toBeGreaterThan(20);
  });

  it("set_schedule fixes already imported cards", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "駅", kana: "えき", meaning: "station" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    await store.rate([{ card_id: card, rating: "good" }]); // the replayed "good": 10-minute step
    const sched = { due: "2026-12-05 10:00", last_review: "2026-11-05 10:00", stability: 30 };
    // Kept: the later "good" applies on top of the imported state.
    const [kept] = await store.setSchedule([{ card_id: card, schedule: sched }]);
    expect(kept).toMatchObject({ state: "review", reviews_applied_after_import: 1 });
    expect(Date.parse(kept!.next_due!)).toBeGreaterThan(Date.parse("2026-12-05T09:00:00Z"));
    // Discarded: exactly the imported schedule; the review stays in history as non-scheduling.
    const [r] = await store.setSchedule([{ card_id: card, schedule: sched, discard_existing_reviews: true }]);
    expect(r).toMatchObject({ state: "review", next_due: "2026-12-05T09:00:00.000Z", reviews_applied_after_import: 0 });
    expect((await store.noteHistory(w!.note_id)).history[0]).toMatchObject({ early: true });
  });
});

describe("bug fixes", () => {
  it("interval_days counts from reviewed_at, not from now", async () => {
    const [w] = await store.addWords("JP", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
    const card = (await store.getNote(w!.note_id)).cards[0]!.card_id;
    const [r] = await store.rate([{ card_id: card, rating: "good", reviewed_at: iso(now - 4 * DAY) }]);
    expect(r!.interval_days).toBeGreaterThanOrEqual(0);
    expect(r!.interval_days).toBeLessThan(1);
  });

  it("enabled_directions lists only directions the note's faces allow; the rest wait for the face", async () => {
    const [w] = await store.addWords("JP", [{ kana: "コーヒー", meaning: "coffee" }]);
    const n = await store.getNote(w!.note_id);
    expect(n.enabled_directions.sort()).toEqual(["kana>meaning", "meaning>kana"]);
    expect(n.waiting_for_face!.map((x) => x.direction).sort()).toEqual(["kanji>kana", "kanji>meaning"]);
    const [u] = await store.updateNotes([{ note_id: w!.note_id, kanji: "珈琲" }]);
    expect(u!.enabled_directions).toHaveLength(4);
  });

  it("lookup deck_only restricts matching to the deck", async () => {
    await store.addWords("Kanji", [{ kanji: "両親", kana: "りょうしん", meaning: "parents" }]);
    expect((await store.lookup({ deck: "Japanese", words: [{ kana: "りょうしん" }] })).words[0]).toMatchObject({ found: true, deck_mismatch: true });
    expect((await store.lookup({ deck: "Japanese", deck_only: true, words: [{ kana: "りょうしん" }] })).words[0]).toMatchObject({ found: false });
  });
});
