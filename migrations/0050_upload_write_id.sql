-- Chosen by whoever sends an upload, so a retry of upload.create or upload.start whose answer was lost
-- gives back the upload the first made instead of a second copy. One writer's ids are theirs alone.
-- An upload being removed lets its id go, so a try that failed can be sent again under the same one.
ALTER TABLE uploads ADD COLUMN write_id TEXT;
CREATE UNIQUE INDEX uploads_by_write ON uploads (workspace_id, uploaded_by_kind, uploaded_by, write_id) WHERE write_id IS NOT NULL AND state <> 'removing';
