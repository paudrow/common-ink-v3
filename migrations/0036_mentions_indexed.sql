-- Mentions are part of a note's index from here (0018 made the table; the query language's 0035 had the
-- index made again for todos at 4). Every note is read in again for its mentions.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 5;
