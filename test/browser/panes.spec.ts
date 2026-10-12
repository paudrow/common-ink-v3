import { expect, test, type Locator, type Page } from "@playwright/test";
import { folderRow, noteCard, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const tabBar = (page: Page, group = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(group);
const tabs = (page: Page, group = 0) => tabBar(page, group).getByRole("tab");
const tab = (page: Page, title: string, group = 0) => tabs(page, group).filter({ hasText: new RegExp(`^${title}$`) });
const group = (page: Page, n: number) => page.getByRole("region", { name: `Editor group ${n}` });
const body = (page: Page, n: number) => group(page, n).locator(".group-body");
/** Which tabs of the whole window are previews, by title. */
const previews = (page: Page) => page.getByRole("tab").evaluateAll((els) => els.filter((el) => getComputedStyle(el).fontStyle === "italic").map((el) => el.getAttribute("aria-label")));
const modes = (page: Page) => page.getByRole("navigation", { name: "Modes" });

async function withNotes(page: Page, ...titles: string[]) {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (const title of titles) await perform(page, { type: "note.create", text: `# ${title}\n\nAbout ${title}.` });
  await page.reload();
}

async function keep(page: Page, title: string) {
  await openAllNotes(page);
  await noteCard(page, title).getByRole("button", { name: `Edit ${title}` }).click();
}

const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

/** Takes something by the mouse and lets it go over a point of a group's body, a share of the way across and down it. */
async function dragOnto(page: Page, from: Locator, onto: Locator, across: number, down: number) {
  const box = (await onto.boundingBox())!;
  await from.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width * across, box.y + box.height * down, { steps: 3 });
  // The browser tells the page where a drag is a move late, so the pointer is moved once more where it already is.
  await page.mouse.move(box.x + box.width * across + 1, box.y + box.height * down);
  await page.mouse.move(box.x + box.width * across, box.y + box.height * down);
  await page.mouse.up();
}

/** What scrolls in a group, and how it sits in the group's body. */
const SCROLLERS = ".folder-list, .note-scroll, .page-pane";
const fit = (page: Page, n: number) =>
  body(page, n).evaluate((el, scrollers) => {
    const scroller = el.querySelector(scrollers);
    if (!scroller) throw new Error("nothing scrolls in this group");
    const [pane, inner, first] = [el.getBoundingClientRect(), scroller.getBoundingClientRect(), scroller.querySelector("h1, input, .cm-line")!.getBoundingClientRect()];
    return {
      // How far past the pane's foot what scrolls ends, and how far above its head it starts.
      below: Math.round(inner.bottom - pane.bottom),
      above: Math.max(0, Math.round(pane.top - inner.top)),
      // How much there is to scroll to.
      hidden: scroller.scrollHeight - scroller.clientHeight,
      firstLineInside: first.top >= pane.top && first.bottom <= pane.bottom,
    };
  }, SCROLLERS);
/** What is in the pane ends where the pane does, and is short enough that there is nowhere to scroll. */
const FITS = { below: 0, above: 0, hidden: 0, firstLineInside: true };

test("in a split down, a folder's list, a note and a page are each as tall as their pane and scroll only when longer than it", async ({ page }) => {
  // Tall enough that a list of two notes is shorter than half of it.
  await page.setViewportSize({ width: 1280, height: 1200 });
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await folderRow(page, "Unsorted").dblclick();
  await tab(page, "Alpha").click({ button: "right" });
  await menuItem(page, "Split down").click();
  await expect(tabs(page, 0)).toHaveText(["Unsorted"]);
  await expect(tabs(page, 1)).toHaveText(["Alpha"]);

  const window = page.viewportSize()!.height;
  for (const n of [1, 2]) {
    const height = (await body(page, n).boundingBox())!.height;
    expect(height).toBeLessThan(window / 2);
    expect(await fit(page, n)).toEqual(FITS);
  }

  // A page in the top half, and a short note below.
  await tab(page, "Unsorted").click();
  await modes(page).getByRole("link", { name: "Dashboard" }).click();
  await expect(group(page, 1).getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  expect(await fit(page, 1)).toEqual(FITS);

  // The edge dragged down: both still fit, the top one taller than it was.
  const before = (await body(page, 1).boundingBox())!.height;
  const edge = page.getByRole("separator", { name: "Resize split up and down" });
  const at = (await edge.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2, at.y + 120, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await body(page, 1).boundingBox())!.height).toBeGreaterThan(before + 60);
  for (const n of [1, 2]) expect(await fit(page, n)).toEqual(FITS);

  // A window too short for the list: each pane shrinks with it, the list scrolls inside its own, and nothing hangs out of a pane.
  const ENDS_WITH_ITS_PANE = { below: 0, above: 0 };
  await page.setViewportSize({ width: 1280, height: 520 });
  await tab(page, "Unsorted").click();
  await expect.poll(() => fit(page, 1)).toMatchObject(ENDS_WITH_ITS_PANE);
  expect((await fit(page, 1)).hidden).toBeGreaterThan(0);
  await expect.poll(() => fit(page, 2)).toMatchObject(ENDS_WITH_ITS_PANE);

  // A split inside the upper half, with the list in it: all three end where their panes do.
  await keep(page, "Beta");
  await tab(page, "Beta").click({ button: "right" });
  await menuItem(page, "Split right").click();
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(3);
  await tab(page, "Unsorted").click();
  for (const n of [1, 2, 3]) await expect.poll(() => fit(page, n)).toMatchObject(ENDS_WITH_ITS_PANE);

  // A long note scrolls inside its own pane.
  await group(page, 2).locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  for (let i = 0; i < 30; i++) await page.keyboard.press("Enter");
  await expect.poll(async () => (await fit(page, 2)).hidden).toBeGreaterThan(0);
  expect(await fit(page, 2)).toMatchObject(ENDS_WITH_ITS_PANE);
});

const sidebarButton = (page: Page) => page.getByRole("group", { name: "Window" }).getByRole("button", { name: "Sidebar" });

test("a mode or a folder dragged from the sidebar lands in a pane as a tab does: the middle adds a kept tab there, an edge splits", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await perform(page, { type: "folder.create", name: "Plans" });
  await page.reload();
  await keep(page, "Alpha");
  await tab(page, "All notes").click({ button: "right" });
  await menuItem(page, "Close").click();
  await expect(tabs(page, 0)).toHaveText(["Alpha"]);

  // A click is what it was: a preview in the pane in front.
  await modes(page).getByRole("link", { name: "Search" }).click();
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Search"]);
  expect(await previews(page)).toEqual(["Search"]);

  // The middle of the pane: a kept tab there, in front, at its address. The preview is as it was.
  await dragOnto(page, modes(page).getByRole("link", { name: "Dashboard" }), body(page, 1), 0.5, 0.5);
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Search", "Dashboard"]);
  await expect(tab(page, "Dashboard")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(await previews(page)).toEqual(["Search"]);

  // An edge: a pane of its own on that side.
  await dragOnto(page, modes(page).getByRole("link", { name: "Todos" }), body(page, 1), 0.9, 0.5);
  await expect(tabs(page, 1)).toHaveText(["Todos"]);
  await expect(group(page, 2).getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();
  await expect(group(page, 2)).toHaveAttribute("data-focused", "true");

  // A folder, and the list of every note, the same way: under the second pane, and into the first.
  await dragOnto(page, folderRow(page, "Plans"), body(page, 2), 0.5, 0.9);
  await expect(tabs(page, 2)).toHaveText(["Plans"]);
  const [over, under] = [(await group(page, 2).boundingBox())!, (await group(page, 3).boundingBox())!];
  expect(under.y).toBeGreaterThanOrEqual(over.y + over.height);
  expect(Math.round(under.x)).toBe(Math.round(over.x));
  await dragOnto(page, folderRow(page, "All notes"), body(page, 1), 0.5, 0.5);
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Search", "Dashboard", "All notes"]);
  await expect(group(page, 1).getByRole("navigation", { name: "Notes" })).toBeVisible();

  // One under More. What is open in another pane moves to where it is dropped, since a page has one tab.
  await modes(page).getByRole("button", { name: "More" }).click();
  await dragOnto(page, modes(page).getByRole("link", { name: "Contacts" }), body(page, 3), 0.5, 0.5);
  await expect(tabs(page, 2)).toHaveText(["Plans", "Contacts"]);
  await dragOnto(page, modes(page).getByRole("link", { name: "Todos" }), body(page, 1), 0.5, 0.5);
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Search", "Dashboard", "All notes", "Todos"]);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "Todos" })).toHaveCount(1);
  // Dropped where it already is, it is turned to.
  await tab(page, "Alpha").click();
  await dragOnto(page, modes(page).getByRole("link", { name: "Todos" }), body(page, 1), 0.5, 0.5);
  await expect(tab(page, "Todos")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Todos" })).toHaveCount(1);

  // Everything dragged in is kept: the one preview is still the one that was clicked.
  expect(await previews(page)).toEqual(["Search"]);

  // The sidebar closed to its bar: its icons drag the same way.
  await sidebarButton(page).click();
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await dragOnto(page, bar.getByRole("link", { name: "Calendar" }), body(page, 2), 0.1, 0.5);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(3);
  await expect(page.getByRole("region", { name: /Editor group/ }).filter({ has: page.getByRole("heading", { name: "Calendar", level: 1 }) })).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/calendar$/);

  // A folder's row dropped on the tree goes nowhere, and a note still moves to a folder dropped on its row.
  await sidebarButton(page).click();
  const before = await page.getByRole("tab").count();
  await folderRow(page, "Plans").dragTo(folderRow(page, "Unsorted"));
  expect(await page.getByRole("tab").count()).toBe(before);
  await tab(page, "All notes").click();
  await noteCard(page, "Beta").dragTo(folderRow(page, "Plans"));
  await expect(folderRow(page, "Plans")).toContainText("1");
});

test("a mode's and a folder's menu open it in a split to the right or below, kept", async ({ page }) => {
  await withNotes(page, "Alpha");
  await keep(page, "Alpha");
  await tab(page, "All notes").click({ button: "right" });
  await menuItem(page, "Close").click();

  await modes(page).getByRole("link", { name: "Calendar" }).click({ button: "right" });
  await page.getByRole("menu", { name: "Calendar actions" }).getByRole("menuitem", { name: "Open in a split right" }).click();
  await expect(tabs(page, 0)).toHaveText(["Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Calendar"]);
  await expect(page).toHaveURL(/\/calendar$/);
  const [left, right] = [(await group(page, 1).boundingBox())!, (await group(page, 2).boundingBox())!];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);

  await folderRow(page, "Unsorted").hover();
  await page.getByRole("button", { name: "Actions for Unsorted" }).click();
  await page.getByRole("menu", { name: "Unsorted actions" }).getByRole("menuitem", { name: "Open in a split down" }).click();
  await expect(tabs(page, 2)).toHaveText(["Unsorted"]);
  const [over, under] = [(await group(page, 2).boundingBox())!, (await group(page, 3).boundingBox())!];
  expect(under.y).toBeGreaterThanOrEqual(over.y + over.height);

  await folderRow(page, "All notes").click({ button: "right" });
  await page.getByRole("menu", { name: "All notes actions" }).getByRole("menuitem", { name: "Open in a split right" }).click();
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(4);
  expect(await previews(page)).toEqual([]);

  // With the keyboard: the menu key on a mode's link, and Enter on the first thing in the menu.
  await modes(page).getByRole("link", { name: "Search" }).focus();
  await page.keyboard.press("ContextMenu");
  await expect(page.getByRole("menu", { name: "Search actions" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(5);
  await expect(page).toHaveURL(/\/search$/);
});

test("the window has one italic tab, in whichever pane is in front, and it is kept only when the member says so", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  for (const name of ["Plans", "Ideas"]) await perform(page, { type: "folder.create", name });
  await page.reload();
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tab(page, "All notes").click({ button: "right" });
  await menuItem(page, "Close").click();
  await tab(page, "Beta").click({ button: "right" });
  await menuItem(page, "Split right").click();
  await expect(tabs(page, 0)).toHaveText(["Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);

  // A folder clicked with each pane in front in turn: one italic tab, in the pane in front.
  for (const [pane, folder, tabsThere, tabsOther] of [[1, "Plans", ["Alpha", "Plans"], ["Beta"]], [2, "Ideas", ["Beta", "Ideas"], ["Alpha"]], [1, "Unsorted", ["Alpha", "Unsorted"], ["Beta"]], [2, "Plans", ["Beta", "Plans"], ["Alpha"]]] as const) {
    await tab(page, pane === 1 ? "Alpha" : "Beta", pane - 1).click();
    await folderRow(page, folder).click();
    await expect(tabs(page, pane - 1)).toHaveText([...tabsThere]);
    await expect(tabs(page, 2 - pane)).toHaveText([...tabsOther]);
    expect(await previews(page)).toEqual([folder]);
  }

  // A mode's link and a note's title are the same: each takes the italic tab's place.
  await modes(page).getByRole("link", { name: "Todos" }).click();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Todos"]);
  expect(await previews(page)).toEqual(["Todos"]);

  // Turning to another tab, another pane and back, and reloading, leave it italic.
  await tab(page, "Beta", 1).click();
  await tab(page, "Todos", 1).click();
  await tab(page, "Alpha").click();
  await group(page, 2).getByRole("heading", { name: "Todos", level: 1 }).click();
  await expect(group(page, 2)).toHaveAttribute("data-focused", "true");
  expect(await previews(page)).toEqual(["Todos"]);
  await page.reload();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Todos"]);
  expect(await previews(page)).toEqual(["Todos"]);

  // A note opened from an italic folder tab takes the list's place in that tab, and Back returns to the list.
  await folderRow(page, "Unsorted").click();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Unsorted"]);
  await group(page, 2).getByRole("navigation", { name: "Notes" }).getByRole("link", { name: "Alpha" }).click();
  // Alpha has a kept tab in the other pane, which the click turns to: nothing opened, so the list is where it was, and italic.
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await expect(tabs(page, 1)).toHaveText(["Beta", "Unsorted"]);
  expect(await previews(page)).toEqual(["Unsorted"]);
  // One with no tab yet takes the list's place.
  await perform(page, { type: "note.create", text: "# Gamma\n\nAbout Gamma." });
  await page.reload();
  await tab(page, "Beta", 1).click();
  await folderRow(page, "Unsorted").click();
  await group(page, 2).getByRole("navigation", { name: "Notes" }).getByRole("link", { name: "Gamma" }).click();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  expect(await previews(page)).toEqual(["Gamma"]);
  await expect(group(page, 2).locator(".cm-line").first()).toHaveText("# Gamma");
  await page.goBack();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Unsorted"]);
  expect(await previews(page)).toEqual(["Unsorted"]);
  await page.goForward();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);

  // Split off from its menu it is the same italic tab in a pane of its own; Keep open, a double click or typing keeps it.
  await tab(page, "Gamma", 1).click({ button: "right" });
  await menuItem(page, "Split down").click();
  await expect(tabs(page, 2)).toHaveText(["Gamma"]);
  expect(await previews(page)).toEqual(["Gamma"]);
  await tab(page, "Gamma", 2).click({ button: "right" });
  await menuItem(page, "Keep open").click();
  expect(await previews(page)).toEqual([]);
  await folderRow(page, "Ideas").click();
  await expect(tabs(page, 2)).toHaveText(["Gamma", "Ideas"]);
  expect(await previews(page)).toEqual(["Ideas"]);
  await tab(page, "Ideas", 2).dblclick();
  expect(await previews(page)).toEqual([]);

  // Dragged to another pane, an italic tab is kept there.
  await folderRow(page, "Plans").click();
  expect(await previews(page)).toEqual(["Plans"]);
  await dragOnto(page, tab(page, "Plans", 2), body(page, 1), 0.5, 0.5);
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Plans"]);
  expect(await previews(page)).toEqual([]);
});

test("a layout kept with an italic tab in each pane opens with one, in the pane in front, and no tab closed", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tab(page, "Beta").click({ button: "right" });
  await menuItem(page, "Split right").click();
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("ink.editor."))!;
    const layout = JSON.parse(localStorage.getItem(key)!) as { groups: { tabs: { preview: boolean }[] }[] };
    for (const group of layout.groups) for (const tab of group.tabs) tab.preview = true;
    localStorage.setItem(key, JSON.stringify(layout));
  });
  await page.reload();
  await expect(tabs(page, 0)).toHaveText(["All notes", "Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  expect(await previews(page)).toEqual(["Beta"]);
});

test("the inspector shows the tab last picked, on whatever has it, and one it does have on what doesn't, without forgetting the pick", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const shown = () => inspector.getByRole("tab", { selected: true });

  // Nothing picked yet: the first tab the note has.
  await expect(shown()).toHaveText("History");
  await inspector.getByRole("tab", { name: "Backlinks" }).click();
  await expect(shown()).toHaveText("Backlinks");

  // A folder has no Backlinks: it shows what it has, and the note after it shows Backlinks again, as another note does.
  await tab(page, "All notes").click();
  await expect(shown()).toHaveText("Info");
  await expect(inspector.getByRole("tab")).toHaveText(["Info"]);
  await tab(page, "Beta").click();
  await expect(shown()).toHaveText("Backlinks");
  await tab(page, "Alpha").click();
  await expect(shown()).toHaveText("Backlinks");

  // A page has no tabs at all, and the pick is still there after it, and after a reload.
  await modes(page).getByRole("link", { name: "Dashboard" }).click();
  await expect(inspector.getByText("Nothing to show for this view")).toBeVisible();
  await tab(page, "Alpha").click();
  await expect(shown()).toHaveText("Backlinks");
  await page.reload();
  await expect(shown()).toHaveText("Backlinks");

  // Info picked on a note is Info on a folder, which has its own, and on the next note.
  await inspector.getByRole("tab", { name: "Info" }).click();
  await openAllNotes(page);
  await expect(inspector.getByText("2 notes")).toBeVisible();
  await tab(page, "Beta").click();
  await expect(shown()).toHaveText("Info");
});
