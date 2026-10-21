import { expect, type Page } from "@playwright/test";
import { expectRowSelected, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";
import { closeSettings, group } from "./settings-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const todosPage = (page: Page) => page.getByRole("region", { name: "Todos" });
const rows = (page: Page) => todosPage(page).getByRole("list", { name: "Todos" }).getByRole("listitem");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const box = (page: Page, text: string) => row(page, text).getByRole("checkbox");
const words = (page: Page) => rows(page).locator(".todo-words");
const bar = (page: Page) => todosPage(page).getByRole("searchbox", { name: "Filter todos" });
/** The notice that says `message`: a notice of another kind stacks with it, and a newer one of its kind takes its place. */
const toast = (page: Page, message: string) => page.locator(".toast-card").filter({ hasText: message });
const toasts = (page: Page) => page.locator(".toast-card");
const menu = (page: Page) => page.getByRole("menu");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
/** Longer than a row put away lingers before it goes. */
const PAST_LINGER_MS = 2500;
const keysOf = (page: Page, table: string, title: string) => sheet(page).getByRole("table", { name: table }).getByRole("row").filter({ has: page.getByRole("rowheader", { name: title, exact: true }) }).locator("kbd");

const CHORES = "# Chores\n\n- [ ] Sweep due:2031-10-01\n- [ ] Dust due:2031-10-02\n- [ ] Paint the fence due:2031-10-03\n- [ ] Learn the cello due:2031-10-04\n";

/** Signs in with `settings`, makes the chores and opens the Todos page on them. */
async function open(page: Page, settings: Record<string, unknown> = {}, text = CHORES) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto("/todos");
  await expect(rows(page).first()).toBeVisible();
  return { note, lines: async () => (await read(page, note.id)).split("\n").slice(2, -1) };
}

test("on a row with the keyboard, x completes, - abandons and > moves to the backlog, each written to the note and said with an Undo, and the keyboard goes on to the next row, the whole row selected", async ({ page }) => {
  const { lines } = await open(page);
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);
  await box(page, "Sweep").focus();

  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task completed")).toHaveText("Task completedUndo");
  await expectRowSelected(row(page, "Dust"));

  await page.keyboard.press("-");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task abandoned")).toHaveText("Task abandonedUndo");
  await expectRowSelected(row(page, "Paint the fence"));

  await page.keyboard.press(">");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task moved to the backlog")).toHaveText("Task moved to the backlogUndo");
  await expectRowSelected(row(page, "Learn the cello"));
  // While it lingers, the row says its new state with its box, as a note draws it.
  await expect(box(page, "Paint the fence")).toHaveAttribute("aria-label", "Backlog");

  // Each put away row goes after its moment; Undo brings the last one back, open, through todo.set as a change of its own.
  await toast(page, "Task moved to the backlog").getByRole("button", { name: "Undo" }).click();
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(words(page)).toHaveText(["Paint the fence", "Learn the cello"]);
});

test("Shift and the key > is on moves a todo to the backlog too, as most keyboards type it", async ({ page }) => {
  const { lines } = await open(page);
  await box(page, "Dust").focus();
  await page.keyboard.press("Shift+Period");
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [>] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
});

test("the key for the state a todo is in opens it again, which says nothing; where the list has both states the row and the keyboard stay", async ({ page }) => {
  const { lines } = await open(page, {}, "# Chores\n\n- [ ] Sweep due:2031-10-01\n- [-] Dust due:2031-10-02\n- [x] Mop due:2031-10-03\n");
  await bar(page).fill("is:open OR is:abandoned");
  await expect(words(page)).toHaveText(["Sweep", "Dust"]);

  await box(page, "Sweep").focus();
  await page.keyboard.press("-");
  await expect.poll(lines).toEqual(["- [-] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [x] Mop due:2031-10-03"]);
  await expect(toast(page, "Task abandoned")).toHaveText("Task abandonedUndo");
  await expect(box(page, "Sweep")).toBeFocused();
  await expect(box(page, "Sweep")).toHaveAttribute("aria-label", "Abandoned");
  await expect(row(page, "Sweep").getByRole("button", { name: "Abandon" })).toHaveAttribute("aria-pressed", "true");

  await toast(page, "Task abandoned").locator(".toast-text").click();
  await expect(toasts(page)).toHaveCount(0);
  await box(page, "Sweep").focus();
  await page.keyboard.press("-");
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [x] Mop due:2031-10-03"]);
  await expect(toasts(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Sweep", "Dust"]);

  // In a list of the done ones, x on one opens it again: it stays, greyed, and says why, and the keyboard goes on.
  await bar(page).fill("is:done OR is:abandoned");
  await expect(words(page)).toHaveText(["Dust", "Mop"]);
  await box(page, "Mop").focus();
  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [ ] Mop due:2031-10-03"]);
  await expect(row(page, "Mop").locator(".todo-why")).toHaveText("Opened again, so it no longer shows in this list. It leaves when you refresh.");
  await expectRowSelected(row(page, "Dust"));
});

test("a row's Abandon and Move to backlog buttons, and its menu, put it away as the keys do, with the same Undo", async ({ page }) => {
  const { lines } = await open(page);
  const abandon = row(page, "Dust").getByRole("button", { name: "Abandon" });
  // Quiet at rest, shown while the row is pointed at or has the keyboard.
  await page.mouse.move(0, 0);
  await expect(abandon).toHaveCSS("opacity", "0");
  await row(page, "Dust").hover();
  await expect(abandon).toHaveCSS("opacity", "1");
  await expect(abandon).toHaveAttribute("aria-pressed", "false");

  await abandon.click();
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task abandoned")).toHaveText("Task abandonedUndo");
  await toast(page, "Task abandoned").getByRole("button", { name: "Undo" }).click();
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);

  await row(page, "Paint the fence").getByRole("button", { name: "Move to backlog" }).click();
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task moved to the backlog")).toHaveText("Task moved to the backlogUndo");

  // The keyboard reaches them after what is set, before what isn't.
  await page.mouse.move(0, 0);
  await box(page, "Sweep").focus();
  const names: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    names.push(await page.evaluate(() => document.activeElement!.getAttribute("aria-label") ?? document.activeElement!.textContent!));
  }
  expect(names).toEqual(["Edit Sweep", expect.stringMatching(/^Due date: /), "Abandon", "Move to backlog", "Add tag", "Repeat: none", "Priority: none", "Chores"]);

  // The menu puts it in each state, and opens one again from the state it is in.
  await row(page, "Sweep").locator(".todo-words").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Open note", "Open to the side", "Complete", "Abandon", "Move to backlog"]);
  await menu(page).getByRole("menuitem", { name: "Complete" }).click();
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task completed")).toHaveText("Task completedUndo");

  await bar(page).fill("is:backlog");
  await expect(words(page)).toHaveText(["Paint the fence"]);
  await row(page, "Paint the fence").locator(".todo-words").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Open note", "Open to the side", "Complete", "Abandon", "Open again"]);
  await menu(page).getByRole("menuitem", { name: "Open again" }).click();
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
});

test("Abandon pressed from the keys, or Move to backlog chosen in the row's menu from the keys, gives the keyboard to the next row, the whole row selected", async ({ page }) => {
  const { lines } = await open(page);
  await box(page, "Sweep").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  await expect(row(page, "Sweep").getByRole("button", { name: "Abandon" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(lines).toEqual(["- [-] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expectRowSelected(row(page, "Dust"));
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(menu(page).getByRole("menuitem", { name: "Move to backlog" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(lines).toEqual(["- [-] Sweep due:2031-10-01", "- [>] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expectRowSelected(row(page, "Paint the fence"));
});

test("ArrowDown and ArrowUp select the next and the previous row, the whole row, with or without vim's keys; from the filter bar ArrowDown selects the first row; in the words' field and a chip's popover they are theirs", async ({ page }) => {
  const { lines } = await open(page);
  await bar(page).focus();
  await page.keyboard.press("ArrowDown");
  await expectRowSelected(row(page, "Sweep"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectRowSelected(row(page, "Paint the fence"));
  await page.keyboard.press("ArrowUp");
  await expectRowSelected(row(page, "Dust"));
  // From anything in a row, as its checkbox, too.
  await box(page, "Learn the cello").focus();
  await page.keyboard.press("ArrowUp");
  await expectRowSelected(row(page, "Paint the fence"));
  // The keys for a todo work on the selected row: Space checks it off, as its checkbox does.
  await page.keyboard.press("Space");
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [x] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expectRowSelected(row(page, "Learn the cello"));

  // In the words' field the arrows move the caret, and in a chip's popover through its choices.
  await row(page, "Dust").locator(".todo-words").click();
  const field = todosPage(page).getByRole("textbox", { name: "Words of Dust" });
  await page.keyboard.press("ArrowDown");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await row(page, "Dust").getByRole("button", { name: "Priority: none" }).press("Enter");
  await expect(page.locator(".chip-popover")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".chip-popover")).toBeVisible();
  await expect(page.locator(".chip-popover :focus")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // With vim's keys on, the arrows are the same, and j goes on from where they left the keyboard.
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.goto("/todos");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Learn the cello"]);
  await bar(page).focus();
  await page.keyboard.press("ArrowDown");
  await expectRowSelected(row(page, "Sweep"));
  await page.keyboard.press("ArrowDown");
  await expectRowSelected(row(page, "Dust"));
  await page.keyboard.press("j");
  await expectRowSelected(row(page, "Learn the cello"));
  await page.keyboard.press("ArrowUp");
  await expectRowSelected(row(page, "Dust"));
});

test("the selected row is named by its words and its state, with its keys; Space held down checks it off once, a modifier with Space or Enter does nothing, and Enter opens its note", async ({ page }) => {
  const { note, lines } = await open(page);
  const before = await lines();
  await bar(page).focus();
  await page.keyboard.press("ArrowDown");
  await expectRowSelected(row(page, "Sweep"));
  await expect(row(page, "Sweep")).toHaveAccessibleName("Sweep, Not done");
  await expect(row(page, "Sweep")).toHaveAttribute("aria-keyshortcuts", "x - > Space Enter");

  // Under a resting pointer it is still drawn as selected, not as a row under the pointer.
  await row(page, "Sweep").hover();
  const fill = await row(page, "Sweep").evaluate((li) => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.backgroundColor = "var(--accent-soft)";
    const soft = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [li.matches(":hover"), getComputedStyle(li).backgroundColor === soft];
  });
  expect(fill).toEqual([true, true]);

  for (const key of ["Control+Enter", "Alt+Enter", "Shift+Enter", "Control+Space", "Alt+Space"]) await page.keyboard.press(key);
  await expect(page).toHaveURL(/\/todos$/);
  expect(await lines()).toEqual(before);
  await expectRowSelected(row(page, "Sweep"));

  // Held down, Space checks Sweep off and goes on to Dust, which the repeats leave alone.
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.down("Space");
  await page.keyboard.up("Space");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expectRowSelected(row(page, "Dust"));
  await expect(toasts(page)).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${note.id}$`));
});

test("a selected row taken out of the list from elsewhere gives the keyboard to the row in its place, and the last row to leave gives it to the filter bar", async ({ page }) => {
  const { note } = await open(page);
  const write = async (text: (was: string) => string) => {
    const { revision, text: was } = await perform(page, { type: "note.read", id: note.id });
    await perform(page, { type: "note.write", id: note.id, baseRevision: revision, text: text(was) });
  };
  await bar(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectRowSelected(row(page, "Dust"));
  await write((was) => was.replace("- [ ] Dust due:2031-10-02\n", ""));
  await expect(words(page)).toHaveText(["Sweep", "Paint the fence", "Learn the cello"], { timeout: 20_000 });
  await expectRowSelected(row(page, "Paint the fence"));

  await write(() => "# Chores\n\nNothing left.\n");
  await expect(rows(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(bar(page)).toBeFocused();
});

test("the last row put away from the keys keeps the keyboard for its moment, and gives it to the filter bar as it goes", async ({ page }) => {
  const { lines } = await open(page, {}, "# Chores\n\n- [ ] Sweep due:2031-10-01\n");
  await bar(page).focus();
  await page.keyboard.press("ArrowDown");
  await expectRowSelected(row(page, "Sweep"));
  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01"]);
  await expectRowSelected(row(page, "Sweep"));
  await expect(rows(page)).toHaveCount(0, { timeout: 5000 });
  await expect(bar(page)).toBeFocused();
});

test("with the order bar over the top of the list, ArrowUp never selects a row under it", async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, i) => `- [ ] Chore ${String(i + 1).padStart(2, "0")} due:2031-10-${String(i + 1).padStart(2, "0")}`).join("\n");
  await page.setViewportSize({ width: 1000, height: 500 });
  await open(page, { "todos.sort": "priority" }, `# Chores\n\n${many}\n`);
  const last = row(page, "Chore 30");
  await last.hover();
  await last.getByRole("button", { name: "Priority: none" }).click();
  await page.locator(".chip-popover").getByRole("button", { name: "High", exact: true }).click();
  const order = todosPage(page).locator(".todo-order");
  await expect(order).toHaveText("The order has changed.Refresh");
  await last.getByRole("checkbox").focus();
  for (let i = 0; i < 29; i++) {
    await page.keyboard.press("ArrowUp");
    const covered = await page.evaluate(() => {
      const bottom = document.querySelector(".todo-order")!.getBoundingClientRect().bottom;
      return document.activeElement!.getBoundingClientRect().top < bottom - 1;
    });
    expect(covered, `ArrowUp ${i + 1}`).toBe(false);
  }
  await expectRowSelected(row(page, "Chore 01"));
});

test("the keys do nothing while a row's words are edited, in a chip's popover, or in its menu", async ({ page }) => {
  const { lines } = await open(page);
  const before = await lines();

  await row(page, "Dust").locator(".todo-words").click();
  const field = todosPage(page).getByRole("textbox", { name: "Words of Dust" });
  await expect(field).toBeFocused();
  await page.keyboard.type("x->");
  await expect(field).toHaveValue("Dustx->");
  await page.keyboard.press("Escape");

  await row(page, "Dust").getByRole("button", { name: "Priority: none" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".chip-popover")).toBeVisible();
  await page.keyboard.press("x");
  await page.keyboard.press("-");
  await expect(page.locator(".chip-popover")).toBeVisible();
  await page.keyboard.press("Escape");

  await box(page, "Dust").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("x");
  await page.keyboard.press("-");
  await page.keyboard.press("Escape");
  await expect(box(page, "Dust")).toBeFocused();

  expect(await lines()).toEqual(before);
  await expect(toasts(page)).toHaveCount(0);
});

test("with vim's keys on, dd abandons the selected todo and goes on to the next; without them, d is nobody's key there", async ({ page }) => {
  const { lines } = await open(page, { "vim.enabled": true });
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await box(page, "Sweep").focus();
  await page.keyboard.press("j");
  // j selects the whole row, and the keys after dd and > select the next one the same way: the row has the keyboard, not its checkbox.
  await expectRowSelected(row(page, "Dust"));
  const selectedLook = (text: string) => row(page, text).evaluate((li) => ({ focused: document.activeElement === li, outline: `${getComputedStyle(li).outlineStyle} ${getComputedStyle(li).outlineWidth} ${getComputedStyle(li).outlineColor}`, offset: getComputedStyle(li).outlineOffset, fill: getComputedStyle(li).backgroundColor }));
  const byJ = await selectedLook("Dust");
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task abandoned")).toHaveText("Task abandonedUndo");
  await expectRowSelected(row(page, "Paint the fence"));
  expect(await selectedLook("Paint the fence")).toEqual(byJ);
  await expect(row(page, "Paint the fence")).toHaveAttribute("data-vim-at", "");
  await page.keyboard.press(">");
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expectRowSelected(row(page, "Learn the cello"));
  expect(await selectedLook("Learn the cello")).toEqual(byJ);
  // k goes on from the row the keys selected, once the rows put away have gone.
  await expect(words(page)).toHaveText(["Sweep", "Learn the cello"]);
  await page.keyboard.press("k");
  await expectRowSelected(row(page, "Sweep"));

  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": false }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.goto("/todos");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(0);
  await box(page, "Sweep").focus();
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await page.keyboard.press("-");
  await expect.poll(lines).toEqual(["- [-] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
});

test("the keyboard shortcuts list the keys for a todo under Todos, and vim's dd under Vim", async ({ page }) => {
  await open(page, { "vim.enabled": true });
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  // ? is vim's search where a search box is in reach, so the sheet is opened from the palette.
  await runCommand(page, "Keyboard shortcuts");
  await expect(sheet(page)).toBeVisible();
  await expect(keysOf(page, "Todos", "Complete the selected todo, or open it again")).toHaveText(["X"]);
  await expect(keysOf(page, "Todos", "Abandon the selected todo, or open it again")).toHaveText(["-"]);
  await expect(keysOf(page, "Todos", "Move the selected todo to the backlog, or open it again")).toHaveText([">"]);
  await expect(keysOf(page, "Vim", "Vim: delete the selected row, or abandon the selected todo")).toHaveText(["D D"]);
});

test("a backlog box's › is drawn in the theme's quiet ink, and follows Night shift", async ({ page }) => {
  await open(page, {}, "# Chores\n\n- [ ] Sweep\n- [>] Learn the cello\n");
  await bar(page).fill("is:backlog");
  await expect(words(page)).toHaveText(["Learn the cello"]);
  const ink = () =>
    row(page, "Learn the cello").evaluate((li) => {
      const mark = getComputedStyle(li.querySelector(".todo-box + .todo-box-mark")!);
      return { mark: mark.backgroundColor, shown: mark.display, muted: getComputedStyle(li.querySelector(".todo-words")!).color };
    });
  const plain = await ink();
  expect(plain.shown).toBe("block");
  expect(plain.mark).toBe(plain.muted);

  await perform(page, { type: "settings.write", text: JSON.stringify({ "night-shift.enabled": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(page.locator("html[data-night-shift]")).toHaveCount(1);
  await expect(words(page)).toHaveText(["Learn the cello"]);
  const night = await ink();
  expect(night.mark).toBe(night.muted);
  expect(night.mark).not.toBe(plain.mark);
});

test("x on a repeating todo completes it and leaves it open, due next, so its row and the keyboard stay", async ({ page }) => {
  const { lines } = await open(page, {}, "# Chores\n\n- [ ] Water the plants every:1w due:2031-10-01\n- [ ] Dust due:2031-10-02\n");
  await box(page, "Water the plants").focus();
  await page.keyboard.press("x");
  await expect.poll(lines).toEqual([expect.stringMatching(/^- \[ \] Water the plants every:1w due:2031-10-08 done:\d{4}-\d{2}-\d{2}x1$/), "- [ ] Dust due:2031-10-02"]);
  await expect(toast(page, "Task completed")).toHaveText("Task completedUndo");
  await expect(box(page, "Water the plants")).toBeFocused();
  await expect(words(page)).toHaveText(["Water the plants", "Dust"]);
});

test("with todos left in place, a todo checked off, abandoned or moved to the backlog, by key or click, stays where it is, in its new state and saying why, until the list is refreshed; Undo puts it back and the keyboard goes on down the list", async ({ page }) => {
  const { lines } = await open(page, { "todos.keepPutAway": true });
  await box(page, "Sweep").focus();
  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(toast(page, "Task completed")).toHaveText("Task completedUndo");
  await expectRowSelected(row(page, "Dust"));

  await page.keyboard.press("-");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expectRowSelected(row(page, "Paint the fence"));

  await row(page, "Paint the fence").getByRole("button", { name: "Move to backlog" }).click();
  await box(page, "Learn the cello").click();
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [x] Learn the cello due:2031-10-04"]);

  await page.waitForTimeout(PAST_LINGER_MS);
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);
  expect(await rows(page).locator(".todo-box").evaluateAll((all) => all.map((el) => el.getAttribute("aria-label")))).toEqual(["Done", "Abandoned", "Backlog", "Done"]);
  expect(await rows(page).evaluateAll((all) => all.map((el) => el.getAttribute("data-gone")))).toEqual(["true", "true", "true", "true"]);
  // Its state has quietened it already, so it isn't greyed as well.
  await expect(row(page, "Sweep").locator(".todo-text")).toHaveCSS("opacity", "1");
  await expect(rows(page).locator(".todo-why")).toHaveText([
    "Checked off, so it no longer shows with the open todos. It leaves when you refresh.",
    "Abandoned, so it no longer shows with the open todos. It leaves when you refresh.",
    "Moved to the backlog, so it no longer shows with the open todos. It leaves when you refresh.",
    "Checked off, so it no longer shows with the open todos. It leaves when you refresh.",
  ]);
  // The member asked for them to stay, so nothing asks for a refresh.
  await expect(todosPage(page).locator(".todo-order")).toHaveCount(0);

  await toast(page, "Task completed").getByRole("button", { name: "Undo" }).click();
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [-] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(row(page, "Learn the cello")).not.toHaveAttribute("data-gone");
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);

  // A kept row opened again from its own box stays, open and no longer greyed.
  await box(page, "Dust").click();
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await expect(row(page, "Dust")).not.toHaveAttribute("data-gone");

  await page.goto("/");
  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Dust", "Learn the cello"]);
});

test("Leave todos in place is the Todos plugin's setting in Settings, off at first, and turned on it is kept with the account", async ({ page }) => {
  const { lines } = await open(page);
  await page.goto("/settings/plugins/todos");
  const keep = group(page, "Todos").getByRole("checkbox", { name: "Leave todos in place when you check them off" });
  await expect(keep).not.toBeChecked();
  await keep.check();
  await expect.poll(async () => JSON.parse((await perform(page, { type: "settings.read" })).text)).toEqual({ "todos.keepPutAway": true });
  await closeSettings(page);
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();

  await box(page, "Sweep").focus();
  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  await page.waitForTimeout(PAST_LINGER_MS);
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);
  await expect(row(page, "Sweep")).toHaveAttribute("data-gone", "true");

  await page.reload();
  await page.goto("/settings/plugins/todos");
  await expect(keep).toBeChecked();
  await keep.uncheck();
  await closeSettings(page);
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();
  await expect(words(page)).toHaveText(["Dust", "Paint the fence", "Learn the cello"]);
  await box(page, "Dust").focus();
  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(["- [x] Sweep due:2031-10-01", "- [x] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"]);
  // Off, it is gone by the time a kept one was seen to stay.
  await page.waitForTimeout(PAST_LINGER_MS);
  expect(await words(page).allTextContents()).toEqual(["Paint the fence", "Learn the cello"]);
});
