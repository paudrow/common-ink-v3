import { expect, test, type Page } from "@playwright/test";
import { anotherPerson, join, perform, signInAsNewPerson } from "./helpers.ts";

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const crumbs = (page: Page) => page.getByRole("navigation", { name: "Breadcrumbs" });
const crumb = (page: Page, name: string) => crumbs(page).getByRole("button", { name, exact: true });
const list = (page: Page) => page.getByRole("dialog").getByRole("listbox");
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).getByRole("tab");

/** A workspace with Projects > Engines > Analytical, and notes at each level. */
async function withTree(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const engines = await perform(page, { type: "folder.create", name: "Engines", parentId: projects.id });
  const analytical = await perform(page, { type: "folder.create", name: "Analytical", parentId: engines.id });
  const plan = await perform(page, { type: "note.create", folderId: projects.id, text: "# Plan\n\nThe plan." });
  const notes = await perform(page, { type: "note.create", folderId: engines.id, text: "# Notes\n\nLoops." });
  const punch = await perform(page, { type: "note.create", folderId: analytical.id, text: "# Punch cards\n\nCards." });
  await perform(page, { type: "note.create", folderId: analytical.id, text: "# Mill\n\nThe mill." });
  await page.goto(`/note/${punch.id}`);
  await expect(editor(page)).toBeVisible();
  return { projects, engines, analytical, plan, notes, punch };
}

test("an open note has breadcrumbs: the workspace, each folder down to the note's, and the note", async ({ page }) => {
  await withTree(page);
  const name = (await (await page.request.get("/api/me")).json()).workspaces[0].name as string;
  await expect(crumbs(page).getByRole("listitem")).toHaveText([name, "Projects", "Engines", "Analytical", "Punch cards"]);
  // The note is where the crumbs end, and is no button.
  await expect(crumbs(page).getByRole("listitem").last()).toHaveAttribute("aria-current", "page");
  await expect(crumbs(page).getByRole("button")).toHaveCount(4);
  // One slim line between the tab row and the note.
  expect((await crumbs(page).boundingBox())!.height).toBeLessThanOrEqual(30);

  // The note's title follows its heading as it is typed.
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.type(" machine");
  await expect(crumbs(page).getByRole("listitem").last()).toHaveText("Punch cards machine");

  // On a page that is no note there are none.
  await page.goto("/search");
  await expect(crumbs(page)).toHaveCount(0);
});

test("a crumb opens a list of its folder's subfolders and notes, with Go to folder at the top", async ({ page }) => {
  const { projects, engines } = await withTree(page);

  await crumb(page, "Engines").click();
  const options = list(page).getByRole("option");
  await expect(options).toHaveText(["Go to folder", "Analytical", "Notes"]);
  await expect(page.getByRole("dialog", { name: "Engines folder" })).toBeVisible();
  // The list is searchable and has the keyboard from the first.
  await expect(page.getByRole("combobox", { name: "Search Engines" })).toBeFocused();
  await page.keyboard.type("not");
  await expect(options).toHaveText(["Go to folder", "Notes"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(crumb(page, "Engines")).toBeFocused();

  // Go to folder opens the folder's list.
  await crumb(page, "Projects").click();
  await expect(options).toHaveText(["Go to folder", "Engines", "Plan"]);
  await options.first().click();
  await expect(page).toHaveURL(new RegExp(`/folder/${projects.id}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Projects");

  // A subfolder in a list opens that folder.
  await page.goBack();
  await crumb(page, "Projects").click();
  await options.filter({ hasText: "Engines" }).click();
  await expect(page).toHaveURL(new RegExp(`/folder/${engines.id}$`));
});

test("by the keyboard a crumb's list is moved through with the arrows and Enter opens a note", async ({ page }) => {
  const { plan } = await withTree(page);

  await crumb(page, "Projects").focus();
  await page.keyboard.press("Enter");
  const options = list(page).getByRole("option");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/note/plan-${plan.id}$`));
  await expect(editor(page)).toContainText("The plan.");
  await expect(crumbs(page).getByRole("listitem")).toContainText(["Projects", "Plan"]);
  await expect(tabs(page)).toHaveText(["Plan"]);
});

test("the workspace crumb lists the top-level folders and goes to all notes", async ({ page }) => {
  await withTree(page);
  const name = (await (await page.request.get("/api/me")).json()).workspaces[0].name as string;
  await crumb(page, name).click();
  await expect(list(page).getByRole("option")).toHaveText(["Go to all notes", "Unsorted", "Projects"]);
  await list(page).getByRole("option").first().click();
  await expect(page).toHaveURL(/\/folder\/all$/);
});

test("in a narrow window the crumbs stay in their line, and focus hides the breadcrumbs", async ({ page }) => {
  await withTree(page);
  await page.setViewportSize({ width: 420, height: 800 });
  const nav = (await crumbs(page).boundingBox())!;
  const main = (await page.getByRole("main", { name: "Editor" }).boundingBox())!;
  expect(nav.x + nav.width).toBeLessThanOrEqual(main.x + main.width + 1);
  expect(nav.height).toBeLessThanOrEqual(30);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Focus" }).click();
  await expect(crumbs(page)).toBeHidden();
});

test("someone who can see only a shared note sees it under Shared with me, and no note or folder they can't see", async ({ page }) => {
  const { punch } = await withTree(page);
  const grace = await anotherPerson(page, "Grace Guest");
  const email = (await (await grace.request.get("/api/me")).json()).person.email as string;
  await perform(page, { type: "grant.set", noteId: punch.id, email, access: "view" });
  await grace.goto(`/note/${punch.id}`);
  await expect(editor(grace)).toBeVisible();
  await expect(crumbs(grace).getByRole("listitem")).toHaveText([/.+/, "Shared with me", "Punch cards"]);
  await crumb(grace, "Shared with me").click();
  // Only what she was shared: the other notes of the folder are not hers to see.
  await expect(grace.getByRole("dialog").getByRole("option")).toHaveText(["Go to folder", "Punch cards"]);
  await grace.keyboard.press("Escape");

  // A viewer of the workspace sees the folders and their notes, and the same crumbs.
  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  await vera.goto(`/note/${punch.id}`);
  await expect(crumbs(vera).getByRole("listitem")).toContainText(["Projects", "Engines", "Analytical", "Punch cards"]);
});
