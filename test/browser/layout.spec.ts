import { expect, test, type Page } from "@playwright/test";
import { listedNote, listedNotes, noteCard, noteIdIn, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const tree = (page: Page) => page.getByRole("tree", { name: "Folders" });
const folder = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
const editorPane = (page: Page) => page.getByRole("main", { name: "Editor" });
const width = async (page: Page) => (await editorPane(page).boundingBox())!.width;
/** In focus, the box of what is in front. */
const filled = (page: Page) => page.locator(".group-body").filter({ visible: true }).boundingBox();
const WINDOW = { x: 0, y: 0, width: 1280, height: 720 };
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
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open in a split right", "Open in a split down", "New folder inside", "Rename", "Delete"]);
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

test("More expands and collapses Contacts, Uploads, and History, and a mode not built yet names what builds it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const modes = page.getByRole("navigation", { name: "Modes" });
  await expect(modes.getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Calendar"]);

  const more = modes.getByRole("button", { name: "More" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  const less = modes.getByRole("button", { name: "Less" });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect(more).toHaveCount(0);
  await expect(modes.getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Calendar", "Contacts", "Uploads", "History", "Plugins"]);
  await modes.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(editorPane(page).getByRole("heading", { level: 1 })).toHaveText("History");
  await expect(editorPane(page)).toContainText("Nothing has been written in this workspace yet.");

  await less.click();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(modes.getByRole("link")).toHaveText(["Dashboard", "Search", "Todos", "Calendar"]);
  await modes.getByRole("link", { name: "Todos" }).click();
  await expect(editorPane(page).locator(".mode-view")).toHaveText("TodosTodos arrives with #18.");
});

test("More opens by itself when a mode under it is reached another way, and stays closed once closed by hand until the next time", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const modes = page.getByRole("navigation", { name: "Modes" });
  await modes.getByRole("button", { name: "More" }).click();
  await modes.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/\/history$/);

  // Closed by hand it stays closed, on this mode and on the ones that aren't under More.
  await modes.getByRole("button", { name: "Less" }).click();
  await expect(modes.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
  await modes.getByRole("link", { name: "Todos" }).click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(modes.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");

  // Back is another way to a mode under More.
  await page.goBack();
  await expect(page).toHaveURL(/\/history$/);
  await expect(modes.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  await expect(modes.getByRole("link", { name: "History" })).toHaveAttribute("aria-current", "page");
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

  await page.getByRole("searchbox", { name: "Filter notes" }).fill("RED");
  await expect(listedNotes(page)).toHaveText(["Apple"]);
  await page.getByRole("searchbox", { name: "Filter notes" }).fill("cherry");
  await expect(listedNotes(page)).toHaveText(["Cherry"]);
  await page.getByRole("searchbox", { name: "Filter notes" }).fill("kiwi");
  await expect(page.getByText("No notes match.")).toBeVisible();

  // The list is as it was left when its tab is come back to, and All notes says which folder each note is in.
  await page.getByRole("searchbox", { name: "Filter notes" }).fill("cherry");
  await expect(listedNotes(page)).toHaveText(["Cherry"]);
  await openAllNotes(page);
  await expect(noteCard(page, "Cherry").locator(".card-details")).toHaveText("FruitAda Lovelacejust now2 open");
  await folder(page, "Fruit").click();
  await expect(page.getByRole("searchbox", { name: "Filter notes" })).toHaveValue("cherry");
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
  // With no tab picked yet, Info shows.
  await expect(inspector.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
  const panel = inspector.getByRole("tabpanel");
  await expect(panel.getByRole("term")).toHaveText(["Folder", "Sharing", "Tags", "URL", "Archive"]);
  await expect(panel.getByRole("definition").first().locator("span")).toHaveText("Projects / Common Ink");
  await expect(panel.getByRole("combobox", { name: "Move to" })).toHaveValue(ink.id);
  await expect(panel.getByRole("definition").nth(1)).toHaveText("Everyone in this workspaceSharing with people and links arrives with #15.");
  await expect(panel.getByRole("definition").nth(2)).toHaveText("Tags arrive with #21.");
  await expect(panel.getByRole("textbox", { name: "Note URL" })).toHaveValue(new URL(`/note/roadmap-${note.id}`, page.url()).href);
  await panel.getByRole("button", { name: "Copy" }).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Archive" })).toBeDisabled();

  await inspector.getByRole("tab", { name: "History" }).click();
  await expect(panel.getByRole("listbox", { name: "Changes" }).getByRole("option")).toContainText("You wrote");
  await inspector.getByRole("tab", { name: "Backlinks" }).click();
  await expect(panel).toHaveText("No notes link here yet. Type [[ in another note to link to this one.");

  await inspector.getByRole("tab", { name: "Info" }).click();
  await panel.getByRole("combobox", { name: "Move to" }).selectOption({ label: "Projects" });
  await expect(panel.getByRole("definition").first().locator("span")).toHaveText("Projects");
  await expect(folder(page, "Projects")).toHaveAccessibleDescription("1");
  await expect(folder(page, "Common Ink")).toHaveAccessibleDescription("0");

  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Inspector", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(inspector).toHaveCount(0);
});

test("⌘. toggles focus, which shows the note with neither side nor a bar of icons, and gives the editor the whole window", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\nWords." });
  await page.goto(`/note/draft-${note.id}`);
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  expect(await width(page)).toBe(764);

  await page.getByRole("textbox", { name: "Note text" }).click();
  await page.keyboard.press("ControlOrMeta+.");

  await expect(page.getByRole("button", { name: "Focus" })).toHaveAttribute("aria-pressed", "true");
  await expect(tree(page)).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Window" })).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Focus" })).toHaveCount(1);
  expect(await filled(page)).toEqual(WINDOW);

  await page.reload();
  await expect(page.getByRole("button", { name: "Focus" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.getByRole("button", { name: "Focus" }).click();
  await expect(tree(page)).toBeVisible();
  expect(await width(page)).toBe(764);
});

test("focus shows neither bar when the sidebar and the inspector were closed, on a note and on a mode, and leaving it brings the bars back", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\nWords." });
  await page.goto(`/note/draft-${note.id}`);
  await page.getByRole("button", { name: "Sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar bar" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Inspector bar" })).toBeVisible();
  expect(await width(page)).toBe(1280 - 44 - 44);

  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("navigation")).toHaveCount(0);
  expect(await filled(page)).toEqual(WINDOW);

  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("complementary")).toHaveCount(0);
  expect(await filled(page)).toEqual(WINDOW);

  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("navigation", { name: "Sidebar bar" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Inspector bar" })).toBeVisible();
});

test("the inspector stays open whatever is in front and shows what belongs to it: a note's tabs, a folder's Info, and one quiet line on a mode", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const plan = await perform(page, { type: "note.create", folderId: projects.id, text: "# Plan" });
  await perform(page, { type: "note.create", folderId: projects.id, text: "# Budget" });
  await perform(page, { type: "note.create", text: "# Loose" });
  await page.goto(`/note/plan-${plan.id}`);

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  const panel = inspector.getByRole("tabpanel");
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Backlinks", "Info"]);
  await inspector.getByRole("tab", { name: "Info" }).click();
  await expect(panel.getByRole("textbox", { name: "Note URL" })).toBeVisible();
  const place = await inspector.boundingBox();

  await folder(page, "Projects").click();
  await expect(listHeading(page)).toHaveText("Projects");
  await expect(inspector.getByRole("tab")).toHaveText(["History", "Info"]);
  await expect(panel.getByRole("term")).toHaveText(["Folder", "Notes", "Last changed"]);
  await expect(panel.getByRole("definition")).toHaveText(["Projects", "2 notes", "just now by Ada Lovelace"]);
  await expect(panel.getByRole("textbox", { name: "Note URL" })).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: "Move to" })).toHaveCount(0);
  expect(await inspector.boundingBox()).toEqual(place);

  // The tab picked on a note is the one a folder showed, and the one a note comes back to.
  await page.goBack();
  await expect(inspector.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
  expect(await inspector.boundingBox()).toEqual(place);

  await openAllNotes(page);
  await expect(panel.getByRole("definition")).toHaveText(["All notes", "3 notes", "just now by Ada Lovelace"]);
  await newFolder(page, "Empty");
  await folder(page, "Empty").click();
  await expect(panel.getByRole("definition")).toHaveText(["Empty", "0 notes", "Nothing in it yet"]);

  await page.getByRole("link", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(inspector).toHaveText("Nothing to show for this view");
  await expect(inspector.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Inspector", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await inspector.boundingBox()).toEqual(place);

  await page.goto("/folder/nosuchfolder");
  await expect(page.getByText("This folder doesn't exist, or you can't see it.")).toBeVisible();
  await expect(inspector).toHaveText("Nothing to show for this view");

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

test("More opens by itself when a page under it is reached another way, and stays closed once closed by hand until the next time", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const modes = page.getByRole("navigation", { name: "Modes" });
  const run = async (command: string) => {
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.keyboard.type(command);
    await expect(page.getByRole("dialog", { name: "Commands" }).getByRole("option").first()).toHaveText(command);
    await page.keyboard.press("Enter");
  };
  await expect(modes.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");

  await run("Go to Plugins");
  await expect(page).toHaveURL(/\/plugins$/);
  await expect(modes.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  await expect(modes.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");

  // Closed by hand it stays closed, on this page and under it, and on the pages that aren't under More.
  await modes.getByRole("button", { name: "Less" }).click();
  await page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "Plugins" }).dblclick();
  await page.getByRole("list", { name: "Plugins" }).getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/\/plugins\/history$/);
  await expect(modes.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
  await modes.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(modes.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");

  // A tab is another way to a page under More.
  await page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "Plugins" }).click();
  await expect(modes.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  await expect(modes.getByRole("link", { name: "Plugins" })).toHaveAttribute("aria-current", "page");
});
