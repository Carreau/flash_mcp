import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password";

// Full flow a claude.ai connector goes through: register, log in on /authorize,
// exchange the code, then call MCP tools with the bearer token.

const BASE = "http://localhost";
const REDIRECT = "https://claude.example/api/mcp/auth_callback";
const worker = (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default;
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(BASE + path, init));

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function cookiesFrom(res: Response) {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
}

async function startAuthorize(clientId: string, challenge: string) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${BASE}/mcp`,
  });
  const res = await call(`/authorize?${q}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  return { html, handle, cookie: cookiesFrom(res) };
}

function postLogin(handle: string, cookie: string, email: string, password: string) {
  return call("/authorize", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
    body: new URLSearchParams({ handle, email, password, decision: "approve" }),
    redirect: "manual",
  });
}

let token = "";
let rpcId = 0;
async function mcp(method: string, params: unknown = {}) {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      Host: "localhost",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  // Either plain JSON or a single SSE "data:" event.
  const json = text.trim().startsWith("{") ? text : /data: (.*)/.exec(text)![1]!;
  return JSON.parse(json) as { result?: any; error?: any };
}
const tool = async (name: string, args: unknown) => {
  const r = await mcp("tools/call", { name, arguments: args });
  expect(r.error).toBeUndefined();
  return { isError: r.result.isError, data: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
};

describe("oauth + mcp end to end", () => {
  beforeAll(async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u-e2e', 'me@example.com', ?, 0)`)
      .bind(await hashPassword("correct horse"))
      .run();
  });

  it("locks out an (email, IP) pair after 10 failures but not other IPs", async () => {
    const tryLogin = async (ip: string, password: string) => {
      const reg = await call("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
      });
      const { client_id } = (await reg.json()) as { client_id: string };
      const { handle, cookie } = await startAuthorize(client_id, "a".repeat(43));
      const res = await call("/authorize", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
        body: new URLSearchParams({ handle, email: "me@example.com", password, decision: "approve" }),
        redirect: "manual",
      });
      return { status: res.status, body: res.status === 302 ? "" : await res.text() };
    };
    for (let i = 0; i < 10; i++) expect((await tryLogin("1.1.1.1", "bad")).body).toContain("Wrong email or password");
    expect((await tryLogin("1.1.1.1", "correct horse")).body).toContain("Too many failed attempts");
    expect((await tryLogin("2.2.2.2", "correct horse")).status).toBe(302);
  });

  it("unauthenticated /mcp gets a 401 pointing at resource metadata", async () => {
    const res = await call("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("registers, logs in, and uses the tools", async () => {
    const reg = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

    // Wrong password: page is shown again with a fresh handle.
    const first = await startAuthorize(client_id, challenge);
    expect(first.html).toContain("Claude");
    expect(first.html).toContain("claude.example");
    const bad = await postLogin(first.handle, first.cookie, "me@example.com", "nope");
    expect(bad.status).toBe(401);
    const badHtml = await bad.text();
    expect(badHtml).toContain("Wrong email or password");
    const retryHandle = /name="handle" value="([^"]+)"/.exec(badHtml)![1]!;

    // Right password on the retry form.
    const ok = await postLogin(retryHandle, cookiesFrom(bad), "me@example.com", "correct horse");
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("xyz");

    const tok = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: loc.searchParams.get("code")!,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
      }),
    });
    const tokBody = (await tok.json()) as { access_token: string; refresh_token?: string };
    expect(tok.status, JSON.stringify(tokBody)).toBe(200);
    expect(tokBody.refresh_token).toBeTruthy();
    token = tokBody.access_token;

    const init = await mcp("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.result.serverInfo.name).toBe("flash-mcp");
    expect(init.result.instructions).toContain("kanji");

    const list = await mcp("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [
        "add_basic", "add_words", "bulk_import", "create_deck", "delete_note", "get_due", "list_decks", "lookup", "note_history",
        "rate", "search_notes", "session_end", "session_start", "set_directions", "stats", "update_deck", "update_note", "update_notes",
      ],
    );

    const added = await tool("add_words", { deck: "Japanese", words: [{ kanji: "犬", kana: "いぬ", meaning: "dog" }] });
    expect(added.data[0].cards).toHaveLength(4);

    const due = await tool("get_due", {});
    const prompt = due.data.items[0].prompts[0];
    expect(prompt.show).toBe("kanji");
    const rated = await tool("rate", {
      reviews: prompt.ask.map((a: { card_id: string; face: string }) => ({
        card_id: a.card_id,
        rating: a.face === "kana" ? "good" : "again",
      })),
    });
    expect(rated.data).toHaveLength(2);
    expect(rated.data[0].next_due_local).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d \(Europe\/Paris\)$/);

    const err = await tool("rate", { reviews: [{ card_id: "nope", rating: "good" }] });
    expect(err.isError).toBe(true);

    // Data landed under the logged-in user.
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM review_log WHERE user_id = 'u-e2e'`).first<{ n: number }>();
    expect(n!.n).toBe(2);

    // Teaching session over the wire: start, end with a content-addressed review, guarded delete.
    const start = await tool("session_start", { kind: "voice", ask_mode: "same_script", tz: "Asia/Tokyo" });
    expect(start.data.since_local).toMatch(/\(Asia\/Tokyo\)$/);
    const end = await tool("session_end", {
      session_id: start.data.session_id,
      reviews: [{ kana: "ねこ", kanji: "猫", meaning: "cat", direction: "kanji>meaning", rating: "again", reviewed_at: "2020-01-01 10:00" }],
      deck: "Japanese",
    });
    expect(end.data.notes_created).toHaveLength(1);
    expect(end.data.reviews[0].reviewed_at).toBe("2020-01-01T09:00:00.000Z");
    const noConfirm = await tool("delete_note", { note_ids: [end.data.notes_created[0].note_id], confirm: false });
    expect(noConfirm.isError).toBe(true);
    // Length limits are enforced by the schema.
    const tooLong = await mcp("tools/call", { name: "add_words", arguments: { deck: "Japanese", words: [{ kana: "ながい", meaning: "x".repeat(2001) }] } });
    expect(tooLong.error ?? tooLong.result.isError).toBeTruthy();
    const del = await tool("delete_note", { note_ids: [end.data.notes_created[0].note_id], confirm: true });
    expect(del.data.deleted[0]).toMatchObject({ kanji: "猫", reviews: 1 });
  });
});
