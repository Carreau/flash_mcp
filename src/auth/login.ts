import { DUMMY_HASH, verifyPassword } from "./password";

// Email/password check shared by the OAuth /authorize page and the web /login page.

// Per IP, and per (email, IP) so someone elsewhere can't lock the owner out.
const LIMITS = { ip: 30, emailIp: 10 };
const WINDOW_MS = 15 * 60_000;

async function failuresFor(env: Env, keys: string[], now: number) {
  const { results } = await env.DB.prepare(
    `SELECT key, count FROM login_failures WHERE key IN (SELECT value FROM json_each(?)) AND window_start > ?`,
  )
    .bind(JSON.stringify(keys), now - WINDOW_MS)
    .all<{ key: string; count: number }>();
  return new Map(results.map((r) => [r.key, r.count]));
}

function recordFailure(env: Env, key: string, now: number) {
  return env.DB.prepare(
    `INSERT INTO login_failures (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END`,
  ).bind(key, now, now - WINDOW_MS);
}

export async function checkLogin(env: Env, request: Request, email: string, password: string) {
  const now = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ipKey = `ip:${ip}`;
  const emailKey = `email-ip:${email}|${ip}`;
  const counts = await failuresFor(env, [ipKey, emailKey], now);
  if ((counts.get(ipKey) ?? 0) >= LIMITS.ip || (counts.get(emailKey) ?? 0) >= LIMITS.emailIp) {
    return { error: "Too many failed attempts. Try again in 15 minutes." };
  }
  const user = await env.DB.prepare(`SELECT id, password_hash FROM users WHERE email = ?`)
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    await env.DB.batch([recordFailure(env, ipKey, now), recordFailure(env, emailKey, now)]);
    return { error: "Wrong email or password." };
  }
  await env.DB.prepare(`DELETE FROM login_failures WHERE key = ?`).bind(emailKey).run();
  return { userId: user.id };
}

