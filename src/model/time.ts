// Times are stored as epoch ms and returned as ISO UTC; tool outputs also get a
// human-readable local version in the learner's IANA time zone.

export const FALLBACK_TZ = "Europe/Paris";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function parts(ms: number, tz: string) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, s: +p.second! };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (Paris in winter: +3600000). */
export function tzOffset(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** "2026-11-20 15:04 (Europe/Paris)" */
export function formatLocal(ms: number, tz: string): string {
  const p = parts(ms, tz);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)} ${z(p.h)}:${z(p.mi)} (${tz})`;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parse a time given by the caller: epoch ms, ISO with Z or offset (Date.parse),
 * or a wall-clock "YYYY-MM-DD HH:mm[:ss]" / "YYYY-MM-DD" without offset, read in `tz`.
 * Returns NaN when unparseable.
 */
export function parseTime(v: string | number, tz: string): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  const m = LOCAL_RE.exec(s);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
    const wall = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +sec);
    // Two passes handle DST transitions.
    let t = wall - tzOffset(wall, tz);
    t = wall - tzOffset(t, tz);
    return t;
  }
  return Date.parse(s);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Walk a tool result and add `<key>_local` next to every ISO UTC timestamp.
 * Arrays of timestamps are left alone (none exist today).
 */
export function addLocalTimes<T>(data: T, tz: string): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        out[k] = walk(x);
        if (typeof x === "string" && ISO_RE.test(x) && !(`${k}_local` in v)) out[`${k}_local`] = formatLocal(Date.parse(x), tz);
      }
      return out;
    }
    return v;
  };
  return walk(data) as T;
}
