import { expect, test } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";
import { json, openJson, settingsDialog } from "./settings-helpers.ts";

const localDay = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const at = new Date();
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  });

test("a nested folder picked for daily notes in Settings is where Today makes the new daily note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const projects = await perform(page, { type: "folder.create", name: "Projects" });
  const journal = await perform(page, { type: "folder.create", name: "Journal", parentId: projects.id });
  const today = await localDay(page);

  await page.goto("/settings/plugins/daily");
  const picker = settingsDialog(page).getByRole("combobox", { name: "Daily notes folder" });
  await expect(picker.getByRole("option")).toHaveText(["Daily", "Projects", "Projects / Journal", "Unsorted"]);
  await expect(picker).toHaveValue("");
  await picker.selectOption({ label: "Projects / Journal" });
  await expect(picker).toHaveValue(journal.id);

  await openJson(page);
  await expect(json(page)).toContainText(`"daily.folder": "${journal.id}"`);

  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toContainText(today);
  const daily = await perform(page, { type: "daily.find", on: today });
  const note = await perform(page, { type: "note.read", id: daily.note!.id });
  expect([note.title, note.folderId]).toEqual([today, journal.id]);
});

test("a folder picked for daily notes that is gone says Daily is used, and a name the setting once held shows as written", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const gone = await perform(page, { type: "folder.create", name: "Gone" });
  await perform(page, { type: "folder.delete", id: gone.id });
  const pick = async (folder: string) => perform(page, { type: "settings.write", text: JSON.stringify({ "daily.folder": folder }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  const picker = settingsDialog(page).getByRole("combobox", { name: "Daily notes folder" });
  const shown = () => picker.evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.textContent);

  await pick(gone.id);
  await page.goto("/settings/plugins/daily");
  await expect.poll(shown).toBe("A folder that's gone or not yours to edit (Daily is used)");
  await expect(picker).toHaveValue(gone.id);

  await pick("Journal");
  await page.reload();
  await expect.poll(shown).toBe("Journal");
});
