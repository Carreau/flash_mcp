// Romaji ⇄ hiragana, lenient enough for answers typed on the wrong keyboard.
// Accepts Hepburn, Kunrei and IME (wapuro) spellings: shi/si, chi/ti, tsu/tu,
// fu/hu, ji/zi, sha/sya, cha/tya/cya, n/nn/n', double consonants, macrons.

const BASE: Record<string, string> = {
  a: "あ", i: "い", u: "う", e: "え", o: "お",
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  sa: "さ", shi: "し", si: "し", su: "す", se: "せ", so: "そ",
  za: "ざ", ji: "じ", zi: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
  ta: "た", chi: "ち", ti: "ち", tsu: "つ", tu: "つ", te: "て", to: "と",
  da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
  ha: "は", hi: "ひ", fu: "ふ", hu: "ふ", he: "へ", ho: "ほ",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
  pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ",
  ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
  la: "ら", li: "り", lu: "る", le: "れ", lo: "ろ",
  wa: "わ", wo: "を", wi: "うぃ", we: "うぇ",
  vu: "ゔ", va: "ゔぁ", vi: "ゔぃ", ve: "ゔぇ", vo: "ゔぉ",
  fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ",
  she: "しぇ", je: "じぇ", che: "ちぇ",
  xa: "ぁ", xi: "ぃ", xu: "ぅ", xe: "ぇ", xo: "ぉ", xtu: "っ", xtsu: "っ", ltu: "っ",
  xya: "ゃ", xyu: "ゅ", xyo: "ょ",
};

// Palatalised: kya, sha/sya, cha/tya/cya, ja/jya/zya, nya, hya, mya, rya, gya, bya, pya, dya.
const YOON: Record<string, string> = { k: "き", g: "ぎ", n: "に", h: "ひ", m: "み", r: "り", l: "り", b: "び", p: "ぴ", d: "ぢ" };
const SMALL: Record<string, string> = { a: "ゃ", u: "ゅ", o: "ょ" };
for (const [c, k] of Object.entries(YOON)) for (const [v, s] of Object.entries(SMALL)) BASE[`${c}y${v}`] = k + s;
for (const [v, s] of Object.entries(SMALL)) {
  BASE[`sh${v}`] = BASE[`sy${v}`] = "し" + s;
  BASE[`ch${v}`] = BASE[`ty${v}`] = BASE[`cy${v}`] = "ち" + s;
  BASE[`j${v}`] = BASE[`jy${v}`] = BASE[`zy${v}`] = "じ" + s;
}

const MACRON: Record<string, string> = { ā: "aa", ī: "ii", ū: "uu", ē: "ee", ō: "ou", â: "aa", î: "ii", û: "uu", ê: "ee", ô: "ou" };

/** Whether a string looks like romaji (Latin letters, optional spaces/apostrophes/hyphens/macrons). */
export function isRomaji(s: string): boolean {
  return /[a-z]/i.test(s) && /^[a-zāīūēōâîûêô' \-.]+$/i.test(s.normalize("NFC").trim());
}

/**
 * Convert romaji to hiragana. Returns null if some part doesn't parse.
 * `longO` picks how ō is read: "ou" (べんきょう) or "oo" (とおい).
 */
export function romajiToHiragana(input: string, longO: "ou" | "oo" = "ou"): string | null {
  let s = input.normalize("NFC").toLowerCase().replace(/[āīūēōâîûêô]/g, (c) => (c === "ō" || c === "ô" ? longO : MACRON[c]!));
  s = s.replace(/[\s.]/g, "").replace(/-/g, "ー");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "ー") { out += "ー"; i++; continue; }
    if (c === "'") { i++; continue; }
    // n: nn, n' or n before a consonant / end → ん
    if (c === "n") {
      const nx = s[i + 1];
      if (nx === "n") { out += "ん"; i += 2; continue; }
      if (nx === "'" || nx === undefined || !/[aiueoy]/.test(nx)) { out += "ん"; i += 1; continue; }
    }
    // double consonant → っ (tch counts too: matcha)
    const nx = s[i + 1];
    if (/[bcdfghjklmpqrstvwxyz]/.test(c) && (nx === c || (c === "t" && nx === "c"))) { out += "っ"; i++; continue; }
    let matched = false;
    for (const len of [4, 3, 2, 1]) {
      const k = BASE[s.slice(i, i + len)];
      if (k) { out += k; i += len; matched = true; break; }
    }
    if (!matched) return null;
  }
  return out;
}

// Reverse table: hiragana → romaji (longest first), for answers typed on a Japanese keyboard by mistake.
const REVERSE: [string, string][] = Object.entries(BASE)
  .filter(([r]) => !/^(si|zi|ti|tu|hu|di|du|sy.|ty.|cy.|zy.|jy.|l.|x.*)$/.test(r))
  .map(([r, k]) => [k, r] as [string, string])
  .sort((a, b) => b[0].length - a[0].length);

/** Hiragana/katakana (possibly mixed with Latin, as IMEs produce: "どg") → romaji. */
export function kanaToRomaji(input: string): string {
  const s = input.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "っ") {
      const rest = kanaToRomaji(s.slice(i + 1, i + 3));
      out += rest[0] && /[a-z]/.test(rest[0]) ? rest[0] : "";
      i++;
      continue;
    }
    if (s[i] === "ん") { out += "n"; i++; continue; }
    const hit = REVERSE.find(([k]) => s.startsWith(k, i));
    if (hit) { out += hit[1]; i += hit[0].length; continue; }
    out += s[i];
    i++;
  }
  return out;
}
