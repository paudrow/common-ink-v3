-- References to email threads are links now: ::email{ref subject} is [[email:ref]], which shows the
-- subject to the member whose mail it is alone. A note that holds the old form is converted once, as
-- note.convertLinks converts the others (0067).
UPDATE notes SET links_converted = 0 WHERE text LIKE '%::email{%';
