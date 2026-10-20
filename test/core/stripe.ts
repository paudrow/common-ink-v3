import { vi } from "vitest";

export const HOOK_SECRET = "whsec_test_secret";
/** The four settings that turn billing on, with Stripe's API at a host nothing else answers. */
export const STRIPE = { STRIPE_SECRET_KEY: "sk_test_123", STRIPE_WEBHOOK_SECRET: HOOK_SECRET, STRIPE_PRICE_MONTH: "price_month", STRIPE_PRICE_YEAR: "price_year", STRIPE_API: "https://stripe.test" };

export interface Sent {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  headers: Headers;
}

export const PRICES: Record<string, unknown> = {
  price_month: { id: "price_month", object: "price", unit_amount: 800, currency: "usd", recurring: { interval: "month" } },
  price_year: { id: "price_year", object: "price", unit_amount: 6000, currency: "usd", recurring: { interval: "year" } },
};

interface Faked {
  /** Every call is refused with this message, or only the call to this path. */
  refuse?: string | { path: string; message: string; code?: string };
  prices?: Record<string, unknown>;
  /** Paid invoices, by the subscription they are for. */
  invoices?: { subscription: string; id: string; payment_intent: string | null }[];
}

/** Stripe, as far as Common Ink asks anything of it. It throws for any other host, so nothing passes by reaching somewhere else. */
export function fakeStripe(subscriptions: ({ customer: string } & Record<string, unknown>)[] = [], { refuse, prices = PRICES, invoices = [] }: Faked = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.origin !== "https://stripe.test") throw new Error(`A request left for ${input}`);
    const method = init.method ?? "GET";
    sent.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), form: Object.fromEntries(new URLSearchParams((init.body as string) ?? "")), headers: new Headers(init.headers) });
    const refused = typeof refuse === "string" ? { message: refuse } : refuse?.path === url.pathname ? refuse : null;
    if (refused) return Response.json({ error: { type: "invalid_request_error", ...refused, path: undefined } }, { status: 400 });
    const price = url.pathname.match(/^\/v1\/prices\/(.+)$/)?.[1];
    if (method === "GET" && price && prices[price]) return Response.json(prices[price]);
    if (method === "POST" && url.pathname === "/v1/customers") return Response.json({ id: "cus_new", object: "customer" });
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") return Response.json({ id: "cs_1", object: "checkout.session", url: "https://checkout.stripe.test/c/pay/cs_1" });
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") return Response.json({ id: "bps_1", object: "billing_portal.session", url: "https://billing.stripe.test/p/session/bps_1" });
    if (method === "GET" && url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: subscriptions.filter((s) => s.customer === url.searchParams.get("customer")), has_more: false });
    // As the version Common Ink asks for answers: an invoice's payments are a list of its own.
    if (method === "GET" && url.pathname === "/v1/invoices") {
      const data = invoices
        .filter((i) => i.subscription === url.searchParams.get("subscription"))
        .map((i) => ({ id: i.id, object: "invoice", status: "paid", payments: { object: "list", data: i.payment_intent ? [{ object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: i.payment_intent } }] : [] } }));
      return Response.json({ object: "list", data, has_more: false });
    }
    if (method === "POST" && url.pathname === "/v1/refunds") return Response.json({ id: `re_for_${url.searchParams.get("payment_intent") ?? ""}`, object: "refund", status: "succeeded" });
    const cancelled = url.pathname.match(/^\/v1\/subscriptions\/(.+)$/)?.[1];
    if (method === "DELETE" && cancelled) return Response.json({ id: cancelled, object: "subscription", status: "canceled" });
    return Response.json({ error: { message: `No such resource: ${url.pathname}` } }, { status: 404 });
  });
  return sent;
}

/** A yearly subscription as a recent version of Stripe's API answers it: its period is on the item. */
export const subscription = (customer: string, status: string, periodEnd: number, more: Record<string, unknown> = {}) => ({
  id: "sub_1",
  object: "subscription",
  customer,
  status,
  created: 1_700_000_000,
  cancel_at_period_end: false,
  items: { object: "list", data: [{ id: "si_1", current_period_start: periodEnd - 365 * 86_400, current_period_end: periodEnd, price: { id: "price_year", recurring: { interval: "year" } } }] },
  metadata: {},
  ...more,
});
