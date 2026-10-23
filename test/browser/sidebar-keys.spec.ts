import { expect, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

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
