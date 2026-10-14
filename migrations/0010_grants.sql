-- Who made a note: the person, or the person whose agent did. Only they can make it private. A note
-- that was never written has no change, so whoever it names as its last author made it.
ALTER TABLE notes ADD COLUMN created_by TEXT REFERENCES people (id);

UPDATE notes SET created_by = COALESCE(
  (SELECT COALESCE(a.person_id, p.id) FROM changes c
     LEFT JOIN people p ON c.author_kind = 'member' AND p.id = c.author_id
     LEFT JOIN agents a ON c.author_kind = 'agent' AND a.id = c.author_id
   WHERE c.note_id = notes.id AND c.revision = 1),
  (SELECT id FROM people WHERE id = notes.updated_by),
  (SELECT person_id FROM agents WHERE id = notes.updated_by)
);

-- A private note is hidden from every member but its owner, admins too. The owner is a member of the
-- note's workspace for as long as it is private.
ALTER TABLE notes ADD COLUMN private_owner TEXT REFERENCES people (id);

-- A private note whose owner an admin removed stops being private, since nobody could reach it. These
-- say whose it was, when, and who removed them.
ALTER TABLE notes ADD COLUMN released_from TEXT REFERENCES people (id);
ALTER TABLE notes ADD COLUMN released_at INTEGER;
ALTER TABLE notes ADD COLUMN released_by TEXT REFERENCES people (id);

CREATE INDEX notes_by_private_owner ON notes (workspace_id, private_owner) WHERE private_owner IS NOT NULL;

-- Access to one note or one folder. A `person` grant names an email, kept in lower case as a
-- person's is, and takes effect when `person_id` is set: at once when the email is already
-- someone's, and otherwise when they first sign in. A `public` or `signed_in` grant is a link: it
-- names nobody, only ever gives view, and opens for whoever holds its token.
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  note_id TEXT REFERENCES notes (id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'public', 'signed_in')),
  email TEXT,
  person_id TEXT REFERENCES people (id),
  token TEXT UNIQUE,
  access TEXT NOT NULL CHECK (access IN ('view', 'edit')),
  granted_by TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL,
  CHECK ((note_id IS NULL) <> (folder_id IS NULL)),
  CHECK ((kind = 'person') = (email IS NOT NULL)),
  CHECK ((kind = 'person') = (token IS NULL)),
  CHECK (kind = 'person' OR (access = 'view' AND person_id IS NULL))
);

-- An item has one grant for an email, so granting again changes that one, and one link.
CREATE UNIQUE INDEX grants_person_on_note ON grants (note_id, email) WHERE kind = 'person' AND note_id IS NOT NULL;
CREATE UNIQUE INDEX grants_person_on_folder ON grants (folder_id, email) WHERE kind = 'person' AND folder_id IS NOT NULL;
CREATE UNIQUE INDEX grants_link_on_note ON grants (note_id) WHERE kind <> 'person' AND note_id IS NOT NULL;
CREATE UNIQUE INDEX grants_link_on_folder ON grants (folder_id) WHERE kind <> 'person' AND folder_id IS NOT NULL;

CREATE INDEX grants_by_person ON grants (person_id, workspace_id) WHERE person_id IS NOT NULL;
CREATE INDEX grants_waiting ON grants (email) WHERE kind = 'person' AND person_id IS NULL;
CREATE INDEX grants_by_workspace ON grants (workspace_id);
