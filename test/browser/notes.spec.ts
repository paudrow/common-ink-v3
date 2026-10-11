import { expect, test, type Page } from "@playwright/test";
import { listedNote, listedNotes, noteCard, noteIdIn, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

const history = (page: Page, id: string) => perform(page, { type: "note.history", id });

const writeElsewhere = (page: Page, op: { id: string; baseRevision: number; text: string }) => perform(page, { type: "note.write", ...op });

/** Clicking outside the editor takes focus from it. */
const leaveEditor = (page: Page) => page.getByRole("complementary", { name: "Sidebar" }).getByText("Folders", { exact: true }).click();

test("opens signed in as the dev user, with no login", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Dev's workspace")).toBeVisible();
  await openAllNotes(page);
  await expect(page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" })).toBeVisible();
});

test("a new person signs in, writes a note, and finds it intact after reloading", async ({ page }) => {
  await signInAsNewPerson(page, "Mary Somerville");
  await expect(page.getByText("Mary's workspace")).toBeVisible();

  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  const editor = page.getByRole("textbox", { name: "Note text" });
  await expect(editor).toBeFocused();
  await page.keyboard.type("# Field notes\n\nTyped in one go.");

  await expect(page).toHaveURL(/\/note\/field-notes-[a-z0-9]{12}$/);
  await expect(page.getByRole("status")).toHaveText("Saved");
  const changes = await history(page, noteIdIn(page));
  expect(changes.map((c) => ({ revision: c.revision, baseRevision: c.baseRevision, author: c.author.name }))).toEqual([
    { revision: 1, baseRevision: 0, author: "Mary Somerville" },
  ]);
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Field notes"]);
  await expect(noteCard(page, "Field notes").locator(".card-preview")).toHaveText("Typed in one go.");
  await expect(noteCard(page, "Field notes")).toContainText("just now");
  await expect(noteCard(page, "Field notes")).toContainText("Mary Somerville");
  await listedNote(page, "Field notes").click();

  await page.reload();
  await expect(page.locator(".cm-line")).toHaveText(["# Field notes", "", "Typed in one go."]);
});

test("typing is committed as soon as the note loses focus", async ({ page }) => {
  await signInAsNewPerson(page, "Emmy Noether");
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Draft");

  const saved = page.waitForResponse((res) => res.url().endsWith("/ops") && res.request().postDataJSON()?.type === "note.write", { timeout: 600 });
  await leaveEditor(page);
  await saved;

  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await history(page, noteIdIn(page))).toHaveLength(1);
});

test("a save based on an old revision keeps the other writer's change, and the editor shows both", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Shared\n\nmine");
  await expect(page).toHaveURL(/\/note\/shared-[a-z0-9]{12}$/);
  await expect(page.getByRole("status")).toHaveText("Saved");

  await writeElsewhere(page, { id: noteIdIn(page), baseRevision: 1, text: "# Shared\n\nmine\n\ntheirs" });
  await page.keyboard.type(" too");
  await leaveEditor(page);

  await expect(page.locator(".cm-line")).toHaveText(["# Shared", "", "mine too", "", "theirs"]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await history(page, noteIdIn(page))).map((c) => c.baseRevision)).toEqual([0, 1, 1]);
});

const isWrite = (body: string | null) => (body ? JSON.parse(body).type === "note.write" : false);

test("a save whose answer is lost is sent again without doubling the text", async ({ page }) => {
  await signInAsNewPerson(page, "Hedy Lamarr");
  let dropped = false;
  await page.route("**/ops", async (route) => {
    if (dropped || !isWrite(route.request().postData())) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort();
  });
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Lost answer");

  await expect(page.getByRole("status")).toHaveText("Couldn't save. Retrying…");
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 10_000 });

  await expect(page.locator(".cm-line")).toHaveText(["# Lost answer"]);
  expect(await history(page, noteIdIn(page))).toHaveLength(1);
});

test("leaving a note while its save is on the way keeps the other writer's change", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Shared\n\nmine");
  await expect(page).toHaveURL(/\/note\/shared-[a-z0-9]{12}$/);
  await expect(page.getByRole("status")).toHaveText("Saved");
  const id = noteIdIn(page);

  let held = false;
  await page.route("**/ops", async (route) => {
    if (held || !isWrite(route.request().postData())) return route.continue();
    held = true;
    await writeElsewhere(page, { id, baseRevision: 1, text: "# Shared\n\nmine\n\ntheirs" });
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({ response });
  });
  await page.keyboard.type(" too");
  await leaveEditor(page);
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page).toHaveURL(/\/note\/untitled-[a-z0-9]{12}$/);
  await expect(page).not.toHaveURL(new RegExp(id));
  await expect(page.getByRole("complementary", { name: "Inspector" }).getByRole("textbox", { name: "Note URL" })).toHaveValue(new RegExp(`${noteIdIn(page)}$`));

  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Untitled", "Shared"]);
  await expect(noteCard(page, "Shared")).toContainText("theirs");

  await expect.poll(async () => (await history(page, id)).length, { timeout: 10_000 }).toBe(3);
  await page.goto(`/note/${id}`);
  await expect(page.locator(".cm-line")).toHaveText(["# Shared", "", "mine too", "", "theirs"]);
  await page.waitForTimeout(1500);
  expect(await history(page, id)).toHaveLength(3);
});

test("a long note in a script that takes several bytes a character saves", async ({ page }) => {
  await signInAsNewPerson(page, "Lu Xun");
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.insertText(`# 狂人日记\n\n${"今天晚上，很好的月光。".repeat(2500)}`);

  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 10_000 });
  await page.reload();
  await expect(page.locator(".cm-line").first()).toHaveText("# 狂人日记");
  expect(await history(page, noteIdIn(page))).toHaveLength(1);
});

test("typing undone before the pause leaves the note saved", async ({ page }) => {
  await signInAsNewPerson(page, "Grace Hopper");
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Undone");
  await expect(page).toHaveURL(/\/note\/undone-[a-z0-9]{12}$/);

  await page.keyboard.type("!");
  await page.keyboard.press("Backspace");
  await expect(page.getByRole("status")).toHaveText("Saved");
  const asked = page.waitForEvent("dialog", { timeout: 1000 }).then(
    async (dialog) => (await dialog.dismiss(), true),
    () => false,
  );
  await page.reload();
  expect(await asked).toBe(false);
});

test("an old link with an outdated slug still opens the note", async ({ page }) => {
  await signInAsNewPerson(page, "Sofia Kovalevskaya");
  await openAllNotes(page);
  await page.getByRole("main", { name: "Editor" }).getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Current title");
  await expect(page).toHaveURL(/\/note\/current-title-[a-z0-9]{12}$/);
  const id = noteIdIn(page);

  await page.goto(`/note/an-old-title-${id}`);

  await expect(page.locator(".cm-line")).toHaveText(["# Current title"]);
  await expect(page).toHaveURL(new RegExp(`/note/current-title-${id}$`));
});
