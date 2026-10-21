-- A tag's name as it was written when it was described or made in Settings, so a tag no note has yet
-- is listed as it was typed and not in the lower case it is kept by. Null for a description said
-- before there was this column: such a tag is listed by its lower-case name until a note has it.
ALTER TABLE tag_descriptions ADD COLUMN name TEXT;
