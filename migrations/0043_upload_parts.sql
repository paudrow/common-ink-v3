-- A file sent in parts. While it is pending, `multipart_id` is the bucket's id for the parts it has
-- taken so far, and `touched_at` is when the last of them arrived: an upload nothing has been sent
-- to for a day is cleared away with whatever parts it had.
ALTER TABLE uploads ADD COLUMN multipart_id TEXT;
ALTER TABLE uploads ADD COLUMN touched_at INTEGER;

-- Each part the bucket has taken, with the tag it answered, which completing the file names.
CREATE TABLE upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads (id),
  number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (upload_id, number)
);

-- An address parts of an upload are sent to. Only the SHA-256 of its secret is kept, as for an
-- agent's token. Each part is sent to one address once: a part asked of an address again is refused,
-- whether or not the first time got through, and a fresh address is given for the parts still to come.
CREATE TABLE upload_passes (
  hash TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES uploads (id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX upload_passes_by_upload ON upload_passes (upload_id);

CREATE TABLE upload_pass_uses (
  hash TEXT NOT NULL,
  number INTEGER NOT NULL,
  PRIMARY KEY (hash, number)
);
