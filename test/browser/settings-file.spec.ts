import { expect, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { anotherPerson, connectAgent, join, listedNotes, openAllNotes, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";
import { category, group, settingsDialog } from "./settings-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

/** The settings JSON, open in a tab: never inside the Settings dialog. */
const file = (page: Page) => page.getByRole("region", { name: "Settings (JSON)" });
const text = (page: Page) => file(page).getByRole("textbox", { name: "Settings JSON" });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).getByRole("tab");
const palette = (page: Page) => page.getByRole("dialog", { name: "Commands" });
const stored = async (page: Page) => JSON.parse((await perform(page, { type: "settings.read" })).text || "{}") as Record<string, unknown>;
const write = async (page: Page, document: Record<string, unknown>) =>
  perform(page, { type: "settings.write", text: JSON.stringify(document), baseRevision: (await perform(page, { type: "settings.read" })).revision });
const theme = (page: Page) => page.locator("html").getAttribute("data-theme");

/** Replaces the whole JSON, as a member who selects all and types would. */
async function retype(page: Page, json: string) {
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(json);
}

async function start(page: Page, settings: Record<string, unknown> = {}) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (Object.keys(settings).length) await write(page, settings);
  const note = await perform(page, { type: "note.create", text: "# Alpha\n\nThe first lines of Alpha." });
  await page.goto(`/note/${note.id}`);
  await expect(tabs(page)).toHaveText(["Alpha"]);
  return note;
}

test("the palette has Go to settings (UI) for the dialog and Go to settings (JSON) for the JSON in a tab, and no other command for either", async ({ page }) => {
  await start(page, { "core.theme": "dark" });
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await palette(page).getByRole("combobox").fill("settings");
  await expect(palette(page).getByRole("option").locator(".palette-label")).toHaveText(["Go to settings (UI)", "Go to settings (JSON)"]);
  await page.keyboard.press("Escape");

  await runCommand(page, "Go to settings (UI)");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(settingsDialog(page)).toBeVisible();
  await expect(settingsDialog(page).getByRole("textbox", { name: "Settings JSON" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);

  await runCommand(page, "Go to settings (JSON)");
  await expect(page).toHaveURL(/\/settings\.json$/);
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(text(page)).toHaveText('{"core.theme":"dark"}');
  await expect(text(page)).toBeFocused();
  await expect(tabs(page).last()).toHaveText("Settings (JSON)");
});

test("the dialog's Open settings (JSON) opens the JSON in a tab, and an old /settings/json address opens it too", async ({ page }) => {
  await start(page, { "core.theme": "dark" });
  await page.goto("/settings");
  await settingsDialog(page).getByRole("button", { name: "Open settings (JSON)" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\.json$/);
  await expect(text(page)).toHaveText('{"core.theme":"dark"}');

  await page.goto("/settings/json");
  await expect(page).toHaveURL(/\/settings\.json$/);
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(text(page)).toHaveText('{"core.theme":"dark"}');
});

test("valid JSON saved in the tab applies at once; JSON that can't be read is marked, saved nowhere, and the settings stay as they were", async ({ page }) => {
  await start(page);
  await runCommand(page, "Go to settings (JSON)");
  await expect(text(page)).toHaveText("{}");
  const state = file(page).getByRole("status");
  await expect(state).toHaveText("Saved");

  await retype(page, '{\n  "core.theme": "dark"\n}');
  await expect.poll(() => theme(page)).toBe("dark");
  await expect(state).toHaveText("Saved");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark" });

  await retype(page, '{\n  "core.theme": "light",');
  await expect(file(page).getByRole("list", { name: "Problems" })).toHaveText("The JSON can't be read. Settings are one JSON object, such as {}. Your settings stay as they were until it can.");
  await expect(state).toHaveText("Not saved until the JSON is fixed");
  await expect(file(page).locator(".cm-lintRange-error")).toHaveCount(1);
  expect(await theme(page)).toBe("dark");
  expect(await stored(page)).toEqual({ "core.theme": "dark" });

  // The dialog's options wait for the JSON, which is shown from there.
  await runCommand(page, "Go to settings (UI)");
  await expect(settingsDialog(page).getByRole("alert")).toContainText("The JSON has a mistake in it");
  await settingsDialog(page).getByRole("button", { name: "Show the JSON" }).click();
  await expect(text(page)).toHaveText('{  "core.theme": "light",');

  // A value the schema doesn't allow is saved and marked, and its default is used.
  await retype(page, '{"core.theme": "light", "core.editorTextSize": 500}');
  await expect.poll(() => theme(page)).toBe("light");
  await expect(file(page).getByRole("list", { name: "Problems" })).toContainText("core.editorTextSize");
  await expect(file(page).locator(".cm-lintRange-error")).toHaveCount(1);
  await expect(state).toHaveText("Saved");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "light", "core.editorTextSize": 500 });
});

test("undo takes back the member's typing and never the settings as they arrived, however late they came", async ({ page }) => {
  await start(page, { "core.theme": "dark", "core.textSize": 110 });
  await page.route("**/ops", async (route) => {
    if ((route.request().postDataJSON() as { type: string }).type === "settings.read") await new Promise((done) => setTimeout(done, 4000));
    await route.continue();
  });
  await page.goto("/settings.json");
  await expect(file(page).getByRole("status")).toHaveText("Loading your settings…");
  await expect(text(page)).toHaveText('{"core.theme":"dark","core.textSize":110}', { timeout: 8000 });
  await text(page).click();
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(300);
  await expect(text(page)).toHaveText('{"core.theme":"dark","core.textSize":110}');

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" ");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(text(page)).toHaveText('{"core.theme":"dark","core.textSize":110}');
  await page.waitForTimeout(300);
  expect(await stored(page)).toEqual({ "core.theme": "dark", "core.textSize": 110 });
});

test("is edited as a note is, with vim's keys and its undo, and follows a change made in the options while it is open", async ({ page }) => {
  const rest = ',"vim.enabled":true,"lineNumbers.enabled":true}';
  await start(page, { "core.theme": "dark", "vim.enabled": true, "lineNumbers.enabled": true });
  await runCommand(page, "Go to settings (JSON)");
  await expect(text(page)).toHaveText(`{"core.theme":"dark"${rest}`);
  await expect(file(page).locator(".note-foot .cm-vim-panel")).toHaveText("--NORMAL--");
  await expect(file(page).locator(".cm-lineNumbers .cm-gutterElement").filter({ hasText: /^1$/ })).toHaveCount(1);
  // As wide as a note's text, in the note's face.
  await expect(file(page).locator(".editor")).toHaveCSS("max-width", "736px");
  await expect(file(page).locator(".cm-content")).toHaveCSS("font-family", /iA Writer Mono/);

  // dw takes a word out and u puts it back, as in a note; ci" changes what is inside the quotes the cursor is in.
  await text(page).click();
  await page.keyboard.press("Escape");
  await page.keyboard.type("0f:wdw");
  await expect(text(page)).toHaveText(`{"core.theme":""${rest}`);
  await page.keyboard.type("u");
  await expect(text(page)).toHaveText(`{"core.theme":"dark"${rest}`);
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "dark", "vim.enabled": true, "lineNumbers.enabled": true });
  await page.keyboard.type('ci"light');
  await page.keyboard.press("Escape");
  await expect(text(page)).toHaveText(`{"core.theme":"light"${rest}`);
  await expect.poll(() => theme(page)).toBe("light");
  await expect.poll(() => stored(page)).toEqual({ "core.theme": "light", "vim.enabled": true, "lineNumbers.enabled": true });

  // The options change the same document, and the tab shows it.
  await runCommand(page, "Go to settings (UI)");
  const appearance = await category(page, "Appearance");
  await appearance.getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(text(page)).toContainText('"core.theme": "dark"');
  await expect.poll(() => theme(page)).toBe("dark");
});

test("is no note: not in All notes, search, quick open or an agent's notes, and another member's tab holds their own settings", async ({ page }) => {
  await start(page, { "core.theme": "dark", "secret.of.ada": "kept" });
  await runCommand(page, "Go to settings (JSON)");
  await expect(text(page)).toContainText("secret.of.ada");

  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Alpha"]);
  await page.goto("/search?q=secret");
  const search = page.getByRole("region", { name: "Search" });
  await expect(search.locator(".empty")).toBeVisible();
  await expect(search.getByRole("article")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+p");
  const quick = page.getByRole("dialog", { name: "Go to note" });
  await quick.getByRole("combobox").fill("secret");
  await expect(quick.getByRole("option")).toHaveCount(0);
  await page.keyboard.press("Escape");

  const agent = await connectAgent(page, "Claude");
  expect((await agent.tool<{ notes: Note[] }>("list_notes", {})).notes.map((n) => n.title)).toEqual(["Alpha"]);
  await expect(agent.tool("search", { query: "secret" })).resolves.toMatchObject({ results: [] });

  // Another member of the workspace opens the same address and finds their own settings, which are none.
  const bea = await anotherPerson(page, "Bea Member");
  const { workspaceId } = await join(bea, page, "editor");
  expect(await perform(bea, { type: "settings.read" }, workspaceId)).toMatchObject({ text: "{}", revision: 0 });
  await bea.evaluate((id) => localStorage.setItem("ink.workspace", JSON.stringify(id)), workspaceId);
  await bea.goto("/settings.json");
  await expect(bea.getByRole("tablist", { name: "Open notes" })).toBeVisible();
  await expect(text(bea)).toHaveText("{}");
  await expect(text(bea)).not.toContainText("secret.of.ada");
});

test("Storage and Export are under Account, and under no other category", async ({ page }) => {
  await start(page);
  await page.goto("/settings");
  const regions = settingsDialog(page).getByRole("region", { name: /^(Storage|Export)$/ });
  await expect(group(page, "Editor")).toBeVisible();
  await expect(regions).toHaveCount(0);
  await category(page, "Keyboard shortcuts");
  await expect(regions).toHaveCount(0);
  const account = await category(page, "Account");
  await expect(account.getByRole("region", { name: "Storage" })).toContainText("This workspace's files take");
  await expect(account.getByRole("region", { name: "Export" })).toContainText("Every note and file you can see in this workspace");
  await expect(regions).toHaveCount(2);
});
