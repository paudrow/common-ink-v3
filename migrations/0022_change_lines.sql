-- How many lines a change added and removed, counted when it is written, so history can say
-- `+60 −115` for a note without reading a diff. Null for a change written before this, which is
-- counted the first time history reads its note.
ALTER TABLE changes ADD COLUMN added INTEGER;
ALTER TABLE changes ADD COLUMN removed INTEGER;
