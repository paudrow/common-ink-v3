-- Whether a note's dates are written as links. Dates were written bare, 2026-10-21, and drawn as dates;
-- now a date is a link, [[2026-10-21]], and a bare one is words. A note written before is converted once,
-- the first time someone who may change it opens it (note.linkDates). A note made from here on is made
-- with it set, as it has nothing to convert. A column with a default costs the notes already there nothing.
ALTER TABLE notes ADD COLUMN dates_linked INTEGER NOT NULL DEFAULT 0;
