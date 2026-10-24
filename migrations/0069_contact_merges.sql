-- A contact a person merged into another, which was deleted where it was kept. `copy` is all its data
-- source held of it, every field, to make it again, and is emptied 30 days after the merge. The names
-- stay: a mention of the merged contact's name goes on finding the contact it was merged into,
-- `kept_id`, until it is restored (`restored_at`). It is the person's, in no workspace.
CREATE TABLE contact_merges (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  data_source TEXT NOT NULL,
  kept_id TEXT NOT NULL,
  kept_name TEXT NOT NULL,
  merged_id TEXT NOT NULL,
  merged_name TEXT NOT NULL,
  copy TEXT,
  created_at INTEGER NOT NULL,
  restored_at INTEGER
);
CREATE INDEX contact_merges_of ON contact_merges (person_id, created_at);
CREATE INDEX contact_merges_kept ON contact_merges (created_at) WHERE copy IS NOT NULL;

-- The contacts a merge is working on, each held for a couple of minutes at most, so two merges of one
-- contact at once can't each delete what the other kept.
CREATE TABLE contact_locks (
  person_id TEXT NOT NULL REFERENCES people (id),
  data_source TEXT NOT NULL,
  record_id TEXT NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (person_id, data_source, record_id)
);
