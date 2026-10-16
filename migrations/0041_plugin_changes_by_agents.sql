-- An admin's agent may install, update and permit plugins as its admin does. Each of those keeps
-- which agent did it, beside the admin it acted for, so a plugin's page says "by <agent> for <admin>".
-- The `_via` columns are an agent's id, or null for the member themself.
ALTER TABLE plugin_installs ADD COLUMN installed_via TEXT;
ALTER TABLE plugin_installs ADD COLUMN updated_by TEXT;
ALTER TABLE plugin_installs ADD COLUMN updated_via TEXT;
ALTER TABLE plugin_permissions ADD COLUMN decided_via TEXT;
