// Cookie sessions for the browser UI. The OAuth tokens used by claude.ai are separate.

const COOKIE = "__Host-flash_session";
const TTL_MS = 30 * 86_400_000;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256(s: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM web_sessions WHERE user_id = ? AND expires_at < ?`).bind(userId, now),
    env.DB.prepare(`INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(
      await sha256(token),
      userId,
      now,
      now + TTL_MS,
    ),
  ]);
  return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}`;
}

export async function sessionUser(env: Env, request: Request): Promise<{ userId: string; email: string } | null> {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, u.email FROM web_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<{ user_id: string; email: string }>();
  return row ? { userId: row.user_id, email: row.email } : null;
}

export async function destroySession(env: Env, request: Request): Promise<string> {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare(`DELETE FROM web_sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
