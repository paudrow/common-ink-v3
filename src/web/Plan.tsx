import { useEffect, useState, type ReactNode } from "react";
import { PLANS, type Billing, type Interval } from "../core/billing.ts";
import { ApiError, checkoutAt, getBilling, portalAt } from "./api.ts";
import { PLAN } from "./settingsLayout.ts";

/** What the person's billing was read as: undefined while it is asked for, null when it couldn't be read, which shows as billing being off. */
export type Read = Billing | null | undefined;

export function useBilling(): [Read, (billing: Billing) => void] {
  const [billing, setBilling] = useState<Read>(undefined);
  useEffect(() => {
    let live = true;
    getBilling().then(
      (got) => live && setBilling(got),
      () => live && setBilling(null),
    );
    return () => void (live = false);
  }, []);
  return [billing, setBilling];
}

/** What Stripe sent the browser back with, in the address's `billing`. */
type Back = "done" | "cancelled" | null;
const backFrom = (query: string): Back => {
  const said = new URLSearchParams(query).get("billing");
  return said === "done" || said === "cancelled" ? said : null;
};

/** How long to wait before each reading again, after Checkout, for Stripe's webhook to say the subscription is active. */
const AFTER_CHECKOUT_MS = [1000, 2000, 4000, 8000];

const dayAndMonth = (time: number) => new Date(time).toLocaleDateString(undefined, { month: "long", day: "numeric" });

const yearLabel = `${PLANS.year.label} ($${PLANS.year.perMonth} a month)`;

const NOTHING_TO_PAY = "You don't own a workspace, so you have nothing to pay for.";

type Sending = { kind: "idle" } | { kind: "opening" } | { kind: "failed"; message: string };

interface Props {
  billing: Billing;
  onBilling: (billing: Billing) => void;
  /** Takes the query off the address, once it has been read. */
  clearQuery: () => void;
}

export function PlanSection({ billing: { plan, owns }, onBilling, clearQuery }: Props) {
  const [back] = useState(() => backFrom(location.search));
  const [sending, setSending] = useState<Sending>({ kind: "idle" });

  useEffect(() => {
    if (back) clearQuery();
    if (back !== "done") return;
    let live = true;
    void (async () => {
      for (const ms of AFTER_CHECKOUT_MS) {
        await new Promise((r) => setTimeout(r, ms));
        const got = live ? await getBilling().catch(() => null) : null;
        if (!live) return;
        if (got) onBilling(got);
        if (got?.plan.status === "active") return;
      }
    })();
    return () => void (live = false);
  }, []);
  // Back from Stripe, the browser may show this page as it was left, still opening it.
  useEffect(() => {
    const shown = () => setSending({ kind: "idle" });
    addEventListener("pageshow", shown);
    return () => removeEventListener("pageshow", shown);
  }, []);

  const toStripe = async (url: () => Promise<string>) => {
    setSending({ kind: "opening" });
    try {
      location.assign(await url());
    } catch (err) {
      setSending({ kind: "failed", message: err instanceof ApiError ? err.message : "Stripe couldn't be reached. Check your connection and try again." });
    }
  };
  const busy = sending.kind === "opening";
  const subscribe = (interval: Interval, label: string) => (
    <button type="button" className="button small primary" disabled={busy} onClick={() => void toStripe(() => checkoutAt(interval))}>
      Subscribe for {label}
    </button>
  );
  const subscribeButtons = (
    <>
      {subscribe("month", PLANS.month.label)}
      {subscribe("year", yearLabel)}
    </>
  );
  const portal = (label: string) => (
    <button type="button" className="button small" disabled={busy} onClick={() => void toStripe(portalAt)}>
      {label}
    </button>
  );

  const [said, controls] = ((): [string, ReactNode] => {
    switch (plan.status) {
      case "free":
        return ["Common Ink is free here.", null];
      case "trial":
        return owns.length ? [`Your free trial ends on ${dayAndMonth(plan.trialEnds)}.`, subscribeButtons] : [NOTHING_TO_PAY, null];
      case "active": {
        const ends = plan.periodEnd === null ? "" : ` ${plan.cancelling ? "Ends" : "Renews"} on ${dayAndMonth(plan.periodEnd)}.`;
        return [`You're subscribed, ${PLANS[plan.interval].label}.${ends}`, portal("Manage billing")];
      }
      case "past_due":
        return [`Your last payment didn't go through. Your workspaces stay writable until ${dayAndMonth(plan.graceEnds)} while your card is tried again.`, portal("Update your card")];
      case "lapsed":
        return [
          owns.length ? "Your plan has ended, so the workspaces you own are read-only." : NOTHING_TO_PAY,
          owns.length > 0 || plan.customer ? (
            <>
              {owns.length > 0 && subscribeButtons}
              {plan.customer && portal("Manage billing")}
            </>
          ) : null,
        ];
    }
  })();

  return (
    <section aria-label={PLAN.name} className="settings-group">
      <h2>{PLAN.name}</h2>
      {back === "done" && plan.status !== "active" && (
        <p role="status" className="soon">
          Thanks. Your subscription is starting; this page updates when Stripe confirms it.
        </p>
      )}
      {back === "cancelled" && (
        <p role="status" className="soon">
          Checkout was cancelled. Nothing was charged.
        </p>
      )}
      <div className="setting" data-row>
        <p className="plan-line">{said}</p>
        {controls && <div className="setting-control">{controls}</div>}
        {busy && (
          <p role="status" className="soon">
            Opening Stripe…
          </p>
        )}
        {sending.kind === "failed" && (
          <p role="alert" className="error">
            {sending.message}
          </p>
        )}
      </div>
      {owns.length > 0 && (
        <div className="setting" data-row>
          <p className="setting-about">Your plan keeps these workspaces writable:</p>
          <ul aria-label="Workspaces you own" className="plan-owns">
            {owns.map((w) => (
              <li key={w.id}>{w.name}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
