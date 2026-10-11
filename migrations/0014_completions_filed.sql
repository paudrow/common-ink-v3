-- Where a completion's line was filed: the revision of the daily note that filed it, and where the
-- line started then. A completion that is taken back takes its line off the daily note, found by
-- following that place through the daily note's later changes. NULL for a completion filed nowhere,
-- or on the todo's own note.
ALTER TABLE completions ADD COLUMN daily_revision INTEGER;
ALTER TABLE completions ADD COLUMN daily_at INTEGER;
