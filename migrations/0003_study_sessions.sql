-- Teaching-agent features.

-- Short "trap" note shown after the answer (e.g. "ともだちに, not を", "午 noon, not 牛 cow").
ALTER TABLE notes ADD COLUMN trap TEXT;

-- One row per study session opened by session_start and closed by session_end.
-- review_log.session_id points here (no FK: older rows may carry free-form ids).
CREATE TABLE study_sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT,            -- 'text' | 'voice' | NULL
  decks       TEXT,            -- JSON array of deck names, NULL = all decks
  since       INTEGER NOT NULL,-- start of the "since last time" window reported by session_start
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  summary     TEXT             -- small JSON written by session_end
);
CREATE INDEX study_sessions_user_ended ON study_sessions(user_id, ended_at);
CREATE INDEX review_log_session ON review_log(session_id) WHERE session_id IS NOT NULL;
