# flash-mcp: Japanese-aware flashcard service as a remote MCP server

## Context
Kuliko stores each card as a flat question/answer pair ("Read: 妻 → つま: (my) wife"). That doesn't fit Japanese, where one word has three faces (kanji, kana, meaning) and each face→face link is a separate skill to schedule. The original brief asked for a personal flashcard service on Cloudflare (Workers + McpAgent + D1 + ts-fsrs) that works as a claude.ai custom connector. Scope for this project: **storage, scheduling and recall over MCP**. The review web UI is a later, separate project, so the data model must already support it (show 犬, the user types `いぬ, dog`, and each part gets its own grade).

Decisions so far:
- Two note types: `word` (triangle) and `basic` (front/back, optionally reversible) for sentences and grammar.
- A word gets 4 directions by default: kanji→kana, kanji→meaning, kana→meaning, meaning→kana. Any of them can be disabled per note or per deck. The schema allows all 6 (kana→kanji and meaning→kanji exist in the enum but aren't generated) so they can be turned on later without a migration.
- Each direction has its own independent FSRS schedule. Directions that share the same prompt face are grouped so they can be asked and graded together.
- Login is this Worker's own email/password page (PBKDF2 hashes in D1). There's no Google or GitHub app to register. Users are created with `npm run add-user`. Every row is keyed by `user_id` from day one.
- Kana answers may be typed as kanji (IME autocomplete). `get_due` lists the accepted forms per asked face, except when the kanji is the prompt.
- Few users, probably just me; data is isolated per user.

## Data model (D1, `migrations/0001_init.sql`)
- `users(id, email UNIQUE, name, created_at)`
- `decks(id, user_id, name, description, default_directions JSON, created_at)`, UNIQUE(user_id, name)
- `notes(id, user_id, deck_id, type 'word'|'basic', kanji NULL, kana NULL, meaning NULL, front NULL, back NULL, reversible, notes, extra JSON (alt readings/meanings, part of speech, example), external_id (kuliko id), created_at, updated_at)`
- `note_tags(note_id, tag)`, PK(note_id, tag)
- `cards(id, user_id, note_id, direction, suspended, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state, last_review)`, UNIQUE(note_id, direction), index (user_id, due)
  - direction enum: `kanji>kana, kanji>meaning, kana>meaning, meaning>kana, kana>kanji, meaning>kanji, front>back, back>front`
- `review_log(id, user_id, card_id, rating 1-4, reviewed_at, source 'chat'|'lesson'|'self'|'ui', answer TEXT NULL, session_id NULL, created_at)`

Rules (in `src/model/directions.ts`):
- A word with no kanji (e.g. さとう, カメラ) gets only kana>meaning and meaning>kana.
- Adding kanji to a note later creates the missing cards. Removing a face suspends the dependent cards rather than deleting them, so their history is kept.
- Disabling a direction sets `suspended=1`; history is kept.
- Words are deduplicated on (user_id, kanji, kana); adding one again returns the existing note.

## Scheduling (`src/model/scheduler.ts`, ts-fsrs)
- Card state is a cache: the review log is the source of truth.
- `rate` accepts `reviewed_at` in the past (lesson ratings are recorded afterwards). If `reviewed_at` ≥ `last_review`, apply it incrementally. Otherwise replay the card's whole log in time order to rebuild its state.
- Grouping for recall: `get_due` returns one item per note, listing that note's due directions grouped by prompt face. Example: `{note: 犬, prompts: [{show: "kanji", ask: ["kana","meaning"], card_ids: {...}}]}`. The caller (Claude in chat, or the future UI) shows one face, collects every answer, and rates each card separately.

## MCP tools (`src/mcp.ts`)
- `list_decks`, `create_deck(name, default_directions?)`
- `add_words(deck, words[{kanji?, kana, meaning, notes?, tags?, directions?, extra?}])`: returns created and deduplicated items
- `add_basic(deck, cards[{front, back, reversible?, notes?, tags?}])`
- `update_note(id, fields)`, `delete_note(id)`, `set_directions(note_id, enable[], disable[])`
- `search_notes(query?, deck?, tag?, limit)`: substring match on kanji/kana/meaning/front/back
- `get_due(deck?, tag?, directions?, limit)`: grouped as described above
- `rate(reviews[{card_id, rating: again|hard|good|easy, reviewed_at?, source?, answer?}])`
- `stats(deck?)`: due counts and retention **per direction** (e.g. "reads kanji well, weak at producing"), plus hardest notes by lapses
- `note_history(note_id)`: reviews per direction

## Auth (`src/auth/authorize.ts`, `src/index.ts`)
- `OAuthProvider` (workers-oauth-provider) makes the Worker its own OAuth server, with DCR and CIMD so claude.ai can register itself. `/mcp` is protected.
- `/authorize` is a single page. It shows which app is asking and where the tokens go (MCP consent requirements), and takes email + password. The consent handle is bound to the browser by a cookie. A wrong password re-issues a fresh handle. Failed logins are counted in D1, with an atomic upsert per email+IP (10) and per IP (30), over 15-minute windows.
- props `{userId}` reach the MCP layer, and `Store` scopes every query by it.
- MCP: stateless `createMcpHandler` from `agents/mcp/server` with `@modelcontextprotocol/server` v2. `McpAgent` is deprecated and we don't need sessions or Durable Objects.
- No secrets needed. KV binding `OAUTH_KV`. Var `MCP_RESOURCE` = the exact public `/mcp` URL.

## Layout
```
package.json, tsconfig.json, wrangler.jsonc, vitest.config.ts
migrations/0001_init.sql
src/index.ts            OAuthProvider wiring
src/auth/authorize.ts   login + consent page
src/auth/password.ts    PBKDF2 hashing
scripts/add-user.ts     create a login (prints wrangler command)
src/mcp.ts              MCP tool definitions (zod)
src/model/directions.ts direction rules, prompt grouping
src/model/scheduler.ts  ts-fsrs wrapper, incremental + replay
src/db/store.ts         D1 queries (all user-scoped)
scripts/import-kuliko.ts
test/*.test.ts
```

## Kuliko import (`scripts/import-kuliko.ts`)
I already have all 292 cards from the Kuliko connector as JSON. The script has two steps:
1. **Classify** the cards into a reviewable `import.json`:
   - "Read: X" → "kana: meaning" becomes a word with kanji.
   - "Say in Japanese: <short gloss>" → a single-word answer (optional `(漢字)`) becomes a word.
   - Everything else (sentences, "What does this mean?", grammar) becomes `basic`.
   - Kuliko tags (lesson-N, kanji-reading) are kept, and `external_id` = kuliko id.
2. **Load** the reviewed file through `wrangler d1 execute` (generated SQL).
   - Duplicates such as 友達 coming from two sources are merged.
   - Scheduling starts fresh: only 19 cards were ever reviewed, and they don't map cleanly to one direction.

## Setup prerequisites
- Development happens in the Linux VM. Node 22 is installed under `~/.local` and tests/`wrangler dev` run there.
- Cloudflare-facing wrangler commands are run **by you, outside the VM**:
  - `wrangler login`
  - `wrangler d1 create flash-mcp`, then put the database id in `wrangler.jsonc`
  - `wrangler kv namespace create OAUTH_KV`, then put the id in `wrangler.jsonc`
  - `wrangler d1 migrations apply flash-mcp --remote`
  - `wrangler deploy`
  - The exact list lives in `README.md`.

## Verification
- `vitest` (with `@cloudflare/vitest-pool-workers`) covers:
  - direction generation (kanji and kanji-less words, enable/disable, adding kanji later)
  - prompt grouping
  - backdated rating replay giving the same state as in-order rating
  - user isolation
- `wrangler dev` plus MCP Inspector against `http://localhost:8788/mcp`: log in, add 犬, get_due, rate kana and meaning separately, check stats.
- `wrangler deploy`, add the connector in claude.ai (Settings → Connectors → Add custom connector → `https://<worker>.workers.dev/mcp`), then run a short quiz in chat that ends with ratings being written.
- Run the import on the live D1 and check that the counts match (words vs basic).

## Teaching-agent features
The main client is Claude acting as a Japanese teacher: one call opens a session, one closes it.
- `session_start(decks?, kind?, since?, tz?)` creates a `study_sessions` row (migration `0003_study_sessions.sql`) and returns per deck: due counts per direction, cards rated again/hard since `since` (default: `ended_at` of the last ended session, else 7 days ago), up to 15 hardest notes, reviews since by source, plus the first due prompts.
- `session_end(session_id, reviews[], add_words?, add_basic?, deck?, tz?)` writes everything in **one** `db.batch`. Reviews name a card by `card_id` or by content (`{kanji?, kana, direction}` / `{front}`), matched after NFKC+trim (`src/model/match.ts`): kanji+kana exact; kana alone → the kana-only note, else the single note with that kana, else narrowed by meaning, else ambiguous. Unknown words with a meaning are created (deck defaults + the reviewed direction). Validation errors abort the whole call; ambiguous/unmatched/not-applicable entries are skipped and returned in `problems` with candidates. `Store.planRatings` is the shared core of `rate` and `session_end` (per-card time order, replay for backdated reviews) and only produces writes.
- A deck in a review entry (or lookup) only narrows: if nothing matches in that deck, matching is retried across all decks (`deck_mismatch` reported); before creating a note, existence is checked per user like the unique index, so a wrong deck never re-creates a word.
- `session_end` closes the session as the first statement of its batch, followed by a guard that re-inserts the session's primary key when `changes() = 0`: a concurrent or retried call fails the whole batch ("already ended") instead of duplicating reviews.
- Writes are set-based (`src/db/writes.ts`): notes, cards, tags, review_log rows and card states are each one `INSERT/UPDATE ... FROM json_each(?)` statement (chunked at 500 rows / ~900 KB of JSON; text fields are capped at 2000 chars, extra at 4000), so the statement count doesn't grow with rows (D1: 100 bound params per statement, queries per invocation are limited). `add_words`, `add_basic`, `bulk_import` (≤1000 rows, JSON or CSV), `update_notes` and `lookup` (≤500 words, 2 queries) use it.
- `get_due ask_mode`: `grouped` (default), `same_script` (never mix a kana/kanji answer with a meaning answer; prompts sharing the shown face are returned together), `single`. `include_not_due` practices ahead.
- Counts reconcile: get_due reports `held_back` (due cards held back by the sibling gap, with `until`); `due_review_cards + held_back.due_review_cards` = session_start's `due_reviews` (= `available_now + held_back`). `returned_cards` = cards in the returned prompts (limit/new_limit cut the rest).
- Meaning answers: `accept` holds the whole meaning plus each part split on `,`/`;` (and without parentheticals), plus `alt_meanings`. kanji>kana prompts carry `accept_with_warning: [kanji]` (IME output).
- Hardest notes (stats, session_start) only list struggling notes: lapses > 0, rated again/hard in the window, or reps >= 2 with stability < 1 day; may be empty.
- Review flags (migration `0004_review_flags.sql`): `verified: false` (correct but unverifiable IME kanji) schedules normally and is counted apart in stats; `early: true` (volunteered answer to a card not asked) is logged with `affects_schedule = 0`, never changes the schedule and is skipped by replay. Both are returned in note_history.
- `SERVER_VERSION` (src/mcp.ts, also the McpServer version) is returned by session_start; bump it whenever tools change. claude.ai caches tools/list and the stateless server can't push list_changed, so the instructions tell Claude to ask for a reconnect when it changes.
- Trap notes: `notes.trap` column; get_due items carry `after_answer: {trap, notes}` to show only after the answer.
- Decks: `update_deck(default_directions, apply_to_existing)` reconciles existing word notes (suspend, never delete).
- Tags merge on update (`replace_tags`, `remove_tags`); `add_words on_conflict: "update"` upserts (extra merged with json_patch, schedule kept).
- `delete_note(note_ids, confirm: true)` reports what was deleted.
- Times: the MCP layer adds `<field>_local` ("2026-11-20 15:04 (Europe/Paris)") next to every ISO timestamp; tz param, default `DEFAULT_TZ` var or Europe/Paris. `reviewed_at`/`since` accept ISO with offset or local "YYYY-MM-DD HH:mm".

## Out of scope (later)
Review web UI, audio/sound directions, kanji-component (single-character) tracking, soft coupling between sibling directions.

### Teacher feedback round 3
- `held_back.cards` (get_due, session_start's due) lists only held-back due reviews; held-back new cards are only counted in `held_back.new_cards`. Counts still reconcile (due_reviews = available_now + held_back).
- `server_version` = `${SERVER_DATE}+${tools_hash}`; `tools_hash` = first 12 hex of sha-256 over tool names, descriptions, annotations and input JSON schemas (computed once per isolate from a probe server, `src/mcp.ts`). session_start returns both; the instructions tell the agent to ask for a connector reconnect when it changes (no tools/list_changed in a stateless server).
- Unclosed sessions (migration `0005_session_closed_by.sql`, `study_sessions.closed_by`): session_start auto-closes the user's open sessions older than 12 h (`ended_at` = last review logged with that session_id, else `started_at`; `closed_by = 'auto'`) and returns `open_sessions` (younger than 12 h, excluding the new one). `since` default = latest `ended_at` of any closed session. session_end accepts an auto-closed session once (sets `closed_by = 'session_end'`); the single-shot guard rejects a second call.
- Meaning accept list: alt_meanings get the same normalisation as the main meaning (split on , ; and strip parentheticals, no un-stripped whole); entries with a parenthetical containing kana/kanji are never emitted (DB data untouched).
