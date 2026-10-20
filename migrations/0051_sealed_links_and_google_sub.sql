-- A share link is looked up by the SHA-256 of its token, and `token` keeps it sealed under a key the
-- database never holds (src/core/linkSeal.ts). Links made before this keep their token in the clear,
-- with no hash, until the hourly job seals them; they open by token until then.
ALTER TABLE grants ADD COLUMN token_hash TEXT;
CREATE UNIQUE INDEX grants_by_token_hash ON grants (token_hash) WHERE token_hash IS NOT NULL;

-- Who Google says a person is, from their first sign-in after this. An email can pass to someone else
-- (a deleted Google account, a reused work address); the subject never does, so a sign-in with that
-- email and another subject is refused.
ALTER TABLE people ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX people_by_google_sub ON people (google_sub) WHERE google_sub IS NOT NULL;
