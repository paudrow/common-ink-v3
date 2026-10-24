-- Two of a person's contacts they said are not the same person, so the pair isn't offered for merging
-- again. The ids are their data source's, the smaller first. It is the person's, in no workspace.
CREATE TABLE contact_dismissals (
  person_id TEXT NOT NULL REFERENCES people (id),
  data_source TEXT NOT NULL,
  first_id TEXT NOT NULL,
  second_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, data_source, first_id, second_id)
);
