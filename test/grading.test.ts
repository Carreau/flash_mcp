import { describe, expect, it } from "vitest";
import { checkAnswer, normalizeJa } from "../src/model/grading";

describe("grading", () => {
  it("kana: katakana/hiragana, width and spaces don't matter", () => {
    expect(normalizeJa("イヌ")).toBe("いぬ");
    expect(checkAnswer("kana", " イヌ ", ["いぬ"])).toEqual({ correct: true, close: false });
    expect(checkAnswer("kana", "ｶﾒﾗ", ["カメラ"]).correct).toBe(true);
    expect(checkAnswer("kana", "もう いちど", ["もういちど"]).correct).toBe(true);
  });

  it("kana: kanji typed via IME is accepted when listed", () => {
    expect(checkAnswer("kana", "犬", ["いぬ", "犬"]).correct).toBe(true);
    expect(checkAnswer("kana", "犬", ["いぬ"]).correct).toBe(false);
  });

  it("sentences: explanations in parentheses and ' / ' alternatives are optional", () => {
    const back = "にちようび、りょうしんは うちに きました。 (plain past; きていました = were over at the house)";
    expect(checkAnswer("back", "にちようび りょうしんは うちに きました", [back]).correct).toBe(true);
    expect(checkAnswer("back", "ドキュメントの こうしんを おねがいします", ["ドキュメントを こうしんして ください。 / ドキュメントの こうしんを おねがいします。"]).correct).toBe(true);
  });

  it("kana: one slip is close, not correct", () => {
    expect(checkAnswer("kana", "きて", ["きって"])).toEqual({ correct: false, close: true });
    expect(checkAnswer("kana", "ねこ", ["いぬ"])).toEqual({ correct: false, close: false });
  });

  it("meaning: alternatives, articles, parentheses, case", () => {
    expect(checkAnswer("meaning", "Dog", ["dog"]).correct).toBe(true);
    expect(checkAnswer("meaning", "wife", ["(my) wife"]).correct).toBe(true);
    expect(checkAnswer("meaning", "meal", ["cooked rice, meal"]).correct).toBe(true);
    expect(checkAnswer("meaning", "to walk", ["walk"]).correct).toBe(true);
    expect(checkAnswer("meaning", "cold", ["cold (weather)"]).correct).toBe(true);
    expect(checkAnswer("meaning", "frend", ["friend"])).toEqual({ correct: false, close: true });
    expect(checkAnswer("meaning", "cat", ["dog"]).correct).toBe(false);
    expect(checkAnswer("meaning", "", ["dog"]).correct).toBe(false);
  });

  it("romaji for a kana answer is accepted with a warning", () => {
    const v = checkAnswer("kana", "neko", ["ねこ", "猫"]);
    expect(v).toMatchObject({ correct: true, warning: expect.stringMatching(/romaji/) });
    expect(checkAnswer("kana", "kamera", ["カメラ"]).correct).toBe(true);
    expect(checkAnswer("kana", "kaado", ["カード"]).correct).toBe(true);
    expect(checkAnswer("kana", "benkyō", ["べんきょう"]).correct).toBe(true);
    expect(checkAnswer("kana", "tōi", ["とおい"]).correct).toBe(true);
    expect(checkAnswer("kana", "kitte", ["きって"]).correct).toBe(true);
    expect(checkAnswer("kana", "shinbun", ["しんぶん"]).correct).toBe(true);
    expect(checkAnswer("kana", "sinbun", ["しんぶん"]).correct).toBe(true);
    expect(checkAnswer("kana", "kin'en", ["きんえん"]).correct).toBe(true);
    expect(checkAnswer("kana", "tomodachi", ["ともだち"]).correct).toBe(true);
    expect(checkAnswer("kana", "ryoushin", ["りょうしん"]).correct).toBe(true);
    expect(checkAnswer("kana", "kite", ["きって"])).toMatchObject({ correct: false, close: true });
    expect(checkAnswer("kana", "inu", ["ねこ"]).correct).toBe(false);
  });

  it("IME kanji for a kana answer is accepted with a warning; plain kana has none", () => {
    expect(checkAnswer("kana", "猫", ["ねこ", "猫"])).toMatchObject({ correct: true, warning: expect.stringMatching(/kanji/) });
    expect(checkAnswer("kana", "ねこ", ["ねこ", "猫"]).warning).toBeUndefined();
  });

  it("a meaning typed with the Japanese keyboard on is read back as romaji", () => {
    expect(checkAnswer("meaning", "どg", ["dog"])).toMatchObject({ correct: true, warning: expect.stringMatching(/keyboard/) });
    // "ca" became か, so this reads back as "kat": close, not correct.
    expect(checkAnswer("meaning", "かt", ["cat"])).toMatchObject({ correct: false, close: true, warning: expect.any(String) });
    expect(checkAnswer("meaning", "いぬ", ["dog"]).correct).toBe(false);
  });

  it("kanji>kana: the shown kanji typed back (IME completion) is accepted with a warning", () => {
    expect(checkAnswer("kana", "犬", ["いぬ"], "犬")).toMatchObject({ correct: true, warning: expect.stringMatching(/reading can't be checked/) });
    expect(checkAnswer("kana", "猫", ["いぬ"], "犬").correct).toBe(false);
  });
});
