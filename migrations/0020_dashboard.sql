-- A note a person chose to show on their own dashboard. It is theirs alone and says nothing in the
-- note. Whether it is shown is decided when it is listed, as for any note: by what they can see now.
CREATE TABLE pins (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  note_id TEXT NOT NULL REFERENCES notes (id),
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, person_id, note_id)
);
CREATE INDEX pins_by_note ON pins (note_id);

-- How far a person has read the changes their dashboard sums up: every change made before `read_until`
-- is one they said they had seen. It only ever moves forward, and only when they say so.
CREATE TABLE visits (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  read_until INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, person_id)
);
