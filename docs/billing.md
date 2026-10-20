# Billing

Common Ink charges through Stripe: one plan, by the month or the year, after a free trial. `src/core/billing.ts` has the plans and the states a person's plan can be in, and `src/worker/billing.ts` talks to Stripe. This page is how to turn it on.

## What changes when it is on

Billing is off until all four Stripe settings below are set. Off, everything is free, and only the emails in `ALLOWED_EMAILS` can sign in.

On:

- Anyone can sign in. A person's first sign-in starts their 14-day trial, with no card.
- A workspace is paid for by its owner, the person who made it. Everyone in it can change it while the owner's plan is good.
- When the owner's plan lapses, their workspaces turn read-only for everyone in them and every agent. Reading, searching and copying notes out still work.
- A failed payment leaves the workspaces writable for 7 days while Stripe tries the card again.
- Deleting an account cancels the person's subscription at Stripe first, at once and with no refund, and deletes nothing if Stripe refuses. A workspace they paid for that others are in passes to its earliest remaining admin. A lapsed owner can still export their workspaces and delete them or their account.
- Settings, under Plan, shows where a person stands, with Subscribe and Manage billing. The site's pricing page and landing page offer the trial.

## Turn it on

Do this in Stripe's test mode first, on a Preview or your machine, then again in live mode for commonink.app.

1. In Stripe, make a product named Common Ink with two recurring prices: $8 a month and $60 a year. Copy each price's id (`price_…`). Before each Checkout the Worker reads the price from Stripe and refuses, logging the difference, unless it is that amount in USD by that interval.
2. Under Developers, Webhooks, add an endpoint at `https://commonink.app/api/stripe/webhook` that sends these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`

   Copy its signing secret (`whsec_…`).
3. Under Settings, Billing, Customer portal, turn on: update payment methods, view invoices, cancel subscriptions (at the end of the period), and switch plans between the two prices.
4. Set the four settings on the Worker:

   ```sh
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put STRIPE_PRICE_MONTH
   npx wrangler secret put STRIPE_PRICE_YEAR
   ```

5. Sign in with an account that isn't on `ALLOWED_EMAILS`, open Settings, Plan, and subscribe with Stripe's test card `4242 4242 4242 4242`. The plan says it is active once the webhook arrives.

## Try it on this machine

Put the four settings in `.dev.vars`, with test-mode keys, and forward Stripe's events to the dev server with the Stripe CLI:

```sh
stripe listen --forward-to localhost:5173/api/stripe/webhook
```

`stripe listen` prints a signing secret for this machine. Use it as `STRIPE_WEBHOOK_SECRET` here. `TRIAL_DAYS` in `.dev.vars` shortens the trial, to see a plan lapse.
