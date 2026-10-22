-- A workspace's agents file: Markdown its admins and editors write to tell agents how the workspace is
-- organized, as a repository's AGENTS.md does. Agents read it and never write it. One row per workspace,
-- none until someone writes it. It is the workspace's, so it is a table of its own beside the workspace and
-- not a member's settings, with the revision and write id a write is checked against, as settings have.
CREATE TABLE agents_files (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces (id),
  text TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  write_id TEXT
);
