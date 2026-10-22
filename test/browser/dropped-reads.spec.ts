import { expect } from "@playwright/test";
import { anotherPerson, dropFirst, join, perform, signInAsNewPerson, test } from "./helpers.ts";
import { codeHashOf, install, openPlugins, runCommand, toast, turnOn } from "./third-party-helpers.ts";

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

test("who a todo can be assigned to, unread once when a note changes, stays who it was", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await join(await anotherPerson(page, "Grace Hopper"), page, "editor");
  await perform(page, { type: "note.create", text: "# Chores\n\n- [ ] Wash\n- [ ] Dry" });
  await page.goto("/todos");
  const todos = page.getByRole("region", { name: "Todos" }).getByRole("list", { name: "Todos" }).getByRole("listitem");
  await expect(todos.getByRole("button", { name: "Assign: nobody" })).toHaveCount(2);
  const members = await dropFirst(page, "member.list");
  const reread = page.waitForResponse((res) => res.url().endsWith("/ops") && (res.request().postDataJSON() as { includeArchived?: boolean }).includeArchived === true);

  await todos.filter({ hasText: "Wash" }).getByRole("checkbox").click();
  await reread;
  await members.handled();

  await expect(todos.filter({ hasText: "Dry" }).getByRole("button", { name: "Assign: nobody" })).toBeVisible({ timeout: 1 });
});

test("who a todo can be assigned to, unread once as Todos opens, is read again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await join(await anotherPerson(page, "Grace Hopper"), page, "editor");
  await perform(page, { type: "note.create", text: "# Chores\n\n- [ ] Wash" });
  // Mentions reads the members as the app starts, and Todos reads them as it opens and again once the notes are read.
  const members = await dropFirst(page, "member.list", 3);

  await page.goto("/todos");
  const todo = page.getByRole("region", { name: "Todos" }).getByRole("list", { name: "Todos" }).getByRole("listitem");
  await expect(todo).toContainText("Wash");
  await members.handled();

  await expect(todo.getByRole("button", { name: "Assign: nobody" })).toBeVisible({ timeout: 10_000 });
});

test("a running draft of a plugin, its drafts unread once, runs once the app reads again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const greeter = { name: "Greeter", version: "1.0", description: "Says hello.", capabilities: [], commands: [{ id: "greet", title: "Greet" }] };
  const id = await install(page, greeter, `ink.onCommand("greet", () => ink.notify("Hello from the plugin"));\n`);
  const note = await perform(page, { type: "note.create", text: "# Plan" });
  await page.goto(`/note/${note.id}`);
  await openPlugins(page);
  await turnOn(page, "Greeter");
  const code = `ink.onCommand("greet", () => ink.notify("Hello from my draft"));\n`;
  await perform(page, { type: "draft.save", id, manifest: JSON.stringify(greeter), code, baseHash: await codeHashOf(page, id), running: true });
  const drafts = await dropFirst(page, "draft.list");

  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Plan");
  await drafts.handled();
  // What the app reads again every so often, it reads when the window comes back to the front.
  await page.evaluate(() => dispatchEvent(new Event("focus")));

  await expect(async () => {
    await runCommand(page, "Greeter plugin: Greet");
    await expect(toast(page)).toHaveText(/Hello from my draft/, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
});
