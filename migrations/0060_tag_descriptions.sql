-- What a tag is for, written by a member or their agent so that whoever tags a note, an agent most
-- of all, can choose by it. A tag is still there only while a note has it: this is what is said of
-- it, kept by the tag's name in lower case, and kept while no note has the tag, until someone takes
-- it away. `updated_by` is the member who last wrote it, and `updated_via` their agent when it was one.
CREATE TABLE tag_descriptions (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  tag TEXT NOT NULL,
  description TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES people (id),
  updated_via TEXT REFERENCES agents (id),
  PRIMARY KEY (workspace_id, tag)
);
CREATE INDEX tag_descriptions_by_person ON tag_descriptions (updated_by);
