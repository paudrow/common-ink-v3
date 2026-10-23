-- Whether a note's mentions and references to events are written as links. They were @[[id|name]],
-- @[[name]] and ::event{ref label}; now they are [[person:…]] and [[event:ref]], and the old forms are
-- words. A note that holds an old form is converted once, by the server, as a member who may change it
-- comes in (note.convertLinks). Every other note, and every note made from here on, has nothing to convert.
ALTER TABLE notes ADD COLUMN links_converted INTEGER NOT NULL DEFAULT 1;
UPDATE notes SET links_converted = 0 WHERE text LIKE '%@[[%' OR text LIKE '%::event{%';
CREATE INDEX notes_to_convert ON notes (workspace_id, id) WHERE links_converted = 0;
