-- Agent tokens last 90 days by default, may be pinned to one workspace, and may be read-only. A token has
-- an optional label, so a member can tell two tokens of one agent name apart ("Claude" on the laptop and
-- on the server). Names are not unique.
ALTER TABLE agents ADD COLUMN label TEXT;
ALTER TABLE agents ADD COLUMN expires_at INTEGER;
ALTER TABLE agents ADD COLUMN workspace_id TEXT REFERENCES workspaces (id);
ALTER TABLE agents ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;

-- Tokens made before this migration (only in Previews) get the default 90 days from when they were made.
UPDATE agents SET expires_at = created_at + 90 * 86400000 WHERE expires_at IS NULL;
