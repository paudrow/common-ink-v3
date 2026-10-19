import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, panelIcon, perform, showPanel, signInAsNewPerson, THEIR_FRAMES } from "./helpers.ts";
import { asPlugin, codeHashOf, frameFor, install, openDetails, openPlugins, pluginRow, relist, runCommand, running, toast, turnOn, type Written } from "./third-party-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const permission = (page: Page, title: string, plugin = "Word counter") => page.getByRole("listitem", { name: `${title} for ${plugin}` });

const COUNTER: Written = {
  name: "Word counter",
  version: "1.2",
  description: "Counts the words in your notes.",
  capabilities: [
    { name: "notes.read", reason: "To count the words in your notes." },
    { name: "notes.write", reason: "To write the count into a note." },
    { name: "todos.read", reason: "To leave todos out of the count." },
  ],
  commands: [
    { id: "count", title: "Count notes" },
    { id: "stamp", title: "Stamp a note" },
  ],
  views: [
    { slot: "inspector", id: "words", label: "Words" },
    { slot: "page", id: "totals", label: "Word totals" },
  ],
  embeds: [{ name: "wordcount", title: "Word count", height: 96 }],
  settings: { unit: { type: "string", default: "words", enum: ["words", "characters"], title: "Unit" } },
};

const COUNTER_CODE = `
ink.onCommand("count", async () => {
  try {
    const notes = await ink.perform({ type: "note.list" });
    await ink.notify("Counted " + notes.length + " notes");
  } catch (err) {
    await ink.notify("Refused: " + err.code + ": " + err.message);
  }
});
ink.onCommand("stamp", async () => {
  try {
    const plan = (await ink.perform({ type: "note.list" })).find((n) => n.title === "Plan");
    if (!plan) return void (await ink.notify("Stamped " + (await ink.perform({ type: "note.create", text: "# Stamped\\n" })).id));
    const note = await ink.perform({ type: "note.read", id: plan.id });
    await ink.perform({ type: "note.write", id: note.id, baseRevision: note.revision, text: note.text + "\\n\\nThe counter's step" });
    await ink.notify("Stamped " + note.id);
  } catch (err) {
    await ink.notify("Refused: " + err.code + ": " + err.message);
  }
});
const say = (text) => { const p = document.createElement("p"); p.className = "said"; p.textContent = text; ink.root.append(p); };
if (ink.context.kind === "view") {
  say("View " + ink.context.id + " in " + ink.settings.unit + ", granted " + ink.granted.join(" "));
  if (ink.context.noteId) ink.perform({ type: "note.read", id: ink.context.noteId }).then((note) => say(note.text.split(/\\s+/).filter(Boolean).length + " words"), (err) => say("Refused: " + err.code));
  ink.onSettings((settings) => say("Now in " + settings.unit));
}
if (ink.context.kind === "embed") say("Embed " + ink.context.name + " of " + JSON.stringify(ink.context.config) + ", read only " + ink.context.readOnly);
`;

test("an admin installs a plugin through the form, is shown each capability with its reason, and only what is ticked is allowed", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/plugins");
  const form = page.getByRole("form", { name: "Install a plugin" });
  await expect(page.getByRole("list", { name: "Plugins" }).getByText("Third-party")).toHaveCount(0);

  // A manifest that isn't one is said to be so, with why, and nothing is installed.
  await form.getByRole("textbox", { name: "Manifest" }).fill("{ not json");
  await form.getByRole("textbox", { name: "Code" }).fill(COUNTER_CODE);
  await form.getByRole("button", { name: "Review" }).click();
  await expect(form.getByRole("alert")).toHaveText("The manifest isn't JSON");
  await form.getByRole("textbox", { name: "Manifest" }).fill(JSON.stringify({ ...COUNTER, capabilities: [{ name: "everything", reason: "Because" }] }));
  await form.getByRole("button", { name: "Review" }).click();
  await expect(form.getByRole("alert")).toContainText("capabilities");
  await expect(form.getByRole("group", { name: /^Review/ })).toHaveCount(0);

  await form.getByRole("textbox", { name: "Manifest" }).fill(JSON.stringify(COUNTER));
  await form.getByRole("button", { name: "Review" }).click();
  const review = form.getByRole("group", { name: "Review Word counter" });
  await expect(review).toContainText("version 1.2");
  await expect(review).toContainText("It adds 2 commands, 2 views and 1 embed.");
  for (const [title, reason] of [
    ["Read notes", "To count the words in your notes."],
    ["Write notes", "To write the count into a note."],
    ["Read todos", "To leave todos out of the count."],
  ]) {
    const asked = review.getByRole("listitem", { name: title! });
    await expect(asked).toContainText(`Word counter says: ${reason}`);
    await expect(asked.getByRole("checkbox", { name: `Allow ${title}` })).not.toBeChecked();
  }
  await expect(review.getByText("can send whatever it is allowed to read to another computer")).toHaveCount(1);
  await expect(review).toContainText("WebRTC");
  await expect(review).toContainText("What an embed is handed is written in the note, by anyone who can change that note.");
  // Nothing is installed by looking.
  await expect.poll(async () => (await perform(page, { type: "plugin.list" })).plugins.filter((p) => p.thirdParty)).toEqual([]);

  await review.getByRole("checkbox", { name: "Allow Read notes" }).check();
  await review.getByRole("button", { name: "Install" }).click();

  const installed = pluginRow(page, "Word counter");
  await expect(installed).toContainText("Third-party");
  await expect(installed).toContainText("Counts the words in your notes.");
  await expect(installed.getByRole("checkbox", { name: "Word counter", exact: true })).not.toBeChecked();
  await expect(form.getByRole("textbox", { name: "Manifest" })).toHaveValue("");
  await openDetails(page, "Word counter");
  const details = page.locator(".plugin-details");
  await expect(details).toContainText("version 1.2");
  await expect(details).toContainText("installed by Ada Lovelace");
  await expect(details).toContainText("Counts the words in your notes.");
  await expect(page.getByRole("region", { name: "What it adds" }).getByRole("group", { name: "Commands" })).toContainText("Count notes");
  await expect(page.getByRole("region", { name: "What it adds" }).getByRole("group", { name: "Embeds" })).toContainText("::x-wordcount{}");
  await expect(permission(page, "Read notes")).toContainText("Allowed");
  await expect(permission(page, "Read notes")).toContainText("decided by Ada Lovelace");
  await expect(permission(page, "Write notes")).toContainText("Off");
  await expect(permission(page, "Read todos")).toContainText("Off");
  await expect(details.getByRole("checkbox", { name: "Word counter", exact: true })).not.toBeChecked();
  await expect
    .poll(async () => (await perform(page, { type: "plugin.list" })).plugins.filter((p) => p.thirdParty).map((p) => [p.manifest.name, p.permissions.map((c) => `${c.capability} ${c.state}`)]))
    .toEqual([["Word counter", ["notes.read allowed", "notes.write off", "todos.read off"]]]);
  // Nothing of it ran: installing a plugin starts no frame.
  expect(running(page)).toHaveLength(0);

  // Other code under the same name is the same plugin, and nothing it was allowed carries over to it.
  const [before] = (await perform(page, { type: "plugin.list" })).plugins.filter((p) => p.thirdParty);
  // The page's one primary action is the switch; updating is in its "…" menu.
  await details.getByRole("button", { name: "More for Word counter" }).click();
  await page.getByRole("menu", { name: "More for Word counter" }).getByRole("menuitem", { name: "Update…" }).click();
  const update = page.getByRole("form", { name: "Update Word counter" });
  await expect(update.getByRole("heading", { name: "Update Word counter" })).toBeVisible();
  await update.getByRole("textbox", { name: "Manifest" }).fill(JSON.stringify(COUNTER));
  await update.getByRole("textbox", { name: "Code" }).fill(`${COUNTER_CODE}\n// changed`);
  await update.getByRole("button", { name: "Review" }).click();
  await expect(update.getByRole("group", { name: "Review Word counter" }).getByRole("checkbox", { name: "Allow Read notes" })).not.toBeChecked();
  await update.getByRole("group", { name: "Review Word counter" }).getByRole("button", { name: "Update" }).click();
  await expect(permission(page, "Read notes")).toContainText("Off");
  await expect(permission(page, "Read notes")).toContainText("It was allowed, and the plugin has changed since. It is off until an admin allows it again.");
  const [after] = (await perform(page, { type: "plugin.list" })).plugins.filter((p) => p.thirdParty);
  expect([after!.id, after!.codeHash === before!.codeHash, after!.permissions[0]!.state]).toEqual([before!.id, false, "off"]);
  await expect(update).toHaveCount(0);
  await page.getByRole("link", { name: "All plugins" }).click();
  await expect(form.getByRole("heading", { name: "Install a plugin" })).toBeVisible();
});

/** Puts the cursor on the note's line `n`, counted from 0. */
async function onLine(page: Page, n: number) {
  // Focused, not clicked: the middle of the note can be under a frame's shield.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < n; i++) await page.keyboard.press("ArrowDown");
}

test("a command reads notes and tells the member, a view and a page are drawn in frames of the plugin's, and an embed below its line", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await install(page, COUNTER, COUNTER_CODE, ["notes.read"]);
  const note = await perform(page, { type: "note.create", text: "# Counted\n\none two three\n\n::x-wordcount{all}\n\nend\n" });
  await turnOn(page, "Word counter");

  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("one two three");
  // The command runs in a frame nobody sees, started when it is first asked for.
  await runCommand(page, "Word counter plugin: Count notes");
  await expect(toast(page)).toContainText(/^Word counter plugin: Counted \d+ notes/);
  const background = await frameFor(page, "background");
  await expect.poll(() => background.evaluate(() => self.origin)).toBe("null");
  await expect(page.locator(".plugin-background:not([data-own])")).toBeHidden();

  // The embed: its title in the line as text, and below it the plugin's frame in the room the manifest named. A line with the embed alone on it is out of sight until the cursor is on it (#50).
  await onLine(page, 4);
  await expect(editor(page).locator(".media-name")).toHaveText("Word counter plugin: Word count");
  const below = page.locator('.embed-below[data-embed="x-wordcount"]');
  await expect(below).toBeVisible();
  expect(Math.round((await below.boundingBox())!.height)).toBe(96);
  const embed = await frameFor(page, "embed", "wordcount");
  await expect(embed.locator(".said")).toHaveText('Embed wordcount of "all", read only true');
  // The room is the note's to size, from the manifest: whatever the frame draws, the line after it is where it was.
  const end = page.locator(".cm-line").filter({ hasText: /^end$/ });
  const before = (await end.boundingBox())!.y;
  await embed.evaluate(() => void (document.body.style.height = "4000px"));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect.poll(async () => (await end.boundingBox())!.y).toBe(before);
  expect(Math.round((await below.boundingBox())!.height)).toBe(96);

  // The inspector's panel is there to pick, and the inspector didn't open on it.
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(panelIcon(page, "Word counter plugin: Words")).toHaveAttribute("aria-expanded", "false");
  await showPanel(page, "Word counter plugin: Words");
  const view = await frameFor(page, "view", "words");
  await expect(view.locator(".said").first()).toHaveText("View words in words, granted notes.read");
  await expect(view.locator(".said").nth(1)).toHaveText("7 words");
  // What shuts it in is its document's own headers, as an HTML embed's: an origin with no name, whatever the frame around it says.
  await expect.poll(() => view.locator("body").evaluate(() => self.origin)).toBe("null");
  await expect(inspector.locator(".plugin-frame iframe")).not.toHaveAttribute("sandbox");

  // A setting the plugin declared reaches its frames when the member changes it.
  await perform(page, { type: "settings.write", text: JSON.stringify({ [`${id}.enabled`]: true, [`${id}.unit`]: "characters" }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.evaluate(() => void window.dispatchEvent(new Event("focus")));
  await expect(view.locator(".said").last()).toHaveText("Now in characters", { timeout: 20_000 });

  // The page has an address of its own, and the command that goes to it says whose page it is.
  await runCommand(page, "Go to Word counter plugin: Word totals");
  await expect(page).toHaveURL(new RegExp(`/x/${id}/totals$`));
  const totals = await frameFor(page, "view", "totals");
  await expect(totals.locator(".said").first()).toHaveText("View totals in characters, granted notes.read");
});

test("a plugin's embed is written ::x-name{}, so one named as a built-in's is never drawn for the built-in's line, even while that built-in is off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await install(page, { name: "Clock", embeds: [{ name: "timer", title: "Timer", height: 60 }] }, 'ink.root.textContent = "Clock drew " + ink.context.name + " of " + ink.context.config;');
  const note = await perform(page, { type: "note.create", text: "# Timed\n\n::timer{5m}\n\n::x-timer{9m}\n\nend\n" });
  await perform(page, { type: "settings.write", text: JSON.stringify({ "timer.enabled": false, [`${id}.enabled`]: true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });

  await page.goto(`/note/${note.id}`);
  const embed = await frameFor(page, "embed", "timer");
  await expect(embed.locator("body")).toContainText("Clock drew timer of 9m");
  // The one line that is the plugin's says whose it is, with the cursor on it. The built-in's line is left as it was written.
  await onLine(page, 4);
  await expect(editor(page).locator(".media-name")).toHaveText(["Clock plugin: Timer"]);
  await expect(page.locator(".embed-below")).toHaveCount(1);
  await expect(page.locator('.embed-below[data-embed="x-timer"] iframe')).toHaveCount(1);
  await expect(editor(page)).toContainText("::timer{5m}");
  expect(running(page)).toHaveLength(1);
  await openPlugins(page);
  await expect(pluginRow(page, "Clock")).toBeVisible();
  await expect(pluginRow(page, "Clock").getByRole("alert")).toHaveCount(0);
});

test("a plugin named as one of Common Ink's own is doesn't start, and the Plugins page says why", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  // The server refuses such a name when a plugin is installed, in whatever letters: this one has a Cyrillic а.
  await expect(perform(page, { type: "plugin.install", manifest: JSON.stringify({ name: "Dаshboard" }), code: "1" })).rejects.toThrow("a plugin can't have a name that is Common Ink's own, or that reads as one");
  // The app checks again against the built-in plugins it has, for a record that holds such a name all the same: here the record is answered with one.
  const id = await install(page, { name: "Helper", commands: [{ id: "go", title: "Open" }], views: [{ slot: "page", id: "home", label: "Home" }] }, "1");
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if (!route.request().postData()?.includes('"plugin.list"')) return route.continue();
    const answer = await route.fetch();
    const record = (await answer.json()) as { plugins: { id: string; manifest: { name: string } }[] };
    for (const plugin of record.plugins) if (plugin.id === id) plugin.manifest.name = " dаshboard";
    await route.fulfill({ response: answer, json: record });
  });
  await perform(page, { type: "settings.write", text: JSON.stringify({ [`${id}.enabled`]: true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });

  await page.goto("/plugins");
  await expect(page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Third-party" }).getByRole("alert")).toHaveText("Its name is one of Common Ink's own, or reads as one");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("dashboard");
  await expect(page.locator(".palette").getByRole("option")).toHaveText(["Go to Dashboard", "Disable plugin: Dashboard"]);
  await page.keyboard.press("Escape");
  await page.goto(`/x/${id}/home`);
  await expect(page.getByText("There's nothing at this address.")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a member who isn't an admin sees what a plugin may do and can only ask; once an admin approves, the plugin running on the member's page may do it without the page being loaded again; a locked permission can't be asked for", async ({ page }) => {
  await signInAsNewPerson(page, "Mel Member");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const id = await install(admin, COUNTER, COUNTER_CODE, ["notes.read"]);
  const note = await perform(admin, { type: "note.create", text: "# Shared\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Shared");
  await page.evaluate(() => void ((window as unknown as { sameLoad: boolean }).sameLoad = true));

  await openPlugins(page);
  await expect(page.getByRole("form", { name: "Install a plugin" })).toHaveCount(0);
  await openDetails(page, "Word counter");
  const mine = page.locator(".plugin-details");
  // Its source, further down, is read once it comes near, and then offers Edit a copy, which a member may: the asks are the buttons that matter here.
  await expect(mine.getByRole("button").filter({ hasNotText: "Edit a copy" })).toHaveText(["Ask an admin", "Ask an admin"]);
  await expect(permission(page, "Read notes")).toContainText("Allowed");
  await expect(permission(page, "Read notes").getByRole("button")).toHaveCount(0);
  await expect(permission(page, "Write notes")).toContainText("Off");
  await expect(permission(page, "Write notes")).toContainText("Word counter says: To write the count into a note.");
  await mine.getByRole("checkbox", { name: "Word counter", exact: true }).check();

  await runCommand(page, "Word counter plugin: Stamp a note");
  await expect(toast(page)).toContainText("Word counter plugin: Refused: forbidden: Word counter isn't permitted to note.create");

  await permission(page, "Write notes").getByRole("button", { name: "Ask an admin for Write notes for Word counter" }).click();
  await expect(permission(page, "Write notes").getByRole("status")).toHaveText("Asked. An admin decides.");
  await expect(permission(page, "Write notes").getByRole("button")).toHaveCount(0);
  // Asking allowed nothing, and a member can't allow it themself.
  await expect.poll(async () => (await perform(admin, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.permissions.map((p) => `${p.capability} ${p.state}`)).toEqual(["notes.read allowed", "notes.write off", "todos.read off"]);
  await expect(perform(page, { type: "plugin.permit", id, capability: "notes.write", allowed: true, codeHash: await codeHashOf(page, id, workspaceId) }, workspaceId)).rejects.toThrow("editor can't plugin.permit");
  await expect.poll(async () => (await asPlugin(page, workspaceId, id, { type: "note.create", text: "# Not yet" })).status).toBe(403);

  await admin.goto("/plugins");
  await expect(pluginRow(admin, "Word counter")).toContainText("1 asking");
  await openDetails(admin, "Word counter");
  const asked = admin.getByRole("group", { name: "Mel Member asked for Write notes for Word counter" });
  await expect(asked).toContainText("Mel Member asked for this.");
  await asked.getByRole("button", { name: "Approve" }).click();
  await expect(permission(admin, "Write notes")).toContainText("Allowed");
  await expect(asked).toHaveCount(0);

  await relist(page);
  await expect(permission(page, "Write notes")).toContainText("Allowed");
  await expect(permission(page, "Write notes").getByRole("status")).toHaveCount(0);
  await runCommand(page, "Word counter plugin: Stamp a note");
  await expect(toast(page)).toContainText(/Word counter plugin: Stamped [a-z0-9]{12}/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { sameLoad?: boolean }).sameLoad), "the member's page was never loaded again").toBe(true);

  // Locked: nobody can ask for it, and the admin can't change it without unlocking.
  await permission(admin, "Read todos").getByRole("button", { name: "Lock Read todos for Word counter" }).click();
  await expect(permission(admin, "Read todos")).toContainText("Locked");
  await expect(permission(admin, "Read todos").getByRole("button", { name: "Allow Read todos for Word counter" })).toBeDisabled();
  await relist(page);
  await expect(permission(page, "Read todos")).toContainText("An admin locked it, so it can't be asked for.");
  await expect(permission(page, "Read todos").getByRole("button")).toHaveCount(0);
  await expect(perform(page, { type: "plugin.request", id, capability: "todos.read" }, workspaceId)).rejects.toThrow();
  await expect(perform(admin, { type: "plugin.permit", id, capability: "todos.read", allowed: true, codeHash: await codeHashOf(admin, id) })).rejects.toThrow("Unlock it first");
  await permission(admin, "Read todos").getByRole("button", { name: "Unlock Read todos for Word counter" }).click();
  await expect(permission(admin, "Read todos").getByRole("button", { name: "Allow Read todos for Word counter" })).toBeEnabled();
  await permission(admin, "Read todos").getByRole("button", { name: "Allow Read todos for Word counter" }).click();
  await expect(permission(admin, "Read todos")).toContainText("Allowed");
  // Locking and unlocking say again that it is allowed, for the code as it is now, and leave it allowed.
  await permission(admin, "Read todos").getByRole("button", { name: "Lock Read todos for Word counter" }).click();
  await expect(permission(admin, "Read todos")).toContainText("Locked");
  await permission(admin, "Read todos").getByRole("button", { name: "Unlock Read todos for Word counter" }).click();
  await expect(permission(admin, "Read todos")).not.toContainText("Locked");
  await expect(permission(admin, "Read todos")).toContainText("Allowed");
  await expect(admin.getByRole("alert")).toHaveCount(0);
  await permission(admin, "Read todos").getByRole("button", { name: "Turn off Read todos for Word counter" }).click();
  await expect(permission(admin, "Read todos")).toContainText("Off");
});

test("a plugin uninstalled while another page has it running is refused by the server at once, and that page loses its commands, views and frames when it next reads the record", async ({ page }) => {
  await signInAsNewPerson(page, "Mel Member");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const id = await install(admin, COUNTER, COUNTER_CODE, ["notes.read"]);
  const note = await perform(admin, { type: "note.create", text: "# Shared\n\n::x-wordcount{all}\n\nend\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Shared");
  await openPlugins(page);
  await turnOn(page, "Word counter", workspaceId);
  await page.goto(`/note/${note.id}`);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await showPanel(page, "Word counter plugin: Words");
  await frameFor(page, "view", "words");
  await frameFor(page, "embed", "wordcount");
  await runCommand(page, "Word counter plugin: Count notes");
  await expect(toast(page)).toContainText(/Counted \d+ notes/);
  expect(running(page)).toHaveLength(3);
  await expect.poll(async () => (await asPlugin(page, workspaceId, id, { type: "note.list" })).status).toBe(200);

  await admin.goto("/plugins");
  await openDetails(admin, "Word counter");
  await admin.getByRole("button", { name: "More for Word counter" }).click();
  await admin.getByRole("menuitem", { name: "Uninstall…" }).click();
  await admin.getByRole("group", { name: "Uninstall Word counter?" }).getByRole("button", { name: "Uninstall it" }).click();
  await expect(admin).toHaveURL(/\/plugins$/);
  await expect(admin.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "History" })).toBeVisible();
  await expect(pluginRow(admin, "Word counter")).toHaveCount(0);

  // At once, whatever the member's page still shows: the server performs nothing for it.
  await expect.poll(() => asPlugin(page, workspaceId, id, { type: "note.list" })).toMatchObject({ status: 403, body: { error: "forbidden" } });
  await expect(perform(page, { type: "plugin.read", id }, workspaceId)).rejects.toThrow();

  await relist(page);
  await expect.poll(() => running(page).length).toBe(0);
  await expect(page.locator(THEIR_FRAMES)).toHaveCount(0);
  await expect(panelIcon(page, "Word counter plugin: Words")).toHaveCount(0);
  await expect(editor(page)).toContainText("::x-wordcount{all}");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  // The palette lists what matches, and nothing of the plugin's does.
  await page.getByRole("combobox", { name: "Commands" }).fill("Toggle inspector");
  await expect(page.locator(".palette").getByRole("option", { name: "Toggle inspector" })).toBeVisible();
  await page.getByRole("combobox", { name: "Commands" }).fill("Word counter");
  await expect(page.locator(".palette").getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto(`/x/${id}/totals`);
  await expect(page.getByText("There's nothing at this address.")).toBeVisible();
});

test("what a plugin writes is recorded as the plugin's for the member it wrote for, and History lists it under the plugin's name and reverts it as anyone's change", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const plan = await perform(page, { type: "note.create", text: "# Plan\n\nAda's step" });
  const id = await install(page, COUNTER, COUNTER_CODE, ["notes.read", "notes.write"]);
  await turnOn(page, "Word counter");
  await page.goto(`/note/${plan.id}`);
  await expect(editor(page)).toContainText("Ada's step");
  await runCommand(page, "Word counter plugin: Stamp a note");
  await expect(toast(page)).toContainText(`Word counter plugin: Stamped ${plan.id}`);
  // The open note takes the plugin's change, as it takes an agent's.
  await expect(editor(page)).toContainText("The counter's step");

  const read = await perform(page, { type: "note.read", id: plan.id });
  expect(read.text).toBe("# Plan\n\nAda's step\n\nThe counter's step");
  expect(read.updatedBy).toEqual({ kind: "plugin", pluginId: id, name: "Word counter", onBehalfOf: (await perform(page, { type: "member.list" }))[0]!.personId });

  // History lists it under the plugin's name, with a plugin's mark, among everyone's changes. It is neither a person's nor an agent's.
  await page.goto("/history");
  const mode = page.getByRole("region", { name: "History" });
  const rows = mode.getByRole("listbox", { name: "Changes" }).getByRole("option");
  const lines = () => rows.locator(".hist-line").evaluateAll((all) => all.map((el) => el.textContent!.trim().replace(/\s+/g, " ")));
  await expect.poll(lines).toEqual(["Word counter edited Plan", "You wrote Plan"]);
  await expect(rows.first().locator('.avatar.agent[data-kind="plugin"] svg')).toHaveCount(1);
  await expect(rows.first().locator(".avatar")).toHaveAttribute("title", "Word counter, a plugin");
  for (const [by, listed] of [["People", ["You wrote Plan"]], ["Agents", []], ["Everyone", ["Word counter edited Plan", "You wrote Plan"]]] as const) {
    await mode.getByRole("radio", { name: by }).click();
    await expect.poll(lines).toEqual(listed);
  }

  // Its change is ticked and reverted as anyone's is.
  await rows.first().locator(".hist-check").click();
  const pane = mode.getByRole("region", { name: "What the selection did" });
  await expect(pane.locator("ins.diff-line .diff-text")).toHaveText(["", "The counter's step"]);
  await mode.getByRole("group", { name: "Selection" }).getByRole("button", { name: "Revert…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Revert/ });
  await expect(dialog).toHaveAccessibleName("Revert 1 change to Plan");
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: plan.id })).text).toBe("# Plan\n\nAda's step");
});

test("a plugin put on the page through the fixture global runs only where the Worker says tests run, and is ignored everywhere else", async ({ page }) => {
  type Planted = { __INK_FIXTURE_PLUGINS__: unknown[]; planted?: boolean };
  await page.addInitScript(() => {
    (window as unknown as Planted).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Planted fixture",
        activate(host: { commands: { register(command: unknown): void } }) {
          (window as unknown as Planted).planted = true;
          host.commands.register({ id: "fixture.ran", title: "Planted command", run() {} });
        },
      },
    ];
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  const builtIn = page.getByRole("list", { name: "Plugins" }).getByRole("checkbox", { name: "History" });

  // Here the Worker says so, and the fixture is a plugin.
  await expect.poll(async () => (await (await page.request.get("/api/me")).json()).dev).toBe(true);
  await page.goto("/plugins");
  await expect(builtIn).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Planted fixture" })).toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as unknown as Planted).planted)).toBe(true);

  // As production answers: the same global on the same page is never read.
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), dev: false } });
  });
  await page.goto("/plugins");
  await expect(builtIn).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Planted fixture" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [(window as unknown as Planted).__INK_FIXTURE_PLUGINS__.length, (window as unknown as Planted).planted ?? null])).toEqual([1, null]);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Planted");
  await expect(page.locator(".palette").getByRole("option")).toHaveCount(0);
});

test("an embed's options declared in its manifest are drawn by the app beneath it, as wide as its room, written into its line and handed to the frame, and the frame follows the app's theme", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const options = [
    { type: "text", id: "question", label: "Question", default: "" },
    { type: "number", id: "votes", label: "Votes each", default: 1, min: 1, max: 5, step: 1 },
    { type: "toggle", id: "open", label: "Open", default: true },
    { type: "choice", id: "show", label: "Show", values: ["bars", "dots"] },
  ];
  const code = `document.body.classList.add("ink-kit");
const said = document.createElement("p");
said.className = "said";
said.textContent = JSON.stringify(ink.context.options);
const button = document.createElement("button");
button.className = "primary";
button.textContent = "Vote";
ink.root.append(said, button);`;
  const id = await install(page, { name: "Poll", embeds: [{ name: "poll", title: "Poll", height: 100, options }] }, code);
  const note = await perform(page, { type: "note.create", text: "# Lunch\n\n::x-poll{size=big}\n\nend\n" });
  await perform(page, { type: "settings.write", text: JSON.stringify({ [`${id}.enabled`]: true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.goto(`/note/${note.id}`);
  const said = async () => (await frameFor(page, "embed", "poll")).locator(".said").textContent();
  await expect.poll(said).toBe('{"question":"","votes":1,"open":true,"show":"bars"}');

  await onLine(page, 2);
  await editor(page).getByRole("button", { name: "Options for Poll plugin: Poll" }).click();
  const panel = page.getByRole("dialog", { name: "Options for Poll plugin: Poll" });
  await expect(panel.getByRole("textbox", { name: "Votes each" })).toHaveValue("1");
  // Beneath the frame's room, as wide as it.
  const [room, box] = [(await page.locator('.embed-below[data-embed="x-poll"]').boundingBox())!, (await panel.boundingBox())!];
  expect(Math.abs(box.width - room.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.x - room.x)).toBeLessThanOrEqual(1);
  expect(box.y).toBeGreaterThanOrEqual(room.y + room.height);

  await panel.getByRole("textbox", { name: "Votes each" }).fill("9");
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("alert")).toHaveText("A whole number from 1 to 5.");
  await panel.getByRole("textbox", { name: "Votes each" }).fill("3");
  await page.keyboard.press("Enter");
  await panel.getByRole("radiogroup", { name: "Open" }).getByRole("radio", { name: "Off" }).click();
  await panel.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "dots" }).click();
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("::x-poll{size=big votes=3 open=off show=dots}");
  await expect.poll(said).toBe('{"question":"","votes":3,"open":false,"show":"dots"}');
  // Back to the default is no word at all.
  await panel.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "bars" }).click();
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("::x-poll{size=big votes=3 open=off}");

  // The kit draws the plugin's button as the app's primary one, and the frame changes theme with the app.
  const look = async () => (await frameFor(page, "embed", "poll")).evaluate(() => ({ scheme: (window as unknown as { ink: { scheme: string } }).ink.scheme, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), button: getComputedStyle(document.querySelector("button")!).backgroundColor }));
  const accent = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--accent").trim());
  const before = await look();
  expect(before.button).toBe(await page.evaluate((colour) => { const probe = document.body.appendChild(document.createElement("i")); probe.style.color = colour; const seen = getComputedStyle(probe).color; probe.remove(); return seen; }, accent));
  const other = before.scheme === "dark" ? "light" : "dark";
  await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), other);
  const appBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
  await expect.poll(look).toMatchObject({ scheme: other, bg: appBg });
  expect(appBg).not.toBe(before.bg);
});
