-- A file in a workspace, in one folder. Its bytes are in the bucket under its id, and nowhere is its
-- name used as a path. Who may see it is decided as for a note: by its folder, a grant on it, and
-- whether it is private.
--
-- `state` is where it is in its life. `pending`: the row was made and the bytes are still arriving,
-- so there may be nothing in the bucket yet. `live`, `archived` and `trashed` are a note's states.
-- `removing`: it is being removed for good, so the bytes may already be gone. Nothing is ever read
-- of an upload that is pending or removing, and one left in either state is cleared away later.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  folder_id TEXT NOT NULL REFERENCES folders (id),
  -- The file's name as it was given, for showing. Data only.
  name TEXT NOT NULL,
  -- What the bytes are served as, decided here from the name's ending and the first bytes.
  type TEXT NOT NULL,
  -- As many bytes as the upload said it would send, then as many as arrived.
  size INTEGER NOT NULL,
  -- SHA-256 of the bytes, in hex. Null while pending.
  hash TEXT,
  -- For an image whose size could be read from its bytes.
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  -- The person who uploaded it, or whose agent did.
  created_by TEXT REFERENCES people (id),
  -- The member or agent who uploaded it.
  uploaded_by TEXT NOT NULL,
  uploaded_by_kind TEXT NOT NULL CHECK (uploaded_by_kind IN ('member', 'agent', 'plugin')),
  private_owner TEXT REFERENCES people (id),
  released_from TEXT REFERENCES people (id),
  released_at INTEGER,
  released_by TEXT REFERENCES people (id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'live', 'archived', 'trashed', 'removing')),
  state_at INTEGER,
  state_by TEXT,
  state_by_kind TEXT CHECK (state_by_kind IN ('member', 'agent', 'plugin')),
  restores_as TEXT CHECK (restores_as IN ('live', 'archived')),
  restores_to TEXT
);

CREATE INDEX uploads_by_folder ON uploads (workspace_id, folder_id);
CREATE INDEX uploads_in_trash ON uploads (state_at) WHERE state = 'trashed';
CREATE INDEX uploads_unsettled ON uploads (state) WHERE state IN ('pending', 'removing');
CREATE INDEX uploads_by_private_owner ON uploads (workspace_id, private_owner) WHERE private_owner IS NOT NULL;

-- Which uploads each note's text refers to, from every ::image{id}, ::file{id}, ::video{id} and
-- ::audio{id} outside code. Like the links it is kept with every change to a note's text and can be
-- made again from the text. `upload_id` has no reference: it is what the note says, whether or not
-- there is such an upload.
CREATE TABLE upload_refs (
  note_id TEXT NOT NULL REFERENCES notes (id),
  upload_id TEXT NOT NULL,
  PRIMARY KEY (note_id, upload_id)
);
CREATE INDEX upload_refs_by_upload ON upload_refs (upload_id);

-- Notes written before there was a table for these have theirs made the next time an upload's uses are asked for.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 5;

-- A grant can be on an upload, as on a note. A link can't: a link opens a note or a folder.
-- A table's checks can't be changed, so the table is made again with the same rows.
CREATE TABLE grants_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  note_id TEXT REFERENCES notes (id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders (id) ON DELETE CASCADE,
  upload_id TEXT REFERENCES uploads (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'public', 'signed_in')),
  email TEXT,
  person_id TEXT REFERENCES people (id),
  token TEXT UNIQUE,
  access TEXT NOT NULL CHECK (access IN ('view', 'edit')),
  granted_by TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL,
  named INTEGER NOT NULL DEFAULT 0,
  CHECK ((note_id IS NOT NULL) + (folder_id IS NOT NULL) + (upload_id IS NOT NULL) = 1),
  CHECK ((kind = 'person') = (email IS NOT NULL)),
  CHECK ((kind = 'person') = (token IS NULL)),
  CHECK (kind = 'person' OR (access = 'view' AND person_id IS NULL AND upload_id IS NULL))
);
INSERT INTO grants_new (id, workspace_id, note_id, folder_id, kind, email, person_id, token, access, granted_by, created_at, named)
  SELECT id, workspace_id, note_id, folder_id, kind, email, person_id, token, access, granted_by, created_at, named FROM grants;
DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;

CREATE UNIQUE INDEX grants_person_on_note ON grants (note_id, email) WHERE kind = 'person' AND note_id IS NOT NULL;
CREATE UNIQUE INDEX grants_person_on_folder ON grants (folder_id, email) WHERE kind = 'person' AND folder_id IS NOT NULL;
CREATE UNIQUE INDEX grants_person_on_upload ON grants (upload_id, email) WHERE kind = 'person' AND upload_id IS NOT NULL;
CREATE UNIQUE INDEX grants_link_on_note ON grants (note_id) WHERE kind <> 'person' AND note_id IS NOT NULL;
CREATE UNIQUE INDEX grants_link_on_folder ON grants (folder_id) WHERE kind <> 'person' AND folder_id IS NOT NULL;
CREATE INDEX grants_by_person ON grants (person_id, workspace_id) WHERE person_id IS NOT NULL;
CREATE INDEX grants_waiting ON grants (email) WHERE kind = 'person' AND person_id IS NULL;
CREATE INDEX grants_by_workspace ON grants (workspace_id);
