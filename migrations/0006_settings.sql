-- One member's settings in one workspace: a JSON object, as they wrote it, holding only what differs from the defaults.
CREATE TABLE settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, person_id)
);
