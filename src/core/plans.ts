// Each person's billing row as the database keeps it, and the plan of the person who pays for each
// workspace. Kept apart from billing.ts, which the app imports and which knows nothing of the database.
import { canWrite, planOf, trialEndsFrom, type BillingRow, type Charging, type Interval, type Plan } from "./billing.ts";

interface Row {
  trial_ends: number;
  customer_id: string | null;
  status: string | null;
  interval: Interval | null;
  period_start: number | null;
  period_end: number | null;
  cancel_at_period_end: number;
}

const COLUMNS = "b.trial_ends, b.customer_id, b.status, b.interval, b.period_start, b.period_end, b.cancel_at_period_end";

const rowOf = (r: Row): BillingRow => ({
  trialEnds: r.trial_ends,
  customerId: r.customer_id,
  status: r.status,
  interval: r.interval,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  cancelAtPeriodEnd: r.cancel_at_period_end === 1,
});

/** Starts the trial of each of these people who has no row yet. Someone who has one keeps it. */
const startTrials = (db: D1Database, personIds: readonly string[], charging: Charging, now: number) =>
  db
    .prepare("INSERT INTO billing (person_id, trial_ends, updated_at) SELECT value, ?2, ?3 FROM json_each(?1) WHERE true ON CONFLICT (person_id) DO NOTHING")
    .bind(JSON.stringify(personIds), trialEndsFrom(now, charging.trialDays), now)
    .run();

/** A person's billing row, made the first time billing sees them, which starts their trial. */
export async function billingRow(db: D1Database, personId: string, charging: Charging, now: number): Promise<BillingRow> {
  const read = () => db.prepare(`SELECT ${COLUMNS} FROM billing b WHERE b.person_id = ?`).bind(personId).first<Row>();
  const row = await read();
  if (row) return rowOf(row);
  await startTrials(db, [personId], charging, now);
  return rowOf((await read())!);
}

/** Where a person stands: `free` while billing is off. */
export const planFor = async (db: D1Database, personId: string, charging: Charging | null, now: number): Promise<Plan> =>
  charging ? planOf(await billingRow(db, personId, charging, now), now) : { status: "free" };

/**
 * Of these workspaces, the ones that are read-only: billing is on and the plan of the person who
 * pays for each has lapsed. A workspace with no owner is never read-only.
 */
export async function readOnlyOf(db: D1Database, workspaceIds: readonly string[], charging: Charging | null, now: number): Promise<Set<string>> {
  if (!charging || !workspaceIds.length) return new Set();
  const read = () =>
    db
      .prepare(`SELECT w.id, w.owner_id, ${COLUMNS} FROM workspaces w LEFT JOIN billing b ON b.person_id = w.owner_id WHERE w.id IN (SELECT value FROM json_each(?)) AND w.owner_id IS NOT NULL`)
      .bind(JSON.stringify(workspaceIds))
      .all<{ id: string; owner_id: string } & { [K in keyof Row]: Row[K] | null }>();
  let { results } = await read();
  // Every operation asks this, so it is one read, and a write only the first time an owner is seen.
  const unseen = results.filter((r) => r.trial_ends === null).map((r) => r.owner_id);
  if (unseen.length) {
    await startTrials(db, [...new Set(unseen)], charging, now);
    ({ results } = await read());
  }
  return new Set(results.filter((r) => !canWrite(planOf(rowOf(r as Row), now))).map((r) => r.id));
}

/** The workspaces a person pays for and is still a member of. */
export async function ownedBy(db: D1Database, personId: string): Promise<{ id: string; name: string }[]> {
  const { results } = await db
    .prepare("SELECT w.id, w.name FROM workspaces w JOIN members m ON m.workspace_id = w.id AND m.person_id = w.owner_id WHERE w.owner_id = ? ORDER BY w.created_at, w.id")
    .bind(personId)
    .all<{ id: string; name: string }>();
  return results;
}

/** Ties a Stripe customer to a person, unless they have one already or it is someone else's. Answers the one they have now, or null for no such person. */
export async function keepCustomer(db: D1Database, personId: string, customerId: string, now: number): Promise<string | null> {
  // Someone first seen by Stripe's webhook gets no trial: they are already paying.
  await db.prepare("INSERT INTO billing (person_id, trial_ends, updated_at) SELECT id, ?2, ?2 FROM people WHERE id = ?1 ON CONFLICT (person_id) DO NOTHING").bind(personId, now).run();
  await db.prepare("UPDATE billing SET customer_id = ?2, updated_at = ?3 WHERE person_id = ?1 AND customer_id IS NULL AND NOT EXISTS (SELECT 1 FROM billing WHERE customer_id = ?2)").bind(personId, customerId, now).run();
  return (await db.prepare("SELECT customer_id FROM billing WHERE person_id = ?").bind(personId).first<{ customer_id: string | null }>())?.customer_id ?? null;
}

/** A subscription as Stripe last said it is, kept on the row of the person whose customer it is. */
export interface Subscribed {
  subscriptionId: string;
  customerId: string;
  status: string;
  interval: Interval;
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * A subscription whose customer is nobody's here is dropped: Checkout ties the customer to its person first.
 * `asked` is when Stripe was asked for it. Stripe gives a subscription no time it last changed, so of two
 * reads the one asked later is kept: each change sends an event, asked for after the change, so the
 * read asked last has every change.
 */
export async function keepSubscription(db: D1Database, sub: Subscribed, asked: number): Promise<void> {
  await db
    .prepare("UPDATE billing SET subscription_id = ?2, status = ?3, interval = ?4, period_start = ?5, period_end = ?6, cancel_at_period_end = ?7, updated_at = ?8 WHERE customer_id = ?1 AND updated_at <= ?8")
    .bind(sub.customerId, sub.subscriptionId, sub.status, sub.interval, sub.periodStart, sub.periodEnd, sub.cancelAtPeriodEnd ? 1 : 0, asked)
    .run();
}
