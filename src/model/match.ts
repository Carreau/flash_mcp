import { plainText } from "./furigana";

// Content addressing: find a note from what the teacher remembers of it
// (kanji + kana, or kana alone, or a basic note's front) instead of a card id.

export const normJa = (s: string | null | undefined) => (s == null ? "" : s.normalize("NFKC").trim());

const normMeaning = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export interface MatchNote {
  id: string;
  type: "word" | "basic";
  kanji: string | null;
  kana: string | null;
  meaning: string | null;
  front: string | null;
  back: string | null;
  deck_name: string;
}

export type MatchResult<N extends MatchNote> =
  | { status: "found"; note: N; deck_mismatch?: boolean }
  | { status: "ambiguous"; candidates: N[] }
  /** candidates: notes sharing the kana (for a kanji+kana query), as hints. */
  | { status: "not_found"; candidates: N[] };

function meaningMatches(noteMeaning: string | null, q: string): boolean {
  if (!noteMeaning) return false;
  const want = normMeaning(q);
  const full = normMeaning(noteMeaning);
  return full === want || full.split(/[,;/]/).some((p) => p.trim() === want);
}

/**
 * In-memory index over candidate notes. Matching rules:
 * - kanji + kana: exact match on both (after NFKC + trim).
 * - kana only: the kana-only note with that kana, else the single note with that kana;
 *   several notes share it -> narrowed by meaning if given, else ambiguous.
 * - deck narrows the candidates but is never required, and never hides a match in another deck.
 */
export class NoteIndex<N extends MatchNote> {
  private byKana = new Map<string, N[]>();
  private byFront = new Map<string, N[]>();

  constructor(notes: Iterable<N> = []) {
    for (const n of notes) this.add(n);
  }

  add(n: N) {
    const [map, key] = n.type === "word" ? [this.byKana, normJa(n.kana)] : [this.byFront, normJa(plainText(n.front ?? ""))];
    const list = map.get(key) ?? [];
    if (!list.some((x) => x.id === n.id)) list.push(n);
    map.set(key, list);
  }

  /**
   * The deck only narrows: when nothing (or nothing unique) matches inside the
   * deck, matching is retried across all decks, and a match found there is
   * returned with deck_mismatch. So a note is never re-created because the
   * teacher named the wrong deck.
   */
  matchWord(q: { kanji?: string | null; kana: string; deck?: string | null; meaning?: string | null }): MatchResult<N> {
    const all = this.byKana.get(normJa(q.kana)) ?? [];
    return this.narrow(all, q.deck, (c) => matchWordIn(c, q));
  }

  matchBasic(q: { front: string; deck?: string | null }): MatchResult<N> {
    // Fronts compare without furigana markup ({今日|きょう} == 今日).
    const all = this.byFront.get(normJa(plainText(q.front))) ?? [];
    return this.narrow(all, q.deck, (c) =>
      c.length === 1 ? { status: "found", note: c[0]! } : c.length > 1 ? { status: "ambiguous", candidates: c } : { status: "not_found", candidates: [] },
    );
  }

  private narrow(all: N[], deck: string | null | undefined, match: (c: N[]) => MatchResult<N>): MatchResult<N> {
    if (!deck) return match(all);
    const inDeck = match(all.filter((n) => n.deck_name === deck));
    if (inDeck.status === "found") return inDeck;
    const global = match(all);
    if (global.status === "found") return { ...global, deck_mismatch: true };
    return inDeck.status === "ambiguous" ? inDeck : global;
  }
}

function matchWordIn<N extends MatchNote>(c: N[], q: { kanji?: string | null; meaning?: string | null }): MatchResult<N> {
  const kanji = normJa(q.kanji);
  if (kanji) {
    const exact = c.filter((n) => normJa(n.kanji) === kanji);
    if (exact.length === 1) return { status: "found", note: exact[0]! };
    if (exact.length > 1) return { status: "ambiguous", candidates: exact };
    return { status: "not_found", candidates: c };
  }
  const kanaOnly = c.filter((n) => !normJa(n.kanji));
  if (kanaOnly.length === 1) return { status: "found", note: kanaOnly[0]! };
  if (c.length === 1) return { status: "found", note: c[0]! };
  if (c.length === 0) return { status: "not_found", candidates: [] };
  if (q.meaning) {
    const m = c.filter((n) => meaningMatches(n.meaning, q.meaning!));
    if (m.length === 1) return { status: "found", note: m[0]! };
  }
  return { status: "ambiguous", candidates: c };
}

/** Raw and NFKC forms of the given strings, for an SQL `IN (json_each(?))` prefilter. */
export function lookupKeys(values: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    out.add(v.trim());
    out.add(normJa(v));
  }
  out.delete("");
  return [...out];
}
