// Checking typed answers. Lenient where Japanese input is ambiguous (katakana vs
// hiragana, full/half width, IME kanji, the wrong keyboard), strict about the
// actual reading. Keyboard slips count as correct but carry a `warning`.

import { isRomaji, kanaToRomaji, romajiToHiragana } from "./romaji";

const PUNCT = /[\s、。・，．,.!?！？「」『』()（）［］[\]"'“”‘’…〜~]/g;

/** Katakana → hiragana (ー and other marks are kept). */
export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function normalizeJa(s: string): string {
  return toHiragana(s.normalize("NFKC").toLowerCase()).replace(PUNCT, "");
}

const stripParens = (s: string) => s.replace(/\([^)]*\)|（[^）]*）/g, " ");

export function normalizeMeaning(s: string): string {
  return stripParens(s.normalize("NFKC").toLowerCase())
    .replace(/[.!?"'“”‘’…]/g, "")
    .replace(/^\s*(to|a|an|the)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "dog, hound; canine" → ["dog", "hound", "canine", "dog, hound; canine"] (normalised). */
function meaningAlternatives(accept: string[]): string[] {
  const out = new Set<string>();
  for (const a of accept) {
    out.add(normalizeMeaning(a));
    for (const part of stripParens(a).split(/[,;/]|\bor\b/)) {
      const n = normalizeMeaning(part);
      if (n) out.add(n);
    }
  }
  out.delete("");
  return [...out];
}

export function levenshtein(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length]!;
}

export interface Verdict {
  correct: boolean;
  /** Not right, but one small slip away (a missing っ or ゛, a typo). */
  close: boolean;
  /** Accepted, but typed in an unexpected way (romaji, IME kanji, Japanese keyboard left on). */
  warning?: string;
  /** false when the answer was accepted but the reading itself wasn't seen (IME kanji). */
  verified?: boolean;
}

const HAS_KANJI = /[\u3400-\u9fff\uf900-\ufaff]/;
const HAS_KANA = /[\u3041-\u3096\u30a1-\u30fa]/;

const WARN = {
  romaji: "Typed in romaji: try answering in kana.",
  ime: "Japanese completion turned this into kanji: make sure you know the reading.",
  jaKeyboard: "Japanese keyboard still on? Read back as romaji.",
  sameAsPrompt: "Autocompleted back to the kanji shown, so the reading can't be checked: type kana (or romaji) to make sure.",
};

/** Long-vowel mark → the vowel it lengthens, so かーど == かあど. */
function expandChoon(s: string): string {
  const vowelOf: Record<string, string> = {};
  "あかさたなはまやらわがざだばぱぁゃ".split("").forEach((c) => (vowelOf[c] = "あ"));
  "いきしちにひみりぎじぢびぴぃ".split("").forEach((c) => (vowelOf[c] = "い"));
  "うくすつぬふむゆるぐずづぶぷぅゅ".split("").forEach((c) => (vowelOf[c] = "う"));
  "えけせてねへめれげぜでべぺぇ".split("").forEach((c) => (vowelOf[c] = "え"));
  "おこそとのほもよろをごぞどぼぽぉょ".split("").forEach((c) => (vowelOf[c] = "お"));
  let out = "";
  for (const ch of s) out += ch === "ー" ? vowelOf[out.slice(-1)] ?? "ー" : ch;
  return out;
}

/**
 * @param shown the prompt text. For kanji>kana, an answer equal to the shown
 *   kanji almost always means the reading was typed and the IME completed it,
 *   so it's accepted with a warning.
 */
export function checkAnswer(face: string, answer: string, accept: string[], shown?: string): Verdict {
  if (face === "kana" && shown && HAS_KANJI.test(answer) && normalizeJa(answer) === normalizeJa(shown)) {
    return { correct: true, close: false, warning: WARN.sameAsPrompt, verified: false };
  }
  if (!answer.trim() || accept.length === 0) return { correct: false, close: false };

  if (face === "meaning") {
    if (HAS_KANA.test(answer) && !accept.some((a) => HAS_KANA.test(a))) {
      const romaji = kanaToRomaji(answer);
      const v = checkAnswer("meaning", romaji, accept);
      if (v.correct || v.close) return { ...v, warning: WARN.jaKeyboard };
      // The read-back is lossy (IME turned "ca" into か → "ka"), so allow one edit even on short words.
      const r = normalizeMeaning(romaji);
      if (meaningAlternatives(accept).some((a) => levenshtein(r, a) <= 1)) return { correct: false, close: true, warning: WARN.jaKeyboard };
      return v;
    }
    const alts = meaningAlternatives(accept);
    // The learner may give several meanings; any one matching is enough.
    const given = [normalizeMeaning(answer), ...answer.split(/[,;/]/).map(normalizeMeaning)].filter(Boolean);
    if (given.some((g) => alts.includes(g))) return { correct: true, close: false };
    const close = given.some((g) =>
      alts.some((a) => {
        const d = levenshtein(g, a);
        return (a.length >= 4 && d <= 1) || (a.length >= 8 && d <= 2);
      }),
    );
    return { correct: false, close };
  }

  // kana, kanji, front, back: compare Japanese-normalised strings.
  // Expected forms: as stored, without (explanations), and each side of " / ".
  const g = normalizeJa(answer);
  const forms = accept.flatMap((a) => [a, stripParens(a), ...stripParens(a).split(/\s+\/\s+|／/)]);
  const alts = [...new Set(forms.map(normalizeJa).filter(Boolean))];
  if (alts.includes(g)) {
    const viaIme = face === "kana" && HAS_KANJI.test(answer) && !alts.some((a) => a === g && !HAS_KANJI.test(a)) ;
    return viaIme ? { correct: true, close: false, warning: WARN.ime, verified: false } : { correct: true, close: false };
  }
  if ((face === "kana" || face === "back" || face === "front") && isRomaji(answer)) {
    const kanaAlts = alts.filter((a) => !HAS_KANJI.test(a)).map(expandChoon);
    // ō is ambiguous (べんきょう vs とおい): try both readings, exact matches first.
    const readings = (["ou", "oo"] as const)
      .map((longO) => romajiToHiragana(answer, longO))
      .filter((k): k is string => k != null)
      .map((k) => expandChoon(normalizeJa(k)));
    if (readings.some((k) => kanaAlts.includes(k))) return { correct: true, close: false, warning: WARN.romaji };
    if (readings.some((k) => kanaAlts.some((a) => [...a].length >= 2 && levenshtein(k, a) === 1))) {
      return { correct: false, close: true, warning: WARN.romaji };
    }
  }
  const close = alts.some((a) => {
    const d = levenshtein(g, a);
    const len = [...a].length;
    return face === "front" || face === "back" ? d <= Math.max(1, Math.floor(len * 0.15)) : len >= 2 && d === 1;
  });
  return { correct: false, close };
}
