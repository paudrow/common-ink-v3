-- The IANA time zone of the browser a person last used Common Ink in, which the server takes their
-- day and times in when nobody says them and their settings name no zone. Null until a browser says one.
ALTER TABLE people ADD COLUMN time_zone TEXT;
