import { expect, type Locator, type Page } from "@playwright/test";
import type { Note } from "../../src/core/protocol.ts";
import { agentWith, perform, shownToken, signInAsNewPerson, test } from "./helpers.ts";

const connected = (page: Page) => page.getByRole("list", { name: "Connected agents" }).getByRole("listitem");
const connectForm = (page: Page) => page.getByRole("form", { name: "Connect an agent" });
const allNotes = (form: Locator) => form.getByRole("radio", { name: "All notes" });
const chosenFolders = (form: Locator) => form.getByRole("radio", { name: /^Only chosen folders/ });
/** The folders offered, each by its path. */
const offered = (form: Locator) => () => form.getByRole("group", { name: "Folders it reaches" }).getByRole("checkbox").evaluateAll((boxes) => boxes.map((box) => box.getAttribute("aria-label")));
const pick = (form: Locator, path: string) => form.getByRole("group", { name: "Folders it reaches" }).getByRole("checkbox", { name: path, exact: true });
const titles = (agent: ReturnType<typeof agentWith>) => async () => (await agent.tool<{ notes: Note[] }>("list_notes", {})).notes.map((n) => n.title).sort();

/** Ada's workspace with Projects, Plans inside it, and Journal beside them, each with a note. */
async function workspaceWithFolders(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const plans = await perform(page, { type: "folder.create", name: "Plans", parentId: projects.id });
  const journal = await perform(page, { type: "folder.create", name: "Journal" });
  await perform(page, { type: "note.create", folderId: projects.id, text: "# Roadmap" });
  await perform(page, { type: "note.create", folderId: plans.id, text: "# Q3 plan" });
  const diary = await perform(page, { type: "note.create", folderId: journal.id, text: "# Diary" });
  await page.goto("/agents");
  return { projects, plans, journal, diary };
}

/** Connects an agent limited to the folders ticked by `choose`, and returns its token's tools. */
async function connectLimited(page: Page, name: string, choose: (form: Locator) => Promise<void>) {
  const form = connectForm(page);
  await form.getByRole("textbox", { name: "Name" }).fill(name);
  await form.getByRole("combobox", { name: "Reaches" }).selectOption({ index: 1 });
  await chosenFolders(form).check();
  await choose(form);
  await form.getByRole("button", { name: "Connect" }).click();
  const shown = page.getByRole("region", { name: "New token" });
  await expect(shown).toContainText(`${name} is connected.`);
  const token = await shownToken(shown);
  await shown.getByRole("button", { name: "Done" }).click();
  return agentWith(page, token);
}

test("an agent is connected to chosen folders: its row names them, and it reaches their notes, the folders inside them, and nothing else", async ({ page }) => {
  const { diary } = await workspaceWithFolders(page);
  const form = connectForm(page);

  // Folders are one workspace's, so they are offered once the agent reaches only one.
  await expect(allNotes(form)).toBeChecked();
  await expect(chosenFolders(form)).toBeDisabled();
  await expect(form).toContainText("To limit it to folders, have it reach only one workspace.");
  await form.getByRole("textbox", { name: "Name" }).fill("Claude");
  await form.getByRole("combobox", { name: "Reaches" }).selectOption({ index: 1 });
  await expect(chosenFolders(form)).toBeEnabled();
  await chosenFolders(form).check();
  await expect.poll(offered(form)).toEqual(["Unsorted", "Journal", "Projects", "Projects / Plans"]);

  await form.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toHaveText("Choose at least one folder, or All notes");
  await expect(connected(page)).toHaveCount(0);

  // A folder brings the folders inside it, which are shown ticked and can't be taken out on their own.
  await pick(form, "Projects").check();
  await expect(pick(form, "Projects / Plans")).toBeChecked();
  await expect(pick(form, "Projects / Plans")).toBeDisabled();
  await form.getByRole("button", { name: "Connect" }).click();
  const shown = page.getByRole("region", { name: "New token" });
  await expect(shown).toContainText("Claude is connected.");
  await expect(shown.getByRole("textbox", { name: "Prompt" })).toHaveValue(/It reaches only the folder "Projects" of my workspace "Ada's workspace" and the folders inside it\. The rest of it is hidden from you\./);
  const claude = agentWith(page, await shownToken(shown));

  const row = connected(page);
  await expect(row).toContainText("reaches only Projects in Ada's workspace");
  await expect(row).toContainText("limited to folders");
  await expect.poll(titles(claude)).toEqual(["Q3 plan", "Roadmap"]);
  await expect(claude.tool("read_note", { id: diary.id })).rejects.toThrow("not_found: No such note");
  await expect(claude.tool("create_note", { text: "# Loose" })).rejects.toThrow("Unsorted isn't one of them");

  // The form starts again for the next agent.
  await expect(form.getByRole("textbox", { name: "Name" })).toHaveValue("");
  await expect(allNotes(form)).toBeChecked();
});

test("editing an agent changes the folders it is limited to, lifts the limit, and sets one, on the token it has", async ({ page }) => {
  await workspaceWithFolders(page);
  const claude = await connectLimited(page, "Claude", (form) => pick(form, "Projects / Plans").check());
  const row = connected(page);
  await expect(row).toContainText("reaches only Projects / Plans in Ada's workspace");
  await expect.poll(titles(claude)).toEqual(["Q3 plan"]);
  const sent: unknown[] = [];
  await page.route("**/api/agents/*", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fallback();
  });

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = row.getByRole("form", { name: "Edit Claude" });
  await expect(chosenFolders(edit)).toBeChecked();
  await expect.poll(offered(edit)).toEqual(["Unsorted", "Journal", "Projects", "Projects / Plans"]);
  await expect(pick(edit, "Projects / Plans")).toBeChecked();
  await expect(pick(edit, "Projects")).not.toBeChecked();
  // Saved as it was opened, nothing is sent.
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);

  await row.getByRole("button", { name: "Edit" }).click();
  await pick(edit, "Projects / Plans").uncheck();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("Choose at least one folder, or All notes");
  await pick(edit, "Journal").check();
  await pick(edit, "Unsorted").check();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText("reaches only Unsorted and Journal in Ada's workspace");
  await expect.poll(titles(claude)).toEqual(["Diary"]);

  await row.getByRole("button", { name: "Edit" }).click();
  await allNotes(edit).check();
  await expect(edit.getByRole("group", { name: "Folders it reaches" })).toHaveCount(0);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText("reaches only Ada's workspace ·");
  await expect(row).not.toContainText("limited to folders");
  await expect.poll(titles(claude)).toEqual(["Diary", "Q3 plan", "Roadmap"]);

  // Reaching every workspace and being limited to folders don't go together: picking the first takes the second away.
  await row.getByRole("button", { name: "Edit" }).click();
  await chosenFolders(edit).check();
  await pick(edit, "Projects").check();
  await edit.getByRole("combobox", { name: "Reaches" }).selectOption({ index: 0 });
  await expect(chosenFolders(edit)).toBeDisabled();
  await expect(allNotes(edit)).toBeChecked();
  await edit.getByRole("combobox", { name: "Reaches" }).selectOption({ index: 1 });
  await expect(chosenFolders(edit)).toBeChecked();
  await expect(pick(edit, "Projects")).toBeChecked();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("reaches only Projects in Ada's workspace");
  await expect.poll(titles(claude)).toEqual(["Q3 plan", "Roadmap"]);

  expect(sent.map((body) => Object.keys(body as object))).toEqual([[], ["folderIds"], ["folderIds"], ["folderIds"]]);
  expect((sent[2] as { folderIds: unknown }).folderIds).toBeNull();
});

test("an agent whose folder is deleted reaches nothing, never everything, and its row and its form say why", async ({ page }) => {
  const { plans } = await workspaceWithFolders(page);
  const claude = await connectLimited(page, "Claude", (form) => pick(form, "Projects / Plans").check());
  await expect.poll(titles(claude)).toEqual(["Q3 plan"]);

  const [q3] = (await perform(page, { type: "note.list", folderId: plans.id })).notes;
  await perform(page, { type: "note.move", id: q3!.id, folderId: (await perform(page, { type: "folder.list" })).unsortedId! });
  await perform(page, { type: "folder.delete", id: plans.id });
  await expect.poll(titles(claude)).toEqual([]);

  await page.reload();
  const row = connected(page);
  await expect(row).toContainText("reaches nothing in Ada's workspace, as the folders it was limited to are gone");
  const sent: unknown[] = [];
  await page.route("**/api/agents/*", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fallback();
  });
  await row.getByRole("button", { name: "Edit" }).click();
  const edit = row.getByRole("form", { name: "Edit Claude" });
  await expect(chosenFolders(edit)).toBeChecked();
  await expect(edit).toContainText("A folder it was limited to is no longer there.");
  // Another thing about it can still be changed, and the limit stays what it was.
  await edit.getByRole("checkbox", { name: /^Read only/ }).check();
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toHaveCount(0);
  await expect(row).toContainText("read only");
  expect(sent).toEqual([{ readOnly: true }]);
  await expect.poll(titles(claude)).toEqual([]);
});
