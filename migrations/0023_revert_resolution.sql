-- What a revert did besides taking changes out, when the person reverting chose what became of
-- lines that later changes had edited: the revert that keeps every later edit, and the edit chosen
-- after it, each as a change set. The two composed are `diff`. Null for every other change.
ALTER TABLE changes ADD COLUMN resolution TEXT;
