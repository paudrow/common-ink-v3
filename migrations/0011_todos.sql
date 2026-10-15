-- The todos in every note, one row for each checkbox line, with the line as written. It is kept
-- with every change to a note's text, in the same batch as the change, and can be made again from
-- the text (the todos.rebuild operation). A note written before this table was has no rows until
-- it is written again or the index is rebuilt.
CREATE TABLE todos (
  note_id TEXT NOT NULL REFERENCES notes (id),
  -- Which line of the note, counted from 0.
  line INTEGER NOT NULL,
  done INTEGER NOT NULL,
  -- 0 for normal, and 1 to 3 for as many !s.
  importance INTEGER NOT NULL,
  -- A calendar date, YYYY-MM-DD, or NULL.
  due TEXT,
  text TEXT NOT NULL,
  PRIMARY KEY (note_id, line)
);

CREATE INDEX todos_by_due ON todos (done, due);

-- The projects of each todo: project is the name in lower case, which is what matches, and name is as written.
CREATE TABLE todo_projects (
  note_id TEXT NOT NULL REFERENCES notes (id),
  line INTEGER NOT NULL,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (note_id, line, project)
);

CREATE INDEX todo_projects_by_project ON todo_projects (project);

-- The tags of each note, from every #tag in its text outside code: tag is the name in lower case, and name is as first written.
CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes (id),
  tag TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);

CREATE INDEX note_tags_by_tag ON note_tags (tag);
