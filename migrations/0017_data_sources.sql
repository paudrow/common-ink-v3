-- Each table is made only if it is missing: this file was numbered 0016 for a while, and a Preview that
-- applied it under that name applies it again under this one.
-- A person's connection to where their data sources come from, such as their Google account. It is
-- the person's, in no workspace, and nothing reads it for anyone else. `access_token` and
-- `refresh_token` are sealed with a key the database doesn't hold (src/worker/vault.ts), and are
-- null for a provider that needs none. `scopes` is what the person agreed to, separated by spaces.
-- `broken` is set when the provider stopped taking the tokens, and `lapsed` names each data source
-- it stopped answering for though the tokens still work. Either way the person is asked to reconnect.
CREATE TABLE IF NOT EXISTS source_connections (
  person_id TEXT NOT NULL REFERENCES people (id),
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  scopes TEXT NOT NULL DEFAULT '',
  broken INTEGER NOT NULL DEFAULT 0,
  lapsed TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, provider)
);

-- What a note writes to reference a record: an id that says nothing about the record, and that only
-- the person who made it can follow. `record_id` is the data source's own id for the record.
CREATE TABLE IF NOT EXISTS source_refs (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  data_source TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (person_id, data_source, record_id)
);

-- The sample data's own record of what was changed in it, where dev sign-in is on. Nothing writes
-- here anywhere else: the sample data can't be connected in production.
CREATE TABLE IF NOT EXISTS sample_records (
  person_id TEXT NOT NULL REFERENCES people (id),
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (person_id, record_id)
);
