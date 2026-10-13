import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, perform, signInAsNewPerson } from "./helpers.ts";
import { codeHashOf, install, openDetails, openPlugins, pluginRow, relist, runCommand, toast, turnOn, type Written } from "./third-party-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const GREETER: Written = {
  name: "Greeter",
  version: "1.0",
  description: "Says hello.",
  capabilities: [{ name: "notes.read", reason: "To greet you by your notes." }],
  commands: [{ id: "greet", title: "Greet" }],
};
const GREETER_CODE = `ink.onCommand("greet", () => ink.notify("Hello from the original"));\n`;

/** Installs a plugin as the admin on `page`, and has the app on that page read the record again, so its card is there without waiting on the next reading. */
async function installed(page: Page, ...args: Parameters<typeof install> extends [Page, ...infer Rest] ? Rest : never) {
  const id = await install(page, ...args);
  await relist(page);
  return id;
}

/** The Source section of the details that are open, scrolled to, which is when its files are fetched. */
async function source(page: Page) {
  const section = page.getByRole("region", { name: "Source" });
  await section.scrollIntoViewIfNeeded();
  return section;
}
type Section = Awaited<ReturnType<typeof source>>;
const picker = (section: Section) => section.getByRole("combobox", { name: "Draft file" });
const draftsOf = async (page: Page, workspaceId?: string) => (await perform(page, { type: "draft.list" }, workspaceId)).drafts;

/** Opens a plugin's details as the member on `page`, in the workspace of the note they are sent to. */
async function detailsIn(page: Page, noteId: string, name: string) {
  await page.goto(`/note/${noteId}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeVisible();
  await openPlugins(page);
  await openDetails(page, name);
  return source(page);
}

/** Puts `text` in the place of everything in the draft's file that is open. */
async function rewrite(page: Page, section: Section, file: "manifest.json" | "plugin.js", text: string) {
  await picker(section).selectOption(file);
  await section.getByRole("textbox", { name: `Draft of ${file}` }).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}

/** Performs `op` at the address a member's draft of a plugin performs through, as whoever is on `page`. */
const asDraft = (page: Page, workspaceId: string, pluginId: string, op: Record<string, unknown>) =>
  page.evaluate(
    async ({ workspaceId, pluginId, op }) => {
      const res = await fetch(`/api/workspaces/${workspaceId}/plugins/${pluginId}/draft/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) });
      return { status: res.status, message: ((await res.json()) as { message?: string }).message ?? "" };
    },
    { workspaceId, pluginId, op },
  );

test("a member edits a copy, saves it, finds it again after loading the app again, sees what they changed, and discards it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await installed(page, GREETER, GREETER_CODE);
  await openPlugins(page);
  await openDetails(page, "Greeter");
  let section = await source(page);

  await section.getByRole("button", { name: "Edit a copy" }).click();
  await expect(picker(section).getByRole("option")).toHaveText(["manifest.json", "plugin.js", "What I changed"]);
  await expect(section.getByRole("textbox", { name: "Draft of manifest.json" })).toContainText('"name": "Greeter"');
  await expect.poll(() => draftsOf(page)).toMatchObject([{ pluginId: id, running: false, baseHash: await codeHashOf(page, id) }]);
  await expect(section.getByRole("button", { name: "Save draft" })).toBeDisabled();
  await expect(section.getByText("nobody else can see it, admins included")).toBeVisible();

  await picker(section).selectOption("plugin.js");
  const code = section.getByRole("textbox", { name: "Draft of plugin.js" });
  await code.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// mine");
  await page.keyboard.press("Enter");
  await section.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(async () => (await perform(page, { type: "draft.read", id })).code).toBe(`${GREETER_CODE}// mine\n`);
  await expect(section.getByRole("button", { name: "Save draft" })).toBeDisabled();

  await code.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" too");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await perform(page, { type: "draft.read", id })).code).toBe(`${GREETER_CODE}// mine too\n`);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(code).not.toContainText("too");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => (await perform(page, { type: "draft.read", id })).code).not.toContain("too");

  await page.reload();
  section = await source(page);
  await picker(section).selectOption("plugin.js");
  await expect(section.getByRole("textbox", { name: "Draft of plugin.js" })).toContainText("// mine");
  await expect(section.getByRole("button", { name: "Edit a copy" })).toHaveCount(0);

  await picker(section).selectOption("What I changed");
  await expect(section.getByRole("group", { name: "Changes to manifest.json" })).toContainText("No changes");
  const changes = section.getByRole("group", { name: "Changes to plugin.js" });
  await expect(changes.locator("ins.diff-line")).toHaveText(/\/\/ mine/);
  await expect(changes.locator("del.diff-line")).toHaveCount(0);
  await picker(section).selectOption("manifest.json");
  await expect(changes).toHaveCount(0);

  await section.getByRole("button", { name: "Discard draft" }).click();
  const confirm = section.getByRole("group", { name: "Discard your draft of Greeter?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await section.getByRole("button", { name: "Discard draft" }).click();
  await confirm.getByRole("button", { name: "Discard it" }).click();
  await expect(section.getByRole("button", { name: "Edit a copy" })).toBeVisible();
  await expect(section.getByRole("textbox", { name: "Source of manifest.json" })).toBeVisible();
  await expect.poll(() => draftsOf(page)).toEqual([]);
  // Leaving after a discard keeps nothing: the draft doesn't come back.
  await page.getByRole("link", { name: "All plugins" }).click();
  await expect(pluginRow(page, "Greeter")).toBeVisible();
  expect(await draftsOf(page)).toEqual([]);
});

test("what was typed in a draft and not saved is kept when the page is left", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await installed(page, GREETER, GREETER_CODE);
  await openPlugins(page);
  await openDetails(page, "Greeter");
  const section = await source(page);
  await section.getByRole("button", { name: "Edit a copy" }).click();
  await rewrite(page, section, "plugin.js", "// typed and not saved\n");
  await page.getByRole("link", { name: "All plugins" }).click();
  await expect.poll(async () => (await perform(page, { type: "draft.read", id })).code).toBe("// typed and not saved\n");
});

test("a running draft runs for its author alone, in the plugin's place, with what the plugin is permitted and never more, and for everyone else the plugin is as it was", async ({ page }) => {
  await signInAsNewPerson(page, "Mel Member");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const id = await install(admin, GREETER, GREETER_CODE, ["notes.read"]);
  const hidden = await perform(admin, { type: "note.create", text: "# Ada's secret\n\nthe launch code\n" });
  await perform(admin, { type: "note.setPrivate", id: hidden.id, private: true });
  const note = await perform(admin, { type: "note.create", text: "# Shared\n\nwritten by Ada\n" });

  for (const who of [page, admin]) {
    await who.goto(`/note/${note.id}`);
    await expect(who.getByRole("textbox", { name: "Note text" })).toBeVisible();
    await openPlugins(who);
    await turnOn(who, "Greeter", workspaceId);
  }

  // Mel's draft asks for more than Greeter was allowed, and tries what a member's draft must not do.
  const tries = {
    shared: { type: "note.read", id: note.id },
    hidden: { type: "note.read", id: hidden.id },
    write: { type: "note.write", id: note.id, baseRevision: 1, text: "# Taken\n" },
    todos: { type: "todo.list" },
    install: { type: "plugin.install", manifest: JSON.stringify({ name: "Mine" }), code: "", replaces: id },
    permit: { type: "plugin.permit", id, capability: "notes.write", allowed: true, codeHash: "0".repeat(64) },
    invite: { type: "member.invite", email: "mallory@example.com", as: "admin" },
    drafts: { type: "draft.read", id },
    settings: { type: "settings.read" },
  };
  const draftCode = `ink.onCommand("greet", async () => {
  const tries = ${JSON.stringify(tries)};
  const got = [];
  for (const [name, op] of Object.entries(tries)) got.push(name + "=" + (await ink.perform(op).then(() => "done", (err) => err.code)));
  await ink.notify("Draft: " + got.join(" "));
});\n`;
  const asks = { ...GREETER, capabilities: [...GREETER.capabilities!, { name: "notes.write", reason: "Mine" }, { name: "todos.read", reason: "Mine" }] };
  await openDetails(page, "Greeter");
  const section = await source(page);
  await section.getByRole("button", { name: "Edit a copy" }).click();
  await rewrite(page, section, "manifest.json", JSON.stringify(asks));
  await rewrite(page, section, "plugin.js", draftCode);
  await section.getByRole("checkbox", { name: "Run my draft" }).check();
  await expect.poll(async () => (await draftsOf(page, workspaceId))[0]?.running).toBe(true);
  await expect(page.locator(".plugin-meta")).toContainText("Running your draft");

  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Shared");
  await runCommand(page, "Greeter plugin: Greet");
  await expect(toast(page)).toContainText("Draft: shared=done hidden=not_found write=forbidden todos=forbidden install=forbidden permit=forbidden invite=forbidden drafts=forbidden settings=forbidden");
  expect((await perform(admin, { type: "note.read", id: note.id })).text).toBe("# Shared\n\nwritten by Ada\n");
  expect((await perform(admin, { type: "plugin.read", id })).code).toBe(GREETER_CODE);

  // The server holds the line whatever the app in Mel's browser would have refused first.
  for (const [name, op] of Object.entries(tries)) {
    const answer = await asDraft(page, workspaceId, id, op);
    expect([name, answer.status], answer.message).toEqual([name, name === "shared" ? 200 : name === "hidden" ? 404 : 403]);
  }

  // Ada has the same plugin on, and an admin's session: it is the workspace's code that runs for her, and there is no draft at her address.
  await admin.goto(`/note/${note.id}`);
  await expect(admin.getByRole("textbox", { name: "Note text" })).toContainText("Shared");
  await runCommand(admin, "Greeter plugin: Greet");
  await expect(toast(admin)).toContainText("Hello from the original");
  expect(await asDraft(admin, workspaceId, id, tries.shared)).toEqual({ status: 403, message: "You have no draft of that plugin that is running" });
  await openPlugins(admin);
  await expect(pluginRow(admin, "Greeter")).not.toContainText("Running your draft");
  await openPlugins(page);
  await expect(pluginRow(page, "Greeter")).toContainText("Running your draft");

  // Switched off, Mel runs the workspace's code again.
  await openDetails(page, "Greeter");
  await (await source(page)).getByRole("checkbox", { name: "Run my draft" }).uncheck();
  await expect.poll(async () => (await draftsOf(page, workspaceId))[0]?.running).toBe(false);
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Shared");
  await runCommand(page, "Greeter plugin: Greet");
  await expect(toast(page)).toContainText("Hello from the original");
});

test("Run my draft is refused with the server's reason for a manifest that asks for what no draft may have, or that isn't one", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await installed(page, GREETER, GREETER_CODE);
  await openPlugins(page);
  await openDetails(page, "Greeter");
  const section = await source(page);
  await section.getByRole("button", { name: "Edit a copy" }).click();
  const run = section.getByRole("checkbox", { name: "Run my draft" });

  await rewrite(page, section, "manifest.json", JSON.stringify({ ...GREETER, capabilities: [{ name: "full-trust", reason: "To do anything." }] }));
  await run.click();
  await expect(section.getByRole("alert")).toBeVisible();
  await expect(run).not.toBeChecked();
  expect((await perform(page, { type: "draft.read", id })).running).toBe(false);

  await rewrite(page, section, "manifest.json", "{ not a manifest");
  await section.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(async () => (await perform(page, { type: "draft.read", id })).manifest).toBe("{ not a manifest");
  await run.click();
  await expect(section.getByRole("alert")).toContainText("The manifest isn't JSON");
  await expect(run).not.toBeChecked();
});

test("nobody else sees a member's draft, an admin included, and a member who isn't an admin has no way to publish theirs", async ({ page }) => {
  await signInAsNewPerson(page, "Mel Member");
  const admin = await anotherPerson(page, "Ada Lovelace");
  const { workspaceId } = await join(page, admin, "editor");
  const id = await install(admin, GREETER, GREETER_CODE);
  const note = await perform(admin, { type: "note.create", text: "# Shared\n" });

  const section = await detailsIn(page, note.id, "Greeter");
  await section.getByRole("button", { name: "Edit a copy" }).click();
  await expect(section.getByRole("textbox", { name: "Draft of manifest.json" })).toBeVisible();
  await expect.poll(async () => (await draftsOf(page, workspaceId)).map((d) => d.pluginId)).toEqual([id]);
  await expect(section.getByRole("button", { name: "Publish to the workspace" })).toHaveCount(0);
  await expect(section.getByText("Only an admin installs a plugin for the workspace. To share this, show an admin your draft or send them its two files.")).toBeVisible();
  const mine = await perform(page, { type: "draft.read", id }, workspaceId);
  await expect(perform(page, { type: "plugin.install", manifest: mine.manifest, code: "// mel's", replaces: id }, workspaceId)).rejects.toThrow("can't plugin.install");

  const theirs = await detailsIn(admin, note.id, "Greeter");
  await expect(theirs.getByRole("button", { name: "Edit a copy" })).toBeVisible();
  await expect(theirs.getByRole("textbox", { name: "Source of manifest.json" })).toBeVisible();
  await expect(theirs.getByRole("combobox", { name: "Draft file" })).toHaveCount(0);
  expect(await draftsOf(admin)).toEqual([]);
  await expect(perform(admin, { type: "draft.read", id })).rejects.toThrow("You have no draft of that plugin");
  expect((await perform(admin, { type: "plugin.read", id })).code).toBe(GREETER_CODE);
});

test("an admin publishes their draft in the plugin's place, which voids what it was permitted", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await installed(page, GREETER, GREETER_CODE, ["notes.read"]);
  const was = await codeHashOf(page, id);
  await openPlugins(page);
  await openDetails(page, "Greeter");
  const section = await source(page);
  await section.getByRole("button", { name: "Edit a copy" }).click();

  await picker(section).selectOption("plugin.js");
  await section.getByRole("textbox", { name: "Draft of plugin.js" }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// published");
  await section.getByRole("button", { name: "Publish to the workspace" }).click();
  const confirm = section.getByRole("group", { name: "Publish your draft of Greeter?" });
  await expect(confirm).toContainText("Everything it was permitted has to be approved again for the new code.");
  await confirm.getByRole("button", { name: "Publish it" }).click();

  await expect(section.getByRole("status")).toContainText("Published.");
  await expect.poll(async () => (await perform(page, { type: "plugin.read", id })).code).toBe(`${GREETER_CODE}// published`);
  const now = (await perform(page, { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
  expect(now.codeHash).not.toBe(was);
  expect(now.permissions.map((p) => p.state)).not.toContain("allowed");
  await expect.poll(async () => (await draftsOf(page))[0]?.baseHash).toBe(now.codeHash);
  await expect(section.getByText("has changed since you made this copy")).toHaveCount(0);
  await picker(section).selectOption("What I changed");
  await expect(section.getByRole("group", { name: "Changes to plugin.js" })).toContainText("No changes");
});

test("a draft is told when the plugin it copies has been replaced since", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const id = await installed(page, GREETER, GREETER_CODE);
  await perform(page, { type: "draft.save", id, manifest: JSON.stringify(GREETER), code: GREETER_CODE, baseHash: await codeHashOf(page, id), running: false });
  await perform(page, { type: "plugin.install", manifest: JSON.stringify(GREETER), code: `${GREETER_CODE}// newer\n`, replaces: id });
  await openPlugins(page);
  await openDetails(page, "Greeter");
  const section = await source(page);

  await expect(section.getByText("Greeter has changed since you made this copy.")).toBeVisible();
  await picker(section).selectOption("What I changed");
  await expect(section.getByRole("group", { name: "Changes to plugin.js" }).locator("del.diff-line")).toHaveText("// newer");
});
