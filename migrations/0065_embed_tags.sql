-- A tag inside an embed's braces, as `::poll{question #garden}` has, is no tag of the note's. Every note is read in again.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 10;
