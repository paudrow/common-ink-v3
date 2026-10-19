-- The person's sessions_ended when the clipper was allowed. Signing out everywhere, by them or by an
-- admin, moves theirs on, and a grant works only while the two agree. A grant made before this column
-- reads 0, so it ends once the person has ever been signed out everywhere.
ALTER TABLE clipper_grants ADD COLUMN sessions_ended INTEGER NOT NULL DEFAULT 0;
