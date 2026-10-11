-- What a change took back out when it wasn't an edit: an undo, a redo, or a revert, as JSON
-- {"how": "undo" | "redo" | "revert", "revisions": [...], "to": N}. Null for an edit.
ALTER TABLE changes ADD COLUMN reverts TEXT;

CREATE INDEX changes_by_author ON changes (author_kind, author_id, created_at);

-- A name on one revision of a note. A revision has at most one, and a note uses a name once.
CREATE TABLE labels (
  note_id TEXT NOT NULL REFERENCES notes (id),
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('member', 'agent', 'plugin')),
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, revision)
);

CREATE UNIQUE INDEX labels_by_name ON labels (note_id, name COLLATE NOCASE);
