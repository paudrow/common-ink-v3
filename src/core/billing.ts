// Paying for Common Ink, as v1 had it: one plan, by the month or the year, paid by a person. A
// workspace is paid for by its owner, the person who made it: everyone in it can change it while the
// owner's plan is good. Someone new gets a trial with no card. When a plan lapses (a trial ended, a
// subscription cancelled, or a payment failed for a week), the owner's workspaces turn read-only and
// are never locked: everyone can still read, search and copy out every note.
//
// Billing is off, and everything is free, until the Stripe settings are all set. What Stripe says of a
// subscription is kept as a row per person, and `planOf` reads where they stand from it.

export const PLANS = {
  month: { price: 8, label: "$8 a month" },
  year: { price: 60, label: "$60 a year", perMonth: 5 },
} as const;
export type Interval = keyof typeof PLANS;

export const TRIAL_DAYS = 14;
/** How long after a failed payment a workspace stays writable, while Stripe tries the card again. */
export const GRACE_DAYS = 7;

const DAY = 86_400_000;

/** Billing turned on, as the Worker's settings say. Wherever billing is off, null is passed instead. */
export interface Charging {
  trialDays: number;
  /**
   * Ends at once, with no refund, every subscription of this Stripe customer that isn't over yet, for
   * an account being deleted. Throws when Stripe refuses, so the account stays while it still pays.
   */
  endSubscriptions: (customerId: string) => Promise<void>;
}

/** What a person is told when their account isn't deleted because Stripe wouldn't cancel their subscription. */
export const NOT_CANCELLED = "Your subscription couldn't be cancelled, so your account wasn't deleted. Try again, or write to support@commonink.app.";

/** What is kept of a person's billing: their trial, and their subscription as Stripe's webhooks last said. */
export interface BillingRow {
  trialEnds: number;
  customerId: string | null;
  /** Stripe's status for the subscription (active, trialing, past_due, unpaid, canceled, incomplete, …), or null for none yet. */
  status: string | null;
  interval: Interval | null;
  /**
   * The period the subscription is in. Stripe starts the next period as it renews, before the payment
   * for it goes through, so a payment that failed was for the period that started at `periodStart`.
   */
  periodStart: number | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Where a person stands. `free`: billing is off here. `trial`: their trial, until `trialEnds`. `active`:
 * paying. `past_due`: a payment failed, and their workspaces stay writable until `graceEnds`.
 * `lapsed`: their workspaces are read-only.
 */
export type Plan =
  | { status: "free" }
  | { status: "trial"; trialEnds: number; customer: boolean }
  | { status: "active"; interval: Interval; periodEnd: number | null; cancelling: boolean }
  | { status: "past_due"; interval: Interval; graceEnds: number }
  | { status: "lapsed"; customer: boolean };

export const canWrite = (plan: Plan) => plan.status !== "lapsed";

/** Where the person whose row this is stands at `now`. A null row is billing turned off. */
export function planOf(row: BillingRow | null, now: number): Plan {
  if (!row) return { status: "free" };
  const interval = row.interval ?? "month";
  if (row.status === "active" || row.status === "trialing") return { status: "active", interval, periodEnd: row.periodEnd, cancelling: row.cancelAtPeriodEnd };
  if ((row.status === "past_due" || row.status === "unpaid") && row.periodStart !== null) {
    const graceEnds = row.periodStart + GRACE_DAYS * DAY;
    if (graceEnds > now) return { status: "past_due", interval, graceEnds };
  }
  if (row.trialEnds > now) return { status: "trial", trialEnds: row.trialEnds, customer: row.customerId !== null };
  return { status: "lapsed", customer: row.customerId !== null };
}

/** When a trial that starts at `now` ends. */
export const trialEndsFrom = (now: number, days = TRIAL_DAYS) => now + days * DAY;

/** What anyone is told when a change is refused because the workspace's owner's plan lapsed. */
export const READ_ONLY = "This workspace is read-only because its owner's Common Ink plan has ended. Everyone can still read and search its notes.";
/** The app's banner in a read-only workspace, for its owner, beside a link to their plan. */
export const READ_ONLY_YOURS = "This workspace is read-only because your Common Ink plan has ended. Everyone can still read and search its notes.";
/** The banner for everyone else in it, who has nothing to pay. */
export const READ_ONLY_THEIRS = `${READ_ONLY} Ask its owner to subscribe.`;

/** What the app shows in Settings, under Plan, from `GET /api/billing`. */
export interface Billing {
  /** Whether this Common Ink charges. Off, everything is free and `plan` is `free`. */
  on: boolean;
  plan: Plan;
  /** The workspaces this person owns, which their plan keeps writable. */
  owns: { id: string; name: string }[];
}
