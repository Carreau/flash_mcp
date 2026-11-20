-- verified = 0: judged correct but the answer couldn't be checked (e.g. IME produced the
-- shown kanji, or another kanji with the same reading, instead of the typed kana).
-- affects_schedule = 0: an "early" answer to a card that wasn't asked (volunteered by the
-- learner); kept in history, ignored by scheduling and by replay.
ALTER TABLE review_log ADD COLUMN verified INTEGER NOT NULL DEFAULT 1;
ALTER TABLE review_log ADD COLUMN affects_schedule INTEGER NOT NULL DEFAULT 1;
