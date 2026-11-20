import { Store, UserError } from "../db/store";
import { acceptedAnswers, splitDirection, type Direction } from "../model/directions";
import { checkAnswer } from "../model/grading";

// JSON API behind the browser UI. Every handler runs as the session's user
// through Store, which scopes all queries by user_id.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const err = (message: string, status: number) => json({ error: message }, status);

const num = (v: string | null) => (v == null || v === "" ? undefined : Number(v));
const str = (v: string | null) => (v == null || v === "" ? undefined : v);
const bool = (v: string | null) => (v == null || v === "" ? undefined : v === "true" || v === "1");

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new UserError("Body must be JSON");
  }
}

/** Look up cards + notes for answer checking, scoped to the user. */
async function checkAnswers(env: Env, userId: string, answers: { card_id: string; answer: string }[]) {
  if (!Array.isArray(answers) || answers.length > 50) throw new UserError("answers must be a list of at most 50");
  const { results } = await env.DB.prepare(
    `SELECT c.id AS card_id, c.direction, n.type, n.kanji, n.kana, n.meaning, n.front, n.back, n.extra
     FROM cards c JOIN notes n ON n.id = c.note_id
     WHERE c.user_id = ? AND c.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, JSON.stringify(answers.map((a) => a.card_id)))
    .all<{ card_id: string; direction: Direction; type: "word" | "basic"; kanji: string | null; kana: string | null; meaning: string | null; front: string | null; back: string | null; extra: string | null }>();
  const byId = new Map(results.map((r) => [r.card_id, r]));
  return answers.map(({ card_id, answer }) => {
    const c = byId.get(card_id);
    if (!c) throw new UserError(`No card ${card_id}`);
    const [show, face] = splitDirection(c.direction);
    const expected = acceptedAnswers({ ...c, extra: c.extra ? JSON.parse(c.extra) : null }, face, show);
    const shownText = (c as unknown as Record<string, string | null>)[show] ?? undefined;
    return { card_id, face, ...checkAnswer(face, String(answer ?? ""), expected, shownText), expected };
  });
}

export async function handleApi(request: Request, env: Env, user: { userId: string; email: string }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  const q = url.searchParams;
  const m = request.method;
  const store = new Store(env.DB, user.userId);

  // CSRF: a custom header can't be sent cross-origin without a CORS preflight, which we never allow.
  if (m !== "GET" && request.headers.get("X-Requested-With") !== "flash") return err("Missing X-Requested-With header", 403);

  try {
    if (m === "GET" && path === "/me") return json({ email: user.email });
    if (m === "GET" && path === "/decks") return json(await store.listDecks());
    if (m === "GET" && path === "/tags") {
      const { results } = await env.DB.prepare(
        `SELECT t.tag, COUNT(*) AS notes FROM note_tags t JOIN notes n ON n.id = t.note_id
         WHERE n.user_id = ? GROUP BY t.tag ORDER BY t.tag`,
      )
        .bind(user.userId)
        .all();
      return json(results);
    }
    if (m === "GET" && path === "/notes") {
      const type = str(q.get("type"));
      return json(
        await store.searchNotes({
          query: str(q.get("query")),
          deck: str(q.get("deck")),
          tag: str(q.get("tag")),
          type: type === "word" || type === "basic" ? type : undefined,
          limit: num(q.get("limit")),
          offset: num(q.get("offset")),
        }),
      );
    }
    const noteMatch = /^\/notes\/([^/]+)(\/directions)?$/.exec(path);
    if (noteMatch) {
      const id = decodeURIComponent(noteMatch[1]!);
      if (noteMatch[2]) {
        if (m !== "POST") return err("Method not allowed", 405);
        const b = await body<{ enable?: Direction[]; disable?: Direction[] }>(request);
        return json(await store.setDirections(id, b.enable ?? [], b.disable ?? []));
      }
      if (m === "GET") return json(await store.noteHistory(id));
      if (m === "PATCH") {
        const b = await body<Record<string, unknown>>(request);
        const allowed = ["deck", "kanji", "kana", "meaning", "front", "back", "notes", "tags"];
        const update = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
        // The web form edits the full tag list, so replace rather than merge.
        return json(await store.updateNote(id, { ...update, replace_tags: true } as Parameters<Store["updateNote"]>[1]));
      }
      if (m === "DELETE") return json(await store.deleteNote(id));
    }
    if (m === "GET" && path === "/due") {
      return json(
        await store.getDue({
          deck: str(q.get("deck")),
          tag: str(q.get("tag")),
          limit: num(q.get("limit")),
          new_limit: num(q.get("new_limit")),
          include_new: bool(q.get("include_new")),
          // Practice ahead of schedule (cards not due yet).
          include_not_due: bool(q.get("include_not_due")),
        } as Parameters<Store["getDue"]>[0]),
      );
    }
    if (m === "POST" && path === "/check") {
      const b = await body<{ answers: { card_id: string; answer: string }[] }>(request);
      return json(await checkAnswers(env, user.userId, b.answers));
    }
    if (m === "POST" && path === "/rate") {
      const b = await body<{ reviews: Parameters<Store["rate"]>[0] }>(request);
      if (!Array.isArray(b.reviews)) throw new UserError("reviews must be a list");
      return json(await store.rate(b.reviews.map((r) => ({ ...r, source: "ui" as const }))));
    }
    if (m === "GET" && path === "/stats") return json(await store.stats({ deck: str(q.get("deck")), days: num(q.get("days")) }));
    return err("Not found", 404);
  } catch (e) {
    if (e instanceof UserError) return err(e.message, 400);
    throw e;
  }
}
