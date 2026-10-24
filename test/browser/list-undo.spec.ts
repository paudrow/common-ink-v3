import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const todosPage = (page: Page) => page.getByRole("region", { name: "Todos" });
const list = (page: Page) => todosPage(page).getByRole("list", { name: "Todos" });
const rows = (page: Page) => list(page).getByRole("listitem");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const box = (page: Page, text: string) => row(page, text).getByRole("checkbox");
const words = (page: Page) => rows(page).locator(".todo-words");
const selected = (page: Page) => rows(page).and(page.locator("[data-selected]")).locator(".todo-words");
const selectionBar = (page: Page) => todosPage(page).getByRole("toolbar", { name: "Selected rows" });
/** The notices shown, and not on their way out. */
const toast = (page: Page) => page.locator(".toast-card:not([data-leaving])");
const notice = (page: Page, text: string) => toast(page).filter({ hasText: text });
/** Gives the keyboard to a row itself, as j and k and the arrows select one. */
const select = (page: Page, text: string) => row(page, text).evaluate((li: HTMLElement) => li.focus());
/** A click on a row where nothing in it is pressed: past the end of its words. */
async function clickRow(page: Page, text: string, modifiers: ("Shift" | "ControlOrMeta")[] = []) {
  const at = row(page, text).locator(".todo-text");
  const { width, height } = (await at.boundingBox())!;
  await at.click({ position: { x: width - 4, y: height / 2 }, modifiers });
}

const CHORES = "# Chores\n\n- [ ] Sweep due:2031-10-01\n- [ ] Dust due:2031-10-02\n- [ ] Paint the fence due:2031-10-03\n- [ ] Learn the cello due:2031-10-04\n";
const OPEN = ["- [ ] Sweep due:2031-10-01", "- [ ] Dust due:2031-10-02", "- [ ] Paint the fence due:2031-10-03", "- [ ] Learn the cello due:2031-10-04"];
/** The chores with these of them put in a state, by their place in the list. */
const withState = (mark: string, ...at: number[]) => OPEN.map((line, i) => (at.includes(i) ? line.replace("[ ]", `[${mark}]`) : line));

/** Signs in, with vim's keys or without, makes the chores, and opens the Todos page on them. */
async function open(page: Page, vim: boolean) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": vim }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: CHORES });
  await page.goto("/todos");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(vim ? 1 : 0);
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);
  return async () => (await perform(page, { type: "note.read", id: note.id })).text.split("\n").slice(2, -1);
}

const MODES = [
  { name: "without vim", vim: false, undo: "ControlOrMeta+z", redo: "ControlOrMeta+Shift+z" },
  { name: "with vim", vim: true, undo: "u", redo: "Control+r" },
];

for (const { name, vim, undo, redo } of MODES) {
  test.describe(name, () => {
    test(`x completes a todo, ${undo} puts it back and ${redo} does it again, each said in the notice`, async ({ page }) => {
      const lines = await open(page, vim);
      await select(page, "Sweep");
      await page.keyboard.press("x");
      await expect.poll(lines).toEqual(withState("x", 0));
      await expect(toast(page)).toHaveText("Task completedUndo");

      await page.keyboard.press(undo);
      await expect.poll(lines).toEqual(OPEN);
      await expect(toast(page)).toHaveText("Undone: Task completedRedo");
      await page.keyboard.press(redo);
      await expect.poll(lines).toEqual(withState("x", 0));
      await expect(toast(page)).toHaveText("Task completedUndo");
      // Undone again, it is open in the list once more, where it was.
      await page.keyboard.press(undo);
      await expect.poll(lines).toEqual(OPEN);
      await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);
      await expect(box(page, "Sweep")).not.toBeChecked();
    });

    test("Shift with Down twice selects three todos, - abandons them as one step, and one undo brings all three back", async ({ page }) => {
      const lines = await open(page, vim);
      await select(page, "Sweep");
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      await expect(selected(page)).toHaveText(["Sweep", "Dust", "Paint the fence"]);
      await expect(selectionBar(page).getByRole("status")).toHaveText("3 selected");

      await page.keyboard.press("-");
      await expect.poll(lines).toEqual(withState("-", 0, 1, 2));
      await expect(toast(page)).toHaveText("3 tasks abandonedUndo");
      // The selection is let go, and the keyboard goes on to the next row that stays.
      await expect(selected(page)).toHaveCount(0);
      await expect(selectionBar(page)).toHaveCount(0);
      await expect.poll(() => row(page, "Learn the cello").evaluate((li) => li === document.activeElement)).toBe(true);
      await expect(words(page)).toHaveText(["Learn the cello"]);

      await page.keyboard.press(undo);
      await expect.poll(lines).toEqual(OPEN);
      await expect(toast(page)).toHaveText("Undone: 3 tasks abandonedRedo");
      await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);
      await page.keyboard.press(redo);
      await expect.poll(lines).toEqual(withState("-", 0, 1, 2));
    });

    test("the notice's Undo is the same step as the keys': after it, undo takes back the step before", async ({ page }) => {
      const lines = await open(page, vim);
      await select(page, "Sweep");
      await page.keyboard.press("x");
      await expect.poll(lines).toEqual(withState("x", 0));
      await select(page, "Paint the fence");
      await page.keyboard.press(">");
      await expect.poll(lines).toEqual([...withState("x", 0).slice(0, 2), "- [>] Paint the fence due:2031-10-03", OPEN[3]]);
      // Each step has a card of its own.
      await expect(toast(page)).toHaveText(["Task completedUndo", "Task moved to the backlogUndo"]);

      await notice(page, "Task moved to the backlog").getByRole("button", { name: "Undo" }).click();
      await expect.poll(lines).toEqual(withState("x", 0));
      await expect(toast(page)).toHaveText(["Task completedUndo", "Undone: Task moved to the backlogRedo"]);
      await select(page, "Dust");
      await page.keyboard.press(undo);
      await expect.poll(lines).toEqual(OPEN);
      await expect(toast(page)).toHaveText(["Undone: Task moved to the backlogRedo", "Undone: Task completedRedo"]);
      // Nothing is left to undo, and both can be done again, the latest undone first.
      await page.keyboard.press(undo);
      await expect(notice(page, "Nothing to undo")).toHaveCount(1);
      await page.keyboard.press(redo);
      await expect.poll(lines).toEqual(withState("x", 0));
      await page.keyboard.press(redo);
      await expect.poll(lines).toEqual([...withState("x", 0).slice(0, 2), "- [>] Paint the fence due:2031-10-03", OPEN[3]]);
    });
  });
}

test("with vim, V and j twice select three todos, x completes them as one step, and one u brings all three back", async ({ page }) => {
  const lines = await open(page, true);
  await select(page, "Sweep");
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(selected(page)).toHaveText(["Sweep", "Dust", "Paint the fence"]);

  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(withState("x", 0, 1, 2));
  await expect(toast(page)).toHaveText("3 tasks completedUndo");
  await expect(selected(page)).toHaveCount(0);

  await page.keyboard.press("u");
  await expect.poll(lines).toEqual(OPEN);
  await expect(toast(page)).toHaveText("Undone: 3 tasks completedRedo");
  await expect(words(page)).toHaveText(["Sweep", "Dust", "Paint the fence", "Learn the cello"]);

  // dd abandons all of the selection too, as its Abandon button does.
  await select(page, "Dust");
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("j");
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  await expect.poll(lines).toEqual(withState("-", 1, 2));
  await expect(notice(page, "2 tasks abandoned")).toHaveText("2 tasks abandonedUndo");
});

test("Shift-click selects a range and ⌘-click one row more or less; the selection bar puts them all away, and Escape lets them go", async ({ page }) => {
  const lines = await open(page, false);
  await clickRow(page, "Sweep", ["ControlOrMeta"]);
  await clickRow(page, "Paint the fence", ["Shift"]);
  await expect(selected(page)).toHaveText(["Sweep", "Dust", "Paint the fence"]);
  await clickRow(page, "Dust", ["ControlOrMeta"]);
  await expect(selected(page)).toHaveText(["Sweep", "Paint the fence"]);
  await expect(selectionBar(page).getByRole("button")).toHaveText(["Complete", "Abandon", "Move to backlog", "Clear"]);

  // A box pressed on a selected row is for all of them.
  await box(page, "Sweep").click();
  await expect.poll(lines).toEqual(withState("x", 0, 2));
  await expect(toast(page)).toHaveText("2 tasks completedUndo");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lines).toEqual(OPEN);

  // Of those selected, the ones in the backlog already stay; the others go there.
  await select(page, "Dust");
  await page.keyboard.press(">");
  const dustAway = ["- [ ] Sweep due:2031-10-01", "- [>] Dust due:2031-10-02", OPEN[2], OPEN[3]];
  await expect.poll(lines).toEqual(dustAway);
  await todosPage(page).getByRole("radio", { name: "All", exact: true }).click();
  await expect(words(page)).toHaveText(["Sweep", "Paint the fence", "Learn the cello", "Dust"]);
  await clickRow(page, "Paint the fence", ["ControlOrMeta"]);
  await clickRow(page, "Dust", ["Shift"]);
  await expect(selected(page)).toHaveText(["Paint the fence", "Learn the cello", "Dust"]);
  await selectionBar(page).getByRole("button", { name: "Move to backlog" }).click();
  await expect.poll(lines).toEqual(["- [ ] Sweep due:2031-10-01", "- [>] Dust due:2031-10-02", "- [>] Paint the fence due:2031-10-03", "- [>] Learn the cello due:2031-10-04"]);
  await expect(notice(page, "2 tasks moved to the backlog")).toHaveText("2 tasks moved to the backlogUndo");
  await expect(selectionBar(page)).toHaveCount(0);
  // The keyboard is on the list, so undo there is of the list's rows.
  await expect.poll(() => list(page).evaluate((ul) => ul.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lines).toEqual(dustAway);

  // All of them in the backlog already, they are all opened again, which says nothing.
  await clickRow(page, "Dust", ["ControlOrMeta"]);
  await expect(selected(page)).toHaveText(["Dust"]);
  await page.keyboard.press(">");
  await expect.poll(lines).toEqual(OPEN);
  await expect(notice(page, "opened again")).toHaveCount(0);
  // It is a step all the same, which undo takes back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lines).toEqual(dustAway);
  await expect(notice(page, "Undone: Task opened again")).toHaveText("Undone: Task opened againRedo");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(lines).toEqual(OPEN);

  // Escape lets the selection go, and so does a plain click on a row.
  await select(page, "Sweep");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selected(page)).toHaveText(["Sweep", "Paint the fence"]);
  await page.keyboard.press("Escape");
  await expect(selected(page)).toHaveCount(0);
  await expect(selectionBar(page)).toHaveCount(0);
  await clickRow(page, "Sweep", ["ControlOrMeta"]);
  await expect(selected(page)).toHaveText(["Sweep"]);
  await clickRow(page, "Learn the cello");
  await expect(selected(page)).toHaveCount(0);
  await expect.poll(lines).toEqual(OPEN);
});

test("a todo whose change is refused says why and not that it was done, and undo is of the step before", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: CHORES });
  await page.goto("/todos");
  const lines = async () => (await perform(page, { type: "note.read", id: note.id })).text.split("\n").slice(2, -1);
  await select(page, "Sweep");
  await page.keyboard.press("x");
  await expect.poll(lines).toEqual(withState("x", 0));
  await expect(toast(page)).toHaveText("Task completedUndo");

  // Dust's line is changed elsewhere since the page listed it, so checking it off there is refused.
  const { revision } = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, baseRevision: revision, text: CHORES.replace("[ ] Sweep", "[x] Sweep").replace("Dust due", "Dust the shelves due") });
  const changed = withState("x", 0).map((line) => line.replace("Dust due", "Dust the shelves due"));
  await select(page, "Dust");
  await page.keyboard.press("x");
  await expect(todosPage(page).getByRole("alert")).toHaveText("This todo was changed since it was listed. List the todos again.");
  await expect(toast(page)).toHaveText(["Task completedUndo"]);
  expect(await lines()).toEqual(changed);

  await select(page, "Sweep");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lines).toEqual(changed.map((line) => line.replace("[x] Sweep", "[ ] Sweep")));
  await expect(notice(page, "Undone: Task completed")).toHaveText("Undone: Task completedRedo");
});

test("a tag taken off is a step too, which undo puts back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Yard\n\n- [ ] Water the roses #garden #weekend\n" });
  await page.goto("/todos");
  const tag = row(page, "Water the roses").getByRole("button", { name: "#garden", exact: true });
  await tag.focus();
  await page.keyboard.press("Delete");
  const line = async () => (await perform(page, { type: "note.read", id: note.id })).text.split("\n")[2];
  await expect.poll(line).toBe("- [ ] Water the roses #weekend");
  await expect(toast(page)).toHaveText("Removed #gardenUndo");
  await select(page, "Water the roses");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(line).toBe("- [ ] Water the roses #garden #weekend");
  await expect(toast(page)).toHaveText("Undone: Removed #gardenRedo");
});
