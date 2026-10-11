-- Who each line of a note mentions, from every @[[...]] in its text outside code. who is what
-- matches: a person's id for a mention that names one, or the name in lower case for a mention of
-- a name alone. name is the name as the note writes it. A mention on a todo's line is who the todo
-- is assigned to. Like the todos index it is kept with every change to a note's text and can be
-- made again from the text.
CREATE TABLE mentions (
  note_id TEXT NOT NULL REFERENCES notes (id),
  -- Which line of the note, counted from 0.
  line INTEGER NOT NULL,
  who TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (note_id, line, who)
);

CREATE INDEX mentions_by_who ON mentions (who);

-- Notes written before there was a table for mentions have theirs made the next time todos are listed.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 4;

-- Whether a grant was made by naming a member rather than by typing an email. Whoever names a
-- member was never told their email, so the grant doesn't tell it to them either.
ALTER TABLE grants ADD COLUMN named INTEGER NOT NULL DEFAULT 0;
