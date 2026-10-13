-- The folders an agent is limited to, as a JSON array of folder ids, each standing for itself and
-- the folders under it. NULL is no limit: every note its member can reach. A folder deleted since
-- stays in the list and matches nothing, so the list never comes to mean "every note" by losing
-- its folders.
ALTER TABLE agents ADD COLUMN folder_ids TEXT;
