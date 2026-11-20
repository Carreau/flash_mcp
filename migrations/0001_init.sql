-- Users log in on this Worker's own page (no third-party identity provider).
-- password_hash: "pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>", see src/auth/password.ts.
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT,
  password_hash  TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE decks (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  description         TEXT,
  -- JSON array of directions new word notes in this deck get; NULL = app default.
  default_directions  TEXT,
  created_at          INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

-- A note is the thing you learn (a word, or a free-form front/back).
-- Cards are derived from it, one per direction.
CREATE TABLE notes (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id             TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('word', 'basic')),
  -- word faces
  kanji               TEXT,
  kana                TEXT,
  meaning             TEXT,
  -- basic faces
  front               TEXT,
  back                TEXT,
  -- JSON array: which directions are switched on for this note.
  enabled_directions  TEXT NOT NULL,
  notes               TEXT,
  -- JSON object: alt readings/meanings, part of speech, example sentence...
  extra               TEXT,
  external_id         TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX notes_user_deck ON notes(user_id, deck_id);
CREATE UNIQUE INDEX notes_word_unique ON notes(user_id, COALESCE(kanji, ''), kana) WHERE type = 'word';
CREATE UNIQUE INDEX notes_external ON notes(user_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE note_tags (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX note_tags_tag ON note_tags(tag);

-- One schedulable card per (note, direction). FSRS state is a cache of review_log.
-- Times are unix epoch milliseconds.
CREATE TABLE cards (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN (
                    'kanji>kana', 'kanji>meaning', 'kana>meaning', 'meaning>kana',
                    'kana>kanji', 'meaning>kanji', 'front>back', 'back>front')),
  suspended       INTEGER NOT NULL DEFAULT 0,
  due             INTEGER NOT NULL,
  stability       REAL NOT NULL DEFAULT 0,
  difficulty      REAL NOT NULL DEFAULT 0,
  elapsed_days    INTEGER NOT NULL DEFAULT 0,
  scheduled_days  INTEGER NOT NULL DEFAULT 0,
  learning_steps  INTEGER NOT NULL DEFAULT 0,
  reps            INTEGER NOT NULL DEFAULT 0,
  lapses          INTEGER NOT NULL DEFAULT 0,
  state           INTEGER NOT NULL DEFAULT 0,
  last_review     INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (note_id, direction)
);
CREATE INDEX cards_user_due ON cards(user_id, suspended, due);

CREATE TABLE review_log (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at  INTEGER NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('chat', 'lesson', 'self', 'ui')),
  answer       TEXT,
  session_id   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX review_log_card ON review_log(card_id, reviewed_at);
CREATE INDEX review_log_user_time ON review_log(user_id, reviewed_at);

-- Failed-login counters (fixed 15-minute windows), keyed "ip:<ip>" and "email-ip:<email>|<ip>".
-- In D1 rather than KV so the increment is atomic and immediately consistent.
CREATE TABLE login_failures (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);
