import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const top = (page: Page) => page.locator(".phone-top");
const up = (page: Page) => top(page).locator(".phone-up");
const title = (page: Page) => top(page).getByRole("heading");
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const folders = (page: Page) => page.getByRole("tree", { name: "Folders" });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const card = (page: Page, name: string) => page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name, exact: true });
const keys = (page: Page) => page.getByRole("toolbar", { name: "Keys" });
const newNote = (page: Page) => page.locator(".phone-new");
const textOf = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/**
 * Stands in for the phone's own keyboard, which a test browser never draws: the visual viewport
 * gets shorter by the keyboard's height, as it does on a phone.
 */
async function withOnScreenKeyboard(page: Page) {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    let covered = 0;
    const sides = { height: () => innerHeight - covered, width: () => innerWidth, offsetTop: () => 0, offsetLeft: () => 0, pageTop: () => scrollY, pageLeft: () => scrollX, scale: () => 1 };
    for (const [name, get] of Object.entries(sides)) Object.defineProperty(viewport, name, { get });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    Object.assign(window, {
      showKeyboard(height: number) {
        covered = height;
        viewport.dispatchEvent(new Event("resize"));
      },
    });
  });
}
const showKeyboard = (page: Page, height: number) => page.evaluate((h) => (window as unknown as { showKeyboard: (h: number) => void }).showKeyboard(h), height);

/** Projects > Engines, a note in each, and a note with a todo in Engines. */
async function withWork(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const engines = await perform(page, { type: "folder.create", name: "Engines", parentId: projects.id });
  const plan = await perform(page, { type: "note.create", folderId: projects.id, text: "# Plan\n\nThe plan." });
  const mill = await perform(page, { type: "note.create", folderId: engines.id, text: "# Mill\n\nThe mill turns.\n\n- [ ] Oil the gears\n" });
  return { projects, engines, plan, mill };
}

test("a phone shows one screen at a time, and up goes from a note to its folder's list, to the folder it is in, to the sidebar", async ({ page }) => {
  const { engines, projects, mill } = await withWork(page);
  await page.goto(`/note/${mill.id}`);
  await expect(editor(page)).toContainText("The mill turns.");
  await expect(sidebar(page)).toHaveCount(0);
  // The note's own heading says what it is, so the bar names only where up goes.
  await expect(title(page)).toHaveCount(0);
  await expect(up(page)).toHaveText("Engines");
  const box = (await page.locator(".main").boundingBox())!;
  expect(box.width, "the note has the whole width").toBe(390);

  await up(page).tap();
  await expect(page).toHaveURL(`/folder/${engines.id}`);
  await expect(title(page)).toHaveText("Engines");
  await expect(card(page, "Mill")).toBeVisible();
  await expect(up(page)).toHaveText("Projects");

  await up(page).tap();
  await expect(page).toHaveURL(`/folder/${projects.id}`);
  await expect(card(page, "Plan")).toBeVisible();
  await expect(up(page)).toHaveText("Workspace");

  await up(page).tap();
  await expect(sidebar(page)).toBeVisible();
  await expect(page.locator(".main")).toBeHidden();
  await expect(page, "the sidebar is no address of its own").toHaveURL(`/folder/${projects.id}`);

  // Going anywhere from the sidebar puts that in front.
  await folders(page).getByRole("treeitem", { name: "All notes", exact: true }).tap();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(title(page)).toHaveText("All notes");
  await card(page, "Plan").getByRole("link", { name: "Edit" }).tap();
  await expect(editor(page)).toContainText("The plan.");
  await expect(up(page)).toHaveText("Projects");

  // The browser's back goes back where the member was, as anywhere.
  await page.goBack();
  await expect(title(page)).toHaveText("All notes");

  // Choosing in the sidebar what is already in front puts it in front again.
  await up(page).tap();
  await folders(page).getByRole("treeitem", { name: "All notes", exact: true }).tap();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(card(page, "Plan")).toBeVisible();
});

test("focus has no hold on a phone: the bar and its way up stay", async ({ page }) => {
  const { mill } = await withWork(page);
  await page.goto(`/note/${mill.id}`);
  await editor(page).getByText("The mill turns.").tap();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(up(page)).toBeInViewport();
  await up(page).tap();
  await expect(title(page)).toHaveText("Engines");
});

test("every mode in the sidebar is a screen of its own under it: Todos, and Search to a note", async ({ page }) => {
  const { mill } = await withWork(page);
  await page.goto("/");
  await expect(title(page)).toHaveText("Dashboard");
  await up(page).tap();
  await sidebar(page).getByRole("link", { name: "Todos", exact: true }).tap();
  await expect(page).toHaveURL("/todos");
  await expect(title(page)).toHaveText("Todos");
  await expect(page.getByText("Oil the gears")).toBeVisible();

  await up(page).tap();
  await sidebar(page).getByRole("link", { name: "Search", exact: true }).tap();
  await expect(title(page)).toHaveText("Search");
  await page.getByRole("searchbox").first().fill("mill turns");
  await page.getByRole("link", { name: /Mill/ }).first().tap();
  await expect(page).toHaveURL(new RegExp(`${mill.id}$`));
  await expect(editor(page)).toContainText("The mill turns.");
});

test("a note is made with the round button, in the folder in front, and written and checked off by touch", async ({ page }) => {
  const { engines } = await withWork(page);
  await page.goto(`/folder/${engines.id}`);
  await newNote(page).tap();
  await expect(page).toHaveURL(/\/note\//);
  await expect(up(page)).toHaveText("Engines");
  const id = /([a-z0-9]{12})$/.exec(new URL(page.url()).pathname)![1]!;
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("# Boiler\n\n- [ ] Check the pressure");
  await expect.poll(() => textOf(page, id)).toBe("# Boiler\n\n- [ ] Check the pressure");

  await editor(page).getByRole("checkbox", { name: "Not done" }).tap();
  await expect.poll(() => textOf(page, id)).toBe("# Boiler\n\n- [x] Check the pressure");

  await up(page).tap();
  await expect(card(page, "Boiler")).toBeVisible();
});

test("the inspector is a sheet from the bottom, its panels tabs along its top, and a tap above it closes it", async ({ page }) => {
  const { mill } = await withWork(page);
  await page.goto(`/note/${mill.id}`);
  await top(page).getByRole("button", { name: "Inspector" }).tap();
  const sheet = page.locator(".phone-sheet");
  await expect(sheet).toBeVisible();
  const { y, height } = (await sheet.boundingBox())!;
  expect(y, "the note stays in view above it").toBeGreaterThan(200);
  expect(y + height).toBe(844);
  await expect(editor(page)).toBeInViewport();

  const tabs = sheet.getByRole("navigation", { name: "Inspector bar" });
  await expect(tabs.getByRole("button", { name: "Info", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(sheet.getByRole("heading", { name: "Info" })).toBeVisible();
  await expect(sheet.getByText("Engines").first()).toBeVisible();
  await tabs.getByRole("button", { name: "History", exact: true }).tap();
  await expect(sheet.getByRole("heading", { name: "History" })).toBeVisible();

  await page.touchscreen.tap(195, 100);
  await expect(sheet).toHaveCount(0);
});

test("a row of keys sits on the on-screen keyboard: marks, links, undo, and hiding the keyboard", async ({ page }) => {
  await withOnScreenKeyboard(page);
  const { mill } = await withWork(page);
  await page.goto(`/note/${mill.id}`);
  await expect(keys(page)).toHaveCount(0);
  await expect(newNote(page)).toBeVisible();

  await editor(page).getByText("The mill turns.").tap();
  await showKeyboard(page, 336);
  await expect(keys(page)).toBeVisible();
  expect((await keys(page).boundingBox())!.y + 44, "it sits right on the keyboard").toBe(844 - 336);
  await expect(newNote(page), "the round button makes way").toHaveCount(0);

  await keys(page).getByRole("button", { name: "Todo" }).tap();
  await expect.poll(() => textOf(page, mill.id)).toBe("# Mill\n\n- [ ] The mill turns.\n\n- [ ] Oil the gears\n");
  await expect(editor(page), "the cursor stays, so the keyboard does").toBeFocused();
  await keys(page).getByRole("button", { name: "Todo" }).tap();
  await expect.poll(() => textOf(page, mill.id)).toBe("# Mill\n\nThe mill turns.\n\n- [ ] Oil the gears\n");

  await page.keyboard.press("End");
  await keys(page).getByRole("button", { name: "Link" }).tap();
  await expect(page.getByRole("listbox"), "the link completion opens as if [[ were typed").toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => textOf(page, mill.id)).toBe("# Mill\n\nThe mill turns.[[\n\n- [ ] Oil the gears\n");
  await keys(page).getByRole("button", { name: "Undo" }).tap();
  await expect.poll(() => textOf(page, mill.id)).toBe("# Mill\n\nThe mill turns.\n\n- [ ] Oil the gears\n");

  // A mark goes on every line the selection covers, after the indentation, in place of another kind.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await keys(page).getByRole("button", { name: "Bullet" }).tap();
  await expect.poll(() => textOf(page, mill.id)).toBe("# Mill\n\n- The mill turns.\n\n- Oil the gears\n");
  await keys(page).getByRole("button", { name: "Todo" }).tap();
  await expect.poll(() => textOf(page, mill.id)).toBe("# Mill\n\n- [ ] The mill turns.\n\n- [ ] Oil the gears\n");
  await keys(page).getByRole("button", { name: "Bullet" }).tap();
  await keys(page).getByRole("button", { name: "Bullet" }).tap();
  await expect.poll(() => textOf(page, mill.id)).toBe("# Mill\n\nThe mill turns.\n\nOil the gears\n");

  await keys(page).getByRole("button", { name: "Hide keyboard" }).tap();
  await expect(editor(page)).not.toBeFocused();
  await expect(keys(page), "the keyboard is still going: the row goes with the cursor").toHaveCount(0);
  await expect(newNote(page)).toBeVisible();

  // Only a note's editor has the row: a search box has no marks to put.
  await up(page).tap();
  await page.getByRole("searchbox").first().tap();
  await showKeyboard(page, 336);
  await expect(keys(page)).toHaveCount(0);
});

test("tabs and splits are off at a phone's width and back in a wider window, with the member's switch left on", async ({ page }) => {
  const { mill } = await withWork(page);
  await page.goto(`/note/${mill.id}`);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await page.goto("/plugins");
  const row = page.getByRole("list", { name: "Plugins" }).getByRole("listitem", { name: "Tabs and splits" });
  await expect(row.getByText("Off on a phone.")).toBeVisible();
  await expect(row.getByRole("checkbox")).toBeChecked();

  await page.goto(`/note/${mill.id}`);
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.getByRole("tablist", { name: "Open notes" })).toBeVisible();
  await expect(sidebar(page)).toBeVisible();
  await expect(top(page)).toHaveCount(0);
  await expect(editor(page)).toContainText("The mill turns.");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await expect(up(page)).toHaveText("Engines");
  await expect(editor(page)).toContainText("The mill turns.");
});

test("Vim is off on a touch screen until a key only an attached keyboard has is pressed, and stays on where the member asks", async ({ page }) => {
  const { mill } = await withWork(page);
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.goto("/plugins");
  const row = page.getByRole("list", { name: "Plugins" }).getByRole("listitem", { name: "Vim mode" });
  await expect(row.getByText(/Off on this device until a keyboard is connected/)).toBeVisible();
  await expect(row.getByRole("checkbox"), "the member's switch is still on").toBeChecked();

  await page.goto(`/note/${mill.id}`);
  await editor(page).getByText("The mill turns.").tap();
  await page.keyboard.type("x");
  await expect.poll(() => textOf(page, mill.id), "letters prove nothing, and type as letters").toContain("x");
  await expect(page.locator(".cm-vim-panel")).toHaveCount(0);

  // Escape is on no phone's keyboard: one is attached.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await page.reload();
  await expect(page.locator(".cm-vim-panel"), "this device is remembered to have one").toBeVisible();

  // Another phone, with no keyboard: the member keeps keyboard plugins on in Settings.
  const other = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: { cookies: await page.context().cookies(), origins: [] } });
  const phone = await other.newPage();
  await phone.goto(`/note/${mill.id}`);
  await expect(editor(phone)).toBeVisible();
  await expect(phone.locator(".cm-vim-panel")).toHaveCount(0);
  await phone.goto("/settings");
  await phone.getByRole("searchbox", { name: "Search settings" }).fill("keyboard plugins");
  await phone.getByRole("checkbox", { name: "Keyboard plugins without a keyboard" }).tap();
  await expect.poll(async () => JSON.parse((await perform(phone, { type: "settings.read" })).text)["core.keyboardPluginsOnTouch"]).toBe(true);
  await phone.goto(`/note/${mill.id}`);
  await expect(phone.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await other.close();
});

test("a wide block scrolls inside itself, and nothing makes the page wider than the phone", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, {
    type: "note.create",
    text: "# Board\n\nA line long enough that it has to wrap on a phone's screen to be read at all.\n\n/kanban()\n~~~markdown\n## To do\n\n- One\n\n## Doing\n\n- Two\n\n## Done\n\n- Three\n\n## Later\n\n- Four\n~~~\n\n| Name | Role | Started | Notes |\n| --- | --- | --- | --- |\n| Ada Lovelace | Analyst | 1842 | Wrote the first program |\n",
  });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".kanban")).toBeVisible();
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, content: document.querySelector(".cm-content")!.getBoundingClientRect().right }));
  expect(widths.page).toBe(390);
  expect(widths.content).toBeLessThanOrEqual(390);
  const board = page.locator(".kanban-columns");
  expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth), "the board scrolls inside itself").toBe(true);
  await board.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await expect(board.getByText("Four")).toBeInViewport();
});

test.describe("a narrow window on a computer", () => {
  test.use({ viewport: { width: 420, height: 800 }, hasTouch: false, isMobile: false });

  test("is no phone: the sidebar, tabs and Vim stay as on any computer", async ({ page }) => {
    const { mill } = await withWork(page);
    await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
    await page.goto(`/note/${mill.id}`);
    await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Open notes" })).toBeVisible();
    await expect(top(page)).toHaveCount(0);
  });
});
