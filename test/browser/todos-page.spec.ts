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

test("the builder under the bar is as wide as the page's column, past the Sort menu at the end of the bar's line", async ({ page }) => {
  await aNoteOfEveryState(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await todosPage(page).getByRole("button", { name: "Advanced" }).click();
  const builder = (await todosPage(page).getByRole("group", { name: "Advanced filter" }).boundingBox())!;
  const heading = (await todosPage(page).getByRole("heading", { name: "Todos" }).boundingBox())!;
  // The builder has a Sort of its own, before the bar's.
  const sort = (await todosPage(page).getByRole("combobox", { name: "Sort" }).last().boundingBox())!;
  const field = (await bar(page).boundingBox())!;
  // From where the heading starts to where the Sort menu ends, with the menu still beside the bar and above the builder.
  expect(Math.round(builder.x)).toBe(Math.round(heading.x));
  expect(Math.round(builder.x + builder.width)).toBe(Math.round(sort.x + sort.width));
  expect(sort.y).toBeLessThan(field.y + field.height);
  expect(sort.y + sort.height).toBeLessThan(builder.y);
});

test("in a phone's width the Sort menu goes under the bar and the state choices stay on one line", async ({ page }) => {
  await aNoteOfEveryState(page);
  await page.setViewportSize({ width: 380, height: 800 });
  // Focus, so the page has the whole window, as a member with a window this narrow would have it.
  await bar(page).focus();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
  const field = (await bar(page).boundingBox())!;
  // The builder has a Sort of its own, before the bar's.
  const sort = (await todosPage(page).getByRole("combobox", { name: "Sort" }).last().boundingBox())!;
  expect(sort.y).toBeGreaterThanOrEqual(field.y + field.height);
  const tops = await states(page).locator("label").evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

const said = (page: Page) => todosPage(page).locator(".todo-add").getByRole("status");
const adder = (page: Page) => todosPage(page).getByRole("textbox", { name: "Add a todo to today's note" });
const localDay = (page: Page, days = 0) =>
  page.evaluate((d) => {
    const at = new Date(Date.now() + d * 86_400_000);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  }, days);

test("a todo typed in the Add field is written at the end of today's daily note, made for it, and is on the list at once when the bar asks for it", async ({ page }) => {
  await aNoteOfEveryState(page);
  const today = await localDay(page);
  const tomorrow = await localDay(page, 1);
  expect((await perform(page, { type: "daily.find", on: today })).note).toBeNull();

  await adder(page).fill("Book the dentist due:tomorrow #health !!");
  await adder(page).press("Enter");
  // The field is empty at once for the next, and says where the todo went.
  await expect(adder(page)).toHaveValue("");
  await expect(adder(page)).toBeFocused();
  await expect(said(page)).toHaveText(`Added “Book the dentist due:tomorrow #health !!” to ${today}`);
  await expect(words(page)).toContainText(["Book the dentist"]);
  const added = todosPage(page).getByRole("listitem").filter({ hasText: "Book the dentist" });
  await expect(added.locator(".todo-note")).toHaveText(today);

  // Two typed quickly land in the order they were typed, after what the note had.
  await adder(page).fill("Water the ferns every:weekly");
  await adder(page).press("Enter");
  await adder(page).fill("Sweep the porch");
  await adder(page).press("Enter");
  const daily = (await perform(page, { type: "daily.find", on: today })).note!;
  await expect.poll(async () => (await perform(page, { type: "note.read", id: daily.id })).text).toBe(`# ${today}\n\n- [ ] !! Book the dentist due:${tomorrow} #health\n- [ ] Water the ferns every:1w\n- [ ] Sweep the porch\n`);

  // Narrowed by the bar, a todo added that the bar asks for is listed, and one it doesn't ask for isn't.
  await bar(page).fill("ferns");
  await expect(words(page)).toHaveText(["Water the ferns"]);
  await adder(page).fill("Repot the ferns");
  await adder(page).press("Enter");
  // Read back as soon as it lands, well before the app would list everything again by itself.
  await expect(words(page)).toHaveText(["Water the ferns", "Repot the ferns"], { timeout: 3000 });
  await adder(page).fill("Mop the floor");
  await adder(page).press("Enter");
  await expect(said(page)).toContainText("Mop the floor");
  await expect(words(page)).toHaveText(["Water the ferns", "Repot the ferns"]);

  // Where it went opens from what the field says.
  await todosPage(page).getByRole("status").getByRole("button", { name: today }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Mop the floor");
});

test("a todo that can't be added waits with those typed after it, in order, until Try again sends each once; a due: that says no day is said to be words", async ({ page }) => {
  await aNoteOfEveryState(page);
  const today = await localDay(page);
  await adder(page).fill("Ask about due:someday");
  await adder(page).press("Enter");
  await expect(said(page)).toHaveText(`Added “Ask about due:someday” to ${today}. due:someday says no day or repeat, so it is words.`);

  // Every edit fails while the network is down.
  const down = (route: import("@playwright/test").Route) => (route.request().postDataJSON()?.type === "note.edit" ? route.abort() : route.continue());
  await page.route("**/ops", down);
  await adder(page).fill("Fix the gate");
  await adder(page).press("Enter");
  await adder(page).fill("Oil the hinge");
  await adder(page).press("Enter");
  const alert = todosPage(page).locator(".todo-add").getByRole("alert");
  await expect(alert).toContainText("aren't added yet");
  await expect(alert).toContainText("2 todos");
  // Nothing typed is lost: the field is free for more, and the two wait their turn.
  await expect(adder(page)).toHaveValue("");

  await page.unroute("**/ops", down);
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toHaveCount(0);
  const daily = (await perform(page, { type: "daily.find", on: today })).note!;
  await expect.poll(async () => (await perform(page, { type: "note.read", id: daily.id })).text).toBe(`# ${today}\n\n- [ ] Ask about due:someday\n- [ ] Fix the gate\n- [ ] Oil the hinge\n`);
});
