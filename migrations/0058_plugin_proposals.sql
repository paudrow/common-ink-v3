-- What an admin's agent asked to do to the workspace's plugins: install or update one, change a
-- permission, or uninstall one. None of it is done until an admin approves it in the app, and a
-- request nobody answers lapses at expires_at. `op` is the operation as the agent sent it, run as it
-- was when approved; `seen_hash` is the code of the plugin it was about then, so an approval of a
-- plugin that has changed since does nothing. `plugin_id` is the id an install will take.
CREATE TABLE plugin_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  agent_id TEXT NOT NULL REFERENCES agents (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  plugin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  op TEXT NOT NULL,
  seen_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined')),
  decided_by TEXT REFERENCES people (id),
  decided_at INTEGER
);
CREATE INDEX plugin_proposals_by_workspace ON plugin_proposals (workspace_id, state, created_at);
