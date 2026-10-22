import { expect, type Locator, type Page } from "@playwright/test";
import { folderRow, noteCard, noteIdIn, openKept, ownPlugin, perform, pinPanel, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const tabBar = (page: Page, group = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(group);
const tabs = (page: Page, group = 0) => tabBar(page, group).getByRole("tab");
const group = (page: Page, n: number) => page.getByRole("region", { name: `Editor group ${n}` });
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const crumbs = (page: Page) => page.getByRole("navigation", { name: "Breadcrumbs" });

type Made = Awaited<ReturnType<typeof withFolders>>;

async function withFolders(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  await perform(page, { type: "folder.create", name: "Reading" });
  await perform(page, { type: "note.create", folderId: projects.id, text: "# Plan\n\nAn #idea." });
  await page.reload();
  return { projects };
}

/** Today in this browser, as the daily note's day is said. */
const today = (page: Page) => page.evaluate(() => new Date().toLocaleDateString("en-CA"));

/**
 * Each kind of thing that drags to the editor area: where the window is when it is dragged (Projects'
 * list in front, or its note Plan open from it in front of the list), what is dragged, and the tab
 * it opens. `checked` is anything more the drop did.
 */
const KINDS: { kind: string; scene: "list" | "note"; source: (page: Page) => Locator; opens: (page: Page) => Promise<string> | string; checked?: (page: Page, made: Made) => Promise<void> }[] = [
  { kind: "a note's card", scene: "list", source: (page) => noteCard(page, "Plan").locator(".card-head"), opens: () => "Plan" },
  { kind: "a folder's row", scene: "list", source: (page) => folderRow(page, "Reading"), opens: () => "Reading" },
  {
    kind: "a tag in the sidebar",
    scene: "list",
    source: (page) => sidebar(page).locator('[data-tag="idea"]'),
    // Each tag's page is a tab of its own, called by the tag.
    opens: () => "#idea",
    checked: async (page) => await expect(page).toHaveURL(/\/tags\/idea$/),
  },
  { kind: "a page's link in the sidebar", scene: "list", source: (page) => page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }), opens: () => "Todos" },
  {
    kind: "Today, which opens the day's note",
    scene: "list",
    source: (page) => page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Today" }),
    opens: async (page) => {
      const on = await today(page);
      await expect.poll(async () => (await perform(page, { type: "daily.find", on })).note).not.toBeNull();
      return (await perform(page, { type: "daily.find", on })).note!.title;
    },
    checked: async (page) => {
      // The day's note is in front where it was dropped, and Today, which only leads to it, is no tab of its own.
      const { note } = await perform(page, { type: "daily.find", on: await today(page) });
      await expect(page).toHaveURL(new RegExp(`${note!.id}$`));
      await expect(page.getByRole("tab", { name: "Today", exact: true })).toHaveCount(0);
    },
  },
  { kind: "the workspace's crumb", scene: "note", source: (page) => crumbs(page).getByRole("button").first(), opens: () => "All notes" },
  { kind: "a note's crumb", scene: "note", source: (page) => crumbs(page).locator(".crumb-note"), opens: () => "Plan" },
  { kind: "a tab", scene: "note", source: (page) => tabs(page).filter({ hasText: /^Plan$/ }), opens: () => "Plan" },
  {
    kind: "New note in the sidebar",
    scene: "list",
    source: (page) => sidebar(page).getByRole("button", { name: "New note" }),
    opens: () => "Untitled",
    checked: madeInProjects,
  },
  {
    kind: "New note in a folder's list",
    scene: "list",
    source: (page) => page.getByRole("main").getByRole("button", { name: "New note" }),
    opens: () => "Untitled",
    checked: madeInProjects,
  },
];

/** The new note is in front, in Projects, which was in front as it was dragged, with the cursor in it to write. */
async function madeInProjects(page: Page, { projects }: Made) {
  await expect(page).toHaveURL(/\/note\/untitled-/);
  expect((await perform(page, { type: "note.read", id: noteIdIn(page) })).folderId).toBe(projects.id);
  await expect(page.getByRole("textbox", { name: "Note text" }).last()).toBeFocused();
}

/** Projects' list kept in a tab and in front, and for `note` its note Plan opened from it in a tab of its own, in front. */
async function scene(page: Page, which: "list" | "note") {
  await folderRow(page, "Projects").dblclick();
  await expect(tabs(page)).toHaveText(["Projects"]);
  if (which === "list") return;
  await openKept(page, "Plan");
  await expect(tabs(page)).toHaveText(["Projects", "Plan"]);
}

for (const { kind, scene: which, source, opens, checked } of KINDS) {
  test(`${kind} dropped on a group's right edge opens in a split there`, async ({ page }) => {
    const made = await withFolders(page);
    await scene(page, which);
    const { width, height } = (await group(page, 1).boundingBox())!;
    await source(page).dragTo(group(page, 1), { targetPosition: { x: width * 0.9, y: height / 2 } });
    await expect(group(page, 2)).toBeVisible();
    const title = await opens(page);
    await expect(tabs(page, 1)).toHaveText([title]);
    await expect(tabs(page, 1).first()).toHaveAttribute("aria-selected", "true");
    await checked?.(page, made);
  });

  test(`${kind} dropped on a tab bar opens a tab at that gap`, async ({ page }) => {
    const made = await withFolders(page);
    await scene(page, which);
    await source(page).dragTo(tabBar(page), { targetPosition: { x: 5, y: 10 } });
    const title = await opens(page);
    await expect(tabs(page).first()).toHaveText(title);
    await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(group(page, 2)).toHaveCount(0);
    await checked?.(page, made);
  });
}

test("each tag's page is a tab of its own: a second tag dragged to a group is a tab beside the first, which stays, and the page of every tag is one more", async ({ page }) => {
  await withFolders(page);
  await perform(page, { type: "note.create", text: "# Pots\n\nRepot the #fern." });
  await page.reload();
  const tag = (name: string) => sidebar(page).locator(`[data-tag="${name}"]`);
  const { width, height } = (await group(page, 1).boundingBox())!;
  await tag("idea").dragTo(group(page, 1), { targetPosition: { x: width * 0.9, y: height / 2 } });
  await expect(tabs(page, 1)).toHaveText(["#idea"]);
  await tag("fern").dragTo(tabBar(page, 1), { targetPosition: { x: 5, y: 10 } });
  await expect(tabs(page, 1)).toHaveText(["#fern", "#idea"]);
  await expect(page).toHaveURL(/\/tags\/fern$/);
  // Each is its own tag's page.
  await expect(group(page, 2).getByRole("region", { name: "#fern", exact: true })).toBeVisible();
  await tabs(page, 1).filter({ hasText: "#idea" }).click();
  await expect(group(page, 2).getByRole("region", { name: "#idea", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/tags\/idea$/);
  await page.reload();
  await expect(tabs(page, 1)).toHaveText(["#fern", "#idea"]);
  await page.goto("/tags");
  await expect(page.getByRole("tab", { name: "Tags", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "#fern", exact: true })).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "#idea", exact: true })).toHaveCount(1);
});

/** Each link inside a page that drags to the editor area, as a link to anything in the app does: where it is, and the tab it opens. */
const LINKS: { kind: string; to: string; link: (page: Page) => Locator | Promise<Locator>; opens: string }[] = [
  { kind: "a Search result", to: "/search?q=plan", link: (page) => page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Plan" }) }).locator(".card-head"), opens: "Plan" },
  { kind: "a note on the Dashboard", to: "/dashboard", link: (page) => page.getByRole("list", { name: "Today's notes" }).getByRole("link", { name: /Plan/ }), opens: "Plan" },
  { kind: "a link to a folder's list", to: "/todos", link: (page) => plainLink(page, "/folder/all", "Every note"), opens: "All notes" },
  { kind: "a link to a tag's page", to: "/todos", link: (page) => plainLink(page, "/tags/idea", "The idea tag"), opens: "#idea" },
];

/** A plain link put in the page in front, as any page of the app's may draw one, with no dragging of its own. */
async function plainLink(page: Page, href: string, text: string) {
  await page.getByRole("main").evaluate((main, [href, text]) => {
    const a = document.createElement("a");
    a.href = href!;
    a.textContent = text!;
    a.style.cssText = "position: fixed; top: 60px; left: 50%; z-index: 9";
    main.append(a);
  }, [href, text]);
  return page.getByRole("link", { name: text });
}

for (const { kind, to, link, opens } of LINKS)
  test(`${kind}, a link, dropped on a group's right edge opens in a split there`, async ({ page }) => {
    await withFolders(page);
    await page.goto(to);
    const source = await link(page);
    const { width, height } = (await group(page, 1).boundingBox())!;
    await source.dragTo(group(page, 1), { targetPosition: { x: width * 0.9, y: height / 2 } });
    await expect(group(page, 2)).toBeVisible();
    await expect(tabs(page, 1)).toHaveText([opens]);
    await expect(tabs(page, 1).first()).toHaveAttribute("aria-selected", "true");
  });

test("a link to another site dropped on a group opens nothing and goes nowhere", async ({ page }) => {
  await withFolders(page);
  await scene(page, "list");
  const url = page.url();
  const source = await plainLink(page, "https://example.com/elsewhere", "Elsewhere");
  const { width, height } = (await group(page, 1).boundingBox())!;
  await source.dragTo(group(page, 1), { targetPosition: { x: width * 0.9, y: height / 2 } });
  await source.dragTo(tabBar(page), { targetPosition: { x: 5, y: 10 } });
  await source.dragTo(group(page, 1), { targetPosition: { x: width / 2, y: height / 2 } });
  await expect(group(page, 2)).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["Projects"]);
  expect(page.url()).toBe(url);
});

test("a link that opens nothing a tab holds, of the app's own or another site's, dropped on a note is left to the note, which writes it in as before", async ({ page }) => {
  await withFolders(page);
  await scene(page, "note");
  const id = noteIdIn(page);
  for (const [href, text] of [["https://example.com/elsewhere", "Elsewhere"], ["/nowhere/at/all", "Nowhere"]] as const) {
    const source = await plainLink(page, href, text);
    await source.dragTo(page.getByRole("textbox", { name: "Note text" }), { targetPosition: { x: 40, y: 10 } });
    await expect.poll(async () => (await perform(page, { type: "note.read", id })).text).toContain(new URL(href, page.url()).href);
    await expect(group(page, 2)).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(2);
  }
});

test("a Backlinks entry is a link to the note's own address, though the browser takes no drop from the frame it is in", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const target = await perform(page, { type: "note.create", text: "# Target" });
  const source = await perform(page, { type: "note.create", text: "# Source\n\nSee [[Target]]." });
  await page.goto(`/note/target-${target.id}`);
  await pinPanel(page, "Backlinks");
  const row = ownPlugin(page, "Backlinks").getByRole("link", { name: /Source/ });
  await expect(row).toHaveAttribute("href", `/note/${source.id}`);
  expect(await row.evaluate((a: HTMLAnchorElement) => new URL(a.href).pathname)).toBe(`/note/${source.id}`);
});
