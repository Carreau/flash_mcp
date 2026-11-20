// Furigana markup in text fields: {今日|きょう} (base + reading) or {漢字} (reading looked up
// at write time from the word note whose kanji face is exactly that text).
//
// Display rule: a span's reading is shown unless the learner can already read it, i.e. a word
// note with that kanji has a kanji>kana card in review with stability >= the user's threshold.

const SPAN = /\{([^{}|\n]+?)(?:\|([^{}|\n]*))?\}/g;
const KANJI = /[㐀-鿿豈-﫿々〆]/;
const KANA = /^[ぁ-ゖァ-ヺー・ー\s]+$/;

export type Segment = { text: string } | { base: string; reading: string | null };

/**
 * Split a marked-up string into plain text and spans. `{x}` without a reading only counts as a
 * span when x contains a kanji, so literal braces in grammar notes (e.g. "{noun}") stay text.
 */
export function parseMarkup(s: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of s.matchAll(SPAN)) {
    const base = m[1]!;
    const reading = m[2] === undefined ? null : m[2].trim() || null;
    if (m[2] === undefined && !KANJI.test(base)) continue;
    if (m.index! > last) out.push({ text: s.slice(last, m.index) });
    out.push({ base, reading });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

export function hasMarkup(s: string | null | undefined): boolean {
  return !!s && parseMarkup(s).some((x) => "base" in x);
}

/** Text with the markup removed: {今日|きょう}は → 今日は. */
export function plainText(s: string): string {
  return parseMarkup(s).map((x) => ("base" in x ? x.base : x.text)).join("");
}

/** Text with every span replaced by its reading (きょうは), or null if a span has no reading. */
export function readingText(s: string): string | null {
  let out = "";
  for (const x of parseMarkup(s)) {
    if (!("base" in x)) out += x.text;
    else if (x.reading) out += x.reading;
    else return null;
  }
  return out;
}

/** Bases of spans that have no reading yet ({漢字}). */
export function bareBases(s: string): string[] {
  return parseMarkup(s).flatMap((x) => ("base" in x && !x.reading ? [x.base] : []));
}

/** Every span base (for the "known reading" lookup). */
export function spanBases(s: string): string[] {
  return parseMarkup(s).flatMap((x) => ("base" in x ? [x.base] : []));
}

/** Rewrite bare spans whose base has a reading in `readings`; others are left as they are. */
export function fillReadings(s: string, readings: ReadonlyMap<string, string>): string {
  return parseMarkup(s)
    .map((x) => {
      if (!("base" in x)) return x.text;
      const r = x.reading ?? readings.get(x.base) ?? null;
      return r ? `{${x.base}|${r}}` : `{${x.base}}`;
    })
    .join("");
}

/** A reading should be kana; returns the spans whose reading isn't. */
export function badReadings(s: string): { base: string; reading: string }[] {
  return parseMarkup(s).flatMap((x) => ("base" in x && x.reading && !KANA.test(x.reading) ? [{ base: x.base, reading: x.reading }] : []));
}

export interface RubySpan {
  text: string;
  reading: string | null;
  /** Show the reading (the learner can't read this yet, or there is no word note for it). */
  show: boolean;
}

/** Spans for <ruby> rendering. `known(base)`: the learner reads this base reliably. */
export function rubySpans(s: string, known: (base: string) => boolean): RubySpan[] {
  return parseMarkup(s).map((x) =>
    "base" in x ? { text: x.base, reading: x.reading, show: !!x.reading && !known(x.base) } : { text: x.text, reading: null, show: false },
  );
}

/** Plain text with the readings to show in brackets: 今日(きょう)は 雨です. */
export function displayText(spans: readonly RubySpan[]): string {
  return spans.map((x) => (x.show && x.reading ? `${x.text}(${x.reading})` : x.text)).join("");
}
