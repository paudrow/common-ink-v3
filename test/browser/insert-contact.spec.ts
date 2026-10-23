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
const headings = (page: Page) => list(page).locator("completion-section");
const notice = (page: Page) => page.getByRole("group", { name: "Notice" });
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const contactNames = async (page: Page, query: string) => (await perform(page, { type: "contact.list", query })).contacts.map((c) => c.name);

/** Ada, with the sample contacts connected to read and, with `edit`, to change, and a note open to write in with the cursor at its end. */
async function inNote(page: Page, edit: boolean) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts", edit });
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return note;
}

/** The same, with `Met @` typed and the contacts read. */
async function atInNote(page: Page, edit: boolean) {
  const note = await inNote(page, edit);
  const read = page.waitForResponse((response) => response.request().postDataJSON()?.type === "contact.list");
  await page.keyboard.type("Met @");
  await read;
  return note;
}

test("@ and a name nobody has offers to create the contact; picking it adds them to the contacts, mentions them, and says so with a way to their page", async ({ page }) => {
  const note = await atInNote(page, true);
  await page.keyboard.type("Zelda Fitz");
  await expect(options(page)).toHaveText(["Create contact “Zelda Fitz”New contact in Sample contacts", "Create note “Zelda Fitz”New note in Unsorted", "Create folder “Zelda Fitz”New folder at the top"]);
  await page.keyboard.press("Tab");

  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nMet [[person:Zelda Fitz]]");
  await expect(editor(page).locator(".md-chip-mention")).toHaveText(["@Zelda Fitz"]);
  expect(await contactNames(page, "zelda")).toEqual(["Zelda Fitz"]);

  // Now one of the contacts, she is offered as one, and there is nothing to create.
  await page.keyboard.type(" and @Zel");
  await expect(options(page)).toHaveText(["Zelda FitzContact", "Create contact “Zel”New contact in Sample contacts", "Create note “Zel”New note in Unsorted", "Create folder “Zel”New folder at the top", "Create tag #ZelNew tag"]);
  await page.keyboard.press("Escape");

  await expect(notice(page)).toContainText("Created contact Zelda Fitz");
  await notice(page).getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/\/person\/Zelda%20Fitz$/);
  await expect(page.getByRole("region", { name: "Your contact Zelda Fitz" })).toBeVisible();
});

test("creating a contact comes after everyone and everything @ finds, so Enter takes a day or a person it matched", async ({ page }) => {
  const note = await atInNote(page, true);
  await page.keyboard.type("Sam Ok");
  await expect(options(page)).toHaveText(["Sam OkaforContact · Okafor Plumbing", "Create contact “Sam Ok”New contact in Sample contacts", "Create note “Sam Ok”New note in Unsorted", "Create folder “Sam Ok”New folder at the top"]);

  for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Fri");
  await expect(headings(page)).toHaveText(["Dates", "New"]);
  await expect(options(page).first()).toHaveText(/^Friday/);
  await expect(options(page).filter({ hasText: "Create" })).toHaveText(["Create contact “Fri”New contact in Sample contacts", "Create note “Fri”New note in Unsorted", "Create folder “Fri”New folder at the top", "Create tag #FriNew tag"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toMatch(/^# Plan\n\nMet \[\[\d{4}-\d{2}-\d{2}\]\]$/);
  expect(await contactNames(page, "fri")).toEqual([]);
});

test("creating a contact is never highlighted of itself: Enter is a new line until Tab or an arrow key picks it, and it is offered once the contacts arrive", async ({ page }) => {
  const note = await inNote(page, true);
  await page.keyboard.type("Met @Zelda Fitz");
  await expect(options(page)).toHaveText(["Create contact “Zelda Fitz”New contact in Sample contacts", "Create note “Zelda Fitz”New note in Unsorted", "Create folder “Zelda Fitz”New folder at the top"]);
  await expect(options(page).first()).not.toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nMet @Zelda Fitz\n");
  expect(await contactNames(page, "zelda")).toEqual([]);

  await page.keyboard.type("Then @Zelda Fitz");
  await expect(options(page)).toHaveText(["Create contact “Zelda Fitz”New contact in Sample contacts", "Create note “Zelda Fitz”New note in Unsorted", "Create folder “Zelda Fitz”New folder at the top"]);
  await page.keyboard.press("ArrowDown");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nMet @Zelda Fitz\nThen [[person:Zelda Fitz]]");
});

test("picking Create contact again while it is being created creates it once", async ({ page }) => {
  const note = await atInNote(page, true);
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if (/"contact\.create"/.test(route.request().postData() ?? "")) await new Promise((done) => setTimeout(done, 800));
    await route.continue();
  });
  await page.keyboard.type("Zelda Fitz");
  await expect(options(page)).toHaveText(["Create contact “Zelda Fitz”New contact in Sample contacts", "Create note “Zelda Fitz”New note in Unsorted", "Create folder “Zelda Fitz”New folder at the top"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nMet [[person:Zelda Fitz]]");
  expect(await contactNames(page, "zelda")).toEqual(["Zelda Fitz"]);
});

test("@ offers to create no contact where the contacts can't be changed from here", async ({ page }) => {
  await atInNote(page, false);
  await page.keyboard.type("Sam");
  await expect(options(page).first()).toHaveText("Sam OkaforContact · Okafor Plumbing");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("Zelda Fitz");
  await expect(options(page)).toHaveText(["Create note “Zelda Fitz”New note in Unsorted", "Create folder “Zelda Fitz”New folder at the top"]);
});

test("a contact that can't be created says why, and writes nothing", async ({ page }) => {
  const note = await atInNote(page, true);
  await page.route("**/api/workspaces/*/ops", (route) =>
    /"contact\.create"/.test(route.request().postData() ?? "") ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden", message: "Connect Sample contacts again to edit contacts" }) }) : route.continue(),
  );
  await page.keyboard.type("Zelda Fitz");
  await page.keyboard.press("Tab");
  await expect(notice(page)).toContainText("Connect Sample contacts again to edit contacts");
  await expect(editor(page)).toContainText("Met @Zelda Fitz");
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nMet @Zelda Fitz");
  expect(await contactNames(page, "zelda")).toEqual([]);
});

test("Create contact highlighted with an arrow key stays highlighted when events found later join the list ahead of it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts", edit: true });
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  let release!: () => void;
  const released = new Promise<void>((done) => (release = done));
  await page.route("**/ops", async (route) => {
    if (route.request().postDataJSON()?.type === "event.list") await released;
    await route.fallback();
  });
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");

  await page.keyboard.type("Met @lunch");
  await expect(options(page).first()).toHaveText("Create contact “lunch”New contact in Sample contacts");
  await page.keyboard.press("ArrowDown");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  release();
  await expect(headings(page)).toHaveText(["Events", "New"]);
  await expect(page.getByRole("option", { selected: true })).toHaveText("Create contact “lunch”New contact in Sample contacts");
});
