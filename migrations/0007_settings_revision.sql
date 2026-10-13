-- How many times a member's settings have been written, so a write made on an older copy can be refused.
ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- The id its writer gave the last write, so a later write can say it takes that one's place.
ALTER TABLE settings ADD COLUMN write_id TEXT;
