import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { me, perform, signInAsNewPerson } from "./helpers.ts";
import { settingsDialog } from "./settings-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

test("a member exports the workspace from Settings as one zip of their notes and files in their folders", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = (await me(page)).workspaces[0]!.id;
  const plans = await perform(page, { type: "folder.create", name: "Plans" });
  const launch = await perform(page, { type: "note.create", folderId: plans.id, text: "# Launch day\n\nSee the chart." });
  await perform(page, { type: "note.create", folderId: plans.id, text: "# launch DAY" });
  const binned = await perform(page, { type: "note.create", text: "# In the bin" });
  await perform(page, { type: "note.trash", id: binned.id });
  const chart = await page.evaluate(
    async ({ workspaceId, folderId }) => {
      const res = await fetch(`/api/workspaces/${workspaceId}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "chart.txt", folderId })) },
        body: "rising",
      });
      return (await res.json()) as { id: string };
    },
    { workspaceId, folderId: plans.id },
  );

  await page.goto("/settings/account");
  const exporting = settingsDialog(page).getByRole("region", { name: "Export" });
  await expect(exporting).toContainText("2 notes and 1 file");
  const [download] = await Promise.all([page.waitForEvent("download"), exporting.getByRole("link", { name: "Download" }).click()]);
  expect(download.suggestedFilename()).toBe("Ada's workspace export.zip");
  const path = await download.path();

  const listed = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n").sort();
  expect(listed).toEqual(["Plans/", "Plans/Launch day.md", "Plans/chart.txt", "Plans/launch DAY (2).md", "Unsorted/", "common-ink-export.json"]);
  expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toContain("No errors detected");
  expect(execFileSync("unzip", ["-p", path, "Plans/Launch day.md"], { encoding: "utf8" })).toBe("# Launch day\n\nSee the chart.");
  expect(execFileSync("unzip", ["-p", path, "Plans/chart.txt"], { encoding: "utf8" })).toBe("rising");
  const index = JSON.parse(execFileSync("unzip", ["-p", path, "common-ink-export.json"], { encoding: "utf8" }));
  expect(index.notes.find((n: { id: string }) => n.id === launch.id)).toMatchObject({ path: "Plans/Launch day.md", title: "Launch day", state: "live" });
  expect(index.uploads).toEqual([expect.objectContaining({ id: chart.id, path: "Plans/chart.txt", name: "chart.txt" })]);
});
