import { expect, type Page } from "@playwright/test";
import { perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const sheet = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const shortcut = (page: Page, title: string) => sheet(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name: title, exact: true }) });
const keysOf = (page: Page, group: string, title: string) => sheet(page).getByRole("table", { name: group }).getByRole("row").filter({ has: page.getByRole("rowheader", { name: title, exact: true }) }).locator("kbd");
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
/** ? as a keyboard types it: Shift and the key that has / on it. */
const question = (page: Page) => page.keyboard.press("Shift+Slash");
const searchField = (page: Page) => page.getByRole("region", { name: "Search" }).getByRole("searchbox", { name: "Search notes" });

test("? outside a text field opens every command with keys over the page, under its heading, and Escape, Close or ? again give the keyboard back to where it was", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/search");
  const advanced = page.getByRole("region", { name: "Search" }).getByRole("button", { name: "Advanced" });
  await advanced.focus();
  await question(page);
  await expect(sheet(page)).toBeVisible();
  expect(await sheet(page).evaluate((el) => el.matches(":modal"))).toBe(true);
  await expect(sheet(page).getByRole("heading", { level: 3 })).toHaveText(["Navigation", "Notes", "Editor", "Todos", "Todos, with the pointer"]);
  await expect(keysOf(page, "Navigation", "Show all commands")).toHaveText([/^(⇧⌘P|Ctrl\+Shift\+P)$/]);
  await expect(keysOf(page, "Navigation", "Keyboard shortcuts")).toHaveText(["?"]);
  await expect(keysOf(page, "Notes", "Archive or unarchive note")).toHaveText([/^(⇧⌘E|Ctrl\+Shift\+E)$/]);
  await expect(keysOf(page, "Editor", "Redo")).toHaveText([/^(⇧⌘Z|Ctrl\+Shift\+Z)$/, /^(⌘Y|Ctrl\+Y)$/]);
  // A command with no keys is no shortcut.
  await expect(shortcut(page, "New note")).toHaveCount(0);
  await expect(shortcut(page, "Show all commands")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(advanced).toBeFocused();
  await question(page);
  await sheet(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(advanced).toBeFocused();
  await question(page);
  await expect(sheet(page)).toBeVisible();
  await question(page);
  await expect(sheet(page)).toHaveCount(0);
  await expect(advanced).toBeFocused();
  // A press on the page around it closes it too, and the keyboard still goes back.
  await question(page);
  await expect(sheet(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(sheet(page)).toHaveCount(0);
  await expect(advanced).toBeFocused();

  // It is a command, so the palette has it too.
  await runCommand(page, "Keyboard shortcuts");
  await expect(sheet(page)).toBeVisible();
  // And it says where the keys are changed.
  await sheet(page).getByRole("link", { name: "Change the keys in Settings" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/keyboard$/);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("table", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("? is left to whatever is being typed in: a note, the search bar, the builder's fields, and Settings' search, where it is typed and opens nothing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Questions\n\nWhy" });
  await page.goto(`/note/${note.id}`);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await question(page);
  await expect(editor(page)).toContainText("Why?");
  await expect(sheet(page)).toHaveCount(0);

  await page.goto("/search");
  await searchField(page).click();
  await question(page);
  await expect(searchField(page)).toHaveValue("?");
  await page.getByRole("region", { name: "Search" }).getByRole("button", { name: "Advanced" }).click();
  const words = page.getByRole("group", { name: "Advanced search" }).getByRole("group", { name: "Condition 1" }).getByRole("textbox", { name: "Value" });
  await words.click();
  await question(page);
  await expect(words).toHaveValue("?");
  await expect(sheet(page)).toHaveCount(0);

  await page.goto("/settings");
  const find = page.getByRole("searchbox", { name: "Search settings" });
  await find.click();
  await question(page);
  await expect(find).toHaveValue("?");
  await expect(sheet(page)).toHaveCount(0);
});

test("in vim's normal mode ? is vim's search backwards; the palette opens the keyboard shortcuts there, with vim's keys under Vim", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: "# Questions\n\nWhy" });
  await page.goto(`/note/${note.id}`);
  const status = page.locator(".cm-vim-panel").first();
  await expect(status).toHaveText("--NORMAL--");
  await editor(page).click();
  await question(page);
  await expect(sheet(page)).toHaveCount(0);
  // Vim asks what to search back for.
  await expect(status).toContainText("?");
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("--NORMAL--");

  await runCommand(page, "Keyboard shortcuts");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("heading", { level: 3 })).toHaveText(["Navigation", "Notes", "Editor", "Vim", "Todos", "Todos, with the pointer"]);
  await expect(keysOf(page, "Vim", "Vim: first row of a list")).toHaveText(["G G"]);
  // / and Shift with / are both the key for the search box, and read as one.
  await expect(keysOf(page, "Vim", "Vim: go to the search box")).toHaveText(["/"]);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  // The keyboard is back in the note, still in normal mode.
  await expect(page.locator(".cm-content")).toBeFocused();
  await expect(status).toHaveText("--NORMAL--");
});

test("a key the member changed is what the sheet shows, read when it opens, and the sheet's own key can be changed too", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "keybindings.view.toggleFocus": ["mod+shift+f"], "keybindings.commands.shortcuts": ["f1"] }), baseRevision: 0 });
  await page.goto("/search");
  await page.getByRole("region", { name: "Search" }).getByRole("button", { name: "Advanced" }).focus();
  // ? is no longer its key: F1 is.
  await question(page);
  await expect(sheet(page)).toHaveCount(0);
  await page.keyboard.press("F1");
  await expect(sheet(page)).toBeVisible();
  await expect(keysOf(page, "Navigation", "Toggle focus")).toHaveText([/^(⇧⌘F|Ctrl\+Shift\+F)$/]);
  await expect(keysOf(page, "Navigation", "Keyboard shortcuts")).toHaveText(["F1"]);
  // Its first line says the key it has now.
  await expect(sheet(page).locator(".help-lead")).toContainText("Press F1 anywhere");
  await page.keyboard.press("Escape");

  // Changed in Settings while the app is open, the sheet has it the next time it opens.
  await page.goto("/settings/keyboard");
  const row = page.getByRole("table", { name: "Keyboard shortcuts" }).getByRole("row", { name: /Toggle focus/ });
  await row.getByRole("button", { name: "Reset Toggle focus" }).click();
  await expect(row.locator(".shortcut-from")).toHaveText("Default");
  await page.keyboard.press("F1");
  await expect(keysOf(page, "Navigation", "Toggle focus")).toHaveText([/^(⌘\.|Ctrl\+\.)$/]);
});

test("the sheet opened over the query help is pressed in without closing the help under it, and each Escape closes the one on top", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/search");
  await page.getByRole("region", { name: "Search" }).getByRole("button", { name: "Advanced" }).click();
  const helpButton = page.getByRole("button", { name: "Query syntax" });
  await helpButton.click();
  const help = page.getByRole("dialog", { name: "Query syntax" });
  await expect(help).toBeVisible();
  await question(page);
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole("heading", { name: "Navigation" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(help).toBeVisible();
  await expect(help.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(helpButton).toBeFocused();
});

test("the command palette and the keyboard shortcuts closed with Escape give the keyboard back to the note where it was, leaving the note scrolled as it was", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the note`);
  const note = await perform(page, { type: "note.create", text: `# Long\n\n${lines.join("\n\n")}\n` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Line 1 of");
  const scroller = page.locator(".note-scroll");
  const scrolled = () => scroller.evaluate((el) => Math.round(el.scrollTop));
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  const line = page.locator(".cm-line").filter({ hasText: /^Line 60 of the note/ });
  await line.click();
  const top = await scrolled();
  expect(top).toBeGreaterThan(500);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  expect(await scrolled()).toBe(top);
  // Typing goes in where the cursor was, and nothing moves to show it.
  await page.keyboard.type("!");
  await expect(line).toHaveText("Line 60 of the note!");
  expect(await scrolled()).toBe(top);

  // The keyboard shortcuts, opened from the palette, give it back the same way.
  await runCommand(page, "Keyboard shortcuts");
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  expect(await scrolled()).toBe(top);
});
