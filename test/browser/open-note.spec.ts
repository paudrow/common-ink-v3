import { expect, test, type Page } from "@playwright/test";
import { editOf, folderRow, listedNotes, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const group = (page: Page) => page.locator(".group[data-front]");
const tools = (page: Page) => group(page).locator(".tab-row");
const bottomBar = (page: Page) => page.getByRole("group", { name: "Bottom bar" });
const isWrite = (body: string | null) => (body ? JSON.parse(body).type === "note.write" : false);

async function openNote(page: Page, text: string) {
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toBeVisible();
  return note;
}

/** Where the heading and the first lines under it are drawn, to the pixel. */
const lines = (page: Page) =>
  page.locator(".cm-line").evaluateAll((all) =>
    all.slice(0, 4).map((line) => {
      const box = line.getBoundingClientRect();
      return [Math.round(box.left), Math.round(box.top), Math.round(box.height)];
    }),
  );

test("an open note begins with its own heading, with Archive, its menu and Focus side by side at its top right", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openNote(page, "# Engine notes\n\nThe first line.");

  await expect(page.locator(".note-bar")).toHaveCount(0);
  const tabRow = (await tools(page).boundingBox())!;
  const heading = (await page.locator(".cm-line").first().boundingBox())!;
  // Under the tab row come the breadcrumbs, one slim line, and then the note itself: its heading, after the editor's own margin and nothing else.
  const crumbs = (await page.getByRole("navigation", { name: "Breadcrumbs" }).boundingBox())!;
  expect(Math.round(crumbs.y - (tabRow.y + tabRow.height))).toBeLessThanOrEqual(1);
  expect(Math.round(crumbs.height)).toBeLessThanOrEqual(30);
  expect(Math.round(heading.y - (crumbs.y + crumbs.height))).toBeLessThanOrEqual(40);

  const buttons = [tools(page).getByRole("button", { name: "Archive" }), tools(page).getByRole("button", { name: "Note menu" }), tools(page).getByRole("button", { name: "Focus" })];
  const boxes = await Promise.all(buttons.map(async (b) => (await b.boundingBox())!));
  expect(boxes.map((b) => Math.round(b.y + b.height / 2))).toEqual(Array(3).fill(Math.round(boxes[0]!.y + boxes[0]!.height / 2)));
  expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
  expect(boxes[1]!.x).toBeLessThan(boxes[2]!.x);
  expect(Math.round(tabRow.x + tabRow.width - (boxes[2]!.x + boxes[2]!.width))).toBeLessThanOrEqual(8);

  // On a page that isn't a note, Focus is where it was and is alone.
  await page.goto("/search");
  await expect(tools(page).getByRole("button", { name: "Focus" })).toBeVisible();
  await expect(tools(page).getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(tools(page).getByRole("button", { name: "Note menu" })).toHaveCount(0);
});

test("the note's menu has its card's options but the splits, and moves the note to another folder", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const team = await perform(page, { type: "folder.create", name: "Team" });
  const note = await openNote(page, "# Engine notes\n\nThe first line.");

  await tools(page).getByRole("button", { name: "Note menu" }).click();
  const menu = page.getByRole("menu", { name: "Note menu" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Share settings", "Move to folder", "Copy link", "Info", "Archive", "Move to Trash"]);
  // Every item has an icon, each its own, so the menu can be skimmed.
  const icons = await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.querySelector(".menu-icon svg")?.innerHTML ?? ""));
  expect(icons.every(Boolean)).toBe(true);
  expect(new Set(icons).size).toBe(icons.length);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tools(page).getByRole("button", { name: "Note menu" })).toBeFocused();

  await tools(page).getByRole("button", { name: "Note menu" }).click();
  await menu.getByRole("menuitem", { name: "Info" }).click();
  await expect(page.getByRole("dialog")).toContainText("Engine notes");
  await page.keyboard.press("Escape");

  await tools(page).getByRole("button", { name: "Note menu" }).click();
  await menu.getByRole("menuitem", { name: "Move to folder" }).click();
  await page.getByRole("menu", { name: "Move Engine notes to" }).getByRole("menuitem", { name: "Team" }).click();
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).folderId).toBe(team.id);
});

test("Saved is in the bottom bar, and nothing in the note moves while it saves, fails and is saved", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openNote(page, "# Engine notes\n\nThe first line.\n\nThe second line.");
  await page.evaluate(() => document.fonts.ready);
  await expect(bottomBar(page).getByRole("status")).toHaveText("Saved");
  const before = await lines(page);

  let release: () => void = () => {};
  let failing = true;
  await page.route("**/ops", async (route) => {
    if (!isWrite(route.request().postData())) return route.continue();
    if (failing) {
      failing = false;
      await new Promise<void>((done) => (release = done));
      return route.abort();
    }
    return route.continue();
  });
  await page.locator(".cm-line").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(bottomBar(page).getByRole("status")).toHaveText("Saving…");
  const saving = await lines(page);
  release();
  await expect(bottomBar(page).getByRole("status")).toHaveText("Couldn't save. Retrying…");
  const failed = await lines(page);
  await expect(bottomBar(page).getByRole("status")).toHaveText("Saved", { timeout: 10_000 });
  const saved = await lines(page);

  expect(saving).toEqual(before);
  expect(failed).toEqual(before);
  expect(saved).toEqual(before);
});

test("Archive puts a note out of the way: a quiet line under its title brings it back, and it leaves the folder's list and Todos but not search", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await openNote(page, "# Old plan\n\nThe first line.\n\n- [ ] file taxes");
  const firstLine = async () => Math.round((await page.locator(".cm-line").nth(0).boundingBox())!.y);
  const heading = await firstLine();

  const archive = tools(page).getByRole("button", { name: "Archive" });
  await expect(archive).toHaveAttribute("title", /^Archive \(.+\)$/);
  await expect(tools(page).getByRole("button", { name: "Pin to dashboard" })).toBeVisible();
  const archiveIcon = await archive.locator("svg").innerHTML();
  await archive.click();
  const line = page.locator(".note-marks");
  await expect(line).toHaveText("Archived·Unarchive");
  expect(await firstLine()).toBe(heading);
  // The line is under the title, before the rest of the note.
  const under = (await line.boundingBox())!;
  expect(under.y).toBeGreaterThan((await page.locator(".cm-line").nth(0).boundingBox())!.y);
  expect(under.y).toBeLessThan((await page.locator(".cm-line").nth(1).boundingBox())!.y);
  // The button becomes Unarchive with an icon of its own, and a pin is not offered while the note is archived.
  const unarchive = tools(page).getByRole("button", { name: "Unarchive" });
  await expect(unarchive).toBeVisible();
  expect(await unarchive.locator("svg").innerHTML()).not.toBe(archiveIcon);
  await expect(tools(page).getByRole("button", { name: /dashboard/ })).toHaveCount(0);
  await expect(tools(page).getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);

  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("is:archived");
  await expect(listedNotes(page)).toHaveText(["Old plan"]);
  await page.goto("/todos");
  await expect(page.getByRole("region", { name: "Todos" })).not.toContainText("file taxes");
  await page.goto("/search?q=plan+is%3Aarchived");
  await expect(page.getByRole("navigation", { name: "Notes" }).locator(".card-title")).toHaveText(["Old plan"]);

  await page.goto(`/note/${note.id}`);
  await line.getByRole("button", { name: "Unarchive" }).click();
  await expect(line).toBeHidden();
  await expect(tools(page).getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  await expect(tools(page).getByRole("button", { name: "Pin to dashboard" })).toBeVisible();

  // Its shortcut does the same from the note's text, and again brings it back.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(line).toHaveText("Archived·Unarchive");
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(line).toBeHidden();
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).state).toBe("live");
});

test("a folder's page has the query as its one control, with no Show, Has todos or Sort beside it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Kept\n\nhere" });
  await openAllNotes(page);
  await expect(editOf(page, "Kept")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Show" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Has todos" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveCount(0);
  await folderRow(page, "Unsorted").click();
  await expect(page.getByRole("radiogroup", { name: "Show" })).toHaveCount(0);
});
