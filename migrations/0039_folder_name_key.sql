-- No two folders in one parent may have names that differ only in case, in any script.
-- folders_by_name folds case for unaccented letters only, as SQLite does. name_key is the name in
-- lower case as the server folds it, so two folders made at once can't both take one. Folders
-- made before have none: the server compares their names itself before it writes.
ALTER TABLE folders ADD COLUMN name_key TEXT;
CREATE UNIQUE INDEX folders_by_key ON folders (workspace_id, COALESCE(parent_id, ''), name_key) WHERE name_key IS NOT NULL;
