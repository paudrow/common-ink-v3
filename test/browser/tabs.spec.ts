import { expect, test, type Page } from "@playwright/test";
import { listedNote, noteCard, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

/** Opens a note from the list of every note as a preview, which is what a click on its title does. */
async function preview(page: Page, title: string) {
  await openAllNotes(page);
  await listedNote(page, title).click();
}

/** Opens a note from the list of every note in a tab that is kept, which is what its pencil does. */
async function keep(page: Page, title: string) {
  await openAllNotes(page);
  await noteCard(page, title).getByRole("button", { name: `Edit ${title}` }).click();
}

const tabBar = (page: Page, group = 0) => page.getByRole("tablist", { name: "Open notes" }).nth(group);
const tabs = (page: Page, group = 0) => tabBar(page, group).getByRole("tab");
const tab = (page: Page, title: string, group = 0) => tabs(page, group).filter({ hasText: new RegExp(`^${title}$`) });
const italic = async (page: Page, group = 0) => tabs(page, group).evaluateAll((els) => els.map((el) => getComputedStyle(el).fontStyle === "italic"));

async function withNotes(page: Page, ...titles: string[]) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const notes = [];
  for (const title of titles) notes.push(await perform(page, { type: "note.create", text: `# ${title}\n\nAbout ${title}.` }));
  await page.reload();
  return notes;
}

test("a single click opens a note in an italic preview tab, and the next single click replaces it", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");

  await preview(page, "Alpha");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha"]);
  expect(await italic(page)).toEqual([false, true]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");

  await preview(page, "Beta");
  await expect(tabs(page)).toHaveText(["All notes", "Beta"]);
  expect(await italic(page)).toEqual([false, true]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await expect(page).toHaveURL(/\/note\/beta-[a-z0-9]{12}$/);
});

test("a note's pencil keeps it in its own tab, and so does double-clicking its tab or typing in it", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta", "Gamma");

  await keep(page, "Alpha");
  await preview(page, "Beta");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta"]);
  expect(await italic(page)).toEqual([false, false, true]);

  await tab(page, "Beta").dblclick();
  expect(await italic(page)).toEqual([false, false, false]);

  await preview(page, "Gamma");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta", "Gamma"]);
  expect(await italic(page)).toEqual([false, false, false, true]);
  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.type(" more");
  await expect.poll(() => italic(page)).toEqual([false, false, false, false]);

  await tab(page, "Alpha").click();
  await expect(tab(page, "Alpha")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await expect(page).toHaveURL(/\/note\/alpha-[a-z0-9]{12}$/);
});

test("dragging a note onto the editor splits it, and onto a tab bar adds or moves a tab", async ({ page }) => {
  const [alpha, beta] = await withNotes(page, "Alpha", "Beta", "Gamma");
  const group = (n: number) => page.getByRole("region", { name: `Editor group ${n}` });
  const noteUrl = page.getByRole("complementary", { name: "Inspector" }).getByRole("textbox", { name: "Note URL" });
  await keep(page, "Alpha");
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");

  const { width } = (await group(1).boundingBox())!;
  await openAllNotes(page);
  await noteCard(page, "Beta").dragTo(group(1), { targetPosition: { x: width * 0.8, y: 130 } });
  await expect(tabs(page, 0)).toHaveText(["All notes", "Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);
  expect(await italic(page, 1)).toEqual([false]);
  await expect(group(2).locator(".cm-line")).toHaveText(["# Beta", "", "About Beta."]);
  await expect(page).toHaveURL(new RegExp(`/note/beta-${beta!.id}$`));
  await expect(noteUrl).toHaveValue(new RegExp(`${beta!.id}$`));
  await tab(page, "Alpha").click();
  await expect(group(1).locator(".cm-line")).toHaveText(["# Alpha", "", "About Alpha."]);
  await group(2).getByRole("textbox", { name: "Note text" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/beta-${beta!.id}$`));

  const visited = await page.evaluate(() => history.length);
  await group(1).getByRole("textbox", { name: "Note text" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/alpha-${alpha!.id}$`));
  await expect(noteUrl).toHaveValue(new RegExp(`${alpha!.id}$`));
  await group(2).getByRole("textbox", { name: "Note text" }).click();
  await expect(page).toHaveURL(new RegExp(`/note/beta-${beta!.id}$`));
  await tab(page, "Alpha").click();
  await expect(page).toHaveURL(new RegExp(`/note/alpha-${alpha!.id}$`));
  expect(await page.evaluate(() => history.length)).toBe(visited);

  await tab(page, "All notes").click();
  await noteCard(page, "Gamma").dragTo(tabBar(page, 1));
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  expect(await italic(page, 1)).toEqual([false, false]);
  await expect(group(2).locator(".cm-line").first()).toHaveText("# Gamma");

  await page.reload();
  await expect(tabs(page, 0)).toHaveText(["All notes", "Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta", "Gamma"]);
  await expect(tab(page, "Gamma", 1)).toHaveAttribute("aria-selected", "true");

  await tab(page, "Gamma", 1).dragTo(tabBar(page, 0), { targetPosition: { x: 5, y: 10 } });
  await expect(tabs(page, 0)).toHaveText(["Gamma", "All notes", "Alpha"]);
  await expect(tabs(page, 1)).toHaveText(["Beta"]);

  await tab(page, "Beta", 1).dragTo(tabBar(page, 0), { targetPosition: { x: (await tabBar(page, 0).boundingBox())!.width - 5, y: 10 } });
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(1);
  await expect(tabs(page)).toHaveText(["Gamma", "All notes", "Alpha", "Beta"]);
  await expect(group(2)).toHaveCount(0);
});

test("a tab's menu closes the others, those to its left, those to its right, or all of them", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta", "Gamma", "Delta");
  const choose = async (title: string, item: string) => {
    await tab(page, title).click({ button: "right" });
    await page.getByRole("menu", { name: `${title} tab` }).getByRole("menuitem", { name: item, exact: true }).click();
  };
  for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) await keep(page, title);
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta", "Gamma", "Delta"]);

  await choose("Gamma", "Close to the right");
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Beta", "Gamma"]);
  await expect(tab(page, "Gamma")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-line").first()).toHaveText("# Gamma");

  await choose("Beta", "Close to the left");
  await expect(tabs(page)).toHaveText(["Beta", "Gamma"]);

  await keep(page, "Alpha");
  await expect(tabs(page)).toHaveText(["Beta", "Gamma", "All notes", "Alpha"]);
  await choose("Gamma", "Close others");
  await expect(tabs(page)).toHaveText(["Gamma"]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Gamma");

  await tab(page, "Gamma").click({ button: "right" });
  for (const item of ["Close others", "Close to the left", "Close to the right"]) await expect(page.getByRole("menuitem", { name: item })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+P");
  await page.getByRole("dialog", { name: "Go to note" }).getByRole("option", { name: /Delta/ }).click();
  await expect(tabs(page)).toHaveText(["Gamma", "Delta"]);
  await choose("Gamma", "Close all");
  await expect(page.getByRole("tablist", { name: "Open notes" })).toHaveCount(0);
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("⇧⌘P lists the commands, narrows them as you type, and runs the one chosen", async ({ page }) => {
  await withNotes(page, "Alpha");
  await preview(page, "Alpha");
  const text = page.getByRole("textbox", { name: "Note text" });
  await text.click();
  const palette = page.getByRole("dialog", { name: "Commands" });

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(palette.getByRole("combobox")).toBeFocused();
  for (const title of ["New note", "Go to note…", "Open All notes", "Toggle writing mode", "Toggle inspector", "Close other tabs", "Go to Dashboard"]) {
    await expect(palette.getByRole("option", { name: title })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
  await expect(text).toBeFocused();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("writ");
  await expect(palette.getByRole("option")).toHaveText([/^Toggle writing mode/]);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Left rail" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("writing");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Left rail" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("insp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await palette.getByRole("option", { name: "New note" }).click();
  await expect(tabs(page)).toHaveText(["All notes", "Alpha", "Untitled"]);
  await expect(text).toBeFocused();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.keyboard.type("no such command");
  await expect(palette.getByText("No commands match.")).toBeVisible();
});

test("⌘P finds notes by title, best match first, and opens the one chosen in its own tab", async ({ page }) => {
  await withNotes(page, "Meeting notes", "Trip planning", "Plan");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  await expect(page.getByText("Pick a note, or start a new one.")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+P");
  await expect(palette.getByRole("option")).toHaveCount(3);
  await page.keyboard.type("pl");
  await expect(palette.getByRole("option")).toHaveText([/^Plan/, /^Trip planning/]);
  await expect(palette.getByRole("option").first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["Trip planning"]);
  expect(await italic(page)).toEqual([false]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Trip planning");
  await expect(page).toHaveURL(/\/note\/trip-planning-[a-z0-9]{12}$/);

  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+P");
  await page.keyboard.type("meet");
  await palette.getByRole("option", { name: /Meeting notes/ }).click();
  await expect(tabs(page)).toHaveText(["Trip planning", "Meeting notes"]);
  await expect(page.locator(".cm-line").first()).toHaveText("# Meeting notes");
});

const isOp = (body: string | null, type: string) => body?.includes(`"${type}"`) ?? false;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a new note stays listed when a listing asked for before it answers after it", async ({ page }) => {
  await page.route("**/ops", async (route) => {
    if (!isOp(route.request().postData(), "note.list")) return route.continue();
    const response = await route.fetch();
    await pause(1500);
    await route.fulfill({ response });
  });
  await signInAsNewPerson(page, "Ada Lovelace");
  await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("dialog", { name: "Commands" }).getByRole("option", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Plan");
  await expect(tabs(page)).toHaveText(["Plan"]);

  // The list of every note is drawn once the listing has answered, which is after the note was made.
  await openAllNotes(page);
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  await expect(listedNote(page, "Plan")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Unsorted" })).toHaveAccessibleDescription("1");
});

test("coming back to a tab while its save is on the way shows what was typed", async ({ page }) => {
  await withNotes(page, "Alpha", "Beta");
  await keep(page, "Alpha");
  await keep(page, "Beta");
  await tab(page, "Alpha").click();
  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await page.route("**/ops", async (route) => {
    if (isOp(route.request().postData(), "note.write")) await pause(800);
    await route.continue();
  });

  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.type("typed late ");
  await tab(page, "Beta").click();
  await expect(page.locator(".cm-line").first()).toHaveText("# Beta");
  await tab(page, "Alpha").click();

  await expect(page.locator(".cm-line").first()).toHaveText("# Alpha");
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("typed late");
  await expect(page.getByRole("status")).toHaveText("Saved");
});
