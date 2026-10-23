import { expect, type Locator, type Page } from "@playwright/test";
import { folderRow, noteCard, openAllNotes, openKept, ownPlugin, panelIcons, perform, pinPanel, runCommand, shownPanel, showPanel, signInAsNewPerson, test, toggleSidebar } from "./helpers.ts";

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
  await openKept(page, title);
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
/** Null until the pane has drawn what it holds: a note's first line arrives after its tab does, so this is asked again until it is there. */
const fit = (page: Page, n: number) =>
  body(page, n).evaluate((el, scrollers) => {
    const scroller = el.querySelector(scrollers);
    const top = scroller?.querySelector("h1, input, .cm-line");
    if (!scroller || !top) return null;
    const [pane, inner, first] = [el.getBoundingClientRect(), scroller.getBoundingClientRect(), top.getBoundingClientRect()];
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
  await page.setViewportSize({ width: 1280, height: 1400 });
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await folderRow(page, "Unsorted").dblclick();
  await tab(page, "Alpha").click({ button: "right" });
  await menuItem(page, "Split down").click();
  // A note split off is copied, so the copy left above is closed: the list is in the top half and the note below.
  await tabBar(page, 0).getByTitle("Close Alpha", { exact: true }).click();
  await expect(tabs(page, 0)).toHaveText(["Unsorted"]);
  await expect(tabs(page, 1)).toHaveText(["Alpha"]);

  const window = page.viewportSize()!.height;
  for (const n of [1, 2]) {
    await expect.poll(async () => (await body(page, n).boundingBox())!.height).toBeLessThan(window / 2);
    await expect.poll(() => fit(page, n)).toEqual(FITS);
  }

  // A page in the top half, and a short note below.
  await tab(page, "Unsorted").click();
  // Todos with nothing to do is the short page: the Dashboard is longer than half a window, and scrolls in its pane as the list below does.
  await modes(page).getByRole("link", { name: "Todos" }).click();
  await expect(group(page, 1).getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();
  await expect.poll(() => fit(page, 1)).toEqual(FITS);
  await modes(page).getByRole("link", { name: "Dashboard" }).click();
  await expect(group(page, 1).getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await expect.poll(() => fit(page, 1)).toMatchObject({ below: 0, above: 0, firstLineInside: true });
  await modes(page).getByRole("link", { name: "Todos" }).click();
  await expect(group(page, 1).getByRole("heading", { name: "Todos", level: 1 })).toBeVisible();

  // The edge dragged down: both still fit, the top one taller than it was.
  const before = (await body(page, 1).boundingBox())!.height;
  const edge = page.getByRole("separator", { name: "Resize split up and down" });
  const at = (await edge.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2, at.y + 120, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await body(page, 1).boundingBox())!.height).toBeGreaterThan(before + 60);
  for (const n of [1, 2]) await expect.poll(() => fit(page, n)).toEqual(FITS);

  // A window too short for the list: each pane shrinks with it, the list scrolls inside its own, and nothing hangs out of a pane.
  const ENDS_WITH_ITS_PANE = { below: 0, above: 0 };
  await page.setViewportSize({ width: 1280, height: 520 });
  await tab(page, "Unsorted").click();
  await expect.poll(() => fit(page, 1)).toMatchObject(ENDS_WITH_ITS_PANE);
  await expect.poll(async () => (await fit(page, 1))?.hidden).toBeGreaterThan(0);
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
  await expect.poll(async () => (await fit(page, 2))?.hidden).toBeGreaterThan(0);
  await expect.poll(() => fit(page, 2)).toMatchObject(ENDS_WITH_ITS_PANE);
});

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
  await expect.poll(() => previews(page)).toEqual(["Search"]);

  // The middle of the pane: a kept tab there, in front, at its address. The preview is as it was.
  await dragOnto(page, modes(page).getByRole("link", { name: "Dashboard" }), body(page, 1), 0.5, 0.5);
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Search", "Dashboard"]);
  await expect(tab(page, "Dashboard")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect.poll(() => previews(page)).toEqual(["Search"]);

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
  await expect.poll(() => previews(page)).toEqual(["Search"]);

  // The sidebar closed to its bar: its icons drag the same way.
  await toggleSidebar(page);
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await dragOnto(page, bar.getByRole("link", { name: "Calendar" }), body(page, 2), 0.1, 0.5);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(3);
  await expect(page.getByRole("region", { name: /Editor group/ }).filter({ has: page.getByRole("heading", { name: "Calendar", level: 1 }) })).toHaveAttribute("data-focused", "true");
  await expect(page).toHaveURL(/\/calendar$/);

  // A folder's row dropped on another folder's row goes inside it and opens nothing, and a note still moves to a folder dropped on its row.
  await toggleSidebar(page);
  const before = await page.getByRole("tab").count();
  await folderRow(page, "Plans").dragTo(folderRow(page, "Unsorted"));
  await expect(folderRow(page, "Plans")).toHaveAttribute("aria-level", "2");
  expect(await page.getByRole("tab").count()).toBe(before);
  await tab(page, "All notes").click();
  await noteCard(page, "Beta").locator(".card-head").dragTo(folderRow(page, "Plans"));
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
  await expect.poll(() => previews(page)).toEqual([]);

  // With the keyboard: the menu key on a mode's link, and Enter on the first thing in the menu.
  await modes(page).getByRole("link", { name: "Search" }).focus();
  await page.keyboard.press("ContextMenu");
  await expect(page.getByRole("menu", { name: "Search actions" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(5);
  await expect(page).toHaveURL(/\/search$/);
});

test("the window has one italic tab, which is where the next thing opens whichever pane is in front, and it is kept only when the member says so", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  for (const name of ["Plans", "Ideas"]) await perform(page, { type: "folder.create", name });
  await page.reload();
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tab(page, "All notes").click({ button: "right" });
  await menuItem(page, "Close").click();
  await tab(page, "Beta").click({ button: "right" });
  await menuItem(page, "Split right").click();
  // A note split off is copied, so Beta is in both panes.
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Beta"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);

  // A folder clicked with each pane in front in turn: the first opens in the pane in front, and the italic tab is then where the next opens, whichever pane is in front.
  for (const [pane, folder] of [[2, "Plans"], [1, "Ideas"], [2, "Unsorted"], [1, "Plans"]] as const) {
    await tab(page, pane === 1 ? "Alpha" : "Beta", pane - 1).click();
    await folderRow(page, folder).click();
    await expect(tabs(page, 1)).toHaveText(["Beta", folder]);
    await expect(tabs(page, 0)).toHaveText(["Alpha", "Beta"]);
    await expect(group(page, 2)).toHaveAttribute("data-focused", "true");
    await expect.poll(() => previews(page)).toEqual([folder]);
  }

  // A mode's link and a note's title are the same: each takes the italic tab's place.
  await modes(page).getByRole("link", { name: "Todos" }).click();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Todos"]);
  await expect.poll(() => previews(page)).toEqual(["Todos"]);

  // Turning to another tab, another pane and back, and reloading, leave it italic.
  await tab(page, "Beta", 1).click();
  await tab(page, "Todos", 1).click();
  await tab(page, "Alpha").click();
  await group(page, 2).getByRole("heading", { name: "Todos", level: 1 }).click();
  await expect(group(page, 2)).toHaveAttribute("data-focused", "true");
  await expect.poll(() => previews(page)).toEqual(["Todos"]);
  await page.reload();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Todos"]);
  await expect.poll(() => previews(page)).toEqual(["Todos"]);

  // A note opened from an italic folder tab takes the list's place in that tab, and Back returns to the list.
  await folderRow(page, "Unsorted").click();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Unsorted"]);
  await group(page, 2).getByRole("navigation", { name: "Notes" }).getByRole("link", { name: "Edit Alpha" }).click();
  // Alpha has a kept tab in the other pane, which the click turns to: nothing opened, so the list is where it was, and italic.
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  await expect(tabs(page, 1)).toHaveText(["Beta", "Unsorted"]);
  await expect.poll(() => previews(page)).toEqual(["Unsorted"]);
  // One with no tab yet takes the list's place.
  await perform(page, { type: "note.create", text: "# Gamma\n\nAbout Gamma." });
  await page.reload();
  await tab(page, "Beta", 1).click();
  await folderRow(page, "Unsorted").click();
  await group(page, 2).getByRole("navigation", { name: "Notes" }).getByRole("link", { name: "Edit Gamma" }).click();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  await expect.poll(() => previews(page)).toEqual(["Gamma"]);
  await expect(group(page, 2).locator(".cm-line").first()).toHaveText("# Gamma");
  await page.goBack();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Unsorted"]);
  await expect.poll(() => previews(page)).toEqual(["Unsorted"]);
  await page.goForward();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);

  // Split off from its menu it is copied into a pane of its own, kept there, and the italic tab stays where it was; Keep open, a double click or typing keeps that one.
  await tab(page, "Gamma", 1).click({ button: "right" });
  await menuItem(page, "Split down").click();
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  await expect(tabs(page, 2)).toHaveText(["Gamma"]);
  await expect.poll(() => previews(page)).toEqual(["Gamma"]);
  await tab(page, "Gamma", 1).click({ button: "right" });
  await menuItem(page, "Keep open").click();
  await expect.poll(() => previews(page)).toEqual([]);
  await folderRow(page, "Ideas").click();
  await expect(tabs(page, 2)).toHaveText(["Gamma", "Ideas"]);
  await expect.poll(() => previews(page)).toEqual(["Ideas"]);
  await tab(page, "Ideas", 2).dblclick();
  await expect.poll(() => previews(page)).toEqual([]);

  // Dragged to another pane, an italic tab is kept there.
  await folderRow(page, "Plans").click();
  await expect.poll(() => previews(page)).toEqual(["Plans"]);
  await dragOnto(page, tab(page, "Plans", 2), body(page, 1), 0.5, 0.5);
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Beta", "Plans"]);
  await expect.poll(() => previews(page)).toEqual([]);
});

test("a layout kept with an italic tab in each pane opens with one, in the pane in front, and no tab closed", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tab(page, "Beta").click({ button: "right" });
  await menuItem(page, "Split right").click();
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("ink.plugin.tabs.") && k.endsWith(".layout"))!;
    const layout = JSON.parse(localStorage.getItem(key)!) as { groups: { tabs: { preview: boolean }[] }[] };
    for (const group of layout.groups) for (const tab of group.tabs) tab.preview = true;
    localStorage.setItem(key, JSON.stringify(layout));
  });
  await page.reload();
  await expect(tabs(page, 0)).toHaveText(["All notes", "Alpha", "Beta"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  await expect.poll(() => previews(page)).toEqual(["Beta"]);
});

test("the inspector shows the panel last picked on whatever is in front, and says there is nothing to show where that panel has nothing", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const shown = () => shownPanel(page);

  await pinPanel(page, "Info");
  await showPanel(page, "Backlinks");
  await expect(shown()).toHaveText("Backlinks");

  // A folder has no backlinks: the panel is still Backlinks, with nothing to show, and the note after it shows Backlinks again, as another note does.
  await tab(page, "All notes").click();
  await expect(shown()).toHaveText("Backlinks");
  await expect(inspector.locator(".inspector-body")).toHaveText("Nothing to show for this view");
  await expect.poll(panelIcons(page)).toEqual(["History", "Backlinks", "Info", "Sample calendar"]);
  await tab(page, "Beta").click();
  await expect(shown()).toHaveText("Backlinks");
  await tab(page, "Alpha").click();
  await expect(shown()).toHaveText("Backlinks");

  // A page that says nothing of what it shows has nothing for any panel, and the pick is still there after it, and after a reload.
  await modes(page).getByRole("link", { name: "Dashboard" }).click();
  await expect(inspector.getByText("Nothing to show for this view")).toBeVisible();
  await tab(page, "Alpha").click();
  await expect(shown()).toHaveText("Backlinks");
  await page.reload();
  await expect(shown()).toHaveText("Backlinks");

  // Info picked on a note is Info on a folder, which has its own, and on the next note.
  await showPanel(page, "Info");
  await openAllNotes(page);
  await expect(inspector.getByText("2 notes")).toBeVisible();
  await tab(page, "Beta").click();
  await expect(shown()).toHaveText("Info");
});

test("a page a plugin adds to the sidebar drags into a pane and opens in a split from its menu, with the plugin doing nothing for it", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Fixture",
        activate(host: { views: { register(slot: string, view: unknown): void } }) {
          host.views.register("page", { id: "fixture-page", path: "/fixture", label: "Fixture page", icon: "info", nav: "primary", component: ({ app }: { app: { path: string } }) => `Fixture at ${app.path}` });
          host.views.register("page", { id: "fixture-more", path: "/fixture-more", label: "Fixture more", icon: "info", nav: "more", component: () => "More of the fixture" });
        },
      },
    ];
  });
  await withNotes(page, "Alpha");
  await keep(page, "Alpha");
  await tab(page, "All notes").click({ button: "right" });
  await menuItem(page, "Close").click();
  await expect(tabs(page, 0)).toHaveText(["Alpha"]);

  // Dragged to an edge it has a pane of its own on that side, and to the middle it is a kept tab there.
  await dragOnto(page, modes(page).getByRole("link", { name: "Fixture page" }), body(page, 1), 0.9, 0.5);
  await expect(tabs(page, 1)).toHaveText(["Fixture page"]);
  await expect(group(page, 2).locator(".page-pane")).toHaveText("Fixture at /fixture");
  await expect(page).toHaveURL(/\/fixture$/);
  await modes(page).getByRole("button", { name: "More" }).click();
  await dragOnto(page, modes(page).getByRole("link", { name: "Fixture more" }), body(page, 1), 0.5, 0.5);
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Fixture more"]);
  expect(await previews(page)).toEqual([]);

  // Its menu opens it in a split, beside or under the pane in front.
  await tab(page, "Fixture page", 1).click({ button: "right" });
  await menuItem(page, "Close").click();
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(1);
  await modes(page).getByRole("link", { name: "Fixture page" }).click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Fixture page actions" }).getByRole("menuitem")).toHaveText(["Open in a split right", "Open in a split down"]);
  await menuItem(page, "Open in a split down").click();
  await expect(tabs(page, 1)).toHaveText(["Fixture page"]);
  await expect(group(page, 2).locator(".page-pane")).toHaveText("Fixture at /fixture");
  await expect.poll(async () => (await group(page, 2).boundingBox())!.y).toBeGreaterThan((await group(page, 1).boundingBox())!.y);

  // From the closed sidebar's bar it is the same link.
  await toggleSidebar(page);
  const bar = page.getByRole("navigation", { name: "Sidebar bar" });
  await bar.getByRole("link", { name: "Fixture more" }).click({ button: "right" });
  await menuItem(page, "Open in a split right").click();
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(3);
  await expect(page.getByRole("region", { name: /^Editor group/ }).filter({ hasText: "More of the fixture" })).toHaveAttribute("data-focused", "true");

  // With no splits to open in, the menu isn't offered.
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("Disable plugin: Tabs and splits");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await bar.getByRole("link", { name: "Fixture page" }).click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Back retraces every open in a split, whatever was clicked between them", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  await page.reload();
  await keep(page, "Alpha");
  await folderRow(page, "Unsorted").dblclick();
  await tab(page, "Alpha").click({ button: "right" });
  await menuItem(page, "Split down").click();
  // A note split off is copied, so the copy left above is closed, and the upper pane shows the folder.
  await tabBar(page, 0).getByTitle("Close Alpha", { exact: true }).click();
  await expect(tabs(page, 0)).toHaveText(["Unsorted"]);
  await expect(tabs(page, 1)).toHaveText(["Alpha"]);
  const address = () => new URL(page.url()).pathname;

  // A folder opened in the lower pane, a press in the upper one, another folder opened there, then a tab clicked.
  await group(page, 2).locator(".cm-line").first().click();
  await folderRow(page, "Projects").dblclick();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(tabs(page, 1)).toHaveText(["Alpha", "Projects"]);
  await body(page, 1).dispatchEvent("pointerdown");
  await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
  // The address follows the pane in front a moment after it is in front.
  await expect(page).not.toHaveURL(new RegExp(`/folder/${projects.id}$`));
  const upper = address();
  await folderRow(page, "All notes").dblclick();
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(tabs(page, 0)).toHaveText(["Unsorted", "All notes"]);
  await tab(page, "Unsorted").click();
  await expect(page).toHaveURL(new RegExp(`${upper}$`));

  await page.goBack();
  await expect(page).toHaveURL(/\/folder\/all$/);
  await expect(tab(page, "All notes")).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${upper}$`));
  await expect(tab(page, "Unsorted")).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(group(page, 2)).toHaveAttribute("data-focused", "true");
  await expect(tab(page, "Projects", 1)).toHaveAttribute("aria-selected", "true");
});

const run = runCommand;

for (const vim of [false, true]) {
  test(`a split from the palette or from a tab's menu leaves the cursor in the new pane's tab in front${vim ? ", a note in vim's normal mode" : ""}`, async ({ page }) => {
    await withNotes(page, "Alpha", "Beta");
    if (vim) {
      await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
      await page.reload();
    }
    await keep(page, "Alpha");
    await keep(page, "Beta");
    await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta"]);
    const text = (n: number) => group(page, n).getByRole("textbox", { name: "Note text" });
    /** What is typed lands in the note that has the cursor, on a line after its last. With vim on that takes `o` first, which in insert mode would be typed too. */
    const typesInto = async (n: number, word: string) => {
      await expect(text(n)).toBeFocused();
      if (vim) {
        await expect(group(page, n).locator(".cm-vim-panel")).toHaveText("--NORMAL--");
        await page.keyboard.press("Shift+G");
        await page.keyboard.press("o");
      } else {
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.press("Enter");
      }
      await page.keyboard.type(word);
      await expect(text(n)).toContainText(word);
      if (vim) await page.keyboard.press("Escape");
    };

    for (const side of ["right", "down"]) {
      await run(page, `Split editor ${side}`);
      await expect(tabs(page, 1)).toHaveText(["Beta"]);
      await typesInto(2, `to the ${side} `);
      await run(page, "Move tab to previous group");
      await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta"]);
      await typesInto(1, `back from the ${side} `);
    }

    await tab(page, "Beta").click({ button: "right" });
    await menuItem(page, "Split down").click();
    await expect(tabs(page, 1)).toHaveText(["Beta"]);
    await typesInto(2, "by the menu ");

    // A folder's list or a page has no text to put the cursor in: its tab has it.
    await tab(page, "All notes").click();
    await run(page, "Split editor right");
    await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(3);
    await expect(page.getByRole("tab", { name: "All notes" })).toBeFocused();
    await expect(page.locator(".group[data-focused]").getByRole("tab")).toHaveText(["All notes"]);
  });
}

test("a note that loads after a tab's menu has opened leaves the keyboard with the menu", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  let arrived = () => {};
  const held = new Promise<void>((done) => (arrived = done));
  await page.route("**/api/**", async (route) => {
    if (route.request().postData()?.includes('"note.read"')) await held;
    await route.fallback();
  });
  await keep(page, "Beta");
  await run(page, "Show tab menu");
  const close = page.getByRole("menu", { name: "Beta tab" }).getByRole("menuitem", { name: "Close", exact: true });
  await expect(close).toBeFocused();
  arrived();
  await expect(group(page, 1).getByRole("textbox", { name: "Note text" })).toContainText("About Beta.");
  await expect(close).toBeFocused();
});

test("a tab's menu opens from the keyboard, and a tab moves to the next pane and back by a command", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tabBar(page).getByTitle("Close All notes", { exact: true }).click();
  await expect(tabs(page)).toHaveText(["Alpha", "Beta"]);

  // The menu of the tab in front, with its first item ready for Enter.
  await run(page, "Show tab menu");
  const menu = page.getByRole("menu", { name: "Beta tab" });
  await expect(menu.getByRole("menuitem", { name: "Close", exact: true })).toBeFocused();
  const [at, under] = [(await menu.boundingBox())!, (await tab(page, "Beta").boundingBox())!];
  expect(Math.abs(at.x - under.x)).toBeLessThan(2);
  expect(Math.abs(at.y - (under.y + under.height))).toBeLessThan(2);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await run(page, "Show tab menu");
  await menuItem(page, "Split right").focus();
  await page.keyboard.press("Enter");
  // A note split off is copied, so Beta is in both panes, and moved back it is one tab again.
  await expect(tabs(page, 0)).toHaveText(["Alpha", "Beta"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);

  // With one pane there is nowhere to move to; with two, next and previous are the other one.
  await run(page, "Move tab to next group");
  await expect(tabs(page)).toHaveText(["Alpha", "Beta"]);
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(1);
  await run(page, "Move tab to next group");
  await expect(tabs(page)).toHaveText(["Alpha", "Beta"]);

  await run(page, "Split editor right");
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  await tab(page, "Alpha").click();
  await run(page, "Move tab to previous group");
  await expect(tabs(page, 0)).toHaveText(["Beta"]);
  await expect(tabs(page, 1)).toHaveText(["Beta", "Alpha"]);
  await expect(tab(page, "Alpha", 1)).toHaveAttribute("aria-selected", "true");
});

/** Where every pane and both sidebars are, to the pixel. */
const placed = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("section.group, aside.sidebar, aside.inspector")].map((el) => {
      const box = el.getBoundingClientRect();
      return `${el.getAttribute("aria-label")} ${[box.x, box.y, box.width, box.height].map(Math.round).join(" ")}`;
    }),
  );

for (const [name, splits, panes] of [
  ["right", ["Split right"], 2],
  ["down", ["Split down"], 2],
  ["nested", ["Split right", "Split down"], 3],
] as const) {
  test(`in a split ${name}, a page from the sidebar, the palette or the address opens where the italic tab is, with every pane and both sidebars where they were`, async ({ page }) => {
    await withNotes(page, "Alpha", "Beta", "Gamma");
    await pinPanel(page, "Info");
    for (const title of ["Alpha", "Beta", "Gamma"]) await keep(page, title);
    // The italic tab, All notes, is split off last, so it is alone in the last pane.
    if (splits.length > 1) {
      await tab(page, "Gamma").click({ button: "right" });
      await menuItem(page, splits[0]).click();
    }
    await tab(page, "All notes").click({ button: "right" });
    await menuItem(page, splits.at(-1)!).click();
    await expect(page.getByRole("region", { name: /^Editor group/ })).toHaveCount(panes);
    const there = (await Promise.all(Array.from({ length: panes }, (_, i) => tabs(page, i).allInnerTexts()))).findIndex((titles) => titles.join() === "All notes");
    expect(there).toBeGreaterThan(0);
    await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
    await modes(page).getByRole("button", { name: "More" }).click();
    await page.evaluate(() => document.fonts.ready);

    const front = async () => {
      await tab(page, "Alpha").click();
      await expect(group(page, 1)).toHaveAttribute("data-focused", "true");
    };
    await front();
    const before = await placed(page);
    expect(before).toHaveLength(panes + 2);
    const others = await Promise.all(Array.from({ length: panes }, (_, i) => tabs(page, i).allInnerTexts()));

    const pages = await modes(page).getByRole("link").allInnerTexts();
    expect(pages).toEqual(["Dashboard", "Search", "Today", "Todos", "Calendar", "Contacts", "Email", "Uploads", "History", "Trash", "Dice", "Plugins"]);
    const opensThere = async (label: string) => {
      for (let i = 0; i < panes; i++) await expect(tabs(page, i)).toHaveText(i === there ? [label] : others[i]!);
      await expect(group(page, there + 1)).toHaveAttribute("data-focused", "true");
      await expect(group(page, there + 1).getByRole("heading", { name: label, level: 1 })).toBeVisible();
      await expect.poll(() => previews(page)).toEqual([label]);
      await expect.poll(() => placed(page)).toEqual(before);
    };
    // Today opens the member's daily note, a note and not a page. Dice is a plugin's page, drawn in a frame, with no heading of the app's.
    for (const label of pages.filter((label) => label !== "Today" && label !== "Dice")) {
      await modes(page).getByRole("link", { name: label, exact: true }).click();
      await opensThere(label);
      await front();
      await expect.poll(() => placed(page)).toEqual(before);
    }
    await modes(page).getByRole("link", { name: "Dice", exact: true }).click();
    await expect(group(page, there + 1)).toHaveAttribute("data-focused", "true");
    await expect(ownPlugin(page, "Dice").getByRole("button", { name: "Roll" })).toBeVisible();
    await expect.poll(() => placed(page)).toEqual(before);
    await front();

    // From the command palette, and from a link to the page's address.
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.keyboard.type("Go to Calendar");
    await page.keyboard.press("Enter");
    await opensThere("Calendar");
    await front();
    await page.evaluate(() => {
      history.pushState(null, "", "/todos");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await opensThere("Todos");
  });
}
