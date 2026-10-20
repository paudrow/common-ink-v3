import { expect, type Locator, type Page } from "@playwright/test";
import { anotherPerson, asViewerOfNote, folderRow, listedNotes, me, noteCard, openAllNotes, perform, showPanel, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).first().getByRole("tab");
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const field = (page: Page) => page.getByRole("searchbox", { name: "Search notes" });
const scope = (page: Page) => page.locator(".finder-scope");
const count = (page: Page) => page.locator(".folder-count");
/** Which notes a list is of, said in its query as the Search page's is: with `words` before it. */
const show = (page: Page, which: "Open" | "Archived" | "All", words = "") =>
  field(page).fill([words, { Open: "", Archived: "is:archived", All: "(is:open OR is:archived)" }[which]].filter(Boolean).join(" "));
const notice = (page: Page) => page.getByRole("group", { name: "Notice" });
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const newInSidebar = (page: Page) => sidebar(page).getByRole("button", { name: "New note" });
const stateOf = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).state;
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const shownAt = (el: Locator) => el.evaluate((node) => getComputedStyle(node).opacity);

/** Every search the page asks the server for, as it was sent. */
function searchesOf(page: Page) {
  const asked: { query: string; folderId?: string; includeArchived?: boolean | "only"; sort?: string }[] = [];
  page.on("request", (request) => {
    const body = request.postData();
    if (body?.includes('"type":"search"')) asked.push(JSON.parse(body));
  });
  return asked;
}

async function withFolders(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const inside = await perform(page, { type: "folder.create", name: "Inside", parentId: projects.id });
  const journal = await perform(page, { type: "folder.create", name: "Journal" });
  const plan = await perform(page, { type: "note.create", folderId: projects.id, text: "# Plan\n\nBuy ink for the heron drawings.\n\n- [ ] order paper +Studio\n" });
  const budget = await perform(page, { type: "note.create", folderId: projects.id, text: "# Budget\n\nInk costs, and a heron fund. #money\n" });
  const inner = await perform(page, { type: "note.create", folderId: inside.id, text: "# Inner\n\nA heron inside.\n" });
  const monday = await perform(page, { type: "note.create", folderId: journal.id, text: "# Monday\n\nSaw a heron in the rain.\n" });
  const loose = await perform(page, { type: "note.create", text: "# Loose\n\nA heron with no folder.\n" });
  await page.reload();
  return { projects, inside, journal, plan, budget, inner, monday, loose };
}

test("a folder's tab has the app's search bar with that folder selected, and taking the folder off searches every note", async ({ page }) => {
  const { projects } = await withFolders(page);
  const asked = searchesOf(page);

  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Budget", "Plan"]);
  await expect(scope(page)).toHaveText("Projects");
  await expect(field(page)).toHaveAttribute("placeholder", 'Search this folder: words, "a phrase", #tag, is:archived');
  await expect(count(page)).toHaveText("2 notes");

  // The folder's own notes are searched, not those of the folders inside it, with the query the Search page takes.
  await field(page).fill("heron");
  await expect(count(page)).toHaveText("2 of 2 notes");
  await expect(listedNotes(page)).toHaveText(["Budget", "Plan"]);
  await expect(noteCard(page, "Plan").locator(".found-line")).toHaveText(["Buy ink for the heron drawings."]);
  await expect(noteCard(page, "Plan").locator("mark")).toHaveText(["heron"]);
  await field(page).fill("#money");
  await expect(listedNotes(page)).toHaveText(["Budget"]);
  await field(page).fill("+studio");
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await field(page).fill('"heron fund"');
  await expect(listedNotes(page)).toHaveText(["Budget"]);
  await field(page).fill("rain");
  await expect(page.locator(".empty")).toHaveText("No notes match “rain” in Projects. Archived notes are left out: add is:archived to search them.");
  expect(asked.map((a) => [a.query, a.folderId])).toEqual([["heron", projects.id], ["#money", projects.id], ["+studio", projects.id], ['"heron fund"', projects.id], ["rain", projects.id]]);

  // A found card is the list's card: its note is drawn under the lines that matched.
  await field(page).fill("heron");
  await expect(noteCard(page, "Plan").locator(".found-line")).toHaveText(["Buy ink for the heron drawings."]);
  await expect(noteCard(page, "Plan").locator(".card-body .cm-line").first()).toHaveText("# Plan");

  await page.getByRole("button", { name: "Search all notes, not only Projects" }).click();
  await expect(tabs(page).filter({ hasText: "All notes" })).toHaveAttribute("aria-selected", "true");
  await expect(scope(page)).toHaveCount(0);
  await expect(field(page)).toHaveValue("heron");
  await expect(field(page)).toHaveAttribute("placeholder", 'Search all notes: words, "a phrase", #tag, is:archived');
  await expect(listedNotes(page)).toHaveText(["Loose", "Monday", "Inner", "Budget", "Plan"]);
  await expect(count(page)).toHaveText("5 of 5 notes");
  expect(asked.at(-1)).toMatchObject({ query: "heron" });
  expect(asked.at(-1)).not.toHaveProperty("folderId");

  // The folder's list is as it was left, and Unsorted is a folder like any other.
  await folderRow(page, "Projects").click();
  await expect(field(page)).toHaveValue("heron");
  await expect(listedNotes(page)).toHaveText(["Budget", "Plan"]);
  await folderRow(page, "Unsorted").click();
  await expect(scope(page)).toHaveText("Unsorted");
  await expect(listedNotes(page)).toHaveText(["Loose"]);
});

test("a folder's notes are listed from what the app holds: nothing is searched for until something is typed", async ({ page }) => {
  await withFolders(page);
  const asked = searchesOf(page);

  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Budget", "Plan"]);
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveCount(5);
  expect(asked).toEqual([]);

  await field(page).fill("heron");
  await expect(count(page)).toHaveText("5 of 5 notes");
  await field(page).fill("");
  await expect(count(page)).toHaveText("5 notes");
  await expect(page.locator(".card-matches")).toHaveCount(0);
  expect(asked.map((a) => a.query)).toEqual(["heron"]);
});

test("a folder's list leaves archived notes out, and its query lists them, alone or with the rest", async ({ page }) => {
  const { plan } = await withFolders(page);
  await perform(page, { type: "note.archive", id: plan.id, archived: true });
  await page.reload();

  await folderRow(page, "Projects").click();
  await expect(page.getByRole("radiogroup", { name: "Show" })).toHaveCount(0);
  await expect(listedNotes(page)).toHaveText(["Budget"]);
  await expect(count(page)).toHaveText("1 note");

  await show(page, "Archived");
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(noteCard(page, "Plan").locator(".state-label")).toHaveText("Archived");
  await show(page, "All");
  await expect.poll(async () => (await listedNotes(page).allTextContents()).sort()).toEqual(["Budget", "Plan"]);

  await show(page, "Archived", "heron");
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await show(page, "Open", "heron");
  await expect(listedNotes(page)).toHaveText(["Budget"]);
  await expect(page.locator(".empty, .search-status")).toHaveCount(0);

  // An archived folder with none says so, and the query is the folder's while the app is open.
  await folderRow(page, "Journal").click();
  await show(page, "Archived");
  await expect(page.locator(".empty")).toContainText("No notes match");
  await folderRow(page, "Projects").click();
  await expect(field(page)).toHaveValue("heron");
  await folderRow(page, "Journal").click();
  await expect(field(page)).toHaveValue("is:archived");
});

test("a card's Archive is its button beside the menu, an item in the menu, or the E key, with Undo, and the card leaves the Open list at once", async ({ page }) => {
  const { plan, budget } = await withFolders(page);
  await folderRow(page, "Projects").click();
  await expect(listedNotes(page)).toHaveText(["Budget", "Plan"]);
  const more = noteCard(page, "Budget").getByRole("button", { name: "More for Budget" });

  // The menu's button is there whether or not the card is pointed at, and nothing of a card waits for a hover.
  await page.mouse.move(5, 5);
  await expect(more).toBeVisible();
  await expect.poll(() => shownAt(more)).toBe("1");
  await expect(noteCard(page, "Budget").getByRole("button", { name: "Archive Budget" })).toBeVisible();

  await more.click();
  await menuItem(page, "Archive").click();
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(notice(page)).toContainText("Archived");
  await expect.poll(() => stateOf(page, budget.id)).toBe("archived");
  await expect(folderRow(page, "Projects")).toHaveAccessibleDescription("1");
  await notice(page).getByRole("button", { name: "Undo" }).click();
  await expect(listedNotes(page)).toHaveText(["Budget", "Plan"]);
  await expect.poll(() => stateOf(page, budget.id)).toBe("live");

  // E archives the focused card and the next one takes the focus, so a list is gone through with one key.
  await noteCard(page, "Budget").focus();
  await page.keyboard.press("e");
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(noteCard(page, "Plan")).toBeFocused();
  await page.keyboard.press("e");
  await expect(listedNotes(page)).toHaveCount(0);
  await expect.poll(() => stateOf(page, plan.id)).toBe("archived");
  await expect(page.locator(".empty")).toHaveText("No notes in this folder.");

  // In a text field E is a letter.
  await field(page).fill("");
  await field(page).press("e");
  await expect(field(page)).toHaveValue("e");
  await field(page).fill("");

  // An archived card offers the way back, and leaves the Archived list as it is taken.
  await show(page, "Archived");
  await expect(listedNotes(page)).toHaveText(["Budget", "Plan"]);
  await noteCard(page, "Plan").getByRole("button", { name: "More for Plan" }).click();
  await expect(menuItem(page, "Unarchive")).toBeVisible();
  await expect(menuItem(page, "Archive")).toHaveCount(0);
  await menuItem(page, "Unarchive").click();
  await expect(listedNotes(page)).toHaveText(["Budget"]);
  await expect.poll(() => stateOf(page, plan.id)).toBe("live");
  await show(page, "All");
  await expect.poll(async () => (await listedNotes(page).allTextContents()).sort()).toEqual(["Budget", "Plan"]);
  await expect(noteCard(page, "Budget").locator(".state-label")).toHaveText("Archived");
  await noteCard(page, "Budget").focus();
  await page.keyboard.press("e");
  await expect(noteCard(page, "Budget").locator(".state-label")).toHaveCount(0);
  await expect(noteCard(page, "Budget")).toBeFocused();

  // A found note is archived the same way, and leaves the results.
  await show(page, "Open", "heron");
  await expect(count(page)).toHaveText("2 of 2 notes");
  await noteCard(page, "Plan").focus();
  await page.keyboard.press("e");
  await expect(listedNotes(page)).toHaveText(["Budget"]);
  // Nothing was opened by it: the only notes drawn are the cards' own readings.
  await expect(editor(page)).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["Projects"]);
});

test("a viewer's cards have no Archive, and E does nothing for them", async ({ page }) => {
  const { note, workspaceId } = await asViewerOfNote(page, "# Plan\n\nAda's words.");
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Ada's words.");
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(noteCard(page, "Plan").getByRole("link", { name: "Edit Plan" })).toBeVisible();
  await noteCard(page, "Plan").getByRole("button", { name: "More for Plan" }).click();
  await expect(menuItem(page, "Copy link")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /archive|trash|move|share/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await noteCard(page, "Plan").focus();
  await page.keyboard.press("e");
  await page.waitForTimeout(500);
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await expect(notice(page)).toHaveCount(0);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id }, workspaceId)).state).toBe("live");
  await expect(newInSidebar(page)).toHaveCount(0);
});

test("a sort: in a folder's query orders its list and a search, which is by best match until it says another order", async ({ page }) => {
  const { plan } = await withFolders(page);
  await perform(page, { type: "note.write", id: plan.id, baseRevision: 1, text: "# Plan\n\nBuy ink for the heron drawings, soon.\n" });
  await page.reload();
  const asked = searchesOf(page);
  await openAllNotes(page);

  await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveCount(0);
  await expect(listedNotes(page)).toHaveText(["Plan", "Loose", "Monday", "Inner", "Budget"]);
  await field(page).fill("sort:created-desc");
  await expect(listedNotes(page)).toHaveText(["Loose", "Monday", "Inner", "Budget", "Plan"]);
  await field(page).fill("sort:title-asc");
  await expect(listedNotes(page)).toHaveText(["Budget", "Inner", "Loose", "Monday", "Plan"]);
  // A sort: alone is the folder's own notes in that order: nothing is searched for.
  expect(asked).toEqual([]);

  await field(page).fill("ink");
  await expect(count(page)).toHaveText("2 of 5 notes");
  await field(page).fill("plan heron");
  await expect(listedNotes(page)).toHaveText(["Plan"]);
  await field(page).fill("heron");
  await expect(listedNotes(page)).toHaveText(["Plan", "Loose", "Monday", "Inner", "Budget"]);
  await field(page).fill("heron sort:title-asc");
  await expect(listedNotes(page)).toHaveText(["Budget", "Inner", "Loose", "Monday", "Plan"]);
  await field(page).fill("heron sort:created-desc");
  await expect(listedNotes(page)).toHaveText(["Loose", "Monday", "Inner", "Budget", "Plan"]);
  expect(asked.map((a) => a.query)).toEqual(["ink", "plan heron", "heron", "heron sort:title-asc", "heron sort:created-desc"]);

  // The query is the folder's while the app is open: another folder has its own, and this one is found as it was left.
  await folderRow(page, "Projects").click();
  await expect(field(page)).toHaveValue("");
  await openAllNotes(page);
  await expect(field(page)).toHaveValue("heron sort:created-desc");
  await expect(listedNotes(page)).toHaveText(["Loose", "Monday", "Inner", "Budget", "Plan"]);
});

test("New note in the left column makes a note in the folder being looked at, with the cursor in it", async ({ page }) => {
  await withFolders(page);

  // With no folder in front, as at the Dashboard, it goes in Unsorted.
  await expect(page.getByRole("region", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(newInSidebar(page)).toHaveCount(1);
  await expect(newInSidebar(page)).toHaveAttribute("title", "New note in Unsorted");
  await newInSidebar(page).click();
  await expect(editor(page)).toBeFocused();
  await expect(folderRow(page, "Unsorted")).toHaveAccessibleDescription("2");

  await folderRow(page, "Journal").click();
  await expect(newInSidebar(page)).toHaveAttribute("title", "New note in Journal");
  // The folder's own button is still there, and the two are the only ones.
  await expect(page.getByRole("button", { name: "New note" })).toHaveCount(2);
  await newInSidebar(page).click();
  await expect(editor(page)).toBeFocused();
  await expect(folderRow(page, "Journal")).toHaveAccessibleDescription("2");
  await page.keyboard.type("# Tuesday");
  await expect(tabs(page).filter({ hasText: "Tuesday" })).toHaveCount(1);
  await showPanel(page, "Info");
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("Journal");

  // With a note in front, it goes beside that note.
  await newInSidebar(page).click();
  await expect(folderRow(page, "Journal")).toHaveAccessibleDescription("3");

  await openAllNotes(page);
  await expect(newInSidebar(page)).toHaveAttribute("title", "New note in Unsorted");
  await newInSidebar(page).click();
  await expect(folderRow(page, "Unsorted")).toHaveAccessibleDescription("3");
});

test("a guest who can't add notes where they are is shown New note with the reason, and it makes nothing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const readOnly = await perform(page, { type: "folder.create", name: "Policies" });
  const open = await perform(page, { type: "folder.create", name: "Drafts" });
  const policy = await perform(page, { type: "note.create", folderId: readOnly.id, text: "# Leave policy\n\nRead me." });
  const grace = await anotherPerson(page, "Grace Hopper");
  const email = (await me(grace)).person.email;
  await perform(page, { type: "grant.set", folderId: readOnly.id, email, access: "view" });
  await perform(page, { type: "grant.set", folderId: open.id, email, access: "edit" });
  const workspaceId = (await me(page)).workspaces[0]!.id;
  await grace.goto(`/note/${policy.id}`);
  await expect(editor(grace)).toContainText("Read me.");

  await folderRow(grace, "Policies").click();
  await expect(listedNotes(grace)).toHaveText(["Leave policy"]);
  await expect(newInSidebar(grace)).toHaveAttribute("aria-disabled", "true");
  await expect(newInSidebar(grace)).toHaveAttribute("title", "You can read Policies, and not add notes to it");
  // Pressed all the same, as a person can.
  await newInSidebar(grace).click({ force: true });
  await grace.waitForTimeout(500);
  await expect(listedNotes(grace)).toHaveText(["Leave policy"]);
  await expect.poll(async () => (await perform(grace, { type: "note.list" }, workspaceId)).notes).toHaveLength(1);

  await folderRow(grace, "Drafts").click();
  await expect(newInSidebar(grace)).toHaveAttribute("aria-disabled", "false");
  const box = await newInSidebar(grace).boundingBox();
  await newInSidebar(grace).click();
  await expect(editor(grace)).toBeFocused();
  await expect(folderRow(grace, "Drafts")).toHaveAccessibleDescription("1");
  await folderRow(grace, "Policies").click();
  // It is in the same place whether or not it can be used, so nothing in the column moves between folders.
  await expect.poll(() => newInSidebar(grace).boundingBox()).toEqual(box);
});

test("a folder's search bar takes the query language, with Advanced beside it, and searches that folder's own notes", async ({ page }) => {
  const { projects, budget } = await withFolders(page);
  const asked = searchesOf(page);
  await page.goto(`/folder/${projects.id}`);
  await expect(scope(page)).toHaveText("Projects");
  await field(page).fill("heron -tag:money");
  await expect(page.locator(".card-title")).toHaveText(["Plan"]);
  // The folder's own notes are searched, and a filter narrows inside them: the note of the folder inside it is not listed.
  await field(page).fill("heron OR has:todo");
  await expect.poll(async () => (await page.locator(".card-title").allTextContents()).sort()).toEqual(["Budget", "Plan"]);
  expect(asked.at(-1)).toMatchObject({ query: "heron OR has:todo", folderId: projects.id });
  // The query says which notes are listed by where they are in their life.
  await perform(page, { type: "note.archive", id: budget.id, archived: true });
  await expect(page.locator(".card-title")).toHaveText(["Plan"]);
  await show(page, "All", "heron");
  await expect.poll(async () => (await page.locator(".card-title").allTextContents()).sort()).toEqual(["Budget", "Plan"]);
  await field(page).fill("heron is:archived");
  await expect(page.locator(".card-title")).toHaveText(["Budget"]);

  // The builder is the same one, here, and writes into this folder's bar.
  await page.getByRole("button", { name: "Advanced" }).click();
  const builder = page.getByRole("group", { name: "Advanced search" });
  await expect(builder.getByRole("group", { name: /^Condition / })).toHaveCount(2);
  await builder.getByRole("group", { name: "Condition 2" }).getByRole("button", { name: "Remove condition 2" }).click();
  await expect(field(page)).toHaveValue("heron");
  await expect(page.locator(".card-title")).toHaveText(["Plan"]);
  await expect(scope(page)).toHaveText("Projects");
});
