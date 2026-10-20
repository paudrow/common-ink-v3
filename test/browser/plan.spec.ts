import { expect, test, type Page } from "@playwright/test";
import type { Billing, Plan } from "../../src/core/billing.ts";
import { signInAsNewPerson } from "./helpers.ts";
import { group, settingsDialog } from "./settings-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const DAY = 86_400_000;
/** Noon, so the date reads the same in every time zone the test may run in. */
const in10Days = new Date(new Date().setHours(12, 0, 0, 0) + 10 * DAY);
const dayAndMonth = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric" });

const categories = (page: Page) => settingsDialog(page).getByRole("navigation", { name: "Categories" });
const plan = (page: Page) => group(page, "Plan");

/** Answers `/api/billing` with billing on and `plan`, whatever the server has. */
async function billingOn(page: Page, planNow: Plan, owns: Billing["owns"] = []) {
  await page.route("/api/billing", (route) => route.fulfill({ json: { on: true, plan: planNow, owns } satisfies Billing }));
}

test.use({ locale: "en-US" });

test("with billing off there is no Plan, and /settings/plan shows what any unknown section does", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/settings/nonsense");
  await expect(categories(page).getByRole("link", { name: "Account", exact: true })).toBeVisible();
  const unknownShows = await categories(page).locator('[aria-current="page"]').textContent();
  await page.goto("/settings/plan");
  await expect(categories(page).getByRole("link", { name: "Account", exact: true })).toBeVisible();
  await expect(categories(page).getByRole("link", { name: "Plan", exact: true })).toHaveCount(0);
  await expect(categories(page).locator('[aria-current="page"]')).toHaveText(unknownShows!);
  await expect(plan(page)).toHaveCount(0);
});

test("a trial says when it ends and subscribing by the month posts the interval and goes where Stripe answers", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "trial", trialEnds: in10Days.getTime(), customer: false }, [{ id: "w1", name: "Ada's notes" }]);
  let posted: unknown = null;
  await page.route("/api/billing/checkout", async (route) => {
    posted = route.request().postDataJSON();
    // Long enough to see the page say it is opening Stripe.
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({ json: { url: "https://checkout.stripe.test/pay/abc" } });
  });
  await page.route("https://checkout.stripe.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Stripe Checkout stub</h1>" }));
  await page.goto("/settings");
  await categories(page).getByRole("link", { name: "Plan", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/plan$/);

  await expect(plan(page)).toContainText(`Your free trial ends on ${dayAndMonth(in10Days)}.`);
  await expect(plan(page).getByRole("button")).toHaveText(["Subscribe for $8 a month", "Subscribe for $60 a year ($5 a month)"]);
  await expect(plan(page)).toContainText("Your plan keeps these workspaces writable:");
  await expect(plan(page).getByRole("list", { name: "Workspaces you own" }).getByRole("listitem")).toHaveText(["Ada's notes"]);
  await page.screenshot({ path: shot("trial") });

  await plan(page).getByRole("button", { name: "Subscribe for $8 a month" }).click();
  await expect(plan(page)).toContainText("Opening Stripe…");
  await expect(page).toHaveURL("https://checkout.stripe.test/pay/abc");
  await expect(page.getByRole("heading", { name: "Stripe Checkout stub" })).toBeVisible();
  expect(posted).toEqual({ interval: "month" });
});

test("a checkout that is refused says why, and the buttons can be pressed again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "trial", trialEnds: in10Days.getTime(), customer: true }, [{ id: "w1", name: "Ada's notes" }]);
  await page.route("/api/billing/checkout", (route) => route.fulfill({ status: 409, json: { error: "conflict", message: "You're already subscribed." } }));
  await page.goto("/settings/plan");
  await plan(page).getByRole("button", { name: "Subscribe for $60 a year ($5 a month)" }).click();
  await expect(plan(page).getByRole("alert")).toHaveText("You're already subscribed.");
  await expect(plan(page).getByRole("button", { name: "Subscribe for $8 a month" })).toBeEnabled();
  await page.screenshot({ path: shot("error") });
});

test("an active plan says what it costs and when it renews, and offers Manage billing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "active", interval: "year", periodEnd: in10Days.getTime(), cancelling: false });
  await page.goto("/settings/plan");
  await expect(plan(page)).toContainText(`You're subscribed, $60 a year. Renews on ${dayAndMonth(in10Days)}.`);
  await expect(plan(page).getByRole("button")).toHaveText(["Manage billing"]);
  await page.screenshot({ path: shot("active") });
});

test("a cancelling plan says when it ends", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "active", interval: "month", periodEnd: in10Days.getTime(), cancelling: true });
  await page.goto("/settings/plan");
  await expect(plan(page)).toContainText(`You're subscribed, $8 a month. Ends on ${dayAndMonth(in10Days)}.`);
});

test("a failed payment says until when the workspaces stay writable, and offers Update your card", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "past_due", interval: "month", graceEnds: in10Days.getTime() });
  await page.goto("/settings/plan");
  await expect(plan(page)).toContainText(`Your last payment didn't go through. Your workspaces stay writable until ${dayAndMonth(in10Days)} while your card is tried again.`);
  await expect(plan(page).getByRole("button")).toHaveText(["Update your card"]);
  await page.screenshot({ path: shot("past-due") });
});

test("a lapsed plan says the workspaces are read-only, with the subscribe buttons and Manage billing for a customer", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "lapsed", customer: true }, [{ id: "w1", name: "Ada's notes" }]);
  await page.goto("/settings/plan");
  await expect(plan(page)).toContainText("Your plan has ended, so the workspaces you own are read-only.");
  await expect(plan(page).getByRole("button")).toHaveText(["Subscribe for $8 a month", "Subscribe for $60 a year ($5 a month)", "Manage billing"]);
  await page.screenshot({ path: shot("lapsed") });
});

test("someone who owns no workspace is told they have nothing to pay for, and offered no subscription", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "trial", trialEnds: in10Days.getTime(), customer: false });
  await page.goto("/settings/plan");
  await expect(plan(page).locator(".plan-line")).toHaveText("You don't own a workspace, so you have nothing to pay for.");
  await expect(plan(page).getByRole("button")).toHaveCount(0);
  await expect(plan(page).getByRole("list", { name: "Workspaces you own" })).toHaveCount(0);
  await page.screenshot({ path: shot("owns-nothing") });

  // A customer whose trial has ended can still reach their invoices.
  await page.unrouteAll();
  await billingOn(page, { status: "lapsed", customer: true });
  await page.reload();
  await expect(plan(page).locator(".plan-line")).toHaveText("You don't own a workspace, so you have nothing to pay for.");
  await expect(plan(page).getByRole("button")).toHaveText(["Manage billing"]);
});

test("back from Checkout, the page thanks the person, takes the query off, and reads billing again until it is active", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  let confirmed = false;
  await page.route("/api/billing", (route) => {
    const planNow: Plan = confirmed ? { status: "active", interval: "month", periodEnd: in10Days.getTime(), cancelling: false } : { status: "trial", trialEnds: in10Days.getTime(), customer: true };
    return route.fulfill({ json: { on: true, plan: planNow, owns: [] } satisfies Billing });
  });
  await page.goto("/settings/plan?billing=done");
  await expect(plan(page)).toContainText("Thanks. Your subscription is starting; this page updates when Stripe confirms it.");
  await expect(page).toHaveURL(/\/settings\/plan$/);
  await page.screenshot({ path: shot("done") });
  confirmed = true;
  await expect(plan(page)).toContainText("You're subscribed, $8 a month.", { timeout: 10_000 });
  await expect(plan(page)).not.toContainText("Thanks.");
});

test("back from a cancelled Checkout, the page says nothing was charged", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await billingOn(page, { status: "trial", trialEnds: in10Days.getTime(), customer: false });
  await page.goto("/settings/plan?billing=cancelled");
  await expect(plan(page)).toContainText("Checkout was cancelled. Nothing was charged.");
  await expect(page).toHaveURL(/\/settings\/plan$/);
});

/** Answers `/api/me` as the server does, with every workspace read-only, and owned by the person only when `owned`. */
async function readOnlyMe(page: Page, owned: boolean) {
  await page.route("/api/me", async (route) => {
    const real = await (await route.fetch()).json();
    real.workspaces = real.workspaces.map(({ owned: theirs, ...w }: { owned?: true }) => ({ ...w, readOnly: true, ...(owned && theirs && { owned: true }) }));
    await route.fulfill({ json: real });
  });
}

test("a read-only workspace tells its owner so, and See plans opens Plan", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/");
  const banner = page.locator(".settings-banner.read-only");
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
  await expect(banner).toHaveCount(0);

  await readOnlyMe(page, true);
  await billingOn(page, { status: "lapsed", customer: false }, [{ id: "w1", name: "Ada's workspace" }]);
  await page.reload();
  await expect(banner).toHaveText("This workspace is read-only because your Common Ink plan has ended. Everyone can still read and search its notes.See plans");
  await page.screenshot({ path: shot("read-only-banner") });
  await banner.getByRole("link", { name: "See plans" }).click();
  await expect(page).toHaveURL(/\/settings\/plan$/);
  await expect(plan(page)).toContainText("Your plan has ended, so the workspaces you own are read-only.");
});

test("a read-only workspace tells everyone but its owner to ask the owner, and offers them no plan", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await readOnlyMe(page, false);
  await page.goto("/");
  const banner = page.locator(".settings-banner.read-only");
  await expect(banner).toHaveText("This workspace is read-only because its owner's Common Ink plan has ended. Everyone can still read and search its notes. Ask its owner to subscribe.");
  await expect(banner.getByRole("link")).toHaveCount(0);
  await page.screenshot({ path: shot("read-only-banner-member") });
});

const shot = (name: string) => `${process.env.PLAN_SHOTS ?? test.info().outputDir}/plan-${name}.png`;
