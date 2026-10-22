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
