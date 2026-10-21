-- A todo's box says one of four states: `[ ]` open, `[x]` done, `[-]` abandoned and `[>]` in the
-- backlog. The state column takes the place of done, and starts as what done said.
ALTER TABLE todos ADD COLUMN state TEXT NOT NULL DEFAULT 'open';
UPDATE todos SET state = 'done' WHERE done = 1;
DROP INDEX todos_by_due;
ALTER TABLE todos DROP COLUMN done;
CREATE INDEX todos_by_due ON todos (state, due);
-- A line written `- [-]` or `- [>]` was no todo before. Every note is read in again.
DROP INDEX notes_to_index;
CREATE INDEX notes_to_index ON notes (workspace_id) WHERE indexed < 9;
