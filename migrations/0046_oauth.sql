-- Signing in with OAuth, so a hosted chat app (claude.ai, ChatGPT) can connect to /mcp where it
-- can't send a pasted token. An OAuth connection is an agent: consenting makes a row in `agents`, with
-- the limits the member chose, and everything that holds for an agent holds for it. What is new is how
-- its token is obtained: a code, traded for an access token (1 hour) and a refresh token (30 days).
-- Like an agent's token, every code and token is kept only as a SHA-256 hash of 256 random bits.

-- An app that registered itself (RFC 7591). Public clients only: none has a secret. Anyone can register
-- one, so a client that never sends anyone to sign in is removed after an hour, and one that never gets a
-- grant after a day.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  -- When it first sent someone to /oauth/authorize.
  requested_at INTEGER,
  -- A hash of the address it registered from, to count registrations by and for nothing else.
  registered_from TEXT
);

-- An authorization that was asked for and not yet answered: what /oauth/authorize was sent, kept for the
-- consent page. It is bound to the first person who opens it, and good for ten minutes and one answer.
-- Its id is in the consent page's address, so only a hash of it is kept, as for a code.
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  person_id TEXT REFERENCES people (id),
  -- A hash of the network the browser came from, to count waiting requests by and for nothing else.
  requested_from TEXT,
  created_at INTEGER NOT NULL
);

-- What consent hands the app, to be traded at /oauth/token within a minute, once. A traded code is kept
-- until it would have lapsed, with `used_at`, so a second try is seen and ends what the first was given.
CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- An access or a refresh token. `family` is one authorization's: a refresh token that is used twice ends
-- the family. A token is good only while its agent is (not disconnected, not expired), looked up each time.
CREATE TABLE oauth_tokens (
  hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents (id),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  family TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX oauth_tokens_by_family ON oauth_tokens (family);
CREATE INDEX oauth_tokens_by_agent ON oauth_tokens (agent_id);
CREATE INDEX oauth_codes_by_client ON oauth_codes (client_id);
CREATE INDEX oauth_requests_by_client ON oauth_requests (client_id);
-- What clearing out what has lapsed, and counting what is live, look at.
CREATE INDEX oauth_tokens_by_end ON oauth_tokens (expires_at);
CREATE INDEX oauth_requests_by_age ON oauth_requests (created_at);
CREATE INDEX oauth_codes_by_end ON oauth_codes (expires_at);
CREATE INDEX oauth_clients_unused ON oauth_clients (created_at) WHERE last_used_at IS NULL;
CREATE INDEX oauth_requests_by_source ON oauth_requests (requested_from, created_at) WHERE requested_from IS NOT NULL;
CREATE INDEX oauth_clients_by_source ON oauth_clients (registered_from, created_at) WHERE registered_from IS NOT NULL;

-- The app an agent was connected from, or null for an agent connected on the Agents page. `token_hash`
-- stays NOT NULL (and unique), so an OAuth agent keeps the hash of a random token that is never issued.
ALTER TABLE agents ADD COLUMN client_id TEXT REFERENCES oauth_clients (id);
CREATE INDEX agents_by_client ON agents (client_id) WHERE client_id IS NOT NULL;
