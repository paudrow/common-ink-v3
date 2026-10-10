CREATE TABLE people (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unsorted_folder_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  PRIMARY KEY (workspace_id, person_id)
);

CREATE INDEX members_by_person ON members (person_id);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  parent_id TEXT REFERENCES folders (id),
  name TEXT NOT NULL
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  folder_id TEXT NOT NULL REFERENCES folders (id),
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX notes_by_workspace ON notes (workspace_id, updated_at);

CREATE TABLE changes (
  note_id TEXT NOT NULL REFERENCES notes (id),
  revision INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('member', 'agent', 'plugin')),
  author_id TEXT NOT NULL,
  diff TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  write_id TEXT,
  PRIMARY KEY (note_id, revision)
);

CREATE UNIQUE INDEX changes_by_write ON changes (note_id, write_id) WHERE write_id IS NOT NULL;
