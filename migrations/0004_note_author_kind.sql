-- The member, agent, or plugin that changed a note last; `updated_by` names a person, an agent, or a plugin.
ALTER TABLE notes ADD COLUMN updated_by_kind TEXT NOT NULL DEFAULT 'member' CHECK (updated_by_kind IN ('member', 'agent', 'plugin'));

UPDATE notes SET updated_by_kind = 'agent' WHERE updated_by IN (SELECT id FROM agents);
