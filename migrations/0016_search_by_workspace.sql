-- `note_search` gains the workspace of each note, so a search is asked for one workspace's notes and
-- walks no other's. A full-text table can't be altered, so it is made again, and every note is below 3
-- until its text has been put in the new one.
DROP TABLE note_search;
CREATE VIRTUAL TABLE note_search USING fts5 (workspace, title, text, tokenize = 'unicode61 remove_diacritics 2');
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 3;
