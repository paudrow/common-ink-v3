import { expect, type Locator, type Page } from "@playwright/test";
import { anotherPerson, folderRow, join, me, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const manage = (page: Page) => page.getByRole("dialog", { name: "Settings" }).getByRole("region", { name: "Folders" });
const manageTable = (page: Page) => manage(page).getByRole("treegrid", { name: "Folders" });
const manageRows = (page: Page) => manageTable(page).locator("tbody tr[data-key]");
const row = (page: Page, name: string) => manageRows(page).filter({ has: page.locator(".manage-name").getByText(name, { exact: true }) });
/** Where a box is and how big, to the pixel. */
const boxOf = async (locator: Locator) => {
  const { x, y, width, height } = (await locator.boundingBox())!;
  return [x, y, width, height].map(Math.round);
};
const card = (page: Page) => page.getByRole("tooltip");
const crumb = (page: Page, name: string) => page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("button", { name, exact: true });

/** Ada's workspace with Home, Garden inside it and a note there, Home Office beside Home, and Work. */
async function withFolders(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const home = await perform(page, { type: "folder.create", name: "Home" });
  const garden = await perform(page, { type: "folder.create", name: "Garden", parentId: home.id });
  const work = await perform(page, { type: "folder.create", name: "Work" });
  await perform(page, { type: "folder.create", name: "Home Office" });
  const seeds = await perform(page, { type: "note.create", folderId: garden.id, text: "# Seeds\n\nOrder seeds\n" });
  await perform(page, { type: "note.create", folderId: garden.id, text: "# Beds\n\nDig the beds\n" });
  return { home, garden, work, seeds };
}

test("Settings' Folders is the tree of folders, Unsorted first as in the sidebar and then in name order, each with what it is for and how many notes are in it and the folders inside it; a description is said by clicking it, in the box it is shown in, and kept after a reload", async ({ page }) => {
  const { garden } = await withFolders(page);
  await page.goto("/");
  await expect(folderRow(page, "Home")).toBeVisible();

  await runCommand(page, "Manage folders");
  await expect(page).toHaveURL(/\/settings\/folders$/);
  const categories = page.getByRole("dialog", { name: "Settings" }).getByRole("navigation", { name: "Categories" });
  await expect(categories.getByRole("link", { name: "Folders" })).toHaveAttribute("aria-current", "page");
  // Beside Tags, among the sections that hold no setting.
  await expect(categories.getByRole("link")).toContainText(["Folders", "Tags", "Account"]);
  await expect(manageTable(page).getByRole("columnheader")).toHaveText(["Folder", "Description", "Notes"]);
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Home", "Garden", "Home Office", "Work"]);
  expect(await manageRows(page).evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-level")))).toEqual(["1", "1", "2", "1", "1"]);
  // Home counts the notes in Garden, and says so.
  await expect(row(page, "Home").getByLabel("2 notes")).toHaveAttribute("title", "0 notes in Home itself, 2 counting the folders inside it");
  await expect(row(page, "Garden").getByLabel("2 notes")).toHaveText("2");
  // Every column lines up down the table, a folder inside another too.
  const columns = async (name: string) => Promise.all([row(page, name).getByRole("rowheader"), ...[0, 1].map((i) => row(page, name).getByRole("gridcell").nth(i))].map(async (cell) => (await boxOf(cell))[0]));
  expect(await columns("Garden")).toEqual(await columns("Home"));

  // Clicking the description says it in the very box it is shown in: nothing in the row moves.
  const gardenRow = row(page, "Garden");
  const said = gardenRow.locator(".manage-description");
  const before = [await boxOf(gardenRow), await boxOf(gardenRow.getByRole("gridcell").first())];
  await said.click();
  const field = manage(page).getByRole("textbox", { name: "What goes in Home / Garden" });
  await expect(field).toBeFocused();
  expect([await boxOf(gardenRow), await boxOf(gardenRow.getByRole("gridcell").first())]).toEqual(before);
  await page.keyboard.type("Seeds, beds and the greenhouse");
  await page.keyboard.press("Enter");
  await expect(field).toHaveCount(0);
  await expect(said).toHaveText("Seeds, beds and the greenhouse");
  await expect(gardenRow).toBeFocused();
  await expect.poll(async () => (await perform(page, { type: "folder.find", path: "Home/Garden" })).description).toBe("Seeds, beds and the greenhouse");

  // Escape leaves it as it was, and Settings open; Enter on the row says it too, and Shift+Enter starts a line.
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("Seeds, beds and the greenhouse");
  await page.keyboard.type(" and more");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(said).toHaveText("Seeds, beds and the greenhouse");
  await expect(gardenRow).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Pots too");
  await expect(field).toHaveValue("Seeds, beds and the greenhouse\nPots too");
  // Leaving the box keeps what was typed.
  await manage(page).getByRole("heading", { name: "Folders" }).click();
  await expect(said).toHaveText("Seeds, beds and the greenhouse\nPots too");

  await page.reload();
  await expect(row(page, "Garden").locator(".manage-description")).toHaveText("Seeds, beds and the greenhouse\nPots too");
  await row(page, "Garden").locator(".manage-description").click();
  await field.fill("");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await perform(page, { type: "folder.find", path: "Home/Garden" })).description).toBeUndefined();
  // With nothing said, the cell is blank but for the row under the pointer or the keyboard.
  await manage(page).getByRole("heading", { name: "Folders" }).click();
  await expect(row(page, "Garden").locator(".manage-placeholder")).toBeHidden();
  await row(page, "Garden").hover();
  await expect(row(page, "Garden").locator(".manage-placeholder")).toHaveText("Add a description");
  await expect(row(page, "Garden").locator(".manage-placeholder")).toBeVisible();

  // Clicking another description while one is being saved leaves the new one open.
  await row(page, "Garden").locator(".manage-description").click();
  await page.keyboard.type("Beds");
  await row(page, "Home").locator(".manage-description").click();
  const home = manage(page).getByRole("textbox", { name: "What goes in Home" });
  await expect(home).toBeFocused();
  await expect(row(page, "Garden").locator(".manage-description")).toHaveText("Beds");
  await expect(home).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(home).toHaveCount(0);

  // Its menu opens the folder's list.
  await row(page, "Garden").getByRole("rowheader").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Home / Garden actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Open", "RenameF2", "Edit descriptionEnter", "New folder inside", "Move to…"]);
  await menu.getByRole("menuitem", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`/folder/${garden.id}$`));
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
});

test("a folder is renamed in its row by a double click, F2 or its pencil, made with New folder or inside another from its menu, and moved by dragging its name onto another row or with Move to…", async ({ page }) => {
  const { home } = await withFolders(page);
  await page.goto("/settings/folders");
  // Held by its key, which stays while the name is being changed.
  const work = manageRows(page).and(page.locator(`[data-key="${(await perform(page, { type: "folder.find", path: "Work" })).id}"]`));
  await expect(work).toBeVisible();

  // A double click on the name: Enter keeps it, and the row goes to its place in name order.
  const before = await boxOf(work);
  await work.locator(".manage-name").dblclick();
  const renaming = manage(page).getByRole("textbox", { name: "Rename Work" });
  await expect(renaming).toHaveValue("Work");
  expect(await boxOf(work)).toEqual(before);
  await renaming.fill("Clients");
  await page.keyboard.press("Enter");
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Clients", "Home", "Garden", "Home Office"]);
  await expect(row(page, "Clients")).toBeFocused();
  // F2 on the row, and Escape keeps the name.
  await page.keyboard.press("F2");
  await page.keyboard.type("Nope");
  await page.keyboard.press("Escape");
  await expect(row(page, "Clients")).toBeFocused();
  await expect(manageRows(page).getByRole("rowheader").nth(1)).toHaveText("Clients");
  // The pencil shows on the row under the pointer, and is a bare icon. A click leaves none behind.
  await row(page, "Clients").locator(".manage-name").click();
  await expect(row(page, "Clients")).toBeFocused();
  const pencil = row(page, "Clients").getByRole("button", { name: "Rename Clients" });
  await expect(pencil).toBeVisible();
  expect(await pencil.evaluate((el) => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).backgroundColor])).toEqual(["0px", "rgba(0, 0, 0, 0)"]);
  await row(page, "Home Office").hover();
  await expect(pencil).toBeHidden();

  // New folder: a name is needed, and with none the row is dropped.
  await manage(page).getByRole("button", { name: "New folder" }).click();
  await page.keyboard.press("Enter");
  await expect(manage(page).getByRole("textbox", { name: "New folder" })).toHaveCount(0);
  await manage(page).getByRole("button", { name: "New folder" }).click();
  await page.keyboard.type("Archive");
  await page.keyboard.press("Enter");
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Archive", "Clients", "Home", "Garden", "Home Office"]);
  await row(page, "Home").getByRole("rowheader").click({ button: "right" });
  await page.getByRole("menu", { name: "Home actions" }).getByRole("menuitem", { name: "New folder inside" }).click();
  await page.keyboard.type("Attic");
  await page.keyboard.press("Enter");
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Archive", "Clients", "Home", "Attic", "Garden", "Home Office"]);
  expect((await perform(page, { type: "folder.find", path: "Home/Attic" })).parentId).toBe(home.id);

  // Dragged by its name onto another row, it goes inside that one, and what it will be is said before the drop.
  const name = row(page, "Archive").locator(".manage-name");
  await expect(name).toHaveAttribute("title", "Drag to move");
  await name.hover();
  await page.mouse.down();
  const onto = (await row(page, "Clients").boundingBox())!;
  await page.mouse.move(onto.x + 40, onto.y + onto.height / 2, { steps: 8 });
  await expect(page.locator(".manage-drag-label")).toHaveText("Archive → Clients / Archive");
  await expect(row(page, "Clients")).toHaveAttribute("data-drop", "true");
  await page.mouse.up();
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Clients", "Archive", "Home", "Attic", "Garden", "Home Office"]);
  await expect(page.locator(".toast-card")).toContainText('Moved "Archive" into "Clients"');

  // A folder inside another dragged under the table goes to the top.
  await row(page, "Attic").locator(".manage-name").hover();
  await page.mouse.down();
  await page.mouse.move(onto.x + 40, onto.y + onto.height * 3, { steps: 4 });
  const strip = manage(page).getByText("Drop here to move to the top level");
  const at = (await strip.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 8 });
  await expect(page.locator(".manage-drag-label")).toHaveText("Home / Attic → Attic");
  await page.mouse.up();
  await expect(strip).toHaveCount(0);
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Attic", "Clients", "Archive", "Home", "Garden", "Home Office"]);

  // Move to… from the menu, for the keyboard.
  await row(page, "Attic").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "Attic actions" }).getByRole("menuitem", { name: "Move to…" }).click();
  await page.getByRole("combobox", { name: "Move Attic to" }).fill("garden");
  await page.keyboard.press("Enter");
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Clients", "Archive", "Home", "Garden", "Attic", "Home Office"]);
  expect(await manageRows(page).evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-level")))).toEqual(["1", "1", "2", "1", "2", "3", "1"]);

  // The arrow keys go through the rows, and shut and open a folder.
  await row(page, "Home").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(manageRows(page).getByRole("rowheader")).toHaveText(["Unsorted", "Clients", "Archive", "Home", "Home Office"]);
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "Home Office")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Garden")).toBeVisible();
});

test("a viewer and a guest read every folder's description in Settings and are given nothing to change it with, and the server refuses them", async ({ page }) => {
  const { garden, seeds } = await withFolders(page);
  await perform(page, { type: "folder.describe", id: garden.id, description: "Seeds and beds" });
  const workspaceId = (await me(page)).workspaces[0]!.id;

  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  await vera.goto(`/note/${seeds.id}`);
  await expect(editor(vera)).toContainText("Order seeds");
  await runCommand(vera, "Manage folders");
  await expect(row(vera, "Garden").locator(".manage-description")).toHaveText("Seeds and beds");
  await expect(manage(vera)).toContainText("Admins and editors write it.");
  // Nothing to change with: no pencil, no New folder, no box, and a click on a name or a description writes nothing.
  await expect(manage(vera).getByRole("button", { name: /Rename|New folder/ })).toHaveCount(0);
  await row(vera, "Garden").locator(".manage-description").click();
  await row(vera, "Work").locator(".manage-name").dblclick();
  await expect(manageTable(vera).getByRole("textbox")).toHaveCount(0);
  await expect(row(vera, "Work").locator(".manage-name")).not.toHaveAttribute("draggable");
  await expect(perform(vera, { type: "folder.describe", id: garden.id, description: "Mine" }, workspaceId)).rejects.toThrow("A viewer can't folder.describe");

  const gus = await anotherPerson(page, "Gus Guest");
  await perform(page, { type: "grant.set", folderId: garden.id, email: (await me(gus)).person.email, access: "edit" });
  await gus.goto(`/note/${seeds.id}`);
  await expect(editor(gus)).toContainText("Order seeds");
  await runCommand(gus, "Manage folders");
  await expect(manageRows(gus).locator(".manage-description")).toHaveText(["Seeds and beds"]);
  await expect(manage(gus).getByRole("button", { name: /Rename|New folder/ })).toHaveCount(0);
  await expect(perform(gus, { type: "folder.describe", id: garden.id, description: "Mine" }, workspaceId)).rejects.toThrow("A guest can't folder.describe");
  expect((await perform(page, { type: "folder.find", path: "Home/Garden" })).description).toBe("Seeds and beds");
});

test("resting on a folder in the sidebar or in the breadcrumbs shows its card: how many notes are in it and what it is for, or for whoever may say it a prompt to, with a link to its row in Settings; the keyboard shows it too, and a viewer sees the name and count alone", async ({ page }) => {
  const { home, seeds } = await withFolders(page);
  await perform(page, { type: "folder.describe", id: home.id, description: "The house and everything in it" });
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("Order seeds");

  await folderRow(page, "Home").hover();
  await expect(card(page)).toHaveText("Home0 notesThe house and everything in itManage folders");
  await folderRow(page, "Garden").hover();
  await expect(card(page)).toHaveText("Home / Garden2 notesNo description yet. Add one to help AI file notes in Garden.Manage folders");
  await page.mouse.move(600, 5);
  await expect(card(page)).toHaveCount(0);

  // In the breadcrumbs, under the crumb, and the pointer can cross to the card to follow its link to the folder's row, open to describe it.
  await crumb(page, "Home").hover();
  await expect(card(page)).toContainText("The house and everything in it");
  await crumb(page, "Garden").hover();
  await expect(card(page)).toContainText("No description yet.");
  const at = (await crumb(page, "Garden").boundingBox())!;
  expect((await card(page).boundingBox())!.y).toBeGreaterThan(at.y + at.height);
  await card(page).getByRole("link", { name: "Manage folders" }).click();
  await expect(page).toHaveURL(/\/settings\/folders$/);
  await expect(card(page)).toHaveCount(0);
  await expect(manage(page).getByLabel("What goes in Home / Garden")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

  // The keyboard on a folder's row shows its card, which describes it, and Escape takes it away.
  await folderRow(page, "Garden").focus();
  await page.keyboard.press("ArrowUp");
  const homeRow = folderRow(page, "Home");
  await expect(homeRow).toBeFocused();
  await expect(card(page)).toContainText("The house and everything in it");
  await expect(homeRow).toHaveAttribute("aria-describedby", new RegExp(`${(await card(page).getAttribute("id"))!}$`));
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(homeRow).not.toHaveAttribute("aria-describedby", /folder-card/);

  // Its name opens the folder's list.
  await folderRow(page, "Garden").hover();
  await card(page).getByRole("link", { name: "Home / Garden" }).click();
  await expect(page).toHaveURL(/\/folder\/[a-z0-9]{12}$/);
  await expect(card(page)).toHaveCount(0);

  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  await vera.goto(`/note/${seeds.id}`);
  await expect(editor(vera)).toContainText("Order seeds");
  await folderRow(vera, "Garden").hover();
  await expect(card(vera)).toHaveText("Home / Garden2 notes");
  await folderRow(vera, "Home").hover();
  await expect(card(vera)).toHaveText("Home0 notesThe house and everything in it");
});

test("a folder's card stays while the pointer rests anywhere on it, its description and its padding too, and goes once the pointer leaves it", async ({ page }) => {
  const { home, seeds } = await withFolders(page);
  await perform(page, { type: "folder.describe", id: home.id, description: "The house and everything in it" });
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("Order seeds");
  await folderRow(page, "Home").hover();
  await expect(card(page)).toContainText("The house and everything in it");
  const description = (await card(page).getByText("The house and everything in it").boundingBox())!;
  await page.mouse.move(description.x + description.width / 2, description.y + description.height / 2, { steps: 10 });
  await page.waitForTimeout(1500);
  await expect(card(page)).toContainText("The house and everything in it");
  const box = (await card(page).boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 5 });
  await page.waitForTimeout(1500);
  await expect(card(page)).toContainText("The house and everything in it");
  await page.mouse.move(700, 300, { steps: 5 });
  await expect(card(page)).toHaveCount(0);
});

test("a menu opened from the keyboard while a folder's card shows under the resting pointer takes the card away, and Escape goes to the menu", async ({ page }) => {
  const { work } = await withFolders(page);
  await perform(page, { type: "note.create", folderId: work.id, text: "# Plans\n\nThe plans\n" });
  await page.goto("/");
  await folderRow(page, "Work").click();
  await expect(card(page)).toContainText("No description yet.");
  await page.getByRole("navigation", { name: "Notes" }).getByRole("article", { name: "Plans", exact: true }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More for Plans" })).toBeFocused();
});

test("a folder's menu in the sidebar has Manage folders, which opens Settings' Folders at its row, in view with the keyboard on it and the folders it is inside open, to describe it there; a viewer's has it too, to read", async ({ page }) => {
  const { home, seeds } = await withFolders(page);
  const cellar = await perform(page, { type: "folder.create", name: "Cellar", parentId: home.id });
  const shelf = await perform(page, { type: "folder.create", name: "Shelf", parentId: cellar.id });
  await Promise.all(Array.from({ length: 24 }, (_, i) => perform(page, { type: "folder.create", name: `Archive ${String(i).padStart(2, "0")}` })));
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("Order seeds");

  await folderRow(page, "Work").click({ button: "right" });
  await page.getByRole("menu", { name: "Work actions" }).getByRole("menuitem", { name: "Manage folders" }).click();
  await expect(page).toHaveURL(/\/settings\/folders$/);
  await expect(row(page, "Work")).toBeFocused();
  await expect(row(page, "Work")).toBeInViewport();
  await expect(row(page, "Archive 00")).not.toBeInViewport();
  // Marked as the keyboard's row, though a click brought it there.
  expect(await row(page, "Work").evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  await page.keyboard.press("Enter");
  await expect(manage(page).getByLabel("What goes in Work")).toBeFocused();
  await page.keyboard.type("Clients, invoices and plans");
  await page.keyboard.press("Enter");
  await expect(row(page, "Work").locator(".manage-description")).toHaveText("Clients, invoices and plans");
  await expect(row(page, "Work")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await folderRow(page, "Work").hover();
  await expect(card(page)).toContainText("Clients, invoices and plans");

  // A folder inside others, its row and the rows it is inside open.
  await page.goto(`/folder/${shelf.id}`);
  await folderRow(page, "Shelf").click({ button: "right" });
  await page.getByRole("menu", { name: "Shelf actions" }).getByRole("menuitem", { name: "Manage folders" }).click();
  const shelfRow = manageRows(page).and(page.locator(`[data-key="${shelf.id}"]`));
  await expect(shelfRow).toBeFocused();
  await expect(shelfRow).toBeInViewport();
  await expect(manageRows(page).and(page.locator(`[data-key="${home.id}"]`))).toHaveAttribute("aria-expanded", "true");
  await expect(manageRows(page).and(page.locator(`[data-key="${cellar.id}"]`))).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");

  const vera = await anotherPerson(page, "Vera Viewer");
  await join(vera, page, "viewer");
  await vera.goto(`/note/${seeds.id}`);
  await expect(editor(vera)).toContainText("Order seeds");
  await folderRow(vera, "Work").click({ button: "right" });
  await vera.getByRole("menu", { name: "Work actions" }).getByRole("menuitem", { name: "Manage folders" }).click();
  await expect(row(vera, "Work")).toBeFocused();
  await expect(row(vera, "Work").locator(".manage-description")).toHaveText("Clients, invoices and plans");
});

test("a folder's card goes when its menu opens and stays away while the menu is up", async ({ page }) => {
  const { seeds } = await withFolders(page);
  await page.goto(`/note/${seeds.id}`);
  await expect(editor(page)).toContainText("Order seeds");
  const home = folderRow(page, "Home");

  await home.hover();
  await expect(card(page)).toContainText("Home0 notes");
  await home.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await home.hover({ position: { x: 30, y: 4 } });
  await home.hover({ position: { x: 40, y: 6 } });
  await page.waitForTimeout(800);
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.mouse.move(700, 300);
  await home.hover();
  await expect(card(page)).toContainText("Home0 notes");
});
