import { expect, type Page } from "@playwright/test";
import { anotherPerson, connectAgent, dropFirst, editOf, join, panelIcon, perform, signInAsNewPerson, test } from "./helpers.ts";
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

test("whether someone else changed the open note, unread once, is read at the member's next save", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  const note = await perform(page, { type: "note.create", text: "# Plan" });
  await claude.tool("write_note", { id: note.id, baseRevision: 1, text: "# Plan\n\nClaude's step" });
  await perform(page, { type: "note.write", id: note.id, baseRevision: 2, text: "# Plan\n\nClaude's step\n\nAda's word" });
  const checks = await dropFirst(page, "history.list");

  await page.goto(`/note/${note.id}`);
  const editor = page.getByRole("textbox", { name: "Note text" });
  await expect(editor).toContainText("Ada's word");
  await expect.poll(() => checks.dropped).toBe(1);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("!");

  await expect(panelIcon(page, "History")).toHaveAccessibleDescription("Changes you haven't seen");
});

test("a change made elsewhere to the open note, unread once, is read at the next listing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Plan" });
  await page.goto(`/note/${note.id}`);
  const editor = page.getByRole("textbox", { name: "Note text" });
  await expect(editor).toContainText("Plan");
  const reads = await dropFirst(page, "note.read");

  await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\nFrom elsewhere" });
  await reads.handled();

  // The notes are listed again every five seconds.
  await expect(editor).toContainText("From elsewhere", { timeout: 10_000 });
});

test("which agents wrote anything, unread once, isn't said to be none, and is read when a note changes", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const claude = await connectAgent(page, "Claude");
  await claude.tool("create_note", { text: "# From Claude" });
  await page.goto("/folder/all");
  await expect(editOf(page, "From Claude")).toBeVisible();
  const authors = await dropFirst(page, "history.authors");

  await page.getByRole("button", { name: "Ada's workspace" }).click();
  await page.getByRole("menuitem", { name: "Agents" }).click();
  const row = page.getByRole("list", { name: "Connected agents" }).getByRole("listitem");
  await expect(row).toContainText("last used just now");
  await authors.handled();
  await expect(row.getByText("No changes in")).toHaveCount(0);

  await perform(page, { type: "note.create", text: "# Mine" });
  await expect(row.getByRole("button", { name: "See its changes" })).toBeVisible({ timeout: 10_000 });
});

const trashedFile = (page: Page) =>
  page.evaluate(async () => {
    const workspaceId = ((await (await fetch("/api/me")).json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;
    const headers = { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "list.txt" })) };
    const { id } = (await (await fetch(`/api/workspaces/${workspaceId}/uploads`, { method: "POST", headers, body: "milk\n" })).json()) as { id: string };
    return id;
  });

test("the files in Trash, unread once, aren't said to be none, and are read when Trash opens again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "upload.trash", id: await trashedFile(page) });
  await page.goto("/dashboard");
  const trashed = await dropFirst(page, "upload.trashed");
  const notes = page.waitForResponse((res) => res.url().endsWith("/ops") && (res.request().postDataJSON() as { type: string }).type === "trash.list");

  await page.goto("/trash");
  await notes;
  await trashed.handled();
  const trash = page.getByRole("region", { name: "Trash" });
  await expect(trash.getByRole("alert")).toHaveText("Internal Server Error");
  await expect(trash.getByText("Trash is empty.")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("list", { name: "Files in Trash" }).getByRole("listitem")).toHaveText([/^list\.txt/]);
  await expect(trash.getByRole("alert")).toHaveCount(0);
});

test("the files in Trash, unread once, are read when Trash changes", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "upload.trash", id: await trashedFile(page) });
  const scrap = await perform(page, { type: "note.create", text: "# Scrap" });
  await page.goto("/dashboard");
  const trashed = await dropFirst(page, "upload.trashed");

  await page.goto("/trash");
  await trashed.handled();
  await perform(page, { type: "note.trash", id: scrap.id });

  await expect(page.getByRole("list", { name: "Notes in Trash" }).getByRole("listitem")).toHaveText([/^Scrap/], { timeout: 20_000 });
  await expect(page.getByRole("list", { name: "Files in Trash" }).getByRole("listitem")).toHaveText([/^list\.txt/]);
});

const tagsSection = (page: Page) => page.getByRole("navigation", { name: "Tags" });
const allTags = (page: Page) => page.getByRole("region", { name: "Tags" });
const allTagLinks = (page: Page) => allTags(page).getByRole("list", { name: "Tags" }).getByRole("link");
const goInApp = (page: Page, path: string) =>
  page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);

/** Leaves the app signing in opened, which may still be reading the tags, so the read dropped next is the next page's. */
const leaveApp = (page: Page) => page.goto("about:blank");

test("the tags, unread once, are read when the window comes back to the front", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Seeds\n\n#garden\n" });
  await leaveApp(page);
  const tags = await dropFirst(page, "tag.list");

  await page.goto("/dashboard");
  await tags.handled();
  await expect(tagsSection(page)).toHaveCount(0);
  await page.evaluate(() => dispatchEvent(new Event("focus")));

  await expect(tagsSection(page).getByRole("link")).toHaveText(["#garden1"]);
});

test("the tags, unread once, are read when the page of every tag opens", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Seeds\n\n#garden\n" });
  await leaveApp(page);
  const tags = await dropFirst(page, "tag.list");

  await page.goto("/dashboard");
  await tags.handled();
  await goInApp(page, "/tags");

  await expect(allTagLinks(page)).toHaveText(["#garden1"]);
  await expect(allTags(page).getByRole("alert")).toHaveCount(0);
});

test("the tags, unread once, are read when Settings' Tags opens", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Seeds\n\n#garden\n" });
  await leaveApp(page);
  const tags = await dropFirst(page, "tag.list");

  await page.goto("/dashboard");
  await tags.handled();
  await goInApp(page, "/settings/tags");

  const manage = page.getByRole("dialog", { name: "Settings" }).getByRole("treegrid", { name: "Tags" });
  await expect(manage.getByRole("rowheader")).toHaveText(["#garden"]);
});

test("the tags, unread on their own page, say why, and Try again reads them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Seeds\n\n#garden\n" });
  let down = true;
  await page.route("**/api/workspaces/*/ops", (route) =>
    down && (route.request().postDataJSON() as { type?: string }).type === "tag.list"
      ? route.fulfill({ status: 500, contentType: "text/plain", body: "Error: Network connection lost." })
      : route.fallback(),
  );

  await page.goto("/tags");
  await expect(allTags(page).getByRole("alert")).toHaveText("Internal Server Error Try again");
  down = false;
  await allTags(page).getByRole("button", { name: "Try again" }).click();

  await expect(allTagLinks(page)).toHaveText(["#garden1"]);
  await expect(allTags(page).getByRole("alert")).toHaveCount(0);
});

test("the tags, unread once while the server was still indexing, don't stay said to be indexing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Seeds\n\n#garden\n" });
  // The server says it is still indexing, so the app reads again in a moment, and that read is dropped.
  let indexing = true;
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if (!indexing || (route.request().postDataJSON() as { type?: string }).type !== "tag.list") return route.fallback();
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...(await answer.json()), indexing: true } });
  });

  await page.goto("/tags");
  await expect(allTags(page).getByRole("status")).toHaveText("Still indexing notes. Results may be missing some.");
  const tags = await dropFirst(page, "tag.list");
  indexing = false;
  await tags.handled();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(allTags(page).getByRole("status")).toHaveCount(0);
  await expect(allTagLinks(page)).toHaveText(["#garden1"]);
});

test("the tags after the first page, unread once, can be shown on asking again, and aren't said to be all", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const names = Array.from({ length: 201 }, (_, i) => `t${String(i).padStart(3, "0")}`);
  await perform(page, { type: "note.create", text: `# Many\n\n${names.map((name) => `#${name}`).join(" ")}\n` });
  await page.goto("/tags");
  await expect(allTagLinks(page)).toHaveCount(200);
  const tags = await dropFirst(page, "tag.list");

  await allTags(page).getByRole("button", { name: "Show more" }).click();
  await tags.handled();
  await expect(tagsSection(page).getByRole("link").last()).toHaveText("All tags");
  await allTags(page).getByRole("button", { name: "Show more" }).click();

  await expect(allTagLinks(page)).toHaveCount(201);
  await expect(tagsSection(page).getByRole("link").last()).toHaveText("All 201 tags");
});

test("the tags after the first page, asked for as a read of every tag is dropped, can still be shown", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const names = Array.from({ length: 201 }, (_, i) => `t${String(i).padStart(3, "0")}`);
  await perform(page, { type: "note.create", text: `# Many\n\n${names.map((name) => `#${name}`).join(" ")}\n` });
  await page.goto("/tags");
  await expect(allTagLinks(page)).toHaveCount(200);
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/workspaces/*/ops", async (route) => {
    const op = route.request().postDataJSON() as { type?: string; after?: string };
    if (op.type === "tag.list" && op.after !== undefined) await released;
    return route.fallback();
  });

  await allTags(page).getByRole("button", { name: "Show more" }).click();
  await expect(allTags(page).getByRole("button", { name: "Show more" })).toHaveCount(0);
  const tags = await dropFirst(page, "tag.list");
  await perform(page, { type: "note.create", text: "# More" });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await tags.handled();
  release();

  await expect(allTags(page).getByRole("alert")).toHaveText("Internal Server Error Try again");
  await expect(tagsSection(page).getByRole("link").last()).toHaveText("All tags");
  await allTags(page).getByRole("button", { name: "Show more" }).click();
  await expect(allTagLinks(page)).toHaveCount(201);
});

test("the tags, unread once, are still said to be unread when Show more brings more", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const names = Array.from({ length: 201 }, (_, i) => `t${String(i).padStart(3, "0")}`);
  await perform(page, { type: "note.create", text: `# Many\n\n${names.map((name) => `#${name}`).join(" ")}\n` });
  await page.goto("/tags");
  await expect(allTagLinks(page)).toHaveCount(200);
  const tags = await dropFirst(page, "tag.list");
  await perform(page, { type: "note.create", text: "# More" });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await tags.handled();
  await expect(allTags(page).getByRole("alert")).toHaveText("Internal Server Error Try again");

  await allTags(page).getByRole("button", { name: "Show more" }).click();
  await expect(allTagLinks(page)).toHaveCount(201);

  await expect(allTags(page).getByRole("alert")).toHaveText("Internal Server Error Try again");
});
