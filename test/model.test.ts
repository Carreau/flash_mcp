import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORD_DIRECTIONS,
  acceptedAnswers,
  activeDirections,
  groupPrompts,
  planCards,
} from "../src/model/directions";
import { applyReview, emptyState, replay } from "../src/model/scheduler";

const inu = { type: "word" as const, kanji: "犬", kana: "いぬ", meaning: "dog" };
const satou = { type: "word" as const, kana: "さとう", meaning: "sugar" };

describe("directions", () => {
  it("a word with kanji gets the 4 default directions", () => {
    expect(activeDirections(inu, DEFAULT_WORD_DIRECTIONS)).toEqual([
      "kanji>kana",
      "kanji>meaning",
      "kana>meaning",
      "meaning>kana",
    ]);
  });

  it("a kana-only word gets only kana<->meaning", () => {
    expect(activeDirections(satou, DEFAULT_WORD_DIRECTIONS)).toEqual(["kana>meaning", "meaning>kana"]);
  });

  it("adding kanji later creates the kanji cards; removing it suspends them", () => {
    const existing = [
      { direction: "kana>meaning" as const, suspended: false },
      { direction: "meaning>kana" as const, suspended: false },
    ];
    expect(planCards({ ...satou, kanji: "砂糖" }, DEFAULT_WORD_DIRECTIONS, existing)).toEqual({
      create: ["kanji>kana", "kanji>meaning"],
      activate: [],
      suspend: [],
    });
    const withKanji = [
      ...existing,
      { direction: "kanji>kana" as const, suspended: false },
      { direction: "kanji>meaning" as const, suspended: false },
    ];
    expect(planCards(satou, DEFAULT_WORD_DIRECTIONS, withKanji)).toEqual({
      create: [],
      activate: [],
      suspend: ["kanji>kana", "kanji>meaning"],
    });
  });

  it("disabled directions are suspended and re-enabled ones reactivated", () => {
    const existing = DEFAULT_WORD_DIRECTIONS.map((d) => ({ direction: d, suspended: d === "kanji>meaning" }));
    expect(planCards(inu, ["kanji>kana", "kanji>meaning", "kana>meaning"], existing)).toEqual({
      create: [],
      activate: ["kanji>meaning"],
      suspend: ["meaning>kana"],
    });
  });

  it("groups due cards by the face shown: show 犬, ask kana + meaning", () => {
    const prompts = groupPrompts(inu, [
      { card_id: "a", direction: "kanji>kana" },
      { card_id: "b", direction: "kanji>meaning" },
      { card_id: "c", direction: "meaning>kana" },
    ]);
    expect(prompts.map((p) => [p.show, p.ask.map((a) => a.face)])).toEqual([
      ["kanji", ["kana", "meaning"]],
      ["meaning", ["kana"]],
    ]);
  });

  it("kana answers accept kanji (IME) except when the kanji is the prompt", () => {
    expect(acceptedAnswers(inu, "kana", "meaning")).toEqual(["いぬ", "犬"]);
    expect(acceptedAnswers(inu, "kana", "kanji")).toEqual(["いぬ"]);
    expect(acceptedAnswers({ ...inu, extra: { alt_meanings: ["hound"] } }, "meaning", "kanji")).toEqual(["dog", "hound"]);
  });
});

describe("scheduler", () => {
  const t0 = Date.parse("2026-11-01T10:00:00Z");
  const day = 86_400_000;
  const reviews = [
    { rating: 3, reviewed_at: t0 + 1000 },
    { rating: 3, reviewed_at: t0 + 1 * day },
    { rating: 1, reviewed_at: t0 + 4 * day },
    { rating: 3, reviewed_at: t0 + 4 * day + 600_000 },
    { rating: 4, reviewed_at: t0 + 9 * day },
  ];

  it("replay of in-order history equals incremental application", () => {
    let s = emptyState(t0);
    for (const r of reviews) s = applyReview(s, r.rating, r.reviewed_at);
    expect(replay(t0, reviews)).toEqual(s);
  });

  it("replay sorts out-of-order history", () => {
    const shuffled = [reviews[3]!, reviews[0]!, reviews[4]!, reviews[2]!, reviews[1]!];
    expect(replay(t0, shuffled)).toEqual(replay(t0, reviews));
  });

  it("good on a new card schedules it in the future; again counts a lapse after review", () => {
    const s1 = applyReview(emptyState(t0), 3, t0);
    expect(s1.due).toBeGreaterThan(t0);
    expect(replay(t0, reviews).lapses).toBe(1);
  });
});

import { parseCsv, splitTags } from "../src/model/csv";
import { NoteIndex } from "../src/model/match";
import { addLocalTimes, formatLocal, parseTime } from "../src/model/time";

describe("ask modes", () => {
  const due = [
    { card_id: "a", direction: "kanji>kana" as const },
    { card_id: "b", direction: "kanji>meaning" as const },
    { card_id: "c", direction: "meaning>kana" as const },
  ];
  it("same_script never mixes kana and meaning answers; single asks one card", () => {
    expect(groupPrompts(inu, due, "same_script").map((p) => [p.show, p.ask.map((a) => a.face)])).toEqual([
      ["kanji", ["kana"]],
      ["kanji", ["meaning"]],
      ["meaning", ["kana"]],
    ]);
    expect(groupPrompts(inu, due, "single").map((p) => p.ask.length)).toEqual([1, 1, 1]);
    expect(groupPrompts(inu, due, "grouped")).toHaveLength(2);
  });
  it("basic front/back are their own scripts", () => {
    const b = { type: "basic" as const, front: "f", back: "b" };
    expect(groupPrompts(b, [{ card_id: "x", direction: "front>back" }], "same_script")).toHaveLength(1);
  });
});

describe("matching", () => {
  const n = (id: string, kanji: string | null, kana: string, meaning: string, deck = "A") =>
    ({ id, type: "word" as const, kanji, kana, meaning, front: null, back: null, deck_name: deck });
  const idx = new NoteIndex([n("1", "紙", "かみ", "paper"), n("2", "髪", "かみ", "hair"), n("3", null, "さとう", "sugar"), n("4", "砂糖", "さとう", "sugar", "B")]);
  it("kanji+kana exact, kana-only note preferred, ambiguity, meaning and deck narrowing", () => {
    expect(idx.matchWord({ kanji: "紙", kana: "かみ" })).toMatchObject({ status: "found", note: { id: "1" } });
    expect(idx.matchWord({ kana: "かみ" }).status).toBe("ambiguous");
    expect(idx.matchWord({ kana: "かみ", meaning: "Hair" })).toMatchObject({ status: "found", note: { id: "2" } });
    expect(idx.matchWord({ kana: "さとう" })).toMatchObject({ status: "found", note: { id: "3" } });
    expect(idx.matchWord({ kana: "さとう", deck: "B" })).toMatchObject({ status: "found", note: { id: "4" } });
    expect(idx.matchWord({ kanji: "神", kana: "かみ" })).toMatchObject({ status: "not_found" });
    expect(idx.matchWord({ kanji: "紙", kana: " かみ " }).status).toBe("found");
  });
});

describe("times", () => {
  it("formats in a zone and parses local wall-clock times, DST included", () => {
    expect(formatLocal(Date.parse("2026-11-20T14:04:00Z"), "Europe/Paris")).toBe("2026-11-20 15:04 (Europe/Paris)");
    expect(new Date(parseTime("2026-11-20 15:04", "Europe/Paris")).toISOString()).toBe("2026-11-20T14:04:00.000Z");
    expect(new Date(parseTime("2026-07-01 15:04", "Europe/Paris")).toISOString()).toBe("2026-07-01T13:04:00.000Z");
    expect(new Date(parseTime("2026-11-20T15:04:00+09:00", "Europe/Paris")).toISOString()).toBe("2026-11-20T06:04:00.000Z");
    expect(parseTime("nope", "Europe/Paris")).toBeNaN();
    expect(addLocalTimes({ a: [{ due: "2026-11-20T14:04:00.000Z" }] }, "Asia/Tokyo")).toEqual({
      a: [{ due: "2026-11-20T14:04:00.000Z", due_local: "2026-11-20 23:04 (Asia/Tokyo)" }],
    });
  });
});

describe("csv", () => {
  it("handles quotes, CRLF and tag separators", () => {
    expect(parseCsv('a,b\r\n"x, ""y""",z\n')).toEqual([["a", "b"], ['x, "y"', "z"]]);
    expect(splitTags("a; b|c")).toEqual(["a", "b", "c"]);
  });
});

import { chunks } from "../src/db/writes";

describe("IME answers and chunking", () => {
  it("kanji>kana accepts the shown kanji with a warning", () => {
    const [p] = groupPrompts(inu, [{ card_id: "a", direction: "kanji>kana" }, { card_id: "b", direction: "kanji>meaning" }]);
    expect(p!.ask.find((a) => a.face === "kana")).toMatchObject({ accept: ["いぬ"], accept_with_warning: ["犬"] });
    expect(p!.ask.find((a) => a.face === "meaning")!.accept_with_warning).toBeUndefined();
    const [m] = groupPrompts(inu, [{ card_id: "c", direction: "meaning>kana" }]);
    expect(m!.ask[0]).toMatchObject({ accept: ["いぬ", "犬"] });
    expect(m!.ask[0]!.accept_with_warning).toBeUndefined();
  });
  it("chunks by row count and by JSON size", () => {
    expect(chunks(Array.from({ length: 1001 }, (_, i) => i)).map((c) => c.length)).toEqual([500, 500, 1]);
    const big = Array.from({ length: 10 }, () => "x".repeat(300_000));
    expect(chunks(big).map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
  });
});
