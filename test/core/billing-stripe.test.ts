import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { newMember } from "./members.ts";
import { HOOK_SECRET, STRIPE, fakeStripe, subscription, type Sent } from "./stripe.ts";

const SECRET = "test-session-secret";
const on = (more: Partial<Env> = {}) => ({ ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: undefined, ...STRIPE, ...more }) as Env;
const off = () => on({ STRIPE_SECRET_KEY: undefined });
const DAY = 86_400_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const session = async (personId: string) => `__Host-ink_session=${await sign({ personId }, SECRET, 600)}`;

const call = async (personId: string, path: string, settings: Env, init: { method?: string; body?: unknown; origin?: string } = {}) => {
  const headers: Record<string, string> = { Cookie: await session(personId), Origin: init.origin ?? "https://commonink.app" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(`https://commonink.app${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }) as never, settings);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const rowOf = (personId: string) =>
  env.DB.prepare("SELECT customer_id, subscription_id, status, interval, period_start, period_end, cancel_at_period_end FROM billing WHERE person_id = ?").bind(personId).first();

async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An event as Stripe sends it, signed `secondsAgo` before now with `secret`. */
async function hook(event: unknown, settings = on(), { secondsAgo = 0, secret = HOOK_SECRET, signature }: { secondsAgo?: number; secret?: string; signature?: string } = {}) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000) - secondsAgo;
  const headers: Record<string, string> = { "Content-Type": "application/json", "Stripe-Signature": signature ?? `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}` };
  const res = await worker.fetch(new Request("https://commonink.app/api/stripe/webhook", { method: "POST", headers, body }) as never, settings);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cors: res.headers.get("Access-Control-Allow-Origin") };
}

/** The Worker's own lines in the log. Every 5xx answer is also logged as a structured fault report (src/worker/report.ts), which is no line. */
const lines = (logged: { mock: { calls: unknown[][] } }) => logged.mock.calls.map((c) => c[0]).filter((first): first is string => typeof first === "string");

describe("GET /api/billing", () => {
  it("says billing is off, the plan free, and the workspace the person made theirs to pay for", async () => {
    const ada = await newMember("Ada Lovelace");
    expect(await call(ada.personId, "/api/billing", off())).toEqual({ status: 200, body: { on: false, plan: { status: "free" }, owns: [{ id: ada.workspaceId, name: "Ada's workspace" }] } });
    expect(await rowOf(ada.personId)).toBeNull();
  });

  it("starts a trial of 14 days, or TRIAL_DAYS, the first time it sees someone with billing on", async () => {
    const ada = await newMember("Ada Lovelace");
    const before = Date.now();
    const { body } = await call(ada.personId, "/api/billing", on());
    const plan = body.plan as { status: string; trialEnds: number; customer: boolean };
    expect({ on: body.on, status: plan.status, customer: plan.customer }).toEqual({ on: true, status: "trial", customer: false });
    expect(plan.trialEnds - before).toBeGreaterThanOrEqual(14 * DAY);
    expect(plan.trialEnds - before).toBeLessThan(14 * DAY + 60_000);
    // Seen again, the trial it started is the one it keeps.
    expect((await call(ada.personId, "/api/billing", on({ TRIAL_DAYS: "3" }))).body.plan).toEqual(plan);

    const eve = await newMember("Eve");
    const short = (await call(eve.personId, "/api/billing", on({ TRIAL_DAYS: "3" }))).body.plan as { trialEnds: number };
    expect(Math.round((short.trialEnds - before) / DAY)).toBe(3);
  });

  it("answers 401 to someone signed out", async () => {
    const res = await worker.fetch(new Request("https://commonink.app/api/billing") as never, on());
    expect(res.status).toBe(401);
  });
});

describe("POST /api/billing/checkout", () => {
  it("makes the person a Stripe customer and sends them to Checkout for the plan they picked", async () => {
    const ada = await newMember("Ada Lovelace");
    const sent = fakeStripe();
    expect(await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval: "year" } })).toEqual({ status: 200, body: { url: "https://checkout.stripe.test/c/pay/cs_1" } });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/prices/price_year", "POST /v1/customers", "GET /v1/subscriptions", "POST /v1/checkout/sessions"]);
    const [, customer, subscriptions, checkout] = sent as [Sent, Sent, Sent, Sent];
    expect(customer.form).toEqual({ email: expect.stringMatching(/@example\.com$/), name: "Ada Lovelace", "metadata[person]": ada.personId });
    expect(customer.headers.get("Authorization")).toBe("Bearer sk_test_123");
    expect(customer.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(customer.headers.get("Idempotency-Key")).toMatch(new RegExp(`^customer-${ada.personId}-[0-9a-f]{16}$`));
    expect(subscriptions.query).toEqual({ customer: "cus_new", status: "all", limit: "100" });
    expect(checkout.form).toEqual({
      mode: "subscription",
      customer: "cus_new",
      client_reference_id: ada.personId,
      "line_items[0][price]": "price_year",
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][person]": ada.personId,
      allow_promotion_codes: "true",
      success_url: "https://commonink.app/settings/plan?billing=done",
      cancel_url: "https://commonink.app/settings/plan?billing=cancelled",
    });
    expect(await rowOf(ada.personId)).toMatchObject({ customer_id: "cus_new", status: null });

    // The second time, the customer they have is the one Checkout is for.
    sent.length = 0;
    await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval: "month" } });
    expect(sent.map((s) => [s.method, s.path, s.form.customer, s.form["line_items[0][price]"]])).toEqual([
      ["GET", "/v1/prices/price_month", undefined, undefined],
      ["GET", "/v1/subscriptions", undefined, undefined],
      ["POST", "/v1/checkout/sessions", "cus_new", "price_month"],
    ]);
  });

  it("refuses someone already subscribed, or past due, with 409", async () => {
    const ada = await newMember("Ada Lovelace");
    fakeStripe();
    await call(ada.personId, "/api/billing", on());
    for (const status of ["active", "trialing", "past_due"]) {
      await env.DB.prepare("UPDATE billing SET customer_id = 'cus_a', status = ?, period_start = ?, period_end = ? WHERE person_id = ?").bind(status, Date.now(), Date.now() + 30 * DAY, ada.personId).run();
      expect(await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval: "month" } })).toEqual({
        status: 409,
        body: { error: "conflict", message: "You already subscribe. Change or cancel it in Settings, under Plan" },
      });
    }
  });

  it("refuses with 409 someone Stripe already has a live subscription for, though Common Ink hasn't heard of it yet", async () => {
    const ada = await newMember("Ada Lovelace");
    await call(ada.personId, "/api/billing", on());
    await env.DB.prepare("UPDATE billing SET customer_id = 'cus_early' WHERE person_id = ?").bind(ada.personId).run();
    for (const status of ["active", "trialing", "past_due", "unpaid"]) {
      const sent = fakeStripe([subscription("cus_early", status, 1_800_000_000), subscription("cus_early", "canceled", 1_700_000_000, { id: "sub_old" })]);
      expect(await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval: "month" } }), status).toEqual({
        status: 409,
        body: { error: "conflict", message: "You already subscribe. Change or cancel it in Settings, under Plan" },
      });
      expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/prices/price_month", "GET /v1/subscriptions"]);
    }
    // One that ended is no subscription: they may subscribe again.
    fakeStripe([subscription("cus_early", "canceled", 1_700_000_000)]);
    expect(await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval: "month" } })).toEqual({ status: 200, body: { url: "https://checkout.stripe.test/c/pay/cs_1" } });
  });

  it("answers 404 while billing is off, 400 for no interval, and 403 from another site, asking nothing of Stripe", async () => {
    const ada = await newMember("Ada Lovelace");
    const sent = fakeStripe();
    expect(await call(ada.personId, "/api/billing/checkout", off(), { method: "POST", body: { interval: "month" } })).toEqual({ status: 404, body: { error: "not_found", message: "Billing isn't on here: everything is free" } });
    expect((await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval: "week" } })).status).toBe(400);
    expect((await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval: "month" }, origin: "https://evil.example" })).status).toBe(403);
    expect(sent).toEqual([]);
  });

  it("answers 502 in words of its own when Stripe refuses, and logs Stripe's, with no key in them", async () => {
    const ada = await newMember("Ada Lovelace");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeStripe([], { refuse: { path: "/v1/checkout/sessions", message: "Invalid API Key provided: sk_test_***123 for price price_month and customer cus_new" } });
    const res = await worker.fetch(
      new Request("https://commonink.app/api/billing/checkout", { method: "POST", headers: { Cookie: await session(ada.personId), Origin: "https://commonink.app", "Content-Type": "application/json" }, body: JSON.stringify({ interval: "month" }) }) as never,
      on(),
    );
    expect([res.status, await res.text()]).toEqual([502, '{"error":"unavailable","message":"Stripe couldn\'t start that. Try again in a moment."}']);
    expect(lines(logged).map((line) => line.split("\n")[0])).toEqual(["Stripe broke: StripeError: POST /checkout/sessions answered 400: Invalid API Key provided: sk_… for price price_month and customer cus_new"]);

    fakeStripe([], { refuse: "Invalid API Key provided: sk_live_***999" });
    await env.DB.prepare("UPDATE billing SET customer_id = 'cus_refused' WHERE person_id = ?").bind(ada.personId).run();
    expect(await call(ada.personId, "/api/billing/portal", on(), { method: "POST" })).toEqual({ status: 502, body: { error: "unavailable", message: "Stripe couldn't start that. Try again in a moment." } });
  });

  it("refuses with 502, and logs why, a price in Stripe that isn't what the site says it costs", async () => {
    const ada = await newMember("Ada Lovelace");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrong = {
      price_month: { id: "price_month", object: "price", unit_amount: 900, currency: "usd", recurring: { interval: "month" } },
      price_year: { id: "price_year", object: "price", unit_amount: 6000, currency: "eur", recurring: { interval: "month" } },
    };
    const sent = fakeStripe([], { prices: wrong });
    for (const interval of ["month", "year"]) {
      expect(await call(ada.personId, "/api/billing/checkout", on(), { method: "POST", body: { interval } })).toEqual({ status: 502, body: { error: "unavailable", message: "Stripe couldn't start that. Try again in a moment." } });
    }
    expect(lines(logged)).toEqual(["STRIPE_PRICE_MONTH is 9 usd/month, but the site says $8", "STRIPE_PRICE_YEAR is 60 eur/month, but the site says $60"]);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/prices/price_month", "GET /v1/prices/price_year"]);
    expect(await rowOf(ada.personId)).toMatchObject({ customer_id: null });
  });
});

describe("POST /api/billing/portal", () => {
  it("refuses someone who has no customer yet with 409, and sends a customer to Stripe's portal", async () => {
    const ada = await newMember("Ada Lovelace");
    const sent = fakeStripe();
    expect(await call(ada.personId, "/api/billing/portal", on(), { method: "POST" })).toEqual({ status: 409, body: { error: "conflict", message: "You haven't subscribed yet" } });
    expect(sent).toEqual([]);
    await env.DB.prepare("UPDATE billing SET customer_id = 'cus_ada' WHERE person_id = ?").bind(ada.personId).run();
    expect(await call(ada.personId, "/api/billing/portal", on(), { method: "POST" })).toEqual({ status: 200, body: { url: "https://billing.stripe.test/p/session/bps_1" } });
    expect(sent.map((s) => [s.path, s.form])).toEqual([["/v1/billing_portal/sessions", { customer: "cus_ada", return_url: "https://commonink.app/settings/plan" }]]);
    expect((await call(ada.personId, "/api/billing/portal", off(), { method: "POST" })).status).toBe(404);
  });
});

describe("POST /api/stripe/webhook", () => {
  it("refuses a body over 256 KB before reading it whole or checking its signature", async () => {
    const body = JSON.stringify({ type: "customer.subscription.updated", padding: "x".repeat(256_000) });
    const res = await worker.fetch(new Request("https://commonink.app/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00" }, body }) as never, on());
    expect([res.status, await res.json()]).toEqual([413, { error: "invalid", message: "An event is at most 256000 bytes" }]);
  });

  const PERIOD_END = 1_800_000_000;
  const PERIOD_START = PERIOD_END - 365 * 86_400;
  const tied = (personId: string, customer: string) => env.DB.prepare("INSERT INTO billing (person_id, trial_ends, customer_id, updated_at) VALUES (?, 0, ?, 0)").bind(personId, customer).run();

  it("ties a completed Checkout's customer to its person and keeps the subscription Stripe has now", async () => {
    const ada = await newMember("Ada Lovelace");
    const sent = fakeStripe([subscription("cus_done", "active", PERIOD_END, { metadata: { person: ada.personId } })]);
    const done = await hook({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_1", object: "checkout.session", mode: "subscription", client_reference_id: ada.personId, customer: "cus_done", subscription: "sub_1" } } });
    expect(done).toEqual({ status: 200, body: { received: true }, cors: null });
    expect(sent.map((s) => [s.method, s.path, s.query])).toEqual([["GET", "/v1/subscriptions", { customer: "cus_done", status: "all", limit: "100" }]]);
    expect(await rowOf(ada.personId)).toEqual({ customer_id: "cus_done", subscription_id: "sub_1", status: "active", interval: "year", period_start: PERIOD_START * 1000, period_end: PERIOD_END * 1000, cancel_at_period_end: 0 });
    expect((await call(ada.personId, "/api/billing", on())).body.plan).toEqual({ status: "active", interval: "year", periodEnd: PERIOD_END * 1000, cancelling: false });
  });

  it("keeps what a subscription is now, not what the event said, its period from the item when the subscription has none", async () => {
    const ada = await newMember("Ada Lovelace");
    await tied(ada.personId, "cus_upd");
    fakeStripe([subscription("cus_upd", "past_due", PERIOD_END, { cancel_at_period_end: true })]);
    expect((await hook({ id: "evt_2", type: "customer.subscription.updated", data: { object: subscription("cus_upd", "active", PERIOD_END - 100) } })).status).toBe(200);
    expect(await rowOf(ada.personId)).toEqual({ customer_id: "cus_upd", subscription_id: "sub_1", status: "past_due", interval: "year", period_start: PERIOD_START * 1000, period_end: PERIOD_END * 1000, cancel_at_period_end: 1 });

    // Deleted, it is canceled, by the month when its price says so, with the period on the subscription itself.
    fakeStripe([{ ...subscription("cus_upd", "canceled", PERIOD_END), current_period_start: PERIOD_END - 30 * 86_400, current_period_end: PERIOD_END + 5, items: { data: [{ price: { recurring: { interval: "month" } } }] } }]);
    expect((await hook({ id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_1", object: "subscription", customer: "cus_upd" } } })).status).toBe(200);
    expect(await rowOf(ada.personId)).toEqual({ customer_id: "cus_upd", subscription_id: "sub_1", status: "canceled", interval: "month", period_start: (PERIOD_END - 30 * 86_400) * 1000, period_end: (PERIOD_END + 5) * 1000, cancel_at_period_end: 0 });
  });

  it("keeps the subscription still paid for when a customer has two and the other ended", async () => {
    const ada = await newMember("Ada Lovelace");
    await tied(ada.personId, "cus_two");
    fakeStripe([subscription("cus_two", "active", PERIOD_END, { id: "sub_paid", created: 1_700_000_000 }), subscription("cus_two", "canceled", PERIOD_END, { id: "sub_dup", created: 1_700_000_100 })]);
    expect((await hook({ id: "evt_7", type: "customer.subscription.deleted", data: { object: { id: "sub_dup", object: "subscription", customer: "cus_two" } } })).status).toBe(200);
    expect(await rowOf(ada.personId)).toMatchObject({ subscription_id: "sub_paid", status: "active" });
  });

  it("ties nobody to a customer by a session's client_reference_id, which a payment link takes from its address", async () => {
    const ada = await newMember("Ada Lovelace");
    await call(ada.personId, "/api/billing", on());
    // Someone else's payment, made through a link that named Ada.
    const sent = fakeStripe([subscription("cus_eve", "active", PERIOD_END, { id: "sub_eve", metadata: {} })]);
    const paid = (mode: string) => ({ id: "evt_8", type: "checkout.session.completed", data: { object: { id: "cs_eve", object: "checkout.session", mode, client_reference_id: ada.personId, customer: "cus_eve", subscription: mode === "subscription" ? "sub_eve" : null } } });
    expect((await hook(paid("payment"))).status).toBe(200);
    expect(sent).toEqual([]);
    expect((await hook(paid("subscription"))).status).toBe(200);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/subscriptions"]);
    expect(await rowOf(ada.personId)).toMatchObject({ customer_id: null, subscription_id: null, status: null });

    // A subscription Common Ink's own Checkout made says whose it is, and that is who it is tied to.
    const eve = await newMember("Eve");
    fakeStripe([subscription("cus_eve", "active", PERIOD_END, { id: "sub_eve", metadata: { person: eve.personId } })]);
    expect((await hook(paid("subscription"))).status).toBe(200);
    expect(await rowOf(ada.personId)).toMatchObject({ customer_id: null, status: null });
    expect(await rowOf(eve.personId)).toMatchObject({ customer_id: "cus_eve", subscription_id: "sub_eve", status: "active" });
  });

  it("cancels at once every live subscription but the first, refunds what it was paid, and asks the same again on a retry", async () => {
    const ada = await newMember("Ada Lovelace");
    await tied(ada.personId, "cus_twice");
    const subs = [
      subscription("cus_twice", "active", PERIOD_END, { id: "sub_second", created: 1_700_000_100 }),
      subscription("cus_twice", "active", PERIOD_END, { id: "sub_first", created: 1_700_000_000 }),
      subscription("cus_twice", "trialing", PERIOD_END, { id: "sub_free", created: 1_700_000_200 }),
      subscription("cus_twice", "canceled", PERIOD_END, { id: "sub_long_ago", created: 1_600_000_000 }),
    ];
    const invoices = [
      { subscription: "sub_second", id: "in_second", payment_intent: "pi_second" },
      { subscription: "sub_first", id: "in_first", payment_intent: "pi_first" },
    ];
    const event = { id: "evt_9", type: "customer.subscription.created", data: { object: { id: "sub_second", object: "subscription", customer: "cus_twice" } } };
    const asked = (sent: Sent[]) => sent.map((s) => [s.method, s.path, s.method === "POST" ? s.form : s.query, s.headers.get("Idempotency-Key"), s.headers.get("Stripe-Version")]);
    const expected = [
      ["GET", "/v1/subscriptions", { customer: "cus_twice", status: "all", limit: "100" }, null, null],
      ["GET", "/v1/invoices", { subscription: "sub_second", status: "paid", limit: "1", "expand[]": "data.payments" }, null, "2025-03-31.basil"],
      ["POST", "/v1/refunds", { payment_intent: "pi_second" }, "refund-sub_second", null],
      ["DELETE", "/v1/subscriptions/sub_second", { prorate: "false" }, null, null],
      ["GET", "/v1/invoices", { subscription: "sub_free", status: "paid", limit: "1", "expand[]": "data.payments" }, null, "2025-03-31.basil"],
      ["DELETE", "/v1/subscriptions/sub_free", { prorate: "false" }, null, null],
    ];

    let sent = fakeStripe(subs, { invoices });
    expect((await hook(event)).status).toBe(200);
    expect(asked(sent)).toEqual(expected);
    expect(await rowOf(ada.personId)).toMatchObject({ subscription_id: "sub_first", status: "active" });

    // Stripe sends the event again, as after a 502: the same refund is asked by the same key, so Stripe makes it once.
    sent = fakeStripe(subs, { invoices });
    expect((await hook(event)).status).toBe(200);
    expect(asked(sent)).toEqual(expected);
  });

  it("still cancels the second subscription when Stripe says its refund was made already, as on a retry a day later", async () => {
    const ada = await newMember("Ada Lovelace");
    await tied(ada.personId, "cus_late");
    const sent = fakeStripe(
      [subscription("cus_late", "active", PERIOD_END, { id: "sub_a", created: 1_700_000_000 }), subscription("cus_late", "active", PERIOD_END, { id: "sub_b", created: 1_700_000_100 })],
      { invoices: [{ subscription: "sub_b", id: "in_b", payment_intent: "pi_b" }], refuse: { path: "/v1/refunds", message: "Charge ch_b has already been refunded.", code: "charge_already_refunded" } },
    );
    expect((await hook({ id: "evt_12", type: "customer.subscription.updated", data: { object: { id: "sub_b", object: "subscription", customer: "cus_late" } } })).status).toBe(200);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/subscriptions", "GET /v1/invoices", "POST /v1/refunds", "DELETE /v1/subscriptions/sub_b"]);
    expect(await rowOf(ada.personId)).toMatchObject({ subscription_id: "sub_a", status: "active" });
  });

  it("keeps what the later of two refreshes read, when the earlier one's answer comes back last", async () => {
    const ada = await newMember("Ada Lovelace");
    await tied(ada.personId, "cus_race");
    const answers = [
      { wait: 60, sub: subscription("cus_race", "active", PERIOD_END) },
      { wait: 0, sub: subscription("cus_race", "canceled", PERIOD_END) },
    ];
    vi.stubGlobal("fetch", async () => {
      const { wait, sub } = answers.shift()!;
      await new Promise((r) => setTimeout(r, wait));
      return Response.json({ object: "list", data: [sub], has_more: false });
    });
    const event = (id: string) => ({ id, type: "customer.subscription.updated", data: { object: { id: "sub_1", object: "subscription", customer: "cus_race" } } });
    const earlier = hook(event("evt_10"));
    await new Promise((r) => setTimeout(r, 10));
    const later = hook(event("evt_11"));
    expect((await Promise.all([earlier, later])).map((r) => r.status)).toEqual([200, 200]);
    expect(await rowOf(ada.personId)).toMatchObject({ subscription_id: "sub_1", status: "canceled" });
  });

  it("refuses with 400 an event with no signature, a wrong one, or one signed more than five minutes ago, and changes nothing", async () => {
    const ada = await newMember("Ada Lovelace");
    await tied(ada.personId, "cus_bad");
    const sent = fakeStripe([subscription("cus_bad", "active", PERIOD_END)]);
    const event = { id: "evt_4", type: "customer.subscription.created", data: { object: { id: "sub_1", customer: "cus_bad" } } };
    const refused = { status: 400, body: { error: "invalid", message: "That isn't signed by Stripe, or it was signed too long ago" }, cors: null };
    expect(await hook(event, on(), { signature: "" })).toEqual(refused);
    expect(await hook(event, on(), { secret: "whsec_someone_else" })).toEqual(refused);
    expect(await hook(event, on(), { secondsAgo: 301 })).toEqual(refused);
    expect(await hook(event, on(), { signature: `t=${Math.floor(Date.now() / 1000)},v1=nothex` })).toEqual(refused);
    expect(sent).toEqual([]);
    expect(await rowOf(ada.personId)).toMatchObject({ status: null });
    // Within the five minutes it is taken.
    expect((await hook(event, on(), { secondsAgo: 290 })).status).toBe(200);
    expect(await rowOf(ada.personId)).toMatchObject({ status: "active" });
  });

  it("takes a signature among several, as while a secret is rolled", async () => {
    const ada = await newMember("Ada Lovelace");
    await tied(ada.personId, "cus_roll");
    fakeStripe([subscription("cus_roll", "active", PERIOD_END)]);
    const body = JSON.stringify({ id: "evt_5", type: "customer.subscription.created", data: { object: { id: "sub_1", customer: "cus_roll" } } });
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${await hmacHex("whsec_old", `${t}.${body}`)},v1=${await hmacHex(HOOK_SECRET, `${t}.${body}`)}`;
    const res = await worker.fetch(new Request("https://commonink.app/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": signature }, body }) as never, on());
    expect(res.status).toBe(200);
    expect(await rowOf(ada.personId)).toMatchObject({ status: "active" });
  });

  it("answers 404 while billing is off, signed or not", async () => {
    expect(await hook({ id: "evt_6", type: "customer.subscription.created", data: { object: { id: "sub_1", customer: "cus_x" } } }, off())).toEqual({ status: 404, body: { error: "not_found" }, cors: null });
  });
});

describe("deleting an account while billing is on", () => {
  const PERIOD_END = 1_800_000_000;
  const subscribed = (personId: string, customer: string) =>
    env.DB.prepare("INSERT INTO billing (person_id, trial_ends, customer_id, subscription_id, status, interval, updated_at) VALUES (?, 0, ?, 'sub_1', 'active', 'year', 0)").bind(personId, customer).run();
  const deleteAccount = async (ada: { personId: string; workspaceId: string }, settings = on()) => {
    const { email } = (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(ada.personId).first<{ email: string }>())!;
    return call(ada.personId, `/api/workspaces/${ada.workspaceId}/ops`, settings, { method: "POST", body: { type: "account.delete", confirm: email } });
  };
  const asked = (sent: Sent[]) => sent.map((s) => [s.method, s.path, s.method === "POST" ? s.form : s.query]);
  const personThere = async (personId: string) => (await env.DB.prepare("SELECT id FROM people WHERE id = ?").bind(personId).first()) !== null;

  it("cancels the person's subscription at Stripe at once, with no refund, then deletes the account and its billing row", async () => {
    const ada = await newMember("Ada Lovelace");
    await subscribed(ada.personId, "cus_del");
    const sent = fakeStripe([subscription("cus_del", "active", PERIOD_END), subscription("cus_del", "canceled", PERIOD_END, { id: "sub_0" }), subscription("cus_else", "active", PERIOD_END, { id: "sub_9" })]);

    expect(await deleteAccount(ada)).toEqual({ status: 200, body: { deleted: [{ id: ada.workspaceId, name: "Ada's workspace" }] } });
    expect(asked(sent), "the one that isn't over is cancelled, and nobody else's").toEqual([
      ["GET", "/v1/subscriptions", { customer: "cus_del", status: "all", limit: "100" }],
      ["DELETE", "/v1/subscriptions/sub_1", {}],
    ]);
    expect(await rowOf(ada.personId)).toBeNull();
    expect(await personThere(ada.personId)).toBe(false);
  });

  it("deletes nothing when Stripe won't cancel, says so, and deletes it all on a second try", async () => {
    const ada = await newMember("Ada Lovelace");
    await subscribed(ada.personId, "cus_stuck");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    fakeStripe([subscription("cus_stuck", "active", PERIOD_END)], { refuse: { path: "/v1/subscriptions/sub_1", message: "Stripe is having a bad day" } });

    expect(await deleteAccount(ada)).toEqual({
      status: 503,
      body: { error: "unavailable", message: "Your subscription couldn't be cancelled, so your account wasn't deleted. Try again, or write to support@commonink.app." },
    });
    expect(lines(logged).map((line) => line.split("\n")[0])).toEqual(["Cancelling a deleted account's subscription at Stripe broke: StripeError: DELETE /subscriptions/sub_1 answered 400: Stripe is having a bad day"]);
    expect(await personThere(ada.personId)).toBe(true);
    expect(await rowOf(ada.personId)).toMatchObject({ customer_id: "cus_stuck", subscription_id: "sub_1", status: "active" });
    expect((await call(ada.personId, `/api/workspaces/${ada.workspaceId}/ops`, on(), { method: "POST", body: { type: "note.list" } })).status, "her workspace is still there").toBe(200);

    const sent = fakeStripe([subscription("cus_stuck", "active", PERIOD_END)]);
    expect((await deleteAccount(ada)).status).toBe(200);
    expect(asked(sent).map(([method, path]) => `${method} ${path}`)).toEqual(["GET /v1/subscriptions", "DELETE /v1/subscriptions/sub_1"]);
    expect(await personThere(ada.personId)).toBe(false);
  });

  it("takes Stripe saying there is no such subscription, or no such customer, as nothing left to cancel", async () => {
    const ada = await newMember("Ada Lovelace");
    await subscribed(ada.personId, "cus_gone_sub");
    fakeStripe([subscription("cus_gone_sub", "active", PERIOD_END)], { refuse: { path: "/v1/subscriptions/sub_1", message: "No such subscription: 'sub_1'", code: "resource_missing" } });
    expect((await deleteAccount(ada)).status).toBe(200);
    expect(await personThere(ada.personId)).toBe(false);

    const bob = await newMember("Bob Babbage");
    await subscribed(bob.personId, "cus_gone");
    fakeStripe([], { refuse: { path: "/v1/subscriptions", message: "No such customer: 'cus_gone'", code: "resource_missing" } });
    expect((await deleteAccount(bob)).status).toBe(200);
    expect(await personThere(bob.personId)).toBe(false);
  });

  it("asks nothing of Stripe for someone who never subscribed, or while billing is off, and deletes their billing row all the same", async () => {
    const ada = await newMember("Ada Lovelace");
    await call(ada.personId, "/api/billing", on());
    expect(await rowOf(ada.personId), "her trial has a row").toMatchObject({ customer_id: null });
    const bob = await newMember("Bob Babbage");
    await subscribed(bob.personId, "cus_off");
    const sent = fakeStripe([subscription("cus_off", "active", PERIOD_END)]);

    expect((await deleteAccount(ada)).status).toBe(200);
    expect((await deleteAccount(bob, off())).status).toBe(200);
    expect(sent).toEqual([]);
    expect([await rowOf(ada.personId), await rowOf(bob.personId)]).toEqual([null, null]);
  });
});
