-- A todo's indexed words were its whole line, so a due date sorted the row. They are the words
-- alone. Every note is read in again.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 8;
