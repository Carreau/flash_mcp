-- Browser sessions for the web UI (/app). The cookie holds a random token;
-- only its SHA-256 is stored.
CREATE TABLE web_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX web_sessions_user ON web_sessions(user_id);
