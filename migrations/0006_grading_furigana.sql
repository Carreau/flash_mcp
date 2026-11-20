-- "Grade later": answers typed in the UI that the UI can't judge (sentences, free production).
-- The card isn't asked again (nor counted as due) while it has an ungraded answer; the next
-- scheduling review of that card (rate / session_end, usually by the teacher agent) grades it.
CREATE TABLE pending_answers (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  answer       TEXT,
  answered_at  INTEGER NOT NULL,
  source       TEXT NOT NULL DEFAULT 'ui',
  created_at   INTEGER NOT NULL,
  graded_at    INTEGER,          -- NULL = waiting for grading
  review_id    TEXT              -- review_log row that graded it
);
CREATE INDEX pending_answers_open ON pending_answers(user_id, graded_at);
CREATE INDEX pending_answers_card ON pending_answers(card_id);

-- Teacher feedback on a review (shown to the learner in the UI), and when the learner saw it.
ALTER TABLE review_log ADD COLUMN feedback TEXT;
ALTER TABLE review_log ADD COLUMN feedback_seen_at INTEGER;

-- Schedule imported from another tool (JSON SchedState). Replays start from it instead of a new card.
ALTER TABLE cards ADD COLUMN initial_state TEXT;

-- Per-user settings (JSON object), e.g. {"furigana_known_days": 7}.
CREATE TABLE user_settings (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- session_end idempotency: a retried identical call returns the first result instead of failing.
ALTER TABLE study_sessions ADD COLUMN end_request_hash TEXT;
