-- A note's title and snippet (0025) and the uploads it refers to (0019) are part of its index with its
-- mentions (0036). Every note is read in again for all of them.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 7;
