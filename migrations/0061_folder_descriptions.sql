-- What a folder is for, written by an admin or an editor, or their agent when asked, so that whoever
-- files a note, an agent most of all, can choose the folder by it. Null when nobody has said. It is
-- kept on the folder's own row, unlike a tag's (0060), which has no row: it goes where the folder
-- goes, renamed or moved, and with it when it is deleted.
ALTER TABLE folders ADD COLUMN description TEXT;
