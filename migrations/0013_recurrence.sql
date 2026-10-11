-- Which note is a member's daily note for a day. A member has one for a day, which is what keeps
-- two completions at once from making two. The note says nothing of whose it is: this does.
CREATE TABLE daily_notes (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  -- A calendar date, YYYY-MM-DD, in the member's time zone.
  day TEXT NOT NULL,
  note_id TEXT NOT NULL UNIQUE REFERENCES notes (id),
  PRIMARY KEY (workspace_id, person_id, day)
);

-- Each time a recurring todo was checked off, written in the batch that changed its note. The todo
-- is named by where its line started once the change at `revision` was made, which later changes
-- are followed from. `person_id` is whose daily note it was filed on, or would have been.
CREATE TABLE completions (
  note_id TEXT NOT NULL REFERENCES notes (id),
  revision INTEGER NOT NULL,
  at INTEGER NOT NULL,
  person_id TEXT REFERENCES people (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('member', 'agent', 'plugin')),
  author_id TEXT NOT NULL,
  done_on TEXT NOT NULL,
  daily_note_id TEXT REFERENCES notes (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, revision, at)
);
