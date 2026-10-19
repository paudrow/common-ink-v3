-- A browser clipper signed in as the member. It is not an agent: notes it saves are the member's,
-- and it is not listed with the agents they connect. Only a SHA-256 hash of the token is kept.
CREATE TABLE clipper_grants (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  extension_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX clipper_grants_by_person ON clipper_grants (person_id);

-- note.create looks for the note an author already made with a write id, so a clip sent twice makes one note.
CREATE INDEX changes_by_author_write ON changes (author_id, write_id) WHERE write_id IS NOT NULL;
