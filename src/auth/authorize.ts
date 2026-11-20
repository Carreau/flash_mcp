import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { handleWeb } from "../web/routes";
import { checkLogin } from "./login";

// The /authorize page: one form that shows which app is asking (MCP consent
// requirements) and takes the user's email + password. No third-party IdP.

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(details: ConsentDescription, handle: string, opts: { error?: string; email?: string } = {}) {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · flash-mcp</title>
<style>
  body { font: 16px/1.5 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.3rem; }
  .who { background: #f4f4f6; border-radius: 8px; padding: .75rem 1rem; }
  .warn { color: #a33; }
  label { display: block; margin-top: .75rem; }
  input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: .5rem; font-size: 1rem; }
  .buttons { margin-top: 1.25rem; display: flex; gap: .5rem; }
  button { padding: .5rem 1rem; font-size: 1rem; }
  .error { color: #a33; font-weight: 600; }
  @media (prefers-color-scheme: dark) { body { background: #16161a; color: #ddd; } .who { background: #24242a; } }
</style></head><body>
<h1>Allow <em>${name}</em> to use your flashcards?</h1>
<div class="who">
  <p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ""}
  <p>It will be able to read, add and edit your cards and record reviews.</p>
</div>
${opts.error ? `<p class="error">${escape(opts.error)}</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label>Email <input type="email" name="email" autocomplete="username" required value="${escape(opts.email ?? "")}"></label>
  <label>Password <input type="password" name="password" autocomplete="current-password"></label>
  <div class="buttons">
    <button name="decision" value="approve">Sign in and allow</button>
    <button name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>
</body></html>`;
}

function textError(message: string, status = 400) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return (await handleWeb(request, env)) ?? textError("Not found", 404);

    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        consent.headers.set("Content-Type", "text/html; charset=utf-8");
        return new Response(page(details, consent.handle), { headers: consent.headers });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const handle = String(form.get("handle") ?? "");
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const email = String(form.get("email") ?? "").trim().toLowerCase();
        // Consume the handle first: this proves the form came from our page in this browser.
        const approved = await oauth.approveConsent(request, handle);
        const login = await checkLogin(env, request, email, String(form.get("password") ?? ""));
        if (!login.userId) {
          // Re-show the form with a fresh handle for the same, server-stored request.
          const details = await oauth.describeConsent(approved.request);
          const retry = await oauth.beginConsent(approved.request);
          retry.headers.set("Content-Type", "text/html; charset=utf-8");
          // Also send the cookie that clears the handle we just used.
          for (const c of approved.headers.getSetCookie()) retry.headers.append("Set-Cookie", c);
          return new Response(page(details, retry.handle, { error: login.error, email }), {
            status: 401,
            headers: retry.headers,
          });
        }
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: login.userId,
          metadata: { email },
          scope: approved.request.scope,
          props: { userId: login.userId },
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      return textError("Method not allowed", 405);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return textError(error.description ?? "Authorization failed.");
      if (error instanceof CimdFetchError) return textError("This app could not be verified.");
      throw error;
    }
  },
};
