-- How many times a person's sessions have all been ended. A session carries the count it was started
-- under and holds only while the count is still that, so raising it signs the person out everywhere.
ALTER TABLE people ADD COLUMN sessions_ended INTEGER NOT NULL DEFAULT 0;
-- When an admin last ended them, which an admin may do once a day: an admin of any one workspace
-- can't keep someone signed out of all of them, and the day is time enough to leave it.
ALTER TABLE people ADD COLUMN ended_by_admin_at INTEGER;
