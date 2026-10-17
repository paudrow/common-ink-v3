import { expect, test, type Locator, type Page } from "@playwright/test";
import { perform, pinPanel, signInAsNewPerson, toggleInspector, toggleSidebar } from "./helpers.ts";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const inspector = (page: Page) => page.getByRole("complementary", { name: "Inspector" });
const edge = (page: Page, name: string) => page.getByRole("separator", { name });
const widthOf = async (part: Locator) => Math.round((await part.boundingBox())!.width);

/** Drags an edge by its middle, the way a hand does: press, move in steps, let go. */
async function drag(page: Page, handle: Locator, dx: number, dy = 0) {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function withNote(page: Page, text = "# Draft\n\nWords.") {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Draft");
  return note;
}

test("the sidebar is dragged wider and narrower by its inner edge, within its limits, and its width is kept across a reload", async ({ page }) => {
  await withNote(page);
  expect(await widthOf(sidebar(page))).toBe(216);
  const handle = edge(page, "Resize sidebar");
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");
  await expect(handle).toHaveAttribute("aria-valuenow", "216");

  await drag(page, handle, 64);
  expect(await widthOf(sidebar(page))).toBe(280);
  await expect(handle).toHaveAttribute("aria-valuenow", "280");

  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  expect(await widthOf(sidebar(page))).toBe(280);

  await drag(page, handle, -170);
  expect(await widthOf(sidebar(page))).toBe(150);
  await drag(page, handle, 900);
  expect(await widthOf(sidebar(page))).toBe(480);

  await handle.dblclick();
  expect(await widthOf(sidebar(page))).toBe(216);
});

test("the inspector is dragged by its inner edge, and both edges are moved with the keyboard and put back with Enter", async ({ page }) => {
  await withNote(page);
  await pinPanel(page, "Info");
  await expect(inspector(page)).toBeVisible();
  expect(await widthOf(inspector(page))).toBe(256);
  const handle = edge(page, "Resize inspector");

  await drag(page, handle, -80);
  expect(await widthOf(inspector(page))).toBe(336);
  await page.reload();
  await expect(inspector(page)).toBeVisible();
  expect(await widthOf(inspector(page))).toBe(336);

  await handle.focus();
  await expect(handle).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  expect(await widthOf(inspector(page))).toBe(352);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await widthOf(inspector(page))).toBe(320);
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowRight");
  expect(await widthOf(inspector(page))).toBe(180);
  await page.keyboard.press("Enter");
  expect(await widthOf(inspector(page))).toBe(256);

  await edge(page, "Resize sidebar").focus();
  await page.keyboard.press("ArrowRight");
  expect(await widthOf(sidebar(page))).toBe(232);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await widthOf(sidebar(page))).toBe(200);
  await page.keyboard.press("End");
  expect(await widthOf(sidebar(page))).toBe(480);
  await page.keyboard.press("Enter");
  expect(await widthOf(sidebar(page))).toBe(216);
});

/** Where the parts of the window are, to check that what floats over them moves none of them. */
const places = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("main, .group, .tab, .note-bar, .cm-line, nav.rail, [role=complementary], [role=separator]")].map((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return [el.getAttribute("aria-label") ?? el.className, x, y, width, height];
    }),
  );

/** The middle of an edge, which is where the side it resizes ends. */
async function middleOf(handle: Locator) {
  const box = (await handle.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const steps of [1, 4, 30]) {
  test(`dragged in past its least width the sidebar folds to its bar, and the bar's edge dragged out opens it, in ${steps} pointer moves a stretch`, async ({ page }) => {
    await withNote(page);
    await page.evaluate(() => document.fonts.ready);
    const handle = edge(page, "Resize sidebar");
    const bar = page.getByRole("navigation", { name: "Sidebar bar" });
    const main = page.getByRole("main", { name: "Editor" });
    const mainX = async () => Math.round((await main.boundingBox())!.x);
    await drag(page, handle, 64);
    expect(await widthOf(sidebar(page))).toBe(280);

    const { x, y } = await middleOf(handle);
    expect(x).toBe(280);
    const to = (at: number) => page.mouse.move(at, y, { steps });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await to(170);
    await expect.poll(() => widthOf(sidebar(page))).toBe(170);
    // Under its least width it stays at it, and well under it folds: at 85 and less, half way to the bar less a little.
    await to(120);
    await expect.poll(() => widthOf(sidebar(page))).toBe(150);
    await to(90);
    await expect(sidebar(page)).toBeVisible();
    expect(await widthOf(sidebar(page))).toBe(150);
    await to(80);
    await expect(bar).toBeVisible();
    await expect(sidebar(page)).toHaveCount(0);
    expect(await widthOf(bar)).toBe(44);
    expect(await mainX()).toBe(44);
    // Back and forth about the place it folded at changes nothing, until the pointer is well past it the other way.
    for (const at of [92, 104, 86, 107, 96]) {
      await to(at);
      await expect(bar).toBeVisible();
      await expect(sidebar(page)).toHaveCount(0);
    }
    await page.mouse.up();
    await expect(bar).toBeVisible();
    await expect(handle).toHaveAttribute("aria-valuetext", "Collapsed");
    expect((await middleOf(handle)).x).toBe(44);

    await page.reload();
    await expect(bar).toBeVisible();
    await expect(sidebar(page)).toHaveCount(0);

    // A short drag out opens it as wide as it was, and nothing follows the pointer until the pointer is out there.
    await page.mouse.move(44, y);
    await page.mouse.down();
    await to(100);
    await expect(bar).toBeVisible();
    await to(118);
    await expect(sidebar(page)).toBeVisible();
    expect(await widthOf(sidebar(page))).toBe(280);
    for (const at of [112, 121, 200]) {
      await to(at);
      expect(await widthOf(sidebar(page))).toBe(280);
    }
    await page.mouse.up();
    expect(await widthOf(sidebar(page))).toBe(280);
    expect(await mainX()).toBe(280);
    await expect(handle).toHaveAttribute("aria-valuenow", "280");

    // A long drag out opens it where the pointer is, and from there it follows the pointer in and out.
    await page.mouse.move(280, y);
    await page.mouse.down();
    await to(60);
    await expect(bar).toBeVisible();
    await to(340);
    await expect.poll(() => widthOf(sidebar(page))).toBe(340);
    await to(200);
    await expect.poll(() => widthOf(sidebar(page))).toBe(200);
    await page.mouse.up();
    expect(await widthOf(sidebar(page))).toBe(200);
    await page.reload();
    await expect(sidebar(page)).toBeVisible();
    expect(await widthOf(sidebar(page))).toBe(200);
  });
}

test("the inspector's pinned panel folds away by its edge, leaving its bar where it was, and opens again by that edge, pinned", async ({ page }) => {
  await withNote(page);
  await pinPanel(page, "Info");
  await page.evaluate(() => document.fonts.ready);
  const handle = edge(page, "Resize inspector");
  const bar = page.getByRole("navigation", { name: "Inspector bar" });
  const main = page.getByRole("main", { name: "Editor" });
  const { x, y } = await middleOf(handle);
  expect(x).toBe(1280 - 256 - 44);
  const barAt = await bar.boundingBox();
  /** Moves the pointer to where the panel would be `wide` across, left of its bar. */
  const to = (wide: number) => page.mouse.move(1280 - 44 - wide, y, { steps: 5 });

  await page.mouse.move(x, y);
  await page.mouse.down();
  await to(140);
  await expect(inspector(page)).toBeVisible();
  expect(await widthOf(inspector(page))).toBe(180);
  // It folds under 78: half way from its least width to nothing, less a little.
  await to(80);
  await expect(inspector(page)).toBeVisible();
  await to(74);
  await expect(inspector(page)).toHaveCount(0);
  for (const wide of [86, 100, 77]) {
    await to(wide);
    await expect(inspector(page)).toHaveCount(0);
  }
  await page.mouse.up();
  expect(await bar.boundingBox()).toEqual(barAt);
  expect(await widthOf(main)).toBe(1280 - 216 - 44);
  await expect(handle).toHaveAttribute("aria-valuetext", "Collapsed");

  await page.mouse.move(1280 - 44, y);
  await page.mouse.down();
  await to(130);
  await expect(inspector(page)).toBeVisible();
  expect(await widthOf(inspector(page))).toBe(256);
  await to(420);
  await expect.poll(() => widthOf(inspector(page))).toBe(420);
  await page.mouse.up();
  expect(await widthOf(inspector(page))).toBe(420);
  expect(await bar.boundingBox()).toEqual(barAt);
  await expect(inspector(page).getByRole("button", { name: "Pin beside the page" })).toHaveAttribute("aria-pressed", "true");
});

test("a press on a folded side's edge with no drag opens it, and from the keyboard its edge folds it and opens it", async ({ page }) => {
  await withNote(page);
  const handle = edge(page, "Resize sidebar");
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await expect(handle).toHaveAttribute("title", "Drag to resize, or past its narrowest to collapse");
  await drag(page, handle, 64);

  await handle.focus();
  await page.keyboard.press("Home");
  await expect(bar).toBeVisible();
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAttribute("aria-valuetext", "Collapsed");
  await expect(handle).toHaveAttribute("title", "Drag or press to open");
  await page.keyboard.press("Enter");
  await expect(sidebar(page)).toBeVisible();
  expect(await widthOf(sidebar(page))).toBe(280);
  await expect(handle).toBeFocused();

  // The arrow keys step it down to its least width, then fold it, and step it back out from there.
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  expect(await widthOf(sidebar(page))).toBe(280);
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowLeft");
  expect(await widthOf(sidebar(page))).toBe(150);
  await page.keyboard.press("ArrowLeft");
  await expect(bar).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(bar).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(sidebar(page)).toBeVisible();
  expect(await widthOf(sidebar(page))).toBe(150);

  await page.keyboard.press("Home");
  await expect(bar).toBeVisible();
  const { x, y } = await middleOf(handle);
  await page.mouse.click(x, y);
  await expect(sidebar(page)).toBeVisible();
  expect(await widthOf(sidebar(page))).toBe(150);

  // The inspector's edge, which grows to the left.
  const right = edge(page, "Resize inspector");
  await right.focus();
  await page.keyboard.press("Home");
  await expect(inspector(page)).toHaveCount(0);
  await expect(right).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(inspector(page)).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await expect(inspector(page)).toBeVisible();
  expect(await widthOf(inspector(page))).toBe(256);
  await page.keyboard.press("Home");
  await page.keyboard.press("End");
  expect(await widthOf(inspector(page))).toBe(256);
});

test("a width kept from before the sides folded by their edges is the width they open at", async ({ page }) => {
  const note = await withNote(page);
  await page.evaluate(() => {
    const person = Object.keys(localStorage).find((key) => key.startsWith("ink.widths."))!;
    localStorage.setItem(person, JSON.stringify({ sidebar: 333, inspector: 444 }));
    localStorage.setItem("ink.sidebar", "false");
    // The inspector as it was kept before it had panels over the page: open or closed, and the tab last picked.
    localStorage.removeItem(person.replace("ink.widths.", "ink.inspectorPanel."));
    localStorage.setItem("ink.inspector", "false");
    localStorage.setItem(person.replace("ink.widths.", "ink.inspectorTab."), JSON.stringify("backlinks"));
  });
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("navigation", { name: "Sidebar bar" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Inspector bar" })).toBeVisible();
  await expect(inspector(page)).toHaveCount(0);
  await edge(page, "Resize sidebar").focus();
  await page.keyboard.press("Enter");
  expect(await widthOf(sidebar(page))).toBe(333);
  await edge(page, "Resize inspector").focus();
  await page.keyboard.press("Enter");
  expect(await widthOf(inspector(page))).toBe(444);
  await expect(inspector(page).locator(".panel-head h2")).toHaveText("Backlinks");
});

test("the tab row has its tabs and Focus and no button for either side, whose commands and keys still close and open them", async ({ page }) => {
  await withNote(page);
  await pinPanel(page, "Info");
  const controls = (part: Locator) => part.locator("a, button:not(.tab-close)").evaluateAll((els) => els.filter((el) => el.getClientRects().length).map((el) => el.getAttribute("aria-label") ?? el.textContent));
  expect(await controls(page.locator(".tab-row"))).toEqual(["Focus"]);
  await expect(page.getByRole("group", { name: "Window" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Sidebar|Inspector)$/ })).toHaveCount(0);
  const main = page.getByRole("main", { name: "Editor" });
  const first = (await page.getByRole("tab", { name: "Draft" }).boundingBox())!;
  expect(Math.round(first.x)).toBe(Math.round((await main.boundingBox())!.x));

  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+\\");
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await expect(bar).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
  expect(await widthOf(bar)).toBe(44);
  expect(await widthOf(main)).toBe(1280 - 44 - 300);
  await expect.poll(() => controls(bar)).toEqual(["New note", "Dashboard", "Search", "Todos", "Today", "Calendar", "More", "Folders", "Tags"]);
  expect(await controls(page.locator(".tab-row"))).toEqual(["Focus"]);
  await page.reload();
  await expect(bar).toBeVisible();
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(sidebar(page)).toBeVisible();

  // Each is a command, with its keys beside it in the palette.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Toggle sidebar");
  await expect(page.getByRole("dialog", { name: "Commands" }).getByRole("option")).toHaveText([/^Toggle sidebar\s*(⌘\\|Ctrl\+\\)$/]);
  await page.keyboard.press("Enter");
  await expect(sidebar(page)).toHaveCount(0);
  await toggleInspector(page);
  await expect(inspector(page)).toHaveCount(0);
  await expect.poll(() => controls(page.getByRole("navigation", { name: "Inspector bar" }))).toEqual(["History", "Backlinks", "Info"]);
  await toggleInspector(page);
  await expect(inspector(page)).toBeVisible();
});

test("in a narrow window, where a side is drawn narrower than it was dragged to, its edge still moves the way it is dragged and folds where the pointer is", async ({ page }) => {
  const note = await withNote(page);
  await page.evaluate(() => localStorage.setItem(Object.keys(localStorage).find((key) => key.startsWith("ink.widths."))!, JSON.stringify({ sidebar: 400, inspector: 500 })));
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Draft");
  const handle = edge(page, "Resize sidebar");
  const drawn = (await sidebar(page).boundingBox())!.width;
  expect(drawn).toBeLessThan(400);
  const { x, y } = await middleOf(handle);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 10, y, { steps: 3 });
  await expect(handle).toHaveAttribute("aria-valuenow", "410");
  expect((await sidebar(page).boundingBox())!.width).toBeGreaterThanOrEqual(drawn);
  await page.mouse.move(x, y, { steps: 3 });
  await expect(handle).toHaveAttribute("aria-valuenow", "400");
  await page.mouse.move(70, y, { steps: 5 });
  await expect(page.getByRole("navigation", { name: "Sidebar bar" })).toBeVisible();
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+\\");
  await expect(handle).toHaveAttribute("aria-valuenow", "400");
});

test("a double click on a folded side's edge opens it and presses nothing in it", async ({ page }) => {
  await withNote(page);
  await toggleSidebar(page);
  const { x, y } = await middleOf(edge(page, "Resize sidebar"));
  // Where All notes' row is once the sidebar is open: the second click lands there.
  await page.mouse.dblclick(x, 296);
  await expect(sidebar(page)).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByRole("tablist", { name: "Open notes" }).getByRole("tab")).toHaveText(["Draft"]);
  expect(y).toBeGreaterThan(0);
  // A click after that is a click again.
  await page.waitForTimeout(600);
  await page.getByRole("treeitem", { name: "All notes" }).click();
  await expect(page.getByRole("tab", { name: "All notes" })).toHaveAttribute("aria-selected", "true");
});

const picker = (page: Page) => page.getByRole("dialog", { name: "Folders" });

test("Folders on the folded sidebar's bar opens the folder tree over the page, and a folder opened from it puts it away, with nothing underneath moved", async ({ page }) => {
  await withNote(page);
  const plans = await perform(page, { type: "folder.create", name: "Plans" });
  await perform(page, { type: "folder.create", name: "Later", parentId: plans.id });
  await perform(page, { type: "note.create", text: "# Plan", folderId: plans.id });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Draft");
  await toggleSidebar(page);
  await page.evaluate(() => document.fonts.ready);
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  const folders = bar.getByRole("button", { name: "Folders" });
  await expect(folders).toHaveAttribute("aria-expanded", "false");
  const before = await places(page);

  await folders.click();
  await expect(folders).toHaveAttribute("aria-expanded", "true");
  const tree = picker(page).getByRole("tree", { name: "Folders" });
  await expect(tree.getByRole("treeitem")).toHaveCount(3);
  await expect(tree.getByRole("treeitem", { name: "All notes" })).toHaveAccessibleDescription("2");
  await expect(tree.getByRole("treeitem", { name: "Plans" })).toHaveAccessibleDescription("1");
  await expect(tree.getByRole("treeitem", { name: "Unsorted" })).toHaveAccessibleDescription("1");
  await expect(picker(page).getByRole("button", { name: "New folder" })).toBeVisible();
  // The tree it shows is the one tree there is: the sidebar's own, drawn here while the sidebar is shut.
  await expect(page.getByRole("tree", { name: "Folders" })).toHaveCount(1);
  await expect(sidebar(page)).toHaveCount(0);
  expect(await places(page)).toEqual(before);
  const [at, rail, main] = [(await picker(page).boundingBox())!, (await bar.boundingBox())!, (await page.getByRole("main", { name: "Editor" }).boundingBox())!];
  expect(at.x).toBeGreaterThanOrEqual(rail.x + rail.width);
  expect(at.x).toBeLessThan(rail.x + rail.width + 12);
  expect(at.x + at.width).toBeGreaterThan(main.x + 100);
  expect(at.y + at.height).toBeLessThanOrEqual(800);

  // A click opens the folder's list as the sidebar's row does, as a preview, and the tree goes.
  await tree.getByRole("treeitem", { name: "Plans" }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Plans" })).toHaveAttribute("data-preview", "true");
  await expect(bar).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(folders).toHaveAttribute("aria-expanded", "false");
  const main2 = (await page.getByRole("main", { name: "Editor" }).boundingBox())!;
  expect(main2).toEqual(main);

  // A double click keeps the list open, as it does in the sidebar.
  await folders.click();
  await tree.getByRole("treeitem", { name: "Unsorted" }).dblclick();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Unsorted" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Unsorted" })).not.toHaveAttribute("data-preview");

  // Escape and a press outside it put it away, and open nothing.
  await folders.click();
  await expect(tree).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await expect(folders).toBeFocused();
  await folders.click();
  await expect(tree).toBeVisible();
  await page.mouse.click(main.x + main.width - 40, main.y + 300);
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Unsorted" })).toHaveAttribute("aria-selected", "true");

  // From the keyboard: it opens on the folder in front, the arrows move through it and into a folder, and Enter opens.
  await folders.focus();
  await page.keyboard.press("Enter");
  await expect(tree.getByRole("treeitem", { name: "Unsorted" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(tree.getByRole("treeitem", { name: "Plans" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tree.getByRole("treeitem")).toHaveCount(3);
  await expect(tree.getByRole("treeitem", { name: "Plans" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem")).toHaveCount(4);
  await page.keyboard.press("ArrowDown");
  await expect(tree.getByRole("treeitem", { name: "Later" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem", { name: "All notes" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(tree.getByRole("treeitem", { name: "Later" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Later" })).toHaveAttribute("aria-selected", "true");
  await expect(folders).toBeFocused();

  // Its menu splits from here too, and a new folder is named in it without it going away.
  await folders.click();
  await picker(page).getByRole("button", { name: "New folder" }).click();
  await page.keyboard.type("Ideas");
  await page.keyboard.press("Enter");
  await expect(tree.getByRole("treeitem", { name: "Ideas" })).toBeVisible();
  // Naming done or given up from the keyboard, the cursor is back on the tree's rows.
  await expect(tree.getByRole("treeitem", { name: "Later" })).toBeFocused();
  await picker(page).getByRole("button", { name: "New folder" }).click();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Later" })).toBeFocused();
  // Left goes from a folder inside another to the one it is in, and Right from an open folder into it.
  await page.keyboard.press("ArrowLeft");
  await expect(tree.getByRole("treeitem", { name: "Plans" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tree.getByRole("treeitem", { name: "Later" })).toBeFocused();
  // The cursor taken out of it with Tab puts it away, and so does focus.
  await page.keyboard.press("Tab");
  await expect(picker(page)).toHaveCount(0);
  await folders.click();
  await expect(tree).toBeVisible();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(picker(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+.");
  await expect(bar).toBeVisible();
  await expect(picker(page)).toHaveCount(0);
  await folders.click();
  await tree.getByRole("treeitem", { name: "Ideas" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in a split right" }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Editor group 2" }).getByRole("tab")).toHaveText(["Ideas"]);

  // The other icons go where they did, with no tree.
  await bar.getByRole("link", { name: "Search" }).click();
  await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
  await expect(picker(page)).toHaveCount(0);
  await expect(sidebar(page)).toHaveCount(0);
});

test("Tags on the folded sidebar's bar shows the tags alone over the page, and a tag opened from it puts it away", async ({ page }) => {
  await withNote(page);
  await perform(page, { type: "note.create", text: "# Garden\n\nTomatoes #garden" });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Draft");
  await toggleSidebar(page);
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  const tags = bar.getByRole("button", { name: "Tags" });
  const folders = bar.getByRole("button", { name: "Folders" });
  await expect(tags).toHaveAttribute("aria-expanded", "false");
  await tags.click();
  await expect(tags).toHaveAttribute("aria-expanded", "true");
  await expect(folders).toHaveAttribute("aria-expanded", "false");
  const shown = page.getByRole("dialog", { name: "Tags" });
  await expect(shown.getByRole("navigation", { name: "Tags" })).toBeVisible();
  await expect(shown.getByRole("tree", { name: "Folders" })).toHaveCount(0);
  await expect(picker(page)).toHaveCount(0);

  // Folders takes its place: one section over the page at a time.
  await folders.click();
  await expect(picker(page).getByRole("tree", { name: "Folders" })).toBeVisible();
  await expect(shown).toHaveCount(0);
  await tags.click();
  await expect(picker(page)).toHaveCount(0);
  await shown.getByRole("link", { name: "#garden" }).click();
  await expect(page).toHaveURL(/\/tags\/garden$/);
  await expect(shown).toHaveCount(0);
  await expect(tags).toHaveAttribute("aria-expanded", "false");
});

test("a folder dragged out of the bar's folder tree lands in a pane as one dragged from the sidebar does, and the tree goes", async ({ page }) => {
  await withNote(page);
  await perform(page, { type: "folder.create", name: "Plans" });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Draft");
  await page.getByRole("tab", { name: "Draft" }).dblclick();
  await toggleSidebar(page);
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await bar.getByRole("button", { name: "Folders" }).click();
  const row = picker(page).getByRole("treeitem", { name: "Plans" });
  const body = (await page.locator(".group-body").boundingBox())!;
  await row.hover();
  await page.mouse.down();
  await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 3 });
  await page.mouse.move(body.x + body.width * 0.9, body.y + body.height / 2, { steps: 3 });
  await page.mouse.move(body.x + body.width * 0.9 + 1, body.y + body.height / 2);
  await page.mouse.move(body.x + body.width * 0.9, body.y + body.height / 2);
  await page.mouse.up();
  await expect(page.getByRole("region", { name: "Editor group 2" }).getByRole("tab")).toHaveText(["Plans"]);
  await expect(picker(page)).toHaveCount(0);
  await expect(bar).toBeVisible();
});

for (const folder of ["Unsorted", "Meeting notes", "Research and development / Quarterly planning documents / Engineering"]) {
test(`in a pane 320px wide a note's bar is as tall before the name of its folder, ${folder}, arrives as after, and the note's first line stays where it is`, async ({ page }) => {
  await page.setViewportSize({ width: 320 + 44 + 44, height: 800 });
  await signInAsNewPerson(page, "Ada Lovelace");
  let folderId: string | undefined;
  if (folder !== "Unsorted") for (const name of folder.split(" / ")) folderId = (await perform(page, { type: "folder.create", name, parentId: folderId })).id;
  const note = await perform(page, { type: "note.create", text: "# Draft\n\nWords.", folderId });
  await page.evaluate(() => {
    localStorage.setItem("ink.sidebar", "false");
  });
  let arrive = () => {};
  const held = new Promise<void>((done) => (arrive = done));
  await page.route("**/api/**", async (route) => {
    if (route.request().postData()?.includes("folder.list")) await held;
    await route.fallback();
  });
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Draft");
  await expect(page.locator(".note-meta")).toContainText("edited");
  await expect(page.locator(".crumbs")).toHaveText("");
  await page.evaluate(() => document.fonts.ready);
  const measured = () =>
    page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return { pane: box(".group-body").width, bar: box(".note-bar").height, firstLine: box(".cm-line").top, edited: box(".note-meta > :last-child").top };
    });
  const before = await measured();
  expect(before.pane).toBe(320);

  arrive();
  await expect(page.locator(".crumbs")).toHaveText(folder);
  expect(await measured()).toEqual(before);
});
}

/** What a part lists, top to bottom: the name of each thing in it, checked to lie one under the other in that order. */
async function listedIn(part: Locator, things: string) {
  const found = await part.locator(things).evaluateAll((els) =>
    els.map((el) => ({ name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(), y: el.getBoundingClientRect().y, current: el.getAttribute("aria-current") === "page" })),
  );
  expect(found.map((f) => f.y)).toEqual(found.map((f) => f.y).sort((a, b) => a - b));
  return found;
}

test("a closed sidebar leaves a bar with an icon for each thing the sidebar lists, in the sidebar's own order, and each goes where it says", async ({ page }) => {
  await withNote(page);
  // The Tags section is drawn once the tags have been asked for.
  await expect(sidebar(page).locator(".section-head > span")).toHaveText(["Folders", "Tags"]);
  const listedOpen = () => listedIn(sidebar(page), ".new-note, nav[aria-label=Modes] > *, .section-head > span");
  await expect.poll(async () => (await listedOpen()).map((o) => o.name)).toEqual(["New note", "Dashboard", "Search", "Todos", "Today", "Calendar", "More", "Folders", "Tags"]);
  const open = await listedOpen();

  await toggleSidebar(page);
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await expect(bar).toBeVisible();
  expect((await listedIn(bar, "a, button")).map((o) => o.name)).toEqual(open.map((o) => o.name));
  for (const name of ["New note", "Dashboard", "Search", "Todos", "Today", "Calendar", "More", "Folders", "Tags"]) {
    const icon = bar.getByRole(["New note", "More", "Folders", "Tags"].includes(name) ? "button" : "link", { name, exact: true });
    await expect(icon).toHaveAttribute("title", name === "New note" ? "New note in Unsorted" : name);
    expect(await widthOf(icon)).toBe(28);
  }

  // A mode's icon goes to the mode, marks it, and leaves the sidebar closed.
  await bar.getByRole("link", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
  expect((await listedIn(bar, "a, button")).filter((o) => o.current).map((o) => o.name)).toEqual(["Calendar"]);

  // More lists the rest in the bar as it does in the sidebar, between Calendar and Folders.
  await bar.getByRole("button", { name: "More" }).click();
  expect((await listedIn(bar, "a, button")).map((o) => o.name)).toEqual(["New note", "Dashboard", "Search", "Todos", "Today", "Calendar", "Less", "Contacts", "Uploads", "History", "Trash", "Plugins", "Folders", "Tags"]);
  await bar.getByRole("button", { name: "Less" }).click();

  // Folders shows the folder tree over the page, and the sidebar stays closed.
  await bar.getByRole("button", { name: "Folders" }).click();
  await expect(picker(page).getByRole("tree", { name: "Folders" })).toBeVisible();
  await expect(bar).toBeVisible();
  await expect(sidebar(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await page.keyboard.press("Escape");

  // New note in the bar makes one.
  await bar.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await expect(bar).toBeVisible();
});

test("the inspector's bar has an icon for each panel whatever is in front, with its panel closed too, and an icon shows its panel", async ({ page }) => {
  await withNote(page);
  await pinPanel(page, "Info");
  const main = page.getByRole("main", { name: "Editor" });
  const before = (await main.boundingBox())!;
  const bar = page.getByRole("navigation", { name: "Inspector bar" });
  const barAt = await bar.boundingBox();
  await toggleInspector(page);
  await expect(inspector(page)).toHaveCount(0);
  await expect(bar.getByRole("button")).toHaveCount(3);
  expect((await listedIn(bar, "button")).map((o) => o.name)).toEqual(["History", "Backlinks", "Info"]);
  await expect(bar.getByRole("button", { name: "Backlinks" })).toHaveAttribute("title", "Backlinks");
  expect(await bar.boundingBox()).toEqual(barAt);
  expect(await widthOf(bar)).toBe(44);
  expect(await widthOf(main)).toBe(Math.round(before.width) + 256);
  expect((await main.boundingBox())!.x).toBe(before.x);

  await bar.getByRole("button", { name: "History" }).click();
  await expect(inspector(page).locator(".panel-head h2")).toHaveText("History");
  await expect(inspector(page).locator(".inspector-body").getByRole("listbox", { name: "Changes" }).getByRole("option")).toHaveCount(1);
  expect(await bar.boundingBox()).toEqual(barAt);

  // A folder's list and a mode have the same three, in the same places.
  const icons = await listedIn(bar, "button");
  await page.getByRole("treeitem", { name: "Unsorted" }).click();
  await expect(page.getByRole("tab", { name: "Unsorted" })).toHaveAttribute("aria-selected", "true");
  expect(await listedIn(bar, "button")).toEqual(icons);
  await bar.getByRole("button", { name: "Info" }).click();
  await expect(inspector(page).getByRole("definition")).toHaveText(["Unsorted", "1 note", "just now by Ada Lovelace"]);

  // The Search page says what it lists; a page that says nothing has nothing to show.
  await page.getByRole("link", { name: "Search" }).click();
  await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
  expect(await listedIn(bar, "button")).toEqual(icons);
  await expect(inspector(page).getByRole("definition")).toHaveText(["Search", "1 note", "just now by Ada Lovelace"]);
  await page.getByRole("link", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  expect(await listedIn(bar, "button")).toEqual(icons);
  await expect(inspector(page).locator(".inspector-body")).toHaveText("Nothing to show for this view");
  await toggleInspector(page);
  await expect(inspector(page)).toHaveCount(0);
  expect(await listedIn(bar, "button")).toEqual(icons);
  expect(await bar.boundingBox()).toEqual(barAt);
});

test("with nothing open Focus and both edges are still there", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  // The app opens to the Dashboard, in a tab. With that closed nothing is open.
  await page.getByRole("button", { name: "Close Dashboard" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Focus" })).toBeVisible();
  await expect(edge(page, "Resize sidebar")).toBeVisible();
  await expect(edge(page, "Resize inspector")).toBeVisible();
});

for (const width of [900, 700, 480]) {
  test(`in a window ${width}px wide every control is inside it, and the sidebar and the inspector still open and close`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const note = await withNote(page, "# Draft with a long title that takes room\n\nWords.");
    await perform(page, { type: "note.setPrivate", id: note.id, private: true });
    await page.reload();
    await expect(page.locator(".note-bar")).toContainText("Private");
    await pinPanel(page, "Info");

    /** Every part named is wholly inside the window: none of it is past the right edge, or the left. */
    const inside = async (...parts: Locator[]) => {
      for (const part of parts) {
        await expect(part).toBeVisible();
        const box = (await part.boundingBox())!;
        expect(box.x, `${part} starts inside the window`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${part} ends inside the window`).toBeLessThanOrEqual(width);
        expect(box.width, `${part} has room`).toBeGreaterThan(0);
      }
    };
    /** Nothing in the note's bar is cut off: each thing in it lies inside the bar, and the bar inside the window. */
    const barIsWhole = () =>
      page.locator(".note-bar").evaluate((bar) => {
        const edge = bar.getBoundingClientRect();
        const cut = [...bar.querySelectorAll("button, .save-state, .note-meta > *")].filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width === 0 || box.left < edge.left - 0.5 || box.right > edge.right + 0.5 || box.top < edge.top - 0.5 || box.bottom > edge.bottom + 0.5 || (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1;
        });
        return { cut: cut.map((el) => el.textContent || el.getAttribute("aria-label")), right: edge.right, wide: innerWidth };
      });

    const focusButton = page.getByRole("button", { name: "Focus" });
    await inside(focusButton, sidebar(page), inspector(page), page.getByRole("tab", { name: /Draft/ }), page.locator(".save-state"), edge(page, "Resize sidebar"), edge(page, "Resize inspector"));
    for (const button of await page.locator(".note-bar").getByRole("button").all()) await inside(button);
    let bar = await barIsWhole();
    expect(bar.cut).toEqual([]);
    expect(bar.right).toBeLessThanOrEqual(bar.wide);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await toggleInspector(page);
    await expect(inspector(page)).toHaveCount(0);
    await inside(focusButton, sidebar(page), page.getByRole("navigation", { name: "Inspector bar" }), edge(page, "Resize sidebar"), edge(page, "Resize inspector"));
    bar = await barIsWhole();
    expect(bar.cut).toEqual([]);
    await toggleSidebar(page);
    await expect(sidebar(page)).toHaveCount(0);
    await inside(focusButton, page.getByRole("navigation", { name: "Sidebar bar" }), page.getByRole("navigation", { name: "Inspector bar" }), edge(page, "Resize sidebar"), edge(page, "Resize inspector"));
    bar = await barIsWhole();
    expect(bar.cut).toEqual([]);
    await toggleSidebar(page);
    await toggleInspector(page);
    await inside(sidebar(page), inspector(page), focusButton);

    await focusButton.click();
    await expect(sidebar(page)).toHaveCount(0);
    await expect(inspector(page)).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await inside(focusButton);
    // In focus the note's bar is out of sight, and its save state is on the quiet line at its foot, whole and inside the window.
    await expect(page.locator(".note-bar")).toBeHidden();
    await inside(page.locator(".note-live-save"));
    await expect(page.locator(".note-live-save")).toHaveText("Saved");
    await focusButton.click();
    await inside(sidebar(page), inspector(page), focusButton);
  });
}
