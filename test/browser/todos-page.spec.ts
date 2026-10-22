import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const todosPage = (page: Page) => page.getByRole("region", { name: "Todos" });
const bar = (page: Page) => todosPage(page).getByRole("searchbox", { name: "Filter todos" });
const words = (page: Page) => todosPage(page).getByRole("list", { name: "Todos" }).getByRole("listitem").locator(".todo-words");
const states = (page: Page) => todosPage(page).getByRole("radiogroup", { name: "Todos by state" });
const state = (page: Page, name: string) => states(page).getByRole("radio", { name, exact: true });

async function aNoteOfEveryState(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Chores\n\n- [ ] Water plants #home\n- [x] Pay rent #home\n- [>] Learn the cello #home\n" });
  // In a note of its own: a todo has its note's tags too.
  await perform(page, { type: "note.create", text: "# Yard\n\n- [-] Paint the fence\n" });
  await page.goto("/todos");
}

test("the state choices under the bar write is: into it, and show what the bar asks for when it is typed", async ({ page }) => {
  await aNoteOfEveryState(page);
  await expect(states(page).locator("label")).toHaveText(["Open", "Backlog", "Done", "Abandoned", "All"]);
  // A bar that names no state lists the open todos, and Open says so.
  await expect(state(page, "Open")).toBeChecked();
  await expect(words(page)).toHaveText(["Water plants"]);

  await state(page, "Done").click();
  await expect(bar(page)).toHaveValue("is:done");
  await expect(words(page)).toHaveText(["Pay rent"]);
  await state(page, "Backlog").click();
  await expect(bar(page)).toHaveValue("is:backlog");
  await expect(words(page)).toHaveText(["Learn the cello"]);
  await state(page, "Abandoned").click();
  await expect(bar(page)).toHaveValue("is:abandoned");
  await expect(words(page)).toHaveText(["Paint the fence"]);

  // What else the bar asks for stays, and the new state replaces the last.
  await bar(page).fill("#home is:abandoned");
  await state(page, "All").click();
  await expect(bar(page)).toHaveValue("#home (is:open OR is:backlog OR is:done OR is:abandoned)");
  await expect(words(page)).toHaveCount(3);
  await state(page, "Open").click();
  await expect(bar(page)).toHaveValue("#home is:open");
  await expect(words(page)).toHaveText(["Water plants"]);

  // Typed into the bar, a state lights its choice; states no choice is light none.
  await bar(page).fill("is:done");
  await expect(state(page, "Done")).toBeChecked();
  await bar(page).fill("is:done OR is:backlog");
  await expect(states(page).getByRole("radio", { checked: true })).toHaveCount(0);
  await bar(page).fill("");
  await expect(state(page, "Open")).toBeChecked();

  // The keyboard goes along the choices as it does any radio group.
  await state(page, "Open").focus();
  await page.keyboard.press("ArrowRight");
  await expect(bar(page)).toHaveValue("is:backlog");
});
