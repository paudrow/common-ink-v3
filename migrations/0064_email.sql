-- Email: mail a person sends or forwards to notes@commonink.app, kept for them alone, in no workspace.
-- Unlike a calendar or contacts, it has nowhere else to be read from, so it is kept here
-- (docs/adr/0018-email-is-kept-because-it-has-nowhere-else-to-be.md). Every row is one person's.

-- An address other than a person's sign-in email that their mail is recognized by. It is trusted
-- once `verified_at` is set, which is when mail from it carried `code_hash`'s code and passed its
-- domain's DMARC or aligned DKIM. A verified address recognizes one person.
CREATE TABLE mail_senders (
  person_id TEXT NOT NULL REFERENCES people (id),
  address TEXT NOT NULL,
  code_hash TEXT,
  code_expires_at INTEGER,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, address)
);
CREATE UNIQUE INDEX mail_senders_verified ON mail_senders (address) WHERE verified_at IS NOT NULL;
CREATE INDEX mail_senders_by_address ON mail_senders (address);

-- A conversation: the messages that name one another by Message-ID. When a message joins two, the
-- later is merged into the earlier and keeps `merged_into`, so a reference to it still leads there.
CREATE TABLE mail_threads (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  subject TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  merged_into TEXT
);
CREATE INDEX mail_threads_by_person ON mail_threads (person_id, last_at DESC);

-- One message, as it was sent: its headers' addresses as JSON lists of { name, address }, its text,
-- its HTML after sanitizing, and what was attached (names, types and sizes, not the bytes).
-- `via` is `sent` for the person's own mail (sent or copied to notes@), `forwarded` for someone
-- else's that they forwarded. `sent_at` is its Date, or when it arrived when it has none.
CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  thread_id TEXT NOT NULL REFERENCES mail_threads (id),
  message_id TEXT NOT NULL,
  in_reply_to TEXT,
  refs TEXT NOT NULL DEFAULT '',
  sender TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL,
  to_list TEXT NOT NULL DEFAULT '[]',
  cc_list TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  html TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  via TEXT NOT NULL,
  comment TEXT,
  UNIQUE (person_id, message_id)
);
CREATE INDEX mail_messages_by_thread ON mail_messages (thread_id, sent_at);
CREATE INDEX mail_messages_by_sender ON mail_messages (person_id, sender, received_at);

-- Every Message-ID a thread has seen: its own messages' and every one they refer to. A message that
-- names any of them joins that thread, whichever of the two arrived first.
CREATE TABLE mail_ids (
  person_id TEXT NOT NULL REFERENCES people (id),
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES mail_threads (id),
  PRIMARY KEY (person_id, message_id)
);
CREATE INDEX mail_ids_by_thread ON mail_ids (thread_id);
