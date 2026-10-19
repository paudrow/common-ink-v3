-- A workspace's record of third-party plugins: what is installed, what each is permitted, and who is
-- waiting on an admin. It is the workspace's, outside anyone's settings.

-- A plugin as it was installed: its manifest, as JSON, and its code, named by its SHA-256. The id is
-- made here and is the plugin's identity everywhere. An uninstalled plugin keeps its row, with
-- `removed_at` set and its code gone, so that History can still name it.
CREATE TABLE plugin_installs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  manifest TEXT NOT NULL,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  installed_by TEXT NOT NULL REFERENCES people (id),
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX plugin_installs_by_workspace ON plugin_installs (workspace_id, installed_at);

-- An admin's decision on one capability of one subject: an install's id, or `html` for HTML embeds.
-- `approved` says what was allowed, the capability as it was declared and the code, so an allowance
-- stands only while the plugin is still that. `origins` is for HTML embeds alone, as JSON.
CREATE TABLE plugin_permissions (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  subject TEXT NOT NULL,
  capability TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('allowed', 'off')),
  locked INTEGER NOT NULL DEFAULT 0,
  approved TEXT,
  origins TEXT,
  decided_by TEXT NOT NULL REFERENCES people (id),
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, subject, capability)
);

-- A member who isn't an admin asking for one. It allows nothing.
CREATE TABLE plugin_requests (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  subject TEXT NOT NULL,
  capability TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES people (id),
  at INTEGER NOT NULL,
  origins TEXT,
  PRIMARY KEY (workspace_id, subject, capability, requested_by)
);

-- What a frame is opened with when its network is allowed: the sites, under the SHA-256 of a token
-- that is good once and for a minute.
CREATE TABLE frame_grants (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  origins TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX frame_grants_by_expiry ON frame_grants (expires_at);

-- The member an agent or a plugin was acting for when it made a change. A plugin acts for every
-- member, so only the change says which. Null for a member's own, and for an agent's before this.
ALTER TABLE changes ADD COLUMN author_owner TEXT;
ALTER TABLE notes ADD COLUMN updated_by_owner TEXT;
