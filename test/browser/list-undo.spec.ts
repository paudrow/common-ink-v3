import { expect, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import type { Me, Upload } from "../../src/core/protocol.ts";
import { folderRow, listedNotes, noteCard, perform, pinPanel, signInAsNewPerson, test } from "./helpers.ts";

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

const notesBar = (page: Page) => page.locator(".folder-head").getByRole("toolbar", { name: "Selected rows" });
const selectedCards = (page: Page) => page.locator(".cards > li[data-selected] .card-title");
const focused = (page: Page, title: string) => expect.poll(() => noteCard(page, title).evaluate((card) => card === document.activeElement), `${title} has the keyboard`).toBe(true);
/** A click on a card where nothing in it is pressed: on what it says of who edited it. */
const clickCard = (page: Page, title: string, modifiers: ("Shift" | "ControlOrMeta")[] = []) => noteCard(page, title).locator(".card-details").click({ modifiers });

/** Signs in, with vim's keys or without, makes Projects with four notes and Journal with none, and opens Projects' list. */
async function openProjects(page: Page, vim: boolean) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": vim }), baseRevision: 0 });
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const journal = await perform(page, { type: "folder.create", name: "Journal" });
  // The newest is listed first.
  const ids: Record<string, string> = {};
  for (const title of ["Delta", "Gamma", "Beta", "Alpha"]) ids[title] = (await perform(page, { type: "note.create", folderId: projects.id, text: `# ${title}\n\nwords` })).id;
  await page.goto("/");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(vim ? 1 : 0);
  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Alpha", "Beta", "Gamma", "Delta"]);
  const read = (title: string) => perform(page, { type: "note.read", id: ids[title]! });
  return {
    projects,
    journal,
    states: () => Promise.all(["Alpha", "Beta", "Gamma", "Delta"].map(async (title) => (await read(title)).state)),
    folders: () => Promise.all(["Alpha", "Beta"].map(async (title) => (await read(title)).folderId)),
  };
}

for (const { name, vim, undo, redo } of MODES) {
  test.describe(`a folder's notes, ${name}`, () => {
    test(`e archives a card, ${undo} brings it back and ${redo} archives it again`, async ({ page }) => {
      const { states } = await openProjects(page, vim);
      await noteCard(page, "Alpha").focus();
      await page.keyboard.press("e");
      await expect.poll(states).toEqual(["archived", "live", "live", "live"]);
      await expect(listedNotes(page)).toHaveText(["Beta", "Gamma", "Delta"]);
      await expect(toast(page)).toHaveText("ArchivedUndo");
      await focused(page, "Beta");

      await page.keyboard.press(undo);
      await expect.poll(states).toEqual(["live", "live", "live", "live"]);
      await expect(listedNotes(page)).toHaveText(["Alpha", "Beta", "Gamma", "Delta"]);
      await expect(toast(page)).toHaveText("Undone: ArchivedRedo");
      await page.keyboard.press(redo);
      await expect.poll(states).toEqual(["archived", "live", "live", "live"]);
      await expect(listedNotes(page)).toHaveText(["Beta", "Gamma", "Delta"]);
    });

    test(`${vim ? "V and j select" : "Shift with Down selects"} two cards, and e archives both as one step`, async ({ page }) => {
      const { states } = await openProjects(page, vim);
      await noteCard(page, "Alpha").focus();
      await page.keyboard.press(vim ? "Shift+V" : "Shift+ArrowDown");
      if (vim) await page.keyboard.press("j");
      await expect(selectedCards(page)).toHaveText(["Alpha", "Beta"]);
      await expect(notesBar(page).getByRole("status")).toHaveText("2 selected");

      await page.keyboard.press("e");
      await expect.poll(states).toEqual(["archived", "archived", "live", "live"]);
      await expect(toast(page)).toHaveText("Archived 2 notesUndo");
      await expect(selectedCards(page)).toHaveCount(0);
      // The keyboard goes on to the first card after them.
      await focused(page, "Gamma");

      await page.keyboard.press(undo);
      await expect.poll(states).toEqual(["live", "live", "live", "live"]);
      await expect(toast(page)).toHaveText("Undone: Archived 2 notesRedo");
      await expect(listedNotes(page)).toHaveText(["Alpha", "Beta", "Gamma", "Delta"]);
    });

    test("Shift with Down selects two cards, the selection bar's Move to Trash trashes both, and one undo brings both back", async ({ page }) => {
      const { states } = await openProjects(page, vim);
      await noteCard(page, "Beta").focus();
      await page.keyboard.press("Shift+ArrowDown");
      await expect(selectedCards(page)).toHaveText(["Beta", "Gamma"]);
      await expect(notesBar(page).getByRole("button")).toHaveText(["Archive", "Move to…", "Move to Trash", "Clear"]);

      await notesBar(page).getByRole("button", { name: "Move to Trash" }).click();
      await expect.poll(states).toEqual(["live", "trashed", "trashed", "live"]);
      await expect(listedNotes(page)).toHaveText(["Alpha", "Delta"]);
      await expect(toast(page)).toHaveText("Moved 2 notes to TrashUndo");
      await expect(notesBar(page)).toHaveCount(0);
      await focused(page, "Delta");

      await page.keyboard.press(undo);
      await expect.poll(states).toEqual(["live", "live", "live", "live"]);
      await expect(listedNotes(page)).toHaveText(["Alpha", "Beta", "Gamma", "Delta"]);
    });
  });
}

test("in a folder's notes, ⌘-click selects a card or lets it go, and Shift-click a range; the bar's Unarchive is for archived ones", async ({ page }) => {
  await openProjects(page, false);
  await clickCard(page, "Alpha", ["ControlOrMeta"]);
  await clickCard(page, "Gamma", ["ControlOrMeta"]);
  await expect(selectedCards(page)).toHaveText(["Alpha", "Gamma"]);
  await clickCard(page, "Alpha", ["ControlOrMeta"]);
  await expect(selectedCards(page)).toHaveText(["Gamma"]);
  await clickCard(page, "Beta", ["ControlOrMeta"]);
  await clickCard(page, "Delta", ["Shift"]);
  await expect(selectedCards(page)).toHaveText(["Beta", "Gamma", "Delta"]);
  // A plain click on a card lets them go.
  await clickCard(page, "Delta");
  await expect(selectedCards(page)).toHaveCount(0);

  // With all of them archived, the bar unarchives them.
  await page.getByRole("radio", { name: "All", exact: true }).first().click();
  await noteCard(page, "Alpha").focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("e");
  await expect(toast(page)).toHaveText("Archived 2 notesUndo");
  await clickCard(page, "Alpha", ["ControlOrMeta"]);
  await clickCard(page, "Beta", ["ControlOrMeta"]);
  await expect(notesBar(page).getByRole("button").first()).toHaveText("Unarchive");
  await clickCard(page, "Gamma", ["ControlOrMeta"]);
  await expect(notesBar(page).getByRole("button").first()).toHaveText("Archive");
});

test("in a folder's notes, two cards moved to another folder from the bar are one step, and undo takes both back", async ({ page }) => {
  const { projects, journal, folders } = await openProjects(page, false);
  await noteCard(page, "Alpha").focus();
  await page.keyboard.press("Shift+ArrowDown");
  await notesBar(page).getByRole("button", { name: "Move to…" }).click();
  const menu = page.getByRole("menu", { name: "Move 2 notes to" });
  await menu.getByRole("menuitem", { name: "Journal" }).click();
  await expect.poll(folders).toEqual([journal.id, journal.id]);
  await expect(listedNotes(page)).toHaveText(["Gamma", "Delta"]);
  await expect(toast(page)).toHaveText("Moved 2 notes to JournalUndo");

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(folders).toEqual([projects.id, projects.id]);
  await expect(listedNotes(page)).toHaveText(["Alpha", "Beta", "Gamma", "Delta"]);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(folders).toEqual([journal.id, journal.id]);
});

test("Trash restores two notes selected as one step, and undo puts both back in Trash", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const ids: string[] = [];
  for (const title of ["Second", "First"]) {
    const note = await perform(page, { type: "note.create", text: `# ${title}` });
    await perform(page, { type: "note.trash", id: note.id });
    ids.push(note.id);
  }
  const states = () => Promise.all(ids.map(async (id) => (await perform(page, { type: "note.read", id })).state));
  await page.goto("/trash");
  const notes = page.getByRole("list", { name: "Notes in Trash" }).getByRole("listitem");
  await expect(notes).toHaveCount(2);
  await notes.first().getByRole("link").focus();
  await page.keyboard.press("Shift+ArrowDown");
  const bar = page.getByRole("region", { name: "Trash" }).getByRole("toolbar", { name: "Selected rows" });
  await expect(bar.getByRole("status")).toHaveText("2 selected");

  await bar.getByRole("button", { name: "Restore" }).click();
  await expect.poll(states).toEqual(["live", "live"]);
  await expect(toast(page)).toHaveText("Restored 2 notes from Trash.Undo");
  await expect(notes).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(states).toEqual(["trashed", "trashed"]);
  await expect(toast(page)).toHaveText("Undone: Restored 2 notes from Trash.Redo");
  await expect(notes).toHaveCount(2);
});

test("Trash restores from the bar and the keyboard goes on to the row that stays, where undo puts them back at once", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const ids: string[] = [];
  for (const title of ["Third", "Second", "First"]) {
    const note = await perform(page, { type: "note.create", text: `# ${title}` });
    await perform(page, { type: "note.trash", id: note.id });
    ids.push(note.id);
  }
  const states = () => Promise.all(ids.map(async (id) => (await perform(page, { type: "note.read", id })).state));
  await page.goto("/trash");
  const notes = page.getByRole("list", { name: "Notes in Trash" }).getByRole("listitem");
  await expect(notes).toHaveText([/^First/, /^Second/, /^Third/]);
  await notes.first().getByRole("link").focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.getByRole("region", { name: "Trash" }).getByRole("toolbar", { name: "Selected rows" }).getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => notes.filter({ hasText: "Third" }).evaluate((li) => li.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(states).toEqual(["trashed", "trashed", "trashed"]);
  await expect(toast(page)).toHaveText("Undone: Restored 2 notes from Trash.Redo");
});

test("⌘Z in an open note's History list is the note's undo, not the lists'", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const chores = await perform(page, { type: "note.create", text: CHORES });
  const plan = await perform(page, { type: "note.create", text: "# Plan\n\nFirst step" });
  await page.goto("/todos");
  await select(page, "Sweep");
  await page.keyboard.press("x");
  const sweep = async () => (await perform(page, { type: "note.read", id: chores.id })).text.split("\n")[2];
  await expect.poll(sweep).toBe("- [x] Sweep due:2031-10-01");

  await page.goto(`/note/${plan.id}`);
  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and the next");
  const text = async () => (await perform(page, { type: "note.read", id: plan.id })).text;
  await expect.poll(text).toBe("# Plan\n\nFirst step and the next");
  await pinPanel(page, "History");
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("listbox", { name: "Changes" }).focus();

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(text).toBe("# Plan\n\nFirst step");
  expect(await sweep()).toBe("- [x] Sweep due:2031-10-01");
});

/** A PNG of one colour. */
function png(width: number, height: number): Buffer {
  const crc = (bytes: Buffer) => {
    let c = ~0;
    for (const byte of bytes) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const [length, sum] = [Buffer.alloc(4), Buffer.alloc(4)];
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 120)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

const sendFile = (page: Page, name: string) =>
  page.evaluate(
    async ({ name, base64 }) => {
      const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) },
        body: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      });
      return (await res.json()) as Upload;
    },
    { name, base64: png(8, 8).toString("base64") },
  );

test("Uploads archives two files selected from the selection bar as one step, and undo brings both back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const files = [await sendFile(page, "chart.png"), await sendFile(page, "map.png")];
  const states = () => Promise.all(files.map(async ({ id }) => (await perform(page, { type: "upload.read", id })).state));
  await page.goto("/uploads");
  const rows = page.getByRole("list", { name: "Uploads" }).getByRole("link");
  await expect(rows).toHaveCount(2);
  await rows.filter({ hasText: "chart.png" }).click({ modifiers: ["ControlOrMeta"] });
  await rows.filter({ hasText: "map.png" }).click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByRole("region", { name: "Uploads" }).getByRole("toolbar", { name: "Selected rows" });
  await expect(bar.getByRole("status")).toHaveText("2 selected");
  await expect(bar.getByRole("button")).toHaveText(["Archive", "Move to Trash", "Clear"]);
  // Picked, not opened.
  await expect(page).toHaveURL(/\/uploads$/);

  await bar.getByRole("button", { name: "Archive" }).click();
  await expect.poll(states).toEqual(["archived", "archived"]);
  await expect(toast(page)).toHaveText("Archived 2 filesUndo");
  await expect(bar).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(states).toEqual(["live", "live"]);
  await expect(toast(page)).toHaveText("Undone: Archived 2 filesRedo");
});

test("Uploads: undoing a file's move, and redoing it, shows in its details at once", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const press = await perform(page, { type: "folder.create", name: "Press" });
  const file = await sendFile(page, "logo.png");
  const folder = async () => (await perform(page, { type: "upload.read", id: file.id })).folderId;
  await page.goto(`/uploads/${file.id}`);
  const card = page.getByRole("complementary", { name: "logo.png" });
  await card.getByRole("button", { name: "More for logo.png" }).click();
  await page.getByRole("menu", { name: "More for logo.png" }).getByRole("menuitem", { name: "Move to folder…" }).click();
  await page.getByRole("menu", { name: "Move logo.png to" }).getByRole("menuitem", { name: "Press" }).click();
  await expect.poll(folder).toBe(press.id);
  await expect(card.locator(".upload-meta")).toContainText("Press");

  await page.getByRole("list", { name: "Uploads" }).getByRole("link").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(folder).not.toBe(press.id);
  await expect(card.locator(".upload-meta")).not.toContainText("Press");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(folder).toBe(press.id);
  await expect(card.locator(".upload-meta")).toContainText("Press");
});

test("the sidebar's rows are selected by the keys alone: Shift with Down selects two, and ⌘-click on a row still opens it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (const name of ["Work", "Home"]) await perform(page, { type: "folder.create", name });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await folderRow(page, "Home").focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(sidebar.locator("[data-selected]")).toHaveCount(2);
  await expect(sidebar.getByRole("toolbar", { name: "Selected rows" }).getByRole("status")).toHaveText("2 selected");
  await expect(sidebar.getByRole("toolbar", { name: "Selected rows" }).getByRole("button")).toHaveText(["Clear"]);
  await page.keyboard.press("Escape");
  await expect(sidebar.locator("[data-selected]")).toHaveCount(0);

  await folderRow(page, "Work").click({ modifiers: ["ControlOrMeta"] });
  await expect(sidebar.locator("[data-selected]")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
});
