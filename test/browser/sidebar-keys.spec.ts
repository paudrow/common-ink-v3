import { expect, type Locator, type Page } from "@playwright/test";
import { perform, pinPanel, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};
const focusIn = (el: Locator) => expect.poll(() => el.evaluate((e) => e.contains(document.activeElement)), "focus is in it").toBe(true);

/** Signs in with vim mode on or off, and makes a folder of three notes, two of them tagged #idea, and a folder inside it. */
async function setUp(page: Page, vim: boolean) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": vim }), baseRevision: 0 });
  const work = await perform(page, { type: "folder.create", name: "Work" });
  const plans = await perform(page, { type: "folder.create", name: "Plans", parentId: work.id });
  for (const text of ["# Alpha\n\nfirst #idea", "# Beta\n\nsecond #idea", "# Gamma\n\nthird"]) await perform(page, { type: "note.create", text, folderId: work.id });
  await page.goto("/folder/all");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(vim ? 1 : 0);
  return { work, plans };
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const folder = (page: Page, name: string) => sidebar(page).getByRole("treeitem", { name, exact: true });
const tag = (page: Page, name: string) => sidebar(page).getByRole("link", { name: new RegExp(`^#${name}\\b`) });
const cards = (page: Page) => page.getByRole("main").locator(".cards > li");

/** Whether the row has focus in it and is the one marked as selected. */
async function expectAt(row: Locator, what: string) {
  await expect.poll(() => row.evaluate((el) => el.contains(document.activeElement)), `${what} has focus`).toBe(true);
  await expect(row, `${what} is on screen`).toBeInViewport({ ratio: 0.9 });
}
async function expectMarked(row: Locator, what: string) {
  await expectAt(row, what);
  await expect(row.page().locator("[data-vim-at]"), `${what} is the one row marked`).toHaveCount(1);
  await expect(row).toHaveAttribute("data-vim-at", "");
}

test.describe("with vim mode on", () => {
  test("Enter and l on a folder or a tag open it and put the keys on its first note, also when it is open already, and from a note", async ({ page }) => {
    const { work } = await setUp(page, true);
    await expect(tag(page, "idea")).toBeVisible();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await keys(page, "Control+w", "h");
    for (let i = 0; i < 6 && !(await folder(page, "Work").evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("j");
    await expectMarked(folder(page, "Work"), "Work");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/folder/.*${work.id}`));
    await expect(cards(page)).toHaveCount(3);
    await expectMarked(cards(page).nth(0), "Work's first note");
    await page.keyboard.press("j");
    await expectMarked(cards(page).nth(1), "Work's second note");

    // Work is open already, so nothing navigates, and the keys go to its list all the same.
    await keys(page, "Control+w", "h");
    await expectMarked(folder(page, "Work"), "Work again");
    await page.keyboard.press("l");
    await expectMarked(cards(page).nth(0), "Work's first note, opened again");

    // A tag's notes are read once its page opens, and the keys wait for them.
    await keys(page, "Control+w", "h");
    await tag(page, "idea").focus();
    await page.keyboard.press("l");
    await expect(page).toHaveURL(/\/tags\/idea/);
    await expect(cards(page)).toHaveCount(2);
    await expectMarked(cards(page).nth(0), "the tag's first note");

    // From a note's text, a folder opened from the sidebar takes the keys to its list and not back to the note.
    await page.keyboard.press("Enter");
    const text = page.getByRole("textbox", { name: "Note text" });
    await expect(text).toBeFocused();
    await keys(page, "Control+w", "h");
    await focusIn(sidebar(page));
    await folder(page, "Work").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/folder/.*${work.id}`));
    await expectMarked(cards(page).nth(0), "Work's first note, from a note");
  });
});

test.describe("with vim mode off", () => {
  test("a key pressed while what Enter opened is still loading leaves the keyboard where the key put it", async ({ page }) => {
    await setUp(page, false);
    await expect(tag(page, "idea")).toBeVisible();
    await page.route("**/api/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await tag(page, "idea").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    const went = await page.evaluate(() => document.activeElement!.outerHTML);
    await expect(cards(page)).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.activeElement!.outerHTML)).toBe(went);
    await focusIn(sidebar(page));
  });

  test("Enter on a folder or a tag opens it and puts the keyboard on its first note, also when it is open already", async ({ page }) => {
    const { work } = await setUp(page, false);
    await expect(tag(page, "idea")).toBeVisible();
    await folder(page, "Work").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/folder/.*${work.id}`));
    await expect(cards(page)).toHaveCount(3);
    await expectAt(cards(page).nth(0), "Work's first note");
    await page.keyboard.press("ArrowDown");
    await expectAt(cards(page).nth(1), "Work's second note");

    await folder(page, "Work").focus();
    await page.keyboard.press("Enter");
    await expectAt(cards(page).nth(0), "Work's first note, opened again");

    await tag(page, "idea").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tags\/idea/);
    await expect(cards(page)).toHaveCount(2);
    await expectAt(cards(page).nth(0), "the tag's first note");

    // A page that puts focus somewhere itself keeps it there: Search's box.
    await sidebar(page).getByRole("link", { name: "Search" }).focus();
    await page.keyboard.press("Enter");
    const box = page.getByRole("main").getByRole("searchbox");
    await expect(box).toBeFocused();
    await page.waitForTimeout(2500);
    await expect(box).toBeFocused();
  });
});

/** What the row with focus is called: a page's link, a folder, or a tag. */
const here = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const by = el.getAttribute("aria-labelledby");
    return (by && document.getElementById(by)?.textContent) || el.querySelector(".tag-name")?.textContent || el.getAttribute("aria-label") || el.textContent!.trim();
  });
/** Presses a key until focus stops moving, and says each row it was on, from the one it starts on. */
async function walk(page: Page, key: string) {
  const seen = [await here(page)];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press(key);
    const now = await here(page);
    if (now === seen.at(-1)) break;
    seen.push(now);
  }
  return seen;
}

/** The folder tree's rows, in order. */
const folders = (page: Page) => sidebar(page).getByRole("treeitem").evaluateAll((rows) => rows.map((row) => document.getElementById(row.getAttribute("aria-labelledby")!)!.textContent!));
const PAGES = ["Dashboard", "Search", "Today", "Todos", "Calendar", "More"];

test.describe("the whole sidebar is one list", () => {
  test("in vim mode, j and k go from the pages through the folders to the tags, gg and G to the ends, and za, l and h open folders and More out and shut them", async ({ page }) => {
    await setUp(page, true);
    // Short, with enough folders that the sidebar scrolls, so the keys have to bring rows into view.
    await page.setViewportSize({ width: 1280, height: 520 });
    for (let n = 1; n <= 12; n++) await perform(page, { type: "folder.create", name: `Shelf ${String(n).padStart(2, "0")}` });
    await page.reload();
    await expect(tag(page, "idea")).toBeAttached();
    await expect(sidebar(page).getByRole("treeitem")).toHaveCount(15);
    const all = [...PAGES, ...(await folders(page)), "#idea"];
    expect(all).toContain("Shelf 12");

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await keys(page, "Control+w", "h", "g", "g");
    await expectMarked(sidebar(page).getByRole("link", { name: "Dashboard" }), "Dashboard, the first row");
    expect(await walk(page, "j")).toEqual(all);
    await expectMarked(sidebar(page).getByRole("list", { name: "Tags" }).getByRole("listitem"), "the tag, the last row, scrolled to");
    expect(await walk(page, "k")).toEqual(all.toReversed());
    await page.keyboard.press("Shift+G");
    await expect.poll(() => here(page)).toBe("#idea");
    await keys(page, "g", "g");
    await expect.poll(() => here(page)).toBe("Dashboard");

    // za and l open Work out; j goes into it, h goes back to it and then shuts it.
    for (let i = 0; i < all.indexOf("Work"); i++) await page.keyboard.press("j");
    await expectMarked(folder(page, "Work"), "Work");
    await keys(page, "z", "a");
    await expect(folder(page, "Work")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("j");
    await expectMarked(folder(page, "Plans"), "Plans, inside Work");
    await page.keyboard.press("j");
    await expect.poll(() => here(page)).toBe("#idea");
    await keys(page, "k", "h");
    await expectMarked(folder(page, "Work"), "Work, Plans's parent");
    await page.keyboard.press("h");
    await expect(folder(page, "Work")).toHaveAttribute("aria-expanded", "false");
    await expect(folder(page, "Plans")).toHaveCount(0);

    // More opens out with za as a folder does, and shuts with h. Its pages are rows then.
    await keys(page, "g", "g");
    for (let i = 0; i < PAGES.indexOf("More"); i++) await page.keyboard.press("j");
    const more = sidebar(page).locator(".more-toggle");
    await expect(more).toHaveText("More");
    await expectMarked(more, "More");
    await keys(page, "z", "a");
    await expect(sidebar(page).getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("j");
    await expect.poll(() => here(page)).not.toBe("All notes");
    await page.keyboard.press("k");
    await page.keyboard.press("h");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("j");
    await expect.poll(() => here(page)).toBe("All notes");
    // l opens More out too, and leaves it open.
    await keys(page, "k", "l");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("l");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expectMarked(more, "More, still");
  });

  test("without vim mode, Down and Up go from the pages through the folders to the tags, Home and End to the ends, and Right and Left still open folders out and shut them", async ({ page }) => {
    await setUp(page, false);
    await expect(tag(page, "idea")).toBeVisible();
    const all = [...PAGES, ...(await folders(page)), "#idea"];
    expect(all).toContain("Work");
    await sidebar(page).getByRole("link", { name: "Dashboard" }).focus();
    expect(await walk(page, "ArrowDown")).toEqual(all);
    expect(await walk(page, "ArrowUp")).toEqual(all.toReversed());
    await page.keyboard.press("End");
    await expect.poll(() => here(page)).toBe("#idea");
    await page.keyboard.press("Home");
    await expect.poll(() => here(page)).toBe("Dashboard");

    // In the tree, Home and End are the whole sidebar's too, and Right and Left are the tree's.
    await folder(page, "Work").focus();
    await page.keyboard.press("ArrowRight");
    await expect(folder(page, "Work")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight");
    await expect(folder(page, "Plans")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => here(page)).toBe("#idea");
    await keys(page, "ArrowUp", "ArrowLeft");
    await expect(folder(page, "Work")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(folder(page, "Work")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("End");
    await expect.poll(() => here(page)).toBe("#idea");
    await keys(page, "Home");
    await expect.poll(() => here(page)).toBe("Dashboard");

    // Right and Left open More out and shut it.
    const more = sidebar(page).locator(".more-toggle");
    await more.focus();
    await page.keyboard.press("ArrowRight");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(more).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(more).toHaveAttribute("aria-expanded", "false");

    // The pieces keep the roles they had: a tree of folders, a list of tags, and links.
    await expect(sidebar(page).getByRole("tree", { name: "Folders" }).getByRole("treeitem")).toHaveCount(3);
    await expect(sidebar(page).getByRole("list", { name: "Tags" }).getByRole("listitem")).toHaveCount(1);
  });
});

test.describe("Space opens a row and stays on it", () => {
  test("in vim mode, Space opens a page, a folder or a tag in the editor area and the keys stay on its row, even on Search, which takes focus; Enter then goes there", async ({ page }) => {
    const { work } = await setUp(page, true);
    await expect(tag(page, "idea")).toBeVisible();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await keys(page, "Control+w", "h", "g", "g", "j");
    const search = sidebar(page).getByRole("link", { name: "Search" });
    await expectMarked(search, "Search");
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(/\/search/);
    await expect(page.getByRole("main").getByRole("searchbox")).toBeVisible();
    await expectMarked(search, "Search, opened");

    await page.keyboard.press("Shift+G");
    const idea = sidebar(page).getByRole("list", { name: "Tags" }).getByRole("listitem");
    await expectMarked(idea, "the tag");
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(/\/tags\/idea/);
    await expect(cards(page)).toHaveCount(2);
    await expectMarked(idea, "the tag, opened");

    await page.keyboard.press("k");
    await expectMarked(folder(page, "Work"), "Work");
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(new RegExp(`/folder/.*${work.id}`));
    await expect(cards(page)).toHaveCount(3);
    await expectMarked(folder(page, "Work"), "Work, opened");

    // Space on More opens it out and leaves it to Enter, which goes nowhere.
    await keys(page, "g", "g");
    for (let i = 0; i < PAGES.indexOf("More"); i++) await page.keyboard.press("j");
    await page.keyboard.press(" ");
    await expect(sidebar(page).getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
    await expect(page).toHaveURL(new RegExp(`/folder/.*${work.id}`));

    // Work was opened out as it opened, so Plans is between it and the tag.
    await keys(page, "Shift+G", "k", "k");
    await expectMarked(folder(page, "Work"), "Work, from the end");
    await page.keyboard.press("Enter");
    await expectMarked(cards(page).nth(0), "Work's first note, after Enter");
  });

  test("without vim mode, Space opens a page, a folder or a tag in the editor area and the keyboard stays on its row, even on Search; Enter then goes there", async ({ page }) => {
    const { work } = await setUp(page, false);
    await expect(tag(page, "idea")).toBeVisible();
    const search = sidebar(page).getByRole("link", { name: "Search" });
    await search.focus();
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(/\/search/);
    await expect(page.getByRole("main").getByRole("searchbox")).toBeVisible();
    await expectAt(search, "Search, opened");

    await page.keyboard.press("End");
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(/\/tags\/idea/);
    await expect(cards(page)).toHaveCount(2);
    await expectAt(tag(page, "idea"), "the tag, opened");

    await page.keyboard.press("ArrowUp");
    await page.keyboard.press(" ");
    await expect(page).toHaveURL(new RegExp(`/folder/.*${work.id}`));
    await expect(cards(page)).toHaveCount(3);
    await expectAt(folder(page, "Work"), "Work, opened");
    await page.keyboard.press("Enter");
    await expectAt(cards(page).nth(0), "Work's first note, after Enter");
  });
});

test("Ctrl-w h lands on the row of what is open, Ctrl-w l puts the note's cursor back where it was, Ctrl-w p goes back to the last region, and Ctrl-w w goes round them", async ({ page }) => {
  const { work } = await setUp(page, true);
  const note = await perform(page, { type: "note.create", text: "# Delta\n\nfirst line\nlast line", folderId: work.id });
  await page.goto(`/note/${note.id}`);
  const text = page.getByRole("textbox", { name: "Note text" });
  await expect(text).toContainText("last line");
  await text.click();
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await keys(page, "Shift+G", "w");

  // The sidebar is entered on the note's folder, whichever row it was left on.
  await keys(page, "Control+w", "h");
  await expectMarked(folder(page, "Work"), "the note's folder");
  await keys(page, "g", "g");
  await expectMarked(sidebar(page).getByRole("link", { name: "Dashboard" }), "Dashboard");
  await keys(page, "Control+w", "l");
  await expect(text).toBeFocused();
  await keys(page, "Control+w", "h");
  await expectMarked(folder(page, "Work"), "the note's folder again");

  // Back in the note, the cursor is where it was: on the last line's second word, even after the page's selection was elsewhere.
  await sidebar(page).evaluate((el) => getSelection()!.selectAllChildren(el.querySelector(".section-head")!));
  await keys(page, "Control+w", "l");
  await expect(text).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("Z");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe("# Delta\n\nfirst line\nlast Zline");

  // p goes back to the row that was left, and not to what is open.
  await keys(page, "Control+w", "h", "k");
  const left = await here(page);
  expect(left).not.toBe("Work");
  await keys(page, "Control+w", "l");
  await expect(text).toBeFocused();
  await keys(page, "Control+w", "p");
  await expect.poll(() => here(page)).toBe(left);
  await keys(page, "Control+w", "p");
  await expect(text).toBeFocused();

  // w goes round the regions in the page's order and back to the first: the sidebar, the note, the inspector.
  await pinPanel(page, "Info");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toBeVisible();
  await text.click();
  await keys(page, "Escape", "Control+w", "w");
  await focusIn(inspector);
  await keys(page, "Control+w", "w");
  await expectMarked(folder(page, "Work"), "round to the sidebar");
  await keys(page, "Control+w", "w");
  await expect(text).toBeFocused();

  // On a page, the sidebar is entered on its link.
  await page.goto("/todos");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await page.getByRole("main").click({ position: { x: 600, y: 300 } });
  await keys(page, "Control+w", "h");
  await expectMarked(sidebar(page).getByRole("link", { name: "Todos" }), "Todos, the page open");
});

test("the keyboard shortcuts list the sidebar's keys under a heading of their own, with vim's for each while vim mode is on, and Ctrl-w p and w among vim's", async ({ page }) => {
  const MAC = process.platform === "darwin";
  const sheetOf = async () => {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.getByRole("combobox", { name: "Commands" }).fill("Keyboard shortcuts");
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    return sheet;
  };
  const rowsOf = (table: Locator) => table.locator("tr").evaluateAll((rows) => rows.map((row) => [row.querySelector("th")!.textContent, ...[...row.querySelectorAll("kbd")].map((k) => k.textContent)]));

  await setUp(page, false);
  await expect(tag(page, "idea")).toBeVisible();
  let sheet = await sheetOf();
  await expect(sheet.getByRole("heading", { level: 3 }).first()).toHaveText("Navigation");
  await expect(sheet.getByRole("heading", { level: 3 }).nth(1)).toHaveText("Sidebar");
  expect(await rowsOf(sheet.getByRole("table", { name: "Sidebar" }))).toEqual([
    ["Next or previous row", "↓", "↑"],
    ["First or last row", "Home", "End"],
    ["Open a folder or More out, or shut it", "→", "←"],
    ["Open the row and go to it", "Enter"],
    ["Open the row and stay in the sidebar", "Space"],
  ]);
  await page.keyboard.press("Escape");

  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  sheet = await sheetOf();
  const ctrlW = (key: string) => (MAC ? `⌃W ${key}` : `Ctrl+W ${key}`);
  expect(await rowsOf(sheet.getByRole("table", { name: "Sidebar" }))).toEqual([
    ["Next or previous row", "↓", "↑", "J", "K"],
    ["First or last row", "Home", "End", "G G", MAC ? "⇧G" : "Shift+G"],
    ["Open a folder or More out, or shut it", "→", "←", "Z A", "H"],
    ["Open the row and go to it", "Enter", "L"],
    ["Open the row and stay in the sidebar", "Space"],
    ["Go to the sidebar, on the row of what is open", ctrlW("H")],
    ["Go back to the region you were in", ctrlW("P")],
  ]);
  const vim = sheet.getByRole("table", { name: "Vim" });
  await expect(vim.getByRole("row", { name: "Vim: go back to the region you were in" }).locator("kbd")).toHaveText([ctrlW("P")]);
  await expect(vim.getByRole("row", { name: "Vim: go to the next region, round to the first" }).locator("kbd")).toHaveText([ctrlW("W")]);
});
