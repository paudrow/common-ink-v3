import { describe, expect, it } from "vitest";
import { planOf, type BillingRow } from "../../src/core/billing.ts";

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 20, 12);

/** Someone whose trial ends five days after T, who has never subscribed. */
const fresh: BillingRow = { trialEnds: T + 5 * DAY, customerId: null, status: null, interval: null, periodStart: null, periodEnd: null, cancelAtPeriodEnd: false };
const paying = (status: string, more: Partial<BillingRow> = {}): BillingRow => ({ ...fresh, trialEnds: T - 20 * DAY, customerId: "cus_1", status, interval: "year", periodStart: T - 335 * DAY, periodEnd: T + 30 * DAY, ...more });
/** A yearly subscription Stripe renewed `daysAgo` before T, whose payment for the new year failed: its period is the new year already. */
const renewed = (status: string, daysAgo: number, more: Partial<BillingRow> = {}) => paying(status, { periodStart: T - daysAgo * DAY, periodEnd: T + (365 - daysAgo) * DAY, ...more });

describe("where a person stands, from their billing row", () => {
  it("is free while billing is off", () => {
    expect(planOf(null, T)).toEqual({ status: "free" });
  });

  it("is on a trial until it ends, then lapsed", () => {
    expect(planOf(fresh, T)).toEqual({ status: "trial", trialEnds: T + 5 * DAY, customer: false });
    expect(planOf(fresh, T + 5 * DAY - 1)).toEqual({ status: "trial", trialEnds: T + 5 * DAY, customer: false });
    expect(planOf(fresh, T + 5 * DAY)).toEqual({ status: "lapsed", customer: false });
  });

  it("is active while Stripe says active or trialing, by the month when Stripe gave no interval", () => {
    expect(planOf(paying("active"), T)).toEqual({ status: "active", interval: "year", periodEnd: T + 30 * DAY, cancelling: false });
    expect(planOf(paying("trialing", { interval: null, periodEnd: null }), T)).toEqual({ status: "active", interval: "month", periodEnd: null, cancelling: false });
  });

  it("is active and cancelling while a cancelled subscription runs out its period", () => {
    expect(planOf(paying("active", { cancelAtPeriodEnd: true }), T)).toEqual({ status: "active", interval: "year", periodEnd: T + 30 * DAY, cancelling: true });
  });

  it("is past due for seven days from the start of the period a payment failed for, then lapsed, though the period runs on", () => {
    const failed = renewed("past_due", 2);
    expect(planOf(failed, T)).toEqual({ status: "past_due", interval: "year", graceEnds: T + 5 * DAY });
    expect(planOf(failed, T + 5 * DAY - 1)).toEqual({ status: "past_due", interval: "year", graceEnds: T + 5 * DAY });
    expect(planOf(failed, T + 5 * DAY)).toEqual({ status: "lapsed", customer: true });
  });

  it("falls back on a trial still running once the grace is over", () => {
    expect(planOf(renewed("past_due", 8, { trialEnds: T + 3 * DAY }), T)).toEqual({ status: "trial", trialEnds: T + 3 * DAY, customer: true });
  });

  it("gives an unpaid subscription the same grace, and a past-due one with no period none", () => {
    expect(planOf(renewed("unpaid", 1), T)).toEqual({ status: "past_due", interval: "year", graceEnds: T + 6 * DAY });
    expect(planOf(renewed("unpaid", 8), T)).toEqual({ status: "lapsed", customer: true });
    expect(planOf(renewed("past_due", 1, { periodStart: null }), T)).toEqual({ status: "lapsed", customer: true });
  });

  it("is lapsed once a subscription is canceled or never finished, unless the trial still runs", () => {
    expect(planOf(paying("canceled"), T)).toEqual({ status: "lapsed", customer: true });
    expect(planOf(paying("incomplete_expired"), T)).toEqual({ status: "lapsed", customer: true });
    expect(planOf({ ...fresh, customerId: "cus_1", status: "incomplete" }, T)).toEqual({ status: "trial", trialEnds: T + 5 * DAY, customer: true });
  });
});
