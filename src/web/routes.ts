import appHtml from "../ui/app.html";
import { checkLogin } from "../auth/login";
import { handleApi } from "./api";
import { createSession, destroySession, sessionUser } from "./session";

// Browser routes: /login, /logout, /app (single-page UI), /api/* (JSON).

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra } });

/** Only same-site paths, never "//host" or a scheme. */
function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/app";
}

function loginPage(next: string, error?: string, email = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · flash</title>
<style>
  body { font: 16px/1.5 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; max-width: 22rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; } label { display: block; margin-top: .75rem; }
  input { width: 100%; box-sizing: border-box; padding: .55rem; font-size: 1rem; }
  button { margin-top: 1.25rem; padding: .55rem 1.2rem; font-size: 1rem; }
  .error { color: #a33; font-weight: 600; }
  @media (prefers-color-scheme: dark) { body { background: #16161a; color: #ddd; } }
</style></head><body>
<h1>flash <span lang="ja">単語帳</span></h1>
${error ? `<p class="error">${escape(error)}</p>` : ""}
<form method="post" action="/login">
  <input type="hidden" name="next" value="${escape(next)}">
  <label>Email <input type="email" name="email" autocomplete="username" required value="${escape(email)}"></label>
  <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
  <button>Sign in</button>
</form>
</body></html>`;
}

const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { Location: to, ...headers } });

export async function handleWeb(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/") return redirect("/app");

  if (path === "/login") {
    if (request.method === "GET") return html(loginPage(safeNext(url.searchParams.get("next"))));
    if (request.method === "POST") {
      const form = await request.formData();
      const next = safeNext(String(form.get("next") ?? ""));
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      const login = await checkLogin(env, request, email, String(form.get("password") ?? ""));
      if (!login.userId) return html(loginPage(next, login.error, email), 401);
      return redirect(next, { "Set-Cookie": await createSession(env, login.userId) });
    }
  }

  if (path === "/logout" && request.method === "POST") {
    return redirect("/login", { "Set-Cookie": await destroySession(env, request) });
  }

  if (path === "/app" || path.startsWith("/api/")) {
    const user = await sessionUser(env, request);
    if (path === "/app") return user ? html(appHtml) : redirect(`/login?next=${encodeURIComponent("/app")}`);
    if (!user) return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401, headers: { "Content-Type": "application/json" } });
    return handleApi(request, env, user);
  }

  return null;
}
