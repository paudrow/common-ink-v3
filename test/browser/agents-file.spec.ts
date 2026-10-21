import { expect, type Page } from "@playwright/test";
import { asViewerOfNote, connectAgent, listedNotes, openAllNotes, perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";
import { settingsDialog } from "./settings-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const file = (page: Page) => page.getByRole("region", { name: "Agents file" });
const text = (page: Page) => file(page).getByRole("textbox", { name: "Agents file text" });
const state = (page: Page) => file(page).getByRole("status");
const tabs = (page: Page) => page.getByRole("tablist", { name: "Open notes" }).getByRole("tab");
const stored = async (page: Page) => (await perform(page, { type: "agentsFile.read" })).text;

async function start(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Alpha\n\nThe first lines of Alpha." });
  await page.goto(`/note/${note.id}`);
  await expect(tabs(page)).toHaveText(["Alpha"]);
}

test("Go to agents file opens it in a tab in a note's editor, where what is typed is saved as it pauses and is there after a reload", async ({ page }) => {
  await start(page);
  await runCommand(page, "Go to agents file");
  await expect(page).toHaveURL(/\/agents-file\.md$/);
  await expect(tabs(page).last()).toHaveText("Agents file");
  await expect(text(page)).toBeFocused();
  await expect(state(page)).toHaveText("Saved");

  await page.keyboard.insertText("# How we file\n\nRecipes go in Kitchen, named for the dish.");
  await expect(state(page)).toHaveText("Unsaved");
  await expect(state(page)).toHaveText("Saved");
  expect(await stored(page)).toBe("# How we file\n\nRecipes go in Kitchen, named for the dish.");
  // Drawn as Markdown is in a note: the heading in bold, the line under it not.
  await expect(text(page).locator(".cm-line").first().locator("span").first()).toHaveCSS("font-weight", "700");
  await expect(text(page).locator(".cm-line").nth(2)).toHaveCSS("font-weight", "400");

  await page.reload();
  await expect(text(page)).toHaveText("# How we fileRecipes go in Kitchen, named for the dish.");
  await expect(tabs(page).last()).toHaveText("Agents file");
});

test("Settings and the Agents page each open it", async ({ page }) => {
  await start(page);
  await page.goto("/settings");
  await settingsDialog(page).getByRole("button", { name: "Open agents file" }).click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents-file\.md$/);
  await expect(text(page)).toBeVisible();

  await page.goto("/agents");
  await page.getByRole("region", { name: "Agents" }).getByRole("button", { name: "Open agents file" }).click();
  await expect(page).toHaveURL(/\/agents-file\.md$/);
  await expect(text(page)).toBeVisible();
});

test("a viewer reads it and can't change it", async ({ page }) => {
  const { admin, note } = await asViewerOfNote(page, "# Their note");
  await perform(admin, { type: "agentsFile.write", text: "# Rules\n\nTag tried recipes #tried.", baseRevision: 0 });
  // The note is in the admin's workspace, so the app is too.
  await page.goto(`/note/${note.id}`);
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText("Their note");
  await runCommand(page, "Go to agents file");
  await expect(text(page)).toHaveText("# RulesTag tried recipes #tried.");
  await expect(state(page)).toHaveText("Read only");
  await expect(file(page)).toContainText("Only admins and editors change it.");
  await expect(text(page)).toHaveAttribute("contenteditable", "false");
  await text(page).click();
  await page.keyboard.insertText("Mine");
  await expect(text(page)).toHaveText("# RulesTag tried recipes #tried.");
  expect(await stored(admin)).toBe("# Rules\n\nTag tried recipes #tried.");
});

test("it is in no list of notes, no search and no quick open, and an agent's list_notes leaves it out while read_agents_file reads it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "agentsFile.write", text: "# Agents file\n\nzephyrwords are filed in Weather.", baseRevision: 0 });
  await perform(page, { type: "note.create", text: "# Zephyr note\n\nzephyrwords in a note." });
  await page.goto("/");
  await openAllNotes(page);
  await expect(listedNotes(page)).toHaveText(["Zephyr note"]);

  await page.goto("/search");
  const search = page.getByRole("region", { name: "Search" });
  await search.getByRole("searchbox", { name: "Search notes" }).fill("zephyrwords");
  await expect(search.getByRole("navigation", { name: "Notes" }).locator(".card-title")).toHaveText(["Zephyr note"]);

  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  await palette.getByRole("combobox").fill("zephyr");
  await expect(palette.getByRole("option")).toHaveText([/^Zephyr note/]);

  const agent = await connectAgent(page, "Claude");
  expect((await agent.tool<{ notes: { title: string }[] }>("list_notes", {})).notes.map((n) => n.title)).toEqual(["Zephyr note"]);
  expect((await agent.tool<{ text: string }>("read_agents_file", {})).text).toBe("# Agents file\n\nzephyrwords are filed in Weather.");
});
