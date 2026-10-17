-- A member's own copy of a plugin's source, kept beside their settings: one per member per plugin
-- per workspace. It is no note: it is in no folder, no search, no history, and no operation reads
-- anyone's but the asker's own. `plugin_id` is an install's id, or the id of one of Common Ink's own
-- plugins that runs shut off. `running` is whether it runs in the original's place, for its author.
CREATE TABLE plugin_drafts (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  plugin_id TEXT NOT NULL,
  manifest TEXT NOT NULL,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  base_hash TEXT,
  running INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, person_id, plugin_id)
);

-- A member turning a full-trust plugin on for themself, for exactly the code named. It counts only
-- while that is still the plugin's code, so other code is off for everyone until each turns it on.
CREATE TABLE plugin_trust (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  plugin_id TEXT NOT NULL REFERENCES plugin_installs (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  code_hash TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id, person_id)
);
