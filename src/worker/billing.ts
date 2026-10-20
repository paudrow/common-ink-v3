// Paying for Common Ink with Stripe: Checkout to subscribe, the Customer Portal to change a card, see
// invoices, switch plans or cancel, and a webhook that says what changed. No card form is ours. Stripe's
// API is reached with fetch, form-encoded as it asks. What a plan is, and when one lapses, is
// src/core/billing.ts; what is kept of it, src/core/plans.ts.
import { cappedBody, cappedJson, MAX_FORM_BYTES, TooLarge } from "./body.ts";
import { z } from "zod";
import { PLANS, TRIAL_DAYS, type Billing, type Charging, type Interval } from "../core/billing.ts";
import { logLine } from "../core/logs.ts";
import { billingRow, keepCustomer, keepSubscription, ownedBy, planFor, type Subscribed } from "../core/plans.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Whether this Common Ink charges: a Stripe key, a webhook secret and both prices are set. */
export const billingOn = (env: Env) => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_PRICE_MONTH && env.STRIPE_PRICE_YEAR);

/** How many days a new person's trial lasts here. */
export function trialDays(env: Env): number {
  const days = env.TRIAL_DAYS?.trim() ? Number(env.TRIAL_DAYS) : TRIAL_DAYS;
  return Number.isInteger(days) && days >= 0 ? days : TRIAL_DAYS;
}

/** What the core is told of billing: null while it is off. */
export const chargingOf = (env: Env): Charging | null => (billingOn(env) ? { trialDays: trialDays(env), endSubscriptions: (customerId) => endSubscriptions(env, customerId) } : null);

/** Stripe refused, or didn't answer. What it said is for the logs and never for the person: it can quote a key, a price or a customer. */
class StripeError extends Error {
  /** Stripe's code for why it refused, as `charge_already_refunded`. */
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}
StripeError.prototype.name = "StripeError";

const UNAVAILABLE = "Stripe couldn't start that. Try again in a moment.";
const unavailable = () => json({ error: "unavailable", message: UNAVAILABLE }, 502);

/**
 * A call to Stripe's API. `once` makes a retry of the same call answer what the first did, and
 * `version` asks for the shapes of that version of the API rather than the account's.
 */
async function stripe<T>(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  answer: z.ZodType<T>,
  params: Record<string, string> = {},
  { once, version }: { once?: string; version?: string } = {},
): Promise<T> {
  const form = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (once) headers["Idempotency-Key"] = once;
  if (version) headers["Stripe-Version"] = version;
  const asked = `${method} ${path}`;
  let res: Response;
  try {
    const query = method !== "POST" && form ? `?${form}` : "";
    res = await fetch(`${env.STRIPE_API ?? "https://api.stripe.com"}/v1${path}${query}`, { method, headers, body: method === "POST" ? form : undefined });
  } catch {
    throw new StripeError(`${asked}: Stripe didn't answer`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const refused = z.object({ error: z.object({ message: z.string().optional(), code: z.string().optional() }) }).safeParse(body).data?.error;
    throw new StripeError(`${asked} answered ${res.status}: ${refused?.message ?? "no reason"}`, refused?.code);
  }
  const parsed = answer.safeParse(body);
  if (!parsed.success) throw new StripeError(`${asked}: Stripe answered in a shape Common Ink doesn't know`);
  return parsed.data;
}

const Url = z.object({ url: z.string() });
const Id = z.object({ id: z.string() });

const Subscription = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  created: z.number().nullish(),
  cancel_at_period_end: z.boolean().nullish(),
  current_period_start: z.number().nullish(),
  current_period_end: z.number().nullish(),
  items: z
    .object({
      data: z.array(z.object({ current_period_start: z.number().nullish(), current_period_end: z.number().nullish(), price: z.object({ recurring: z.object({ interval: z.string() }).nullish() }).nullish() })),
    })
    .nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
});
type Subscription = z.infer<typeof Subscription>;
const Subscriptions = z.object({ data: z.array(Subscription) });

/** A subscription that is paid for, or still being tried: one a customer must have only one of. */
const LIVE: Record<string, number> = { active: 3, trialing: 3, past_due: 2, unpaid: 1 };
const live = (sub: Subscription) => sub.status in LIVE;

const Price = z.object({ unit_amount: z.number().nullish(), currency: z.string(), recurring: z.object({ interval: z.string() }).nullish() });

/**
 * The id of the price Checkout charges for `interval`, once Stripe says it costs what the site shows.
 * Null, and the difference logged, when it doesn't: nobody is shown one amount and charged another.
 */
async function checkedPrice(env: Env, interval: Interval): Promise<string | null> {
  const setting = interval === "year" ? "STRIPE_PRICE_YEAR" : "STRIPE_PRICE_MONTH";
  const id = env[setting]!;
  const { unit_amount, currency, recurring } = await stripe(env, "GET", `/prices/${encodeURIComponent(id)}`, Price);
  const dollars = PLANS[interval].price;
  if (unit_amount === dollars * 100 && currency === "usd" && recurring?.interval === interval) return id;
  logLine(`${setting} is ${unit_amount == null ? "no set amount" : unit_amount / 100} ${currency}/${recurring?.interval ?? "once"}, but the site says $${dollars}`);
  return null;
}

const seconds = (at: number | null | undefined) => (at == null ? null : at * 1000);

function subscribed(sub: Subscription): Subscribed {
  const item = sub.items?.data[0];
  // Newer versions of Stripe's API keep the period on the item, not the subscription.
  return {
    subscriptionId: sub.id,
    customerId: sub.customer,
    status: sub.status,
    interval: item?.price?.recurring?.interval === "year" ? "year" : "month",
    periodStart: seconds(sub.current_period_start ?? item?.current_period_start),
    periodEnd: seconds(sub.current_period_end ?? item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
  };
}

/** A person's Stripe customer, made the first time they subscribe. */
async function customerOf(env: Env, personId: string, now: number): Promise<string> {
  const row = await billingRow(env.DB, personId, chargingOf(env)!, now);
  if (row.customerId) return row.customerId;
  const person = (await env.DB.prepare("SELECT email, name FROM people WHERE id = ?").bind(personId).first<{ email: string; name: string }>())!;
  const params = { email: person.email, name: person.name, "metadata[person]": personId };
  // Stripe refuses a key sent again with other params, as after a change of name, so the key carries them.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(params))));
  const made = await stripe(env, "POST", "/customers", Id, params, { once: `customer-${personId}-${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}` });
  return (await keepCustomer(env.DB, personId, made.id, now)) ?? made.id;
}

const Asked = z.object({ interval: z.enum(["month", "year"]) });

/** The account's routes, for the person signed in: where their plan stands, and the way to Checkout or the Portal. */
export async function handleBillingApi(req: Request, env: Env, url: URL, personId: string): Promise<Response> {
  const charging = chargingOf(env);
  const now = Date.now();

  if (url.pathname === "/api/billing") {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return json({ on: charging !== null, plan: await planFor(env.DB, personId, charging, now), owns: await ownedBy(env.DB, personId) } satisfies Billing);
  }

  const to = url.pathname === "/api/billing/checkout" ? "checkout" : url.pathname === "/api/billing/portal" ? "portal" : null;
  if (!to) return json({ error: "not_found" }, 404);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // The session cookie rides along on any request to us, so a plan is changed only from Common Ink's own pages.
  if (req.headers.get("Origin") !== url.origin) return json({ error: "forbidden", message: "Plans are changed from Common Ink itself" }, 403);
  if (!charging) return json({ error: "not_found", message: "Billing isn't on here: everything is free" }, 404);

  try {
    if (to === "portal") {
      const { customerId } = await billingRow(env.DB, personId, charging, now);
      if (!customerId) return json({ error: "conflict", message: "You haven't subscribed yet" }, 409);
      return json(await stripe(env, "POST", "/billing_portal/sessions", Url, { customer: customerId, return_url: `${url.origin}/settings/plan` }));
    }
    if (!req.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "invalid", message: "Send JSON" }, 400);
    let sent: unknown;
    try {
      sent = await cappedJson(req, MAX_FORM_BYTES);
    } catch (err) {
      if (err instanceof TooLarge) return json({ error: "invalid", message: `A body here is at most ${MAX_FORM_BYTES} bytes` }, 413);
      sent = null;
    }
    const asked = Asked.safeParse(sent);
    if (!asked.success) return json({ error: "invalid", message: 'Say "interval": "month" or "year"' }, 400);
    const subscribed = json({ error: "conflict", message: "You already subscribe. Change or cancel it in Settings, under Plan" }, 409);
    const { status } = await planFor(env.DB, personId, charging, now);
    if (status === "active" || status === "past_due") return subscribed;
    const price = await checkedPrice(env, asked.data.interval);
    if (!price) return unavailable();
    const customer = await customerOf(env, personId, now);
    // Stripe may know of a subscription its webhook hasn't told of yet, as just after another Checkout.
    const { data } = await stripe(env, "GET", "/subscriptions", Subscriptions, { customer, status: "all", limit: "100" });
    if (data.some(live)) return subscribed;
    const session = await stripe(env, "POST", "/checkout/sessions", Url, {
      mode: "subscription",
      customer,
      client_reference_id: personId,
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][person]": personId,
      allow_promotion_codes: "true",
      success_url: `${url.origin}/settings/plan?billing=done`,
      cancel_url: `${url.origin}/settings/plan?billing=cancelled`,
    });
    return json({ url: session.url });
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    faultAtStripe("Stripe", err);
    return unavailable();
  }
}

/** How long a webhook's signature holds, as Stripe's own libraries take it. */
const TOLERANCE_SECONDS = 300;

const hexBytes = (hex: string) => (/^(?:[0-9a-f]{2})+$/.test(hex) ? Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16)) : null);

/**
 * Whether Stripe signed `body` within the last five minutes: `Stripe-Signature` is `t=<seconds>,v1=<hex>`,
 * the HMAC-SHA-256 of `<t>.<body>` under the webhook's secret. There may be several v1s while a secret is
 * rolled. `verify` compares in constant time.
 */
export async function signedByStripe(secret: string, header: string | null, body: string, now: number): Promise<boolean> {
  const pairs = (header ?? "").split(",").map((part) => part.trim().split("=", 2) as [string, string?]);
  const t = pairs.find(([k]) => k === "t")?.[1] ?? "";
  if (!/^\d{1,12}$/.test(t) || Math.abs(now / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${t}.${body}`);
  for (const [k, v] of pairs) {
    const sig = k === "v1" && v ? hexBytes(v) : null;
    if (sig && (await crypto.subtle.verify("HMAC", key, sig, signed))) return true;
  }
  return false;
}

const Event = z.object({
  type: z.string(),
  data: z.object({ object: z.object({ customer: z.string().nullish(), mode: z.string().nullish() }) }),
});

const Invoices = z.object({
  data: z.array(z.object({ payments: z.object({ data: z.array(z.object({ status: z.string(), payment: z.object({ payment_intent: z.string().nullish() }) })) }).nullish() })),
});

/**
 * Ends at once a customer's second live subscription, as two Checkouts at once make, and refunds the
 * latest invoice it was paid. The refund goes first and by a key of the subscription's, so a retry
 * after either step failed finds it still live and asks the same refund again, which Stripe makes once.
 */
async function cancelSecond(env: Env, sub: Subscription): Promise<void> {
  // An invoice's payments are listed from this version of Stripe's API on, whatever the account's is.
  const { data } = await stripe(env, "GET", "/invoices", Invoices, { subscription: sub.id, status: "paid", limit: "1", "expand[]": "data.payments" }, { version: "2025-03-31.basil" });
  const paid = data[0]?.payments?.data.find((p) => p.status === "paid")?.payment.payment_intent;
  if (paid) {
    try {
      await stripe(env, "POST", "/refunds", Id, { payment_intent: paid }, { once: `refund-${sub.id}` });
    } catch (err) {
      // A day on, Stripe has forgotten the key, and says so this way of the refund it made.
      if (!(err instanceof StripeError && err.code === "charge_already_refunded")) throw err;
    }
  }
  await stripe(env, "DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`, Id, { prorate: "false" });
}

/** A subscription that is over and can't start again, which ending an account leaves alone. */
const OVER = new Set(["canceled", "incomplete_expired"]);

/** Stripe saying the customer or subscription isn't there, as one already gone: there is nothing left to charge. */
const missing = (err: unknown) => err instanceof StripeError && /No such (customer|subscription)/i.test(err.message);

/**
 * Before an account is deleted, as v1's `endBilling` did: ends at once, with no refund, every subscription
 * of the customer that isn't over, so a deleted account is never charged again. They are fetched, not
 * read from the billing row, which may not have heard of one yet, and which a restore of the database
 * brings back as it was. So deleting an account again after a restore cancels nothing twice.
 */
async function endSubscriptions(env: Env, customerId: string): Promise<void> {
  try {
    const { data } = await stripe(env, "GET", "/subscriptions", Subscriptions, { customer: customerId, status: "all", limit: "100" });
    for (const sub of data.filter((s) => !OVER.has(s.status))) {
      await stripe(env, "DELETE", `/subscriptions/${encodeURIComponent(sub.id)}`, Id).catch((err: unknown) => {
        if (!missing(err)) throw err;
      });
    }
  } catch (err) {
    if (missing(err)) return;
    faultAtStripe("Cancelling a deleted account's subscription at Stripe", err);
    throw err;
  }
}

/** Of a customer's live subscriptions, the one kept: a paid one over one still being tried, and of those the first. */
const keeping = (a: Subscription, b: Subscription) => LIVE[b.status]! - LIVE[a.status]! || (a.created ?? 0) - (b.created ?? 0) || a.id.localeCompare(b.id);

/**
 * Keeps where a customer stands as Stripe says it is now, from all of their subscriptions. They are
 * fetched, not read from the event: Stripe sends events in no set order, and a customer can have two
 * subscriptions (two Checkouts at once), of which the second is cancelled and refunded. Whose a
 * customer is comes from a subscription's metadata, which only Common Ink's own Checkout sets.
 */
async function refresh(env: Env, customerId: string): Promise<void> {
  const asked = Date.now();
  const { data } = await stripe(env, "GET", "/subscriptions", Subscriptions, { customer: customerId, status: "all", limit: "100" });
  const [kept, ...second] = data.filter(live).toSorted(keeping);
  for (const sub of second) await cancelSecond(env, sub);
  const sub = kept ?? data.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
  if (!sub) return;
  const person = sub.metadata?.person;
  if (person) await keepCustomer(env.DB, person, sub.customer, asked);
  await keepSubscription(env.DB, subscribed(sub), asked);
}

/** What went wrong at Stripe, in the Worker's log and never the browser: what was asked, then Stripe's own words, redacted. */
const faultAtStripe = (what: string, err: unknown) => logLine(`${what} broke: ${err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err)}`);

/** The most a Stripe event is read to: its own events are a few kilobytes, and one that names a long subscription a few tens. The body is read before its signature can be checked, so it is capped. */
const MAX_WEBHOOK_BYTES = 256_000;

/** POST /api/stripe/webhook: what Stripe says changed. It has no session, and an event that isn't Stripe's, signed just now, is refused. */
export async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (!billingOn(env)) return json({ error: "not_found" }, 404);
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const bytes = await cappedBody(req, MAX_WEBHOOK_BYTES);
  if (!bytes) return json({ error: "invalid", message: `An event is at most ${MAX_WEBHOOK_BYTES} bytes` }, 413);
  const body = new TextDecoder().decode(bytes);
  const now = Date.now();
  if (!(await signedByStripe(env.STRIPE_WEBHOOK_SECRET!, req.headers.get("Stripe-Signature"), body, now))) {
    return json({ error: "invalid", message: "That isn't signed by Stripe, or it was signed too long ago" }, 400);
  }
  let event: z.infer<typeof Event>;
  try {
    event = Event.parse(JSON.parse(body));
  } catch {
    return json({ error: "invalid", message: "That isn't an event Common Ink can read" }, 400);
  }
  const { object } = event.data;
  try {
    switch (event.type) {
      case "checkout.session.completed":
        // A session's client_reference_id says nothing of whose its customer is: a payment link takes it from its address.
        if (object.mode === "subscription" && object.customer) await refresh(env, object.customer);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        if (object.customer) await refresh(env, object.customer);
        break;
      // A failed payment needs nothing more: the subscription's own update says past_due.
    }
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    // Stripe sends the event again later.
    faultAtStripe("Stripe's webhook", err);
    return unavailable();
  }
  return json({ received: true });
}
