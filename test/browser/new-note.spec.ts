import { expect, type Page } from "@playwright/test";
import { listedNote, noteIdIn, openAllNotes, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).first().getByRole("tab");
const read = async (page: Page, id: string) => perform(page, { type: "note.read", id });

test("a new note starts empty with the cursor in it, and its first words are its title", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/note\/untitled-/);
  await expect(editor(page)).toBeFocused();
  const id = noteIdIn(page);

  // Nothing in it but the placeholder, which is no text of the note's.
  await expect(page.locator(".cm-line")).toHaveCount(1);
  await expect(page.locator(".cm-line .cm-placeholder")).toBeVisible();
  // Untouched, the note is as empty as it was made, with no change recorded, and leaving it for another tab sends nothing.
  const sent: string[] = [];
  page.on("request", (request) => /"note\.write"/.test(request.postData() ?? "") && sent.push(request.postData()!));
  await tabs(page).first().focus();
  await page.waitForTimeout(1500);
  await expect.poll(() => read(page, id)).toMatchObject({ text: "", title: "", snippet: "", revision: 0 });
  await expect.poll(() => perform(page, { type: "note.history", id })).toEqual([]);
  expect(sent).toEqual([]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(tabs(page).last()).toHaveText("Untitled");
  await editor(page).focus();

  await page.keyboard.type("Groceries");
  await expect(page.locator(".cm-line").first()).toHaveText("Groceries");
  await expect.poll(async () => (await read(page, id)).text).toBe("Groceries");
  await expect.poll(async () => (await read(page, id)).title).toBe("Groceries");
  await expect.poll(async () => (await perform(page, { type: "note.history", id })).map((c) => c.revision)).toEqual([1]);
  await expect(tabs(page).last()).toHaveText("Groceries");
  await expect(page).toHaveURL(/\/note\/groceries-/);
});

test("a heading typed or pasted in a new note is that heading, and a # among the first words is only a letter", async ({ page }) => {
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

  // Words typed with no mark are the title, a `#` among them included.
  await openAllNotes(page);
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect(page).not.toHaveURL(new RegExp(second));
  await expect(editor(page)).toBeFocused();
  const third = noteIdIn(page);
  await page.keyboard.type("C# notes");
  await expect.poll(async () => (await read(page, third)).text).toBe("C# notes");
  await expect(tabs(page).last()).toHaveText("C# notes");
});

test("a note with no heading is titled by its first words: in its tab, its address, and the list", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "Shopping for **the week**\n\n- milk" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Shopping for");
  await expect(tabs(page)).toHaveText(["Shopping for the week"]);
  await expect(page).toHaveURL(new RegExp(`/note/shopping-for-the-week-${note.id}$`));

  // The old address, by another title, still opens it.
  await page.goto(`/note/untitled-${note.id}`);
  await expect(editor(page)).toContainText("Shopping for");
  await expect(page).toHaveURL(new RegExp(`/note/shopping-for-the-week-${note.id}$`));

  await openAllNotes(page);
  await expect(listedNote(page, "Shopping for the week")).toBeVisible();
});

test("with vim on, a new note starts in insert mode, so its first words are typed at once there too", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await page.reload();
  await openAllNotes(page);
  await page.getByRole("main").getByRole("button", { name: "New note" }).click();
  await expect(page.locator(".cm-vim-panel")).toHaveText("--INSERT--");
  await expect(editor(page)).toBeFocused();
  const id = noteIdIn(page);
  await page.keyboard.type("Groceries");
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await expect.poll(async () => (await read(page, id)).text).toBe("Groceries");

  // A note with words in it opens in normal mode, as before.
  await page.goto(`/note/${id}`);
  await expect(page.locator(".cm-line").first()).toHaveText("Groceries");
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
});

const gone = async (page: Page, id: string) => {
  await expect.poll(() => read(page, id).then(() => "there", (err: Error) => err.message)).toMatch(/No such note/);
  expect((await perform(page, { type: "trash.list" })).notes.map((n) => n.id)).not.toContain(id);
};

test("a new note left with nothing in it is gone when its tab closes, not put in Trash, and one that ever had words stays", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const kept = await perform(page, { type: "note.create", text: "# Kept" });
  await page.goto(`/note/${kept.id}`);
  await expect(editor(page)).toContainText("Kept");
  const newNote = async () => {
    await page.getByRole("button", { name: "New note" }).first().click();
    await expect(page).toHaveURL(/\/note\/untitled-/);
    await expect(editor(page)).toBeFocused();
    return noteIdIn(page);
  };
  const closeTab = () => page.getByTitle("Close Untitled", { exact: true }).click();

  // Untouched.
  const untouched = await newNote();
  await closeTab();
  await gone(page, untouched);

  // Only a # and spaces, sent before the tab closed.
  const marked = await newNote();
  await page.keyboard.type("#  ");
  await expect.poll(async () => (await read(page, marked)).revision).toBeGreaterThan(0);
  await closeTab();
  await gone(page, marked);

  // Words saved and taken out again: it had words, so it stays, empty.
  const cleared = await newNote();
  await page.keyboard.type("Plan");
  await expect.poll(async () => (await read(page, cleared)).text).toBe("Plan");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await closeTab();
  await expect.poll(async () => (await read(page, cleared)).text).toBe("");
  await page.waitForTimeout(1500);
  expect((await read(page, cleared)).state).toBe("live");

  // Typed and closed at once: what was typed is sent first, so it is kept.
  const quick = await newNote();
  await page.keyboard.type("Quick");
  await closeTab();
  await expect.poll(async () => (await read(page, quick)).text).toBe("Quick");
});

test("an empty note stays while any tab holds it, and switching tabs is not leaving it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const other = await perform(page, { type: "note.create", text: "# Other" });
  await page.goto(`/note/${other.id}`);
  await expect(editor(page)).toContainText("Other");
  await page.getByRole("button", { name: "New note" }).first().click();
  await expect(page).toHaveURL(/\/note\/untitled-/);
  const id = noteIdIn(page);
  await tabs(page).filter({ hasText: "Other" }).dblclick();
  await expect(editor(page)).toContainText("Other");
  await page.waitForTimeout(1500);
  expect((await read(page, id)).text).toBe("");
  await tabs(page).filter({ hasText: "Untitled" }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("Later");
  await expect.poll(async () => (await read(page, id)).title).toBe("Later");
});

test("an empty note open in another tab of the browser is not discarded when one tab closes it, so what is typed there is kept", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const kept = await perform(page, { type: "note.create", text: "# Kept" });
  await page.goto(`/note/${kept.id}`);
  await page.getByRole("button", { name: "New note" }).first().click();
  await expect(page).toHaveURL(/\/note\/untitled-/);
  const id = noteIdIn(page);
  const other = await page.context().newPage();
  await other.goto(`/note/${id}`);
  await expect(editor(other)).toBeVisible();

  await page.getByTitle("Close Untitled", { exact: true }).click();
  await page.waitForTimeout(1500);
  expect((await read(page, id)).state).toBe("live");
  await editor(other).focus();
  await other.keyboard.type("Typed in the other tab");
  await expect.poll(async () => (await read(page, id)).text).toBe("Typed in the other tab");
});

test("an empty note that loads while a folder's name is typed leaves the cursor in the name", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const empty = await perform(page, { type: "note.create" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if (route.request().postData()?.includes(`"note.read","id":"${empty.id}"`)) await held;
    await route.continue();
  });
  await page.goto(`/note/${empty.id}`);
  await page.getByRole("button", { name: "New folder" }).click();
  const name = page.getByRole("textbox", { name: "Folder name" });
  await page.keyboard.type("Pro");
  release();
  await expect(editor(page)).toBeVisible();
  await page.waitForTimeout(300);
  await page.keyboard.type("jects");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Projects");
  expect((await read(page, empty.id)).text).toBe("");
});

test("a new note made from the commands while typing in another note takes the cursor", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Kept" });
  await page.goto(`/note/${note.id}`);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("New note");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/note\/untitled-/);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("# Fresh");
  await expect(page).toHaveURL(/\/note\/fresh-/);
  expect((await read(page, note.id)).text).toBe("# Kept");
});
