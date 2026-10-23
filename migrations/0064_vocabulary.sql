-- A workspace's vocabulary: the names and jargon its recordings are transcribed with, such as "Common Ink" or "jj",
-- told to Whisper as its prompt so they are spelled as the workspace spells them. It is the workspace's, written
-- by its admins and editors, and the last write is what it is, so it is a column and not a table with revisions.
ALTER TABLE workspaces ADD COLUMN vocabulary TEXT NOT NULL DEFAULT '';
