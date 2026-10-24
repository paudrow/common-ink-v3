-- Skip rules: what a member asks of mail for it not to be kept (docs/email.md). `criteria` is the
-- rule as JSON, as MailRuleCriteria in src/core/protocol.ts reads it. Each row is one person's.
CREATE TABLE mail_rules (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id),
  criteria TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mail_rules_by_person ON mail_rules (person_id, created_at);

-- The mailing list a message came through, as its List-Id header names it, which a rule may ask for.
-- Mail kept before this has none.
ALTER TABLE mail_messages ADD COLUMN list_id TEXT;
