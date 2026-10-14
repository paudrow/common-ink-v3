-- What the query language asks that nothing answered from an index before.

-- Whether a todo recurs, for has:recurrence. It is made from the line with the rest of the index.
-- Lines indexed before are marked by what they most likely say, and every note is read in again
-- for what its lines do say.
ALTER TABLE todos ADD COLUMN recurs INTEGER NOT NULL DEFAULT 0;
UPDATE todos SET recurs = 1 WHERE text LIKE '% every:%';
-- A todo's line as its words alone, without case or accents, for finding a word by its start as the
-- search index does. Until a note is read in again its lines are as close as SQL can make them.
ALTER TABLE todos ADD COLUMN words TEXT NOT NULL DEFAULT '';
UPDATE todos SET words = ' ' || lower(text);
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 4;

-- editor: and author: ask whether one author has a change to a note.
CREATE INDEX changes_by_note_author ON changes (note_id, author_kind, author_id);
-- They name the author, who is looked up by name.
CREATE INDEX people_by_name ON people (name COLLATE NOCASE);
CREATE INDEX agents_by_name ON agents (name COLLATE NOCASE);
-- sort:created-desc, and created: over a workspace.
CREATE INDEX notes_by_created ON notes (workspace_id, created_at);
