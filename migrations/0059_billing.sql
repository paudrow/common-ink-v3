-- Paying for Common Ink (src/core/billing.ts). A workspace is paid for by its owner: the person who
-- made it. One made before there was an owner is its earliest admin's, by when they joined.
ALTER TABLE workspaces ADD COLUMN owner_id TEXT REFERENCES people (id);

UPDATE workspaces SET owner_id = (
  SELECT m.person_id FROM members m WHERE m.workspace_id = workspaces.id AND m.role = 'admin' ORDER BY m.joined_at, m.person_id LIMIT 1
) WHERE owner_id IS NULL;

CREATE INDEX workspaces_by_owner ON workspaces (owner_id);

-- One row per person, made the first time billing sees them, which starts their trial. Their Stripe
-- customer and subscription, as Stripe's webhooks last said.
CREATE TABLE billing (
  person_id TEXT PRIMARY KEY REFERENCES people (id),
  trial_ends INTEGER NOT NULL,
  customer_id TEXT UNIQUE,
  subscription_id TEXT,
  -- Stripe's status for the subscription (active, trialing, past_due, unpaid, canceled, incomplete, ...), or NULL for none yet.
  status TEXT,
  interval TEXT CHECK (interval IN ('month', 'year')),
  -- The subscription's period. Stripe starts the next one as it renews, so a failed payment was for the one that started at period_start.
  period_start INTEGER,
  period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
