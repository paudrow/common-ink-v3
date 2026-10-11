-- When a person joined a workspace, so their workspaces are listed in the order they came to them.
ALTER TABLE members ADD COLUMN joined_at INTEGER NOT NULL DEFAULT 0;

UPDATE members SET joined_at = (SELECT created_at FROM workspaces WHERE id = members.workspace_id);

-- An admin's offer of a role in a workspace to whoever signs in with an email. It is pending until a
-- person with that email arrives, which makes them a member (accepted), or an admin takes it back
-- (revoked). The email is kept in lower case, as a person's is. The id is in the link the admin
-- shares, and opens nothing by itself: only the person with the email is let in.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  invited_by TEXT NOT NULL REFERENCES people (id),
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'revoked')),
  decided_at INTEGER
);

-- A workspace has one pending invite for an email, so inviting it again changes that one.
CREATE UNIQUE INDEX invites_pending ON invites (workspace_id, email) WHERE state = 'pending';

CREATE INDEX invites_by_email ON invites (email, state);
