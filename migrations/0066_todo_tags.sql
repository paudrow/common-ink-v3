-- The tags each todo has: the ones written on its line, and the ones other lines of its note cover
-- it with, as src/core/tagScope.ts reads them (a heading's, a line of tags' to the end of its
-- section, an item's over the items nested under it). tag is the name in lower case, which is what
-- matches, and name is the name as the note writes it. A note's own tags are still note_tags. Like
-- the todos index it is kept with every change to a note's text and can be made again from the text.
CREATE TABLE todo_tags (
  note_id TEXT NOT NULL REFERENCES notes (id),
  -- The todo's line, counted from 0.
  line INTEGER NOT NULL,
  tag TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (note_id, line, tag)
);

CREATE INDEX todo_tags_by_tag ON todo_tags (tag);

-- Every note is read in again, for the tags of its todos.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 11;
