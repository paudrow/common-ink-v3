-- `uploader:` in the query language finds who is named by the uploads of theirs the asker can see,
-- one person at a time, so their uploads are looked up by who uploaded them.
CREATE INDEX uploads_by_uploader ON uploads (uploaded_by, uploaded_by_kind);
