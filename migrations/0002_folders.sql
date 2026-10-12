ALTER TABLE notes ADD COLUMN snippet TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN open_todos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN updated_by TEXT NOT NULL DEFAULT '';

UPDATE notes SET updated_by = COALESCE(
  (SELECT author_id FROM changes WHERE note_id = notes.id ORDER BY revision DESC LIMIT 1),
  (SELECT person_id FROM members WHERE workspace_id = notes.workspace_id AND role = 'admin' ORDER BY person_id LIMIT 1),
  ''
);

CREATE INDEX notes_by_folder ON notes (folder_id, updated_at);

CREATE UNIQUE INDEX folders_by_name ON folders (workspace_id, COALESCE(parent_id, ''), name COLLATE NOCASE);

CREATE INDEX folders_by_parent ON folders (parent_id);
