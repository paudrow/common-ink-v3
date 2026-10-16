-- Where a note is in its life: live, archived, or in Trash. A note that was removed from Trash has no
-- row at all. `state_at` is when it was archived or trashed, and `state_by` who did it.
ALTER TABLE notes ADD COLUMN state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'archived', 'trashed'));
ALTER TABLE notes ADD COLUMN state_at INTEGER;
ALTER TABLE notes ADD COLUMN state_by TEXT;
ALTER TABLE notes ADD COLUMN state_by_kind TEXT CHECK (state_by_kind IN ('member', 'agent', 'plugin'));
-- For a note in Trash, what restoring it returns it to: the state it had, and the folder it was in.
-- The folder has no reference, since it may be deleted while the note waits.
ALTER TABLE notes ADD COLUMN restores_as TEXT CHECK (restores_as IN ('live', 'archived'));
ALTER TABLE notes ADD COLUMN restores_to TEXT;
CREATE INDEX notes_in_trash ON notes (state_at) WHERE state = 'trashed';

-- The text of each note as search reads it. A row of `note_search` is found by the number
-- `note_search_rows` gives its note, since a full-text table can only be changed by row number.
CREATE TABLE note_search_rows (
  id INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes (id)
);
CREATE VIRTUAL TABLE note_search USING fts5 (title, text, tokenize = 'unicode61 remove_diacritics 2');

-- Every note is below 2 until its text has been put in `note_search`, as it was below 1 until its
-- links and todos were made.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 2;
