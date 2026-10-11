-- Which notes link to which: one row for each note that a note's text links to by id, as [[id]].
-- It is kept with every change to a note's text, in the same batch as the change, and can be made
-- again from the text (the links.rebuild operation). The target may be a note that doesn't exist.
CREATE TABLE links (
  source_id TEXT NOT NULL REFERENCES notes (id),
  target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX links_by_target ON links (target_id);
