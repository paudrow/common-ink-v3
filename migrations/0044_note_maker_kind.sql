-- Whether a member or an agent made a note, beside `created_by`, which names the person either way. A note made before this was kept is of neither, so none is ever taken for an empty note a member made and left.
ALTER TABLE notes ADD COLUMN created_by_kind TEXT CHECK (created_by_kind IN ('member', 'agent', 'plugin'));
