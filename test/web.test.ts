import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password";
import { Store } from "../src/db/store";

const BASE = "http://localhost";
const worker = (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default;
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(BASE + path, { redirect: "manual", ...init }));

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  call(`/api${path}`, {
    ...init,
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-Requested-With": "flash", ...(init.headers ?? {}) },
  });

describe("web ui", () => {
  beforeAll(async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u-web', 'web@example.com', ?, 0)`)
      .bind(await hashPassword("correct horse"))
      .run();
    await new Store(env.DB, "u-web").addWords("Japanese", [{ kanji: "犬", kana: "いぬ", meaning: "dog" }]);
  });

  it("redirects to login without a session; api answers 401", async () => {
    const app = await call("/app");
    expect(app.status).toBe(303);
    expect(app.headers.get("Location")).toBe("/login?next=%2Fapp");
    expect((await call("/api/decks")).status).toBe(401);
    expect((await call("/login")).status).toBe(200);
  });

  it("rejects a bad password and an off-site next", async () => {
    const bad = await call("/login", {
      method: "POST",
      body: new URLSearchParams({ email: "web@example.com", password: "nope", next: "/app" }),
    });
    expect(bad.status).toBe(401);
    const ok = await call("/login", {
      method: "POST",
      body: new URLSearchParams({ email: "web@example.com", password: "correct horse", next: "//evil.example" }),
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("Location")).toBe("/app");
    cookie = ok.headers.get("Set-Cookie")!.split(";")[0]!;
    expect(cookie).toMatch(/^__Host-flash_session=/);
  });

  it("serves the app with security headers", async () => {
    const app = await call("/app", { headers: { Cookie: cookie } });
    expect(app.status).toBe(200);
    expect(app.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await app.text()).toContain("<html");
  });

  it("review flow: due → check → rate", async () => {
    const due = (await (await api("/due")).json()) as any;
    const prompt = due.items[0].prompts[0];
    expect(due.items[0].faces.kanji).toBe("犬");
    const answers = prompt.ask.map((a: any) => ({ card_id: a.card_id, answer: a.face === "kana" ? "イヌ" : "cat" }));
    const checked = (await (await api("/check", { method: "POST", body: JSON.stringify({ answers }) })).json()) as any[];
    expect(checked.map((c) => [c.face, c.correct])).toEqual(
      prompt.ask.map((a: any) => [a.face, a.face === "kana"]),
    );
    const rated = await api("/rate", {
      method: "POST",
      body: JSON.stringify({ reviews: checked.map((c) => ({ card_id: c.card_id, rating: c.correct ? "good" : "again" })) }),
    });
    expect(rated.status).toBe(200);
    const src = await env.DB.prepare(`SELECT DISTINCT source FROM review_log WHERE user_id = 'u-web'`).all<{ source: string }>();
    expect(src.results.map((r) => r.source)).toEqual(["ui"]);
  });

  it("an unverified (IME kanji) answer is stored as verified: false", async () => {
    const notes = (await (await api("/notes?query=" + encodeURIComponent("犬"))).json()) as any[];
    const card = notes[0].cards.find((c: any) => c.direction === "kanji>kana").card_id;
    const checked = (await (await api("/check", { method: "POST", body: JSON.stringify({ answers: [{ card_id: card, answer: "犬" }] }) })).json()) as any[];
    expect(checked[0]).toMatchObject({ correct: true, verified: false });
    await api("/rate", { method: "POST", body: JSON.stringify({ reviews: [{ card_id: card, rating: "good", answer: "犬", verified: false }] }) });
    const row = await env.DB.prepare(`SELECT verified FROM review_log WHERE card_id = ? ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`).bind(card).first<{ verified: number }>();
    expect(row!.verified).toBe(0);
  });

  it("browse and edit notes, tags", async () => {
    const notes = (await (await api("/notes?query=" + encodeURIComponent("犬"))).json()) as any[];
    expect(notes).toHaveLength(1);
    const id = notes[0].note_id;
    const patched = (await (await api(`/notes/${id}`, { method: "PATCH", body: JSON.stringify({ meaning: "dog, hound", tags: ["animals"] }) })).json()) as any;
    expect(patched.meaning).toBe("dog, hound");
    expect(patched.tags).toEqual(["animals"]);
    const tags = (await (await api("/tags")).json()) as any[];
    expect(tags).toEqual([{ tag: "animals", notes: 1 }]);
    const detail = (await (await api(`/notes/${id}`)).json()) as any;
    expect(detail.history.length).toBe(3);
  });

  it("requires the CSRF header on writes and scopes to the user", async () => {
    const noHeader = await call("/api/rate", { method: "POST", headers: { Cookie: cookie }, body: "{}" });
    expect(noHeader.status).toBe(403);
    const other = await new Store(env.DB, "u-web").searchNotes({});
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u-x', 'x@example.com', 'x', 0)`).run();
    const theirs = await new Store(env.DB, "u-x").addWords("J", [{ kanji: "猫", kana: "ねこ", meaning: "cat" }]);
    expect((await api(`/notes/${theirs[0]!.note_id}`)).status).toBe(400);
    expect(other).toHaveLength(1);
  });

  it("logout ends the session", async () => {
    const out = await call("/logout", { method: "POST", headers: { Cookie: cookie } });
    expect(out.status).toBe(303);
    expect((await api("/decks")).status).toBe(401);
  });
});
