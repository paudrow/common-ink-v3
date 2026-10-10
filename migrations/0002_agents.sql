-- An agent a member has connected. It acts as that member (their role in each workspace, no more) and
-- stops working when they lose access. Only a SHA-256 hash of its token is kept; the token itself is
-- shown once, when the agent is connected.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX agents_by_person ON agents (person_id);
