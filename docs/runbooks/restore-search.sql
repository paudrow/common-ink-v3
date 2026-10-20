INSERT INTO note_search (rowid, workspace, title, text) SELECT r.id, n.workspace_id, n.title, n.text FROM note_search_rows r JOIN notes n ON n.id = r.note_id;
