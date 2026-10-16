-- A note's title is now its first heading's words without their markdown, or its first line of words.
-- The titles and snippets stored by the older rule are made again the next time notes are listed.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 6;
