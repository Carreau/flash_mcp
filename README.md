# flash-mcp

A personal flashcard service for Japanese, running as a remote MCP server on Cloudflare
(Workers + D1 + FSRS scheduling). You add it to claude.ai as a custom connector. Claude can
then add words, quiz you and record your ratings, including ratings entered after a lesson.

- **word** notes have three faces: kanji, kana and meaning. Each direction is its own card
  with its own schedule. Four directions by default: kanji→kana, kanji→meaning,
  kana→meaning, meaning→kana. kana→kanji and meaning→kanji are tracked but not created.
  Words without kanji get only kana↔meaning.
- **basic** notes are front/back (optionally reversible) for sentences and grammar.
- Login uses this Worker's own email/password page. There's no Google or GitHub app to set
  up. Data is separated per user.

See `plan.md` for the design.

## MCP tools

- Sessions: `session_start` (overview + due prompts, opens a study session) and `session_end`
  (all ratings, new words and sentences of a lesson in one atomic write; cards can be named by
  kanji/kana instead of id).
- Review: `get_due` (`ask_mode`: grouped / same_script / single; `include_not_due`), `rate`,
  `stats`, `note_history`.
- Notes: `add_words` (`on_conflict: skip|update`), `add_basic`, `bulk_import` (JSON rows or CSV,
  up to 1000), `lookup` (does this word exist? up to 500), `search_notes`, `update_note`,
  `update_notes`, `set_directions`, `delete_note` (needs `confirm: true`).
- Decks: `list_decks`, `create_deck`, `update_deck` (default directions, optionally applied to
  existing notes).

Times are returned in UTC plus a `*_local` version in the `tz` parameter's zone (default
`DEFAULT_TZ` if set as a var, else Europe/Paris).

## Deploy (run these where wrangler is logged in)

```sh
npm install
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc    # your config; git-ignored
npm run cf-typegen                          # generates worker-configuration.d.ts

# 1. Create the database and KV namespace, then paste their ids into wrangler.jsonc
npx wrangler d1 create flash-mcp            # -> d1_databases[0].database_id
npx wrangler kv namespace create OAUTH_KV   # -> kv_namespaces[0].id

# 2. Set MCP_RESOURCE in wrangler.jsonc to https://flash-mcp.<your-subdomain>.workers.dev/mcp
#    (your workers.dev subdomain is shown in the Cloudflare dashboard, Workers & Pages).
#    It must be exactly the URL you give claude.ai.

# 3. Create the tables and deploy
npx wrangler d1 migrations apply flash-mcp --remote
npx wrangler deploy

# 4. Create your login. This prompts for a password and prints a wrangler command; run it.
npm run add-user -- you@example.com "Your Name"
```

If the URL printed by `wrangler deploy` differs from `MCP_RESOURCE`, fix `MCP_RESOURCE` and
deploy again. Tokens are bound to that exact URL.

## Add it to claude.ai

1. Go to **Settings → Connectors → Add custom connector**.
2. Name it `Flashcards` and set the URL to `https://flash-mcp.<your-subdomain>.workers.dev/mcp`.
   Leave the advanced OAuth client ID and secret empty.
3. Click **Connect**. Our login page opens. Sign in with the email and password from step 4.
4. In a chat, enable the connector and try *"quiz me on my due Japanese cards"* or
   *"add 犬 いぬ dog to my Japanese deck"*.

Claude stays connected through refresh tokens. A login expires after 90 days without use.

## Local development

```sh
cp wrangler.example.jsonc wrangler.jsonc   # if you haven't yet (tests and dev need it)
npm run cf-typegen                         # generated types for the type check
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply flash-mcp --local
npm run dev                      # http://localhost:8788/mcp
npm test                         # unit + store + full OAuth→MCP end-to-end tests
```

For the MCP Inspector, run `npx @modelcontextprotocol/inspector` and point it at
`http://localhost:8788/mcp`. Create a local user with `npm run add-user` and run the printed
command with `--local` instead of `--remote`.

## Adding another person

`npm run add-user -- friend@example.com`, then run the printed command. Running it again for an
existing email resets that person's password.

## Importing Kuliko flashcards

Save the Kuliko `list_learning_resources` output as `import/kuliko-raw.json` (`import/` is gitignored), then:

```sh
npm run import:classify -- import/kuliko-raw.json import/import.json   # prints counts + "unsure" list
# review/edit import/import.json (words: kanji?/kana/meaning/notes, basic: front/back)
npm run import:sql -- import/import.json --email you@example.com [--deck Japanese] > import/import.sql
npx wrangler d1 execute flash-mcp --remote --file import/import.sql
```

The user must exist first (`npm run add-user`). Ids are derived from email + Kuliko id and every
insert is `OR IGNORE`, so re-running the SQL is a no-op. All cards start as new; every note gets the
tag `kuliko` plus its Kuliko tags. A word that already exists for that user (same kanji + kana) is skipped.
