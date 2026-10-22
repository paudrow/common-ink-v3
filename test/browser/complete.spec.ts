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
  await expect(list(page).locator("completion-section")).toHaveText(["Notes", "Folders"]);
  await expect(options(page)).toHaveText(["Garden diaryUnsorted", "Garden plansFolder", "Gardening notesFolder in Garden plans"]);
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
