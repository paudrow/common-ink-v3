-- Whether a note's embeds are written /name(args), with a block's content in a fence under it. They were
-- ::name{config} and :::name{config} … :::. A note that holds an old form is converted once, by the server, as a
-- member who may change it comes in (note.convertEmbeds). Every other note, and every note made from here on, has
-- nothing to convert.
ALTER TABLE notes ADD COLUMN embeds_converted INTEGER NOT NULL DEFAULT 1;
UPDATE notes SET embeds_converted = 0 WHERE text LIKE '%::%';
CREATE INDEX notes_embeds_to_convert ON notes (workspace_id, id) WHERE embeds_converted = 0;
