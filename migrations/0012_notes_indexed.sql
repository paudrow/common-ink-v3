-- Whether what is derived from a note's text, its links, todos, projects and tags, has been made
-- from the text at least once since there were tables for all of it. Every note written before is
-- 0, and is indexed the first time it is written or its workspace's todos are listed. The rebuild
-- operations set a workspace's notes back to 0 to have them made again.
ALTER TABLE notes ADD COLUMN indexed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 1;
