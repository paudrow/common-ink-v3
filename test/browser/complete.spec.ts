import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const list = (page: Page) => page.getByRole("listbox");
const options = (page: Page) => list(page).getByRole("option");
const highlighted = (page: Page) => list(page).locator('[role="option"][aria-selected="true"]');
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** Opens the note and puts the cursor at its end. */
async function open(page: Page, noteId: string, shows: string) {
  await page.goto(`/note/${noteId}`);
  await expect(editor(page)).toContainText(shows);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
}

test("# lists the tags, with what each is for, narrowed as the member types; Enter or Tab writes one, and a tag nobody has is offered to create last, where Enter stays a new line", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Seeds\n\nOrder seeds #garden #Shopping #reading\n" });
  await perform(page, { type: "tag.describe", name: "garden", description: "The vegetable beds" });
  const note = await perform(page, { type: "note.create", text: "# Today\n\nPlans" });
  await open(page, note.id, "Plans");
  // `#` lists the tags the sidebar has read.
  await expect(page.getByRole("navigation", { name: "Tags" }).getByRole("link")).toHaveCount(3);

  await page.keyboard.type(" #");
  await expect(options(page)).toHaveText(["#garden", "#reading", "#Shopping"].map((tag) => new RegExp(`^${tag}`)));
  await page.keyboard.type("ga");
  await expect(options(page)).toHaveText(["#gardenThe vegetable beds", "Create #gaNew tag"]);
  await expect(highlighted(page)).toHaveText(/^#garden/);
  await page.keyboard.press("Enter");
  await page.keyboard.type(" #sho");
  await expect(options(page).first()).toHaveText("#Shopping");
  await page.keyboard.press("Tab");
  await expect(list(page)).toBeHidden();

  await page.keyboard.type(" #newt");
  await expect(options(page)).toHaveText(["Create #newtNew tag"]);
  await expect(highlighted(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.type("next");
  await expect.poll(() => text(page, note.id)).toBe("# Today\n\nPlans #garden #Shopping #newt\nnext");
});

test("a link to a folder that is gone, or that the member can't see, reads Unavailable folder and goes nowhere", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const old = await perform(page, { type: "folder.create", name: "Old plans" });
  const note = await perform(page, { type: "note.create", text: `# Today\n\nSee [[folder:${old.id}]] and [[folder:zzzzzzzzzzzz]]` });
  await perform(page, { type: "folder.delete", id: old.id });
  await open(page, note.id, "See");
  const drawn = editor(page).locator(".md-chip-link");
  await expect(drawn).toHaveText(["Unavailable folder", "Unavailable folder"]);
  await expect(drawn.first()).toHaveAttribute("title", "This folder doesn't exist, or you can't see it.");
  await drawn.first().click();
  await expect(page).toHaveURL(new RegExp(`/note/.*${note.id}$`));
});

test("@ lists the folders under Folders, each with the folder it is in; picking one writes a link to the folder that reads as its name now and opens its list", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const garden = await perform(page, { type: "folder.create", name: "Garden plans" });
  await perform(page, { type: "folder.create", name: "Gardening notes", parentId: garden.id });
  await perform(page, { type: "note.create", text: "# Garden diary" });
  const note = await perform(page, { type: "note.create", text: "# Today\n\nSee" });
  await open(page, note.id, "See");

  await page.keyboard.type(" @gard");
  await expect(list(page).locator("completion-section")).toHaveText(["Notes", "Folders", "New"]);
  await expect(options(page)).toHaveText(["Garden diaryUnsorted", "Garden plansFolder", "Gardening notesFolder in Garden plans", "Create note “gard”New note in Unsorted", "Create folder “gard”New folder at the top", "Create tag #gardNew tag"]);
  await page.keyboard.press("ArrowDown");
  await expect(highlighted(page)).toHaveText(/^Garden plans/);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Today\n\nSee [[folder:${garden.id}]]`);
  // A slash is a path: the part before it a folder the one found is in.
  await page.keyboard.type(" @gard pl/gard");
  await expect(options(page).filter({ hasText: /Folder/ })).toHaveText(["Gardening notesFolder in Garden plans"]);
  await page.keyboard.press("Escape");

  const drawn = editor(page).getByRole("link");
  await expect(drawn).toHaveText("Garden plans");
  await expect(drawn).toHaveAttribute("title", /^The folder Garden plans\nClick to open/);
  // Renamed in the sidebar, the link reads as its new name with nothing reloaded.
  await page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Garden plans" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.keyboard.type("Vegetable beds");
  await page.keyboard.press("Enter");
  await expect(drawn).toHaveText("Vegetable beds");
  await drawn.click();
  await expect(page).toHaveURL(new RegExp(`/folder/${garden.id}$`));
  await expect(page.getByRole("main", { name: "Editor" }).getByRole("heading", { level: 1 })).toHaveText("Vegetable beds");
});

test("@ offers last to create a note titled with what was typed, beside the note it is typed in; picked, the note is made and linked, and a note already so titled is offered instead", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const garden = await perform(page, { type: "folder.create", name: "Garden" });
  await perform(page, { type: "note.create", text: "# Seed order", folderId: garden.id });
  const note = await perform(page, { type: "note.create", text: "# Today\n\nSee", folderId: garden.id });
  await open(page, note.id, "See");

  await page.keyboard.type(" @seed order");
  await expect(options(page)).toHaveText(["Seed orderGarden", "Create folder “seed order”New folder at the top"]);
  await page.keyboard.type("s");
  await expect(options(page)).toHaveText(["Create note “seed orders”New note in Garden", "Create folder “seed orders”New folder at the top"]);
  await expect(highlighted(page)).toHaveCount(0);
  await page.keyboard.press("Tab");

  await expect(page.getByRole("group", { name: "Notice" })).toContainText("Created note seed orders");
  const drawn = editor(page).getByRole("link");
  await expect(drawn).toHaveText("seed orders");
  const made = (await perform(page, { type: "note.list", folderId: garden.id })).notes.find((n) => n.title === "seed orders")!;
  expect((await perform(page, { type: "note.read", id: made.id })).text).toBe("# seed orders\n");
  await expect.poll(() => text(page, note.id)).toBe(`# Today\n\nSee [[${made.id}]]`);
  await drawn.click();
  await expect(page).toHaveURL(new RegExp(`/note/seed-orders-${made.id}$`));
});

test("@ ends with what it can create of what was typed, a contact, a note, a folder and a tag in that order; picking the tag writes it, and a name someone has offers no contact", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts", edit: true });
  const note = await perform(page, { type: "note.create", text: "# Today\n\nSee" });
  await open(page, note.id, "See");

  await page.keyboard.type(" @compost");
  await expect(list(page).locator("completion-section")).toHaveCount(0);
  await expect(options(page)).toHaveText(["Create contact “compost”New contact in Sample contacts", "Create note “compost”New note in Unsorted", "Create folder “compost”New folder at the top", "Create tag #compostNew tag"]);
  await expect(highlighted(page)).toHaveCount(0);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(highlighted(page)).toHaveText(/^Create tag #compost/);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe("# Today\n\nSee #compost");
  await expect(editor(page).locator(".md-tag")).toHaveText("#compost");

  await page.keyboard.type(" and @sam okafor");
  await expect(options(page)).toHaveText(["Sam OkaforContact · Okafor Plumbing", "Create note “sam okafor”New note in Unsorted", "Create folder “sam okafor”New folder at the top"]);
});

test("@ creates a folder of the name typed at the top, or of a path inside the folders of it that are there, and links it at once", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const note = await perform(page, { type: "note.create", text: "# Today\n\nSee" });
  await open(page, note.id, "See");

  await page.keyboard.type(" @projects/Garden/Beds");
  const folder = options(page).filter({ hasText: "Create folder" });
  await expect(folder).toHaveText("Create folder “projects/Garden/Beds”New folders in Projects");
  await folder.click();
  await expect(editor(page).getByRole("link")).toHaveText("Beds");
  await expect(page.getByRole("group", { name: "Notice" })).toContainText("Created folder projects/Garden/Beds");
  const garden = await perform(page, { type: "folder.find", path: "Projects/Garden" });
  const beds = await perform(page, { type: "folder.find", path: "Projects/Garden/Beds" });
  expect([garden.parentId, beds.parentId]).toEqual([projects.id, garden.id]);
  await expect.poll(() => text(page, note.id)).toBe(`# Today\n\nSee [[folder:${beds.id}]]`);

  await page.keyboard.type(" and @Compost");
  await expect(options(page).filter({ hasText: "Create folder" })).toHaveText("Create folder “Compost”New folder at the top");
  await page.keyboard.type(" heap");
  await expect(options(page).filter({ hasText: "Create" })).toHaveText(["Create note “Compost heap”New note in Unsorted", "Create folder “Compost heap”New folder at the top"]);
  await page.keyboard.press("Escape");
  await page.keyboard.type(" @projects/garden");
  await expect(options(page).filter({ hasText: "Create folder" })).toHaveCount(0);
});

test("picking Create note again while it is being made makes one note, and an archived note's title is taken too", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const old = await perform(page, { type: "note.create", text: "# Old plans" });
  await perform(page, { type: "note.archive", id: old.id, archived: true });
  const note = await perform(page, { type: "note.create", text: "# Today\n\nSee" });
  await open(page, note.id, "See");
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if (/"note\.create"/.test(route.request().postData() ?? "")) await new Promise((done) => setTimeout(done, 800));
    await route.continue();
  });

  await page.keyboard.type(" @old plans");
  await expect(list(page).getByText("Create note")).toHaveCount(0);
  await page.keyboard.type(" @Compost");
  await expect(options(page)).toHaveText(["Create note “Compost”New note in Unsorted", "Create folder “Compost”New folder at the top", "Create tag #CompostNew tag"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(editor(page).getByRole("link")).toHaveText("Compost");
  const titled = async () => (await perform(page, { type: "note.list" })).notes.filter((n) => n.title === "Compost").length;
  await expect.poll(titled).toBe(1);
  await page.waitForTimeout(1000);
  expect(await titled()).toBe(1);
});

test("the list stays while nothing fits the word being typed, saying so or offering to create it, so taking letters back finds what fit again; a space after a word that fits nothing closes it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Garden diary" });
  await perform(page, { type: "note.create", text: "# Seeds\n\n#garden" });
  const note = await perform(page, { type: "note.create", text: "# Today\n\nSee" });
  await open(page, note.id, "See");

  await page.keyboard.type(" [[Gard");
  await expect(options(page)).toHaveText(["Garden diaryUnsorted"]);
  await page.keyboard.type("zz");
  await expect(options(page)).toHaveText(["No matches"]);
  await expect(highlighted(page)).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(options(page)).toHaveText(["Garden diaryUnsorted"]);
  await page.keyboard.type("q ");
  await expect(list(page)).toBeHidden();
  // Enter with nothing to pick is a new line.
  await page.keyboard.type("and [[");
  await expect(options(page)).toHaveCount(3);
  await page.keyboard.type("qq");
  await expect(options(page)).toHaveText(["No matches"]);
  await page.keyboard.press("Enter");
  await expect(list(page)).toBeHidden();
  await expect.poll(() => text(page, note.id)).toBe("# Today\n\nSee [[Gardq and [[qq\n");

  await page.keyboard.type("#gard");
  await expect(options(page)).toHaveText(["#garden", "Create #gardNew tag"]);
  await page.keyboard.type("x");
  await expect(options(page)).toHaveText(["Create #gardxNew tag"]);
  await page.keyboard.press("Backspace");
  await expect(options(page).first()).toHaveText("#garden");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe("# Today\n\nSee [[Gardq and [[qq\n#garden");
});
