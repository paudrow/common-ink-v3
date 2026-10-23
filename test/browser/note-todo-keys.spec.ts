import { expect, type Page } from "@playwright/test";
import { perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, words: string) => editor(page).locator(".cm-line").filter({ hasText: words });
const statusLine = (page: Page) => page.locator(".cm-vim-panel");
const toast = (page: Page) => page.locator(".toast-card");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const keysOf = (page: Page, table: string, title: string) => sheet(page).getByRole("table", { name: table }).getByRole("row").filter({ has: page.getByRole("rowheader", { name: title, exact: true }) }).locator("kbd");
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};
const cursorLine = (page: Page) =>
  page.evaluate(() => {
    const at = getSelection()?.focusNode;
    return (at instanceof Element ? at : at?.parentElement)?.closest(".cm-line")?.textContent ?? null;
  });

const NOTE = "# Chores\n\n- [ ] Water the plants\n- [x] Call the plumber\n- [-] Fix the gate\n- Buy milk\nA plain line\n\nLast words.\n\n```\n- In code\n```";

/** Signs in, with vim's keys or without, and opens the chores. `lines` reads the note's lines from the server, the heading and the blank line after it left out. */
async function open(page: Page, vim = false) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (vim) await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: NOTE });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Last words.");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(vim ? 1 : 0);
  return async () => (await perform(page, { type: "note.read", id: note.id })).text.split("\n").slice(2);
}

/** Puts the cursor at the end of the line that says `words`. */
async function toEnd(page: Page, words: string) {
  await line(page, words).getByText(words).click();
  await page.keyboard.press("End");
}

test("⌘Enter checks off the todo the cursor is on, said with an Undo, and opens it again; ⇧⌘Enter abandons it and ⌥⌘Enter moves it to the backlog, and each opens it again", async ({ page }) => {
  const lines = await open(page);
  await toEnd(page, "Water the plants");

  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await lines())[0]).toBe("- [x] Water the plants");
  await expect(line(page, "Water the plants").getByRole("checkbox")).toBeChecked();
  await expect(toast(page)).toHaveText("Task completedUndo");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants");
  await expect(line(page, "Water the plants").getByRole("checkbox")).not.toBeChecked();

  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect.poll(async () => (await lines())[0]).toBe("- [-] Water the plants");
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants");
  await page.keyboard.press("ControlOrMeta+Alt+Enter");
  await expect.poll(async () => (await lines())[0]).toBe("- [>] Water the plants");
  await page.keyboard.press("ControlOrMeta+Alt+Enter");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants");

  // The cursor stayed at the end of the line through all of it.
  await page.keyboard.type(" now");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants now");
});

test("⌘Enter makes an open todo of a list item, and checks it off when pressed again; on a line that is neither, or one in code, it is the editor's own, a blank line below", async ({ page }) => {
  const lines = await open(page);
  // From just after the item's mark, the cursor goes on past the box to the words, as if the box were typed.
  await toEnd(page, "Buy milk");
  for (let n = 0; n < "Buy milk".length; n++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.type("Go ");
  await expect.poll(async () => (await lines())[3]).toBe("- [ ] Go Buy milk");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await lines())[3]).toBe("- [x] Go Buy milk");
  // Abandoning and the backlog are for todos alone.
  await toEnd(page, "A plain line");
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.type("Next");
  await toEnd(page, "In code");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.type("More");
  await expect.poll(lines).toEqual(["- [ ] Water the plants", "- [x] Call the plumber", "- [-] Fix the gate", "- [x] Go Buy milk", "A plain line", "Next", "", "Last words.", "", "```", "- In code", "More", "```"]);
});

test("⌘Enter on a todo that repeats checks it off as a click does: the server completes it, and it is said with an Undo", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Habits\n\n- [ ] Stretch every:1d\nAfter" });
  await page.goto(`/note/${note.id}`);
  await toEnd(page, "Stretch");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(toast(page)).toHaveText("Task completedUndo");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text.split("\n")[2]).toMatch(/^- \[ \] Stretch every:1d due:\d{4}-\d{2}-\d{2} done:\d{4}-\d{2}-\d{2}x1$/);
});

test("over a selection, each key puts every todo it takes in in its state, and opens them all when pressed again; ⌘Z takes it back as one edit", async ({ page }) => {
  const lines = await open(page);
  await toEnd(page, "Water the plants");
  await keys(page, "Shift+ArrowDown", "Shift+ArrowDown");

  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await lines()).slice(0, 4)).toEqual(["- [x] Water the plants", "- [x] Call the plumber", "- [x] Fix the gate", "- Buy milk"]);
  // Several checked off at once are no one task to undo from a notice.
  await expect(toast(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect.poll(async () => (await lines()).slice(0, 3)).toEqual(["- [ ] Water the plants", "- [ ] Call the plumber", "- [ ] Fix the gate"]);
  await page.keyboard.press("ControlOrMeta+Alt+Enter");
  await expect.poll(async () => (await lines()).slice(0, 3)).toEqual(["- [>] Water the plants", "- [>] Call the plumber", "- [>] Fix the gate"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await lines()).slice(0, 3)).toEqual(["- [ ] Water the plants", "- [ ] Call the plumber", "- [ ] Fix the gate"]);
});

test("in vim's normal mode gx, g- and g> set the cursor's todo and open it again, and leave the cursor where it was; gg is still the first line", async ({ page }) => {
  const lines = await open(page, true);
  await editor(page).click();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await keys(page, "g", "g", "j", "j", "$");

  await keys(page, "g", "x");
  await expect.poll(async () => (await lines())[0]).toBe("- [x] Water the plants");
  await expect(toast(page)).toHaveText("Task completedUndo");
  await keys(page, "g", "x");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants");
  await keys(page, "g", "-");
  await expect.poll(async () => (await lines())[0]).toBe("- [-] Water the plants");
  await keys(page, "g", "-");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants");
  await keys(page, "g", ">");
  await expect.poll(async () => (await lines())[0]).toBe("- [>] Water the plants");
  await keys(page, "g", ">");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants");

  // Still on the line's last letter, after which a is the end of the line.
  await keys(page, "a");
  await page.keyboard.type(" now");
  await keys(page, "Escape");
  await expect.poll(async () => (await lines())[0]).toBe("- [ ] Water the plants now");

  await keys(page, "Shift+G", "g", "g");
  await expect.poll(() => cursorLine(page)).toMatch(/Chores$/);
});

test("in vim's visual line and block modes the keys put every todo selected in a state and leave visual mode, and u takes it back", async ({ page }) => {
  const lines = await open(page, true);
  await editor(page).click();
  await keys(page, "g", "g", "j", "j", "Shift+V", "j", "j");
  await expect(statusLine(page)).toHaveText("--VISUAL LINE--");

  await keys(page, "g", "x");
  await expect.poll(async () => (await lines()).slice(0, 4)).toEqual(["- [x] Water the plants", "- [x] Call the plumber", "- [x] Fix the gate", "- Buy milk"]);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await keys(page, "u");
  await expect.poll(async () => (await lines()).slice(0, 3)).toEqual(["- [ ] Water the plants", "- [x] Call the plumber", "- [-] Fix the gate"]);

  // Visual block mode is a selection on each of its lines.
  await keys(page, "g", "g", "j", "j", "Control+v", "j", "g", "-");
  await expect.poll(async () => (await lines()).slice(0, 3)).toEqual(["- [-] Water the plants", "- [-] Call the plumber", "- [-] Fix the gate"]);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
});

test("the keyboard shortcuts list a note's todo keys under Todos, and vim's only with vim on", async ({ page }) => {
  await open(page);
  await runCommand(page, "Keyboard shortcuts");
  await expect(keysOf(page, "Todos", "Complete the todo the cursor is on, or open it again")).toHaveText([/^(⌘Enter|Ctrl\+Enter)$/]);
  await expect(keysOf(page, "Todos", "Abandon the todo the cursor is on, or open it again")).toHaveText([/^(⇧⌘Enter|Ctrl\+Shift\+Enter)$/]);
  await expect(keysOf(page, "Todos", "Move the todo the cursor is on to the backlog, or open it again")).toHaveText([/^(⌥⌘Enter|Ctrl\+Alt\+Enter)$/]);
  await expect(keysOf(page, "Todos", "Vim: complete the todo, or open it again")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await page.reload();
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await runCommand(page, "Keyboard shortcuts");
  await expect(keysOf(page, "Todos", "Vim: complete the todo, or open it again")).toHaveText(["G X"]);
  await expect(keysOf(page, "Todos", "Vim: abandon the todo, or open it again")).toHaveText(["G -"]);
  await expect(keysOf(page, "Todos", "Vim: move the todo to the backlog, or open it again")).toHaveText(["G >"]);
  await expect(keysOf(page, "Todos", "Complete the todo the cursor is on, or open it again")).toHaveText([/^(⌘Enter|Ctrl\+Enter)$/]);
});
