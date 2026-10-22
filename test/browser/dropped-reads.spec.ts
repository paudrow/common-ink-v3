import { expect } from "@playwright/test";
import { dropFirst, perform, signInAsNewPerson, test } from "./helpers.ts";

// Each read the app keeps, answered once with the 500 the built Worker gives a request it dropped, is
// asked again the next time the app would ask for it anyway, and never taken for an answer meanwhile.

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

test("a note's pin, unread once, is read when the next note opens", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await perform(page, { type: "note.create", text: "# Plan" });
  const other = await perform(page, { type: "note.create", text: "# Other" });
  await perform(page, { type: "pin.set", id: plan.id, pinned: true });
  const pins = await dropFirst(page, "pin.list");

  await page.goto(`/note/${other.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Other");
  await pins.handled();
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/note/${plan.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Plan");

  await expect(page.getByRole("button", { name: "Unpin from dashboard" })).toHaveAttribute("aria-pressed", "true");
});

test("the Dashboard's pins, unread once, are read when a note comes", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await perform(page, { type: "note.create", text: "# Plan" });
  await perform(page, { type: "pin.set", id: plan.id, pinned: true });
  const pins = await dropFirst(page, "pin.list");

  await page.goto("/dashboard");
  const dashboard = page.getByRole("region", { name: "Dashboard", exact: true });
  const pinned = dashboard.getByRole("region", { name: "Pinned", exact: true });
  // Today's notes is read once the app has the notes, as Pinned is drawn from them.
  await expect(dashboard.getByRole("region", { name: "Today's notes", exact: true })).toHaveAttribute("aria-busy", "false");
  await pins.handled();
  await expect(pinned).toHaveAttribute("aria-busy", "true");
  await expect(pinned).not.toContainText("Nothing is pinned.");
  await perform(page, { type: "note.create", text: "# New" });

  await expect(pinned.getByRole("list", { name: "Pinned notes" })).toContainText("Plan", { timeout: 20_000 });
});
