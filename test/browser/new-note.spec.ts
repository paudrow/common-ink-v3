import { expect, test, type Page } from "@playwright/test";
import { listedNote, noteIdIn, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const read = async (page: Page, id: string) => perform(page, { type: "note.read", id });

test("a new note starts with the mark of its title and the cursor after it, so the title is typed at once", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/note\/untitled-/);
  await expect(editor(page)).toBeFocused();
  const id = noteIdIn(page);

  await expect(page.locator(".cm-line")).toHaveText(["# "]);
  // The mark is in the editor alone: untouched, the note is as empty as it was made, with no change recorded, and leaving it sends nothing.
  const sent: string[] = [];
  page.on("request", (request) => /"note\.write"/.test(request.postData() ?? "") && sent.push(request.postData()!));
  await page.getByRole("button", { name: "Writing mode" }).focus();
  await page.waitForTimeout(1500);
  expect(await read(page, id)).toMatchObject({ text: "", title: "", snippet: "", revision: 0 });
  expect(await perform(page, { type: "note.history", id })).toEqual([]);
  expect(sent).toEqual([]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await editor(page).focus();

  await page.keyboard.type("Groceries");
  await expect(page.locator(".cm-line").first()).toHaveText("# Groceries");
  await expect.poll(async () => (await read(page, id)).text).toBe("# Groceries");
  // The mark and the title are the note's one change.
  expect((await perform(page, { type: "note.history", id })).map((c) => c.revision)).toEqual([1]);
  await expect(page).toHaveURL(/\/note\/groceries-/);
});

test("typing or pasting a heading's mark in a new note gives that heading, and not a second mark after the first", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect(editor(page)).toBeFocused();
  const first = noteIdIn(page);
  await page.keyboard.type("## Agenda");
  await expect.poll(async () => (await read(page, first)).text).toBe("## Agenda");

  await openAllNotes(page);
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect(page).not.toHaveURL(new RegExp(first));
  await expect(editor(page)).toBeFocused();
  const second = noteIdIn(page);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "# Pasted\n\nbody");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await read(page, second)).text).toBe("# Pasted\n\nbody");

  // Words typed after the mark are the title, a `#` among them included.
  await openAllNotes(page);
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect(page).not.toHaveURL(new RegExp(second));
  await expect(editor(page)).toBeFocused();
  const third = noteIdIn(page);
  await page.keyboard.type("C# notes");
  await expect.poll(async () => (await read(page, third)).text).toBe("# C# notes");
});

test("a note with no heading is titled by its first words: in its address and the list", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "Shopping for **the week**\n\n- milk" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Shopping for");
  await expect(page).toHaveURL(new RegExp(`/note/shopping-for-the-week-${note.id}$`));

  // The old address, by another title, still opens it.
  await page.goto(`/note/untitled-${note.id}`);
  await expect(editor(page)).toContainText("Shopping for");
  await expect(page).toHaveURL(new RegExp(`/note/shopping-for-the-week-${note.id}$`));

  await openAllNotes(page);
  await expect(listedNote(page, "Shopping for the week")).toBeVisible();
});
