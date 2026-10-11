import { expect, test, type Page } from "@playwright/test";
import { listedNote, listedNotes, noteCard, noteIdIn, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const tree = (page: Page) => page.getByRole("tree", { name: "Folders" });
const folder = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
const editorPane = (page: Page) => page.getByRole("main", { name: "Editor" });
const width = async (page: Page) => (await editorPane(page).boundingBox())!.width;
const listHeading = (page: Page) => editorPane(page).getByRole("heading", { level: 1 });

async function newFolder(page: Page, name: string, parent?: string) {
  if (parent) {
    await folder(page, parent).hover();
    await page.getByRole("button", { name: `Actions for ${parent}` }).click();
    await page.getByRole("menuitem", { name: "New folder inside" }).click();
  } else {
    await page.getByRole("button", { name: "New folder" }).click();
  }
  await page.getByRole("textbox", { name: "Folder name" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(folder(page, name)).toBeVisible();
}

test("folders nest, and clicking a collapsed parent shows its children", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");

  await newFolder(page, "Projects");
  await newFolder(page, "Common Ink", "Projects");
  await expect(tree(page).getByRole("treeitem")).toHaveText([/^All notes/, /^Unsorted/, /^Projects/, /^Common Ink/]);
  await expect(folder(page, "Common Ink")).toHaveAttribute("aria-level", "2");

  await page.getByRole("button", { name: "Collapse Projects" }).click();
  await expect(tree(page).getByRole("treeitem")).toHaveText([/^All notes/, /^Unsorted/, /^Projects/]);

  await folder(page, "Projects").click();
  await expect(folder(page, "Projects")).toHaveAttribute("aria-selected", "true");
  await expect(tree(page).getByRole("treeitem")).toHaveText([/^All notes/, /^Unsorted/, /^Projects/, /^Common Ink/]);
  await expect(listHeading(page)).toHaveText("Projects");

  await page.reload();
  await expect(tree(page).getByRole("treeitem")).toHaveText([/^All notes/, /^Unsorted/, /^Projects/, /^Common Ink/]);
});

test("a folder name already used beside it is refused with the server's reason, and Escape cancels", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await newFolder(page, "Projects");

  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("textbox", { name: "Folder name" }).fill("projects");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(`There's already a folder named "projects" here`);
  await page.keyboard.press("Escape");

  await expect(page.getByRole("textbox", { name: "Folder name" })).toHaveCount(0);
  await expect(tree(page).getByRole("treeitem")).toHaveText([/^All notes/, /^Unsorted/, /^Projects/]);
});

test("a new note lands in the folder whose list is open, or Unsorted from the list of every note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await expect(listHeading(page)).toHaveText("All notes");

  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await expect(folder(page, "Unsorted")).toHaveAttribute("aria-selected", "true");
  await expect(folder(page, "Unsorted")).toHaveAccessibleDescription("1");
  await folder(page, "Unsorted").click();
  await expect(listHeading(page)).toHaveText("Unsorted");
  await expect(listedNotes(page)).toHaveText(["Untitled"]);
  await expect(noteCard(page, "Untitled").locator(".card-details")).toHaveText("Ada Lovelacejust now");

  await newFolder(page, "Projects");
  await folder(page, "Projects").click();
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Plan");

  await expect(page.getByRole("tab", { name: "Plan" })).toBeVisible();
  await expect(editorPane(page).locator(".note-meta").getByText("Projects", { exact: true })).toBeVisible();
  await expect(editorPane(page).getByText("edited just now by Ada Lovelace")).toBeVisible();
  await expect(folder(page, "Projects")).toHaveAccessibleDescription("1");
  await expect(folder(page, "Unsorted")).toHaveAccessibleDescription("1");
  await folder(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(noteCard(page, "Plan").locator(".card-details")).toHaveText("Ada Lovelacejust now");
});

test("dragging a note onto a folder moves it there", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "folder.create", name: "Projects" });
  await perform(page, { type: "note.create", text: "# Plan\n\nWrite it down." });
  await page.reload();
  await folder(page, "Unsorted").click();

  await noteCard(page, "Plan").dragTo(folder(page, "Projects"));

  await expect(folder(page, "Projects")).toHaveAccessibleDescription("1");
  await expect(folder(page, "Unsorted")).toHaveAccessibleDescription("0");
  await expect(page.getByText("No notes in this folder.")).toBeVisible();
  await folder(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(noteCard(page, "Plan").locator(".card-preview")).toHaveText("Write it down.");
});

test("a folder with notes in it can't be deleted, and an empty one can", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const full = await perform(page, { type: "folder.create", name: "Full" });
  await perform(page, { type: "folder.create", name: "Empty" });
  await perform(page, { type: "note.create", text: "# Keep", folderId: full.id });
  await page.reload();

  await folder(page, "Full").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alert")).toHaveText(`"Full" isn't empty. Move or delete what's in it first.`);

  await folder(page, "Empty").hover();
  await page.getByRole("button", { name: "Actions for Empty" }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["New folder inside", "Rename", "Delete"]);
  await page.getByRole("menuitem", { name: "Delete" }).click();

  await expect(tree(page).getByRole("treeitem")).toHaveText([/^All notes/, /^Unsorted/, /^Full/]);
});

test("a folder is renamed in place", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "folder.create", name: "Projects" });
  await page.reload();

  await folder(page, "Projects").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByRole("textbox", { name: "Folder name" })).toHaveValue("Projects");
  await page.keyboard.type("Work");
  await page.keyboard.press("Enter");

  await expect(tree(page).getByRole("treeitem")).toHaveText([/^All notes/, /^Unsorted/, /^Work/]);
});

test("More expands and collapses Contacts, Uploads, and History, and each mode is a page", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const modes = page.getByRole("navigation", { name: "Modes" });
  await expect(modes.getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Today", "Calendar"]);

  await modes.getByRole("button", { name: "More" }).click();
  await expect(modes.getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Today", "Calendar", "Contacts", "Uploads", "History", "Trash"]);
  await modes.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(editorPane(page).getByRole("heading", { level: 1 })).toHaveText("History");
  await expect(editorPane(page)).toContainText("Nothing has been written in this workspace yet.");

  await modes.getByRole("button", { name: "More" }).click();
  await expect(modes.getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Today", "Calendar"]);
  await modes.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(editorPane(page).getByRole("heading", { level: 1 })).toHaveText("Dashboard");
});

test("a folder's list filters on title and snippet, sorts, and narrows to notes with open todos", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const fruit = await perform(page, { type: "folder.create", name: "Fruit" });
  const banana = await perform(page, { type: "note.create", folderId: fruit.id, text: "# Banana\n\nYellow and curved.\n\n- [ ] buy" });
  await perform(page, { type: "note.create", folderId: fruit.id, text: "# Apple\n\nRed or green." });
  await perform(page, { type: "note.create", folderId: fruit.id, text: "# Cherry\n\n- [ ] pit\n- [ ] wash" });
  await perform(page, { type: "note.write", id: banana.id, baseRevision: 1, text: "# Banana\n\nYellow and curved, ripe.\n\n- [ ] buy" });
  await page.reload();
  await folder(page, "Fruit").click();

  await expect(listHeading(page)).toHaveText("Fruit");
  await expect(editorPane(page).getByText("3 notes", { exact: true })).toBeVisible();
  await expect(listedNotes(page)).toHaveText(["Banana", "Cherry", "Apple"]);
  await expect(noteCard(page, "Banana").locator(".card-preview")).toHaveText("Yellow and curved, ripe. buy");
  await expect(noteCard(page, "Banana").locator(".card-details")).toHaveText("Ada Lovelacejust now1 open");
  await expect(noteCard(page, "Cherry").locator(".card-preview")).toHaveText("pit wash");
  await expect(noteCard(page, "Cherry").locator(".card-details")).toHaveText("Ada Lovelacejust now2 open");
  await expect(noteCard(page, "Apple").locator(".card-details")).toHaveText("Ada Lovelacejust now");
  const sort = page.getByRole("combobox", { name: "Sort by" });
  await expect(sort).toHaveValue("recent");
  await sort.selectOption("Created");
  await expect(listedNotes(page)).toHaveText(["Cherry", "Apple", "Banana"]);
  await sort.selectOption("Title");
  await expect(listedNotes(page)).toHaveText(["Apple", "Banana", "Cherry"]);

  await page.getByRole("button", { name: "Has todos" }).click();
  await expect(listedNotes(page)).toHaveText(["Banana", "Cherry"]);
  await page.getByRole("button", { name: "Has todos" }).click();

  // What is typed is searched for in the folder's notes, by the server, and found in a note's text as in its title.
  await page.getByRole("searchbox", { name: "Search notes" }).fill("RED");
  await expect(listedNotes(page)).toHaveText(["Apple"]);
  await expect(noteCard(page, "Apple").locator("mark")).toHaveText(["Red"]);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("cherry");
  await expect(listedNotes(page)).toHaveText(["Cherry"]);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("kiwi");
  await expect(page.getByText("No notes match “kiwi” in Fruit.")).toBeVisible();

  // The list is as it was left when its tab is come back to, and All notes says which folder each note is in.
  await page.getByRole("searchbox", { name: "Search notes" }).fill("cherry");
  await expect(listedNotes(page)).toHaveText(["Cherry"]);
  await openAllNotes(page);
  await expect(noteCard(page, "Cherry").locator(".card-details")).toHaveText("FruitAda Lovelacejust now2 open");
  await folder(page, "Fruit").click();
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toHaveValue("cherry");
  await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("title");
  await expect(listedNotes(page)).toHaveText(["Cherry"]);
});

test("the inspector has History, Backlinks, and Info, and Info shows the folder, sharing, tags, URL, and Archive", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const ink = await perform(page, { type: "folder.create", name: "Common Ink", parentId: projects.id });
  const note = await perform(page, { type: "note.create", folderId: ink.id, text: "# Roadmap" });
  await page.goto(`/note/roadmap-${note.id}`);
  await expect(folder(page, "Common Ink")).toHaveAttribute("aria-selected", "true");

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Backlinks", "Info"]);
  await expect(inspector.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
  const panel = inspector.getByRole("tabpanel");
  await expect(panel.getByRole("term")).toHaveText(["Folder", "Sharing", "Tags", "URL", "Archive", "Trash"]);
  await expect(panel.getByRole("definition").first().locator("span")).toHaveText("Projects / Common Ink");
  await expect(panel.getByRole("combobox", { name: "Move to" })).toHaveValue(ink.id);
  await expect(panel.getByRole("definition").nth(1)).toHaveText("Everyone in this workspace · Link offShare");
  await expect(panel.getByRole("definition").nth(2)).toHaveText("No tags. Write #tag in the note to tag it.");
  await expect(panel.getByRole("textbox", { name: "Note URL" })).toHaveValue(new URL(`/note/roadmap-${note.id}`, page.url()).href);
  await panel.getByRole("button", { name: "Copy" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Archive" })).toBeEnabled();

  await inspector.getByRole("tab", { name: "History" }).click();
  await expect(panel.getByRole("list", { name: "Changes" }).getByRole("listitem")).toHaveAccessibleName("Change 1 by Ada Lovelace");
  await inspector.getByRole("tab", { name: "Backlinks" }).click();
  await expect(panel).toHaveText("No notes link here yet. Type [[ in another note to link to this one.");

  await inspector.getByRole("tab", { name: "Info" }).click();
  await panel.getByRole("combobox", { name: "Move to" }).selectOption({ label: "Projects" });
  await expect(panel.getByRole("definition").first().locator("span")).toHaveText("Projects");
  await expect(folder(page, "Projects")).toHaveAccessibleDescription("1");
  await expect(folder(page, "Common Ink")).toHaveAccessibleDescription("0");

  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(inspector).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Inspector" })).toHaveAttribute("aria-pressed", "false");
  await expect(inspector).toHaveCount(0);
});

test("⌘. toggles writing mode, collapsing both sides to rails and giving the editor their width", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\nWords." });
  await page.goto(`/note/draft-${note.id}`);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  expect(await width(page)).toBe(764);

  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+.");

  await expect(page.getByRole("navigation", { name: "Left rail" })).toBeVisible();
  for (const name of ["History", "Backlinks", "Info"]) await expect(page.getByRole("navigation", { name: "Right rail" }).getByRole("button", { name })).toBeVisible();
  await expect(tree(page)).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Writing mode" })).toHaveAttribute("aria-pressed", "true");
  expect(await width(page)).toBe(1192);

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Left rail" })).toBeVisible();
  await page.getByRole("button", { name: "Writing mode" }).click();
  await expect(tree(page)).toBeVisible();
  expect(await width(page)).toBe(764);
});

test("a rail opens its panel over the note without moving it, and opening a note from it closes it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const first = await perform(page, { type: "note.create", text: "# First\n\nOne." });
  const second = await perform(page, { type: "note.create", text: "# Second\n\nTwo." });
  await page.goto(`/note/first-${first.id}`);
  const text = page.getByRole("textbox", { name: "Note text" });
  await expect(text).toHaveText("# FirstOne.");
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("navigation", { name: "Left rail" })).toBeVisible();
  const before = await text.boundingBox();

  await page.getByRole("button", { name: "Info", exact: true }).click();
  const info = page.getByRole("dialog", { name: "Info" });
  await expect(info.getByRole("combobox", { name: "Move to" })).toHaveValue(first.folderId!);
  expect(await text.boundingBox()).toEqual(before);
  await text.click();
  await expect(info).toHaveCount(0);

  await page.getByRole("button", { name: "Folders", exact: true }).click();
  const folders = page.getByRole("dialog", { name: "Folders" });
  await expect(folders.getByRole("treeitem", { name: "Unsorted" })).toHaveAttribute("aria-selected", "true");
  expect(await text.boundingBox()).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(folders).toHaveCount(0);

  await page.getByRole("button", { name: "Folders", exact: true }).click();
  await expect(folders.getByRole("navigation", { name: "Notes" })).toHaveCount(0);
  await folders.getByRole("treeitem", { name: "All notes" }).click();
  await expect(folders).toHaveCount(0);
  await expect(page).toHaveURL(/\/folder\/all$/);
  await listedNote(page, "Second").click();
  await expect(page).toHaveURL(new RegExp(`/note/second-${second.id}$`));
  await expect(page.locator(".cm-line")).toHaveText(["# Second", "", "Two."]);
  expect(noteIdIn(page)).toBe(second.id);
});

test("the workspace menu names the workspace and your role, and signs out", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.getByRole("button", { name: "Ada's workspace Admin" }).click();

  const menu = page.getByRole("menu", { name: "Workspaces" });
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Ada's workspaceAdmin"]);
  await expect(menu.getByRole("menuitemradio")).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitem", { name: "Sign out" }).click();

  await expect(page.getByRole("button", { name: "Dev's workspace Admin" })).toBeVisible();
});
