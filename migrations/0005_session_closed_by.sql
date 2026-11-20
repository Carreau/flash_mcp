-- How a study session was closed: 'session_end' (explicit), 'auto' (session_start closed it
-- after 12 h without session_end), NULL = open, or closed before this column existed.
-- An auto-closed session still accepts one later session_end (which sets 'session_end').
ALTER TABLE study_sessions ADD COLUMN closed_by TEXT;
