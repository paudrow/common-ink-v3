ALTER TABLE changes ADD COLUMN write_id TEXT;

CREATE UNIQUE INDEX changes_by_write ON changes (note_id, write_id) WHERE write_id IS NOT NULL;
