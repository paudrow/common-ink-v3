-- Set on the row that stands in for someone who deleted their account, which what they wrote in a
-- workspace they shared is kept under. Nobody signs in as it: its email is at .invalid, which no mail reaches.
ALTER TABLE people ADD COLUMN former INTEGER NOT NULL DEFAULT 0;
-- When an admin deleted the workspace. From then nobody reaches it, and what it held is erased a
-- chunk at a time until the row itself goes.
ALTER TABLE workspaces ADD COLUMN deleting_at INTEGER;
CREATE INDEX workspaces_deleting ON workspaces (deleting_at) WHERE deleting_at IS NOT NULL;

-- What deleting an account finds its rows by, each column of src/core/erase.ts's PERSON_COLUMNS in a
-- large table, so the one batch that deletes it reads only what was theirs. Deleting the person's
-- row checks every column that refers to people too, by the same indexes. A column most rows leave
-- empty is indexed only where it is set, and one beside a `_kind` only where that says member, as the
-- statement says too.
CREATE INDEX notes_by_creator ON notes (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX notes_by_updater ON notes (updated_by) WHERE updated_by_kind = 'member';
CREATE INDEX notes_by_updater_owner ON notes (updated_by_owner) WHERE updated_by_owner IS NOT NULL;
CREATE INDEX notes_by_state_by ON notes (state_by) WHERE state_by_kind = 'member';
CREATE INDEX notes_by_released_from ON notes (released_from) WHERE released_from IS NOT NULL;
CREATE INDEX notes_by_released_by ON notes (released_by) WHERE released_by IS NOT NULL;
CREATE INDEX notes_by_owner_alone ON notes (private_owner) WHERE private_owner IS NOT NULL;
CREATE INDEX changes_by_owner ON changes (author_owner) WHERE author_owner IS NOT NULL;
CREATE INDEX labels_by_author ON labels (author_kind, author_id);
CREATE INDEX completions_by_author ON completions (author_kind, author_id);
CREATE INDEX completions_by_person ON completions (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX uploads_by_creator ON uploads (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX uploads_by_state_by ON uploads (state_by) WHERE state_by_kind = 'member';
CREATE INDEX uploads_by_released_from ON uploads (released_from) WHERE released_from IS NOT NULL;
CREATE INDEX uploads_by_released_by ON uploads (released_by) WHERE released_by IS NOT NULL;
CREATE INDEX uploads_by_owner_alone ON uploads (private_owner) WHERE private_owner IS NOT NULL;
CREATE INDEX grants_by_granter ON grants (granted_by);

-- What removing a note, and deleting a folder, check of what refers to it, a note or a folder at a
-- time, as erasing a workspace removes every one.
CREATE INDEX completions_by_daily_note ON completions (daily_note_id) WHERE daily_note_id IS NOT NULL;
CREATE INDEX grants_by_note ON grants (note_id) WHERE note_id IS NOT NULL;
CREATE INDEX grants_by_folder ON grants (folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX uploads_by_folder_alone ON uploads (folder_id);
