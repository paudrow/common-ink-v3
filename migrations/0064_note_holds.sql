-- Who has a note open now, so a note nobody wrote in is not discarded under them. A holder is one page
-- of the app with the note open in an editor (`page:<id>`), or an agent that made or read the note
-- while it was blank (`agent:<id>`). `at` is when it last said so: a hold is taken to have lapsed ten
-- minutes after, which is how one closed without a word lets go.
CREATE TABLE note_holds (
  note_id TEXT NOT NULL REFERENCES notes (id),
  holder TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (note_id, holder)
);

CREATE INDEX note_holds_by_at ON note_holds (at);

-- The notes with no title, where the hourly sweep looks for ones nobody wrote in.
CREATE INDEX notes_untitled ON notes (created_at) WHERE title = '';
