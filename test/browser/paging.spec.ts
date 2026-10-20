import { expect, test, type Page } from "@playwright/test";
import type { Me } from "../../src/core/protocol.ts";
import { signInAsNewPerson } from "./helpers.ts";

// A page of Trash or of Uploads holds a hundred, so each test makes a few more than that.
test.describe.configure({ timeout: 120_000 });

/** Makes `count` notes, each in Trash, ten at a time, as the signed-in person: "Trashed 000" the first, trashed first. */
function trashMany(page: Page, count: number) {
  return page.evaluate(async (count) => {
    const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
    const op = async (body: object) => {
      const res = await fetch(`/api/workspaces/${id}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    };
    for (let from = 0; from < count; from += 10) {
      const made = await Promise.all(Array.from({ length: Math.min(10, count - from) }, (_, i) => op({ type: "note.create", text: `# Trashed ${String(from + i).padStart(3, "0")}` })));
      for (const note of made) await op({ type: "note.trash", id: note.id });
    }
  }, count);
}

/** Sends `count` small files, ten at a time, as the signed-in person: "file-000.txt" the first. */
function uploadMany(page: Page, count: number) {
  return page.evaluate(async (count) => {
    const id = ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
    const send = async (name: string) => {
      const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name })) }, body: new TextEncoder().encode(name) });
      if (!res.ok) throw new Error(await res.text());
    };
    for (let from = 0; from < count; from += 10) await Promise.all(Array.from({ length: Math.min(10, count - from) }, (_, i) => send(`file-${String(from + i).padStart(3, "0")}.txt`)));
  }, count);
}

const showMore = (page: Page) => page.getByRole("button", { name: "Show more" });

test("Trash lists a page of notes, and Show more the rest, which stay listed when Trash is read again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await trashMany(page, 103);
  await page.goto("/trash");
  const rows = page.getByRole("list", { name: "Notes in Trash" }).getByRole("listitem");

  const titles = rows.locator(".trash-title");
  const every = Array.from({ length: 103 }, (_, i) => `Trashed ${String(i).padStart(3, "0")}`);

  await expect(rows).toHaveCount(100);
  await showMore(page).click();
  await expect(rows).toHaveCount(103);
  await expect(showMore(page)).toHaveCount(0);
  expect((await titles.allTextContents()).toSorted(), "each note once").toEqual(every);

  await rows.filter({ hasText: "Trashed 001" }).getByRole("button", { name: "Restore" }).click();
  await expect(rows).toHaveCount(102);
  await expect(showMore(page)).toHaveCount(0);
  expect((await titles.allTextContents()).toSorted(), "read again, as far as Show more had read").toEqual(every.filter((t) => t !== "Trashed 001"));
});

test("Uploads lists a page of files, and Show more the rest, each once", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await uploadMany(page, 102);
  await page.goto("/uploads");
  const rows = page.getByRole("list", { name: "Uploads" }).getByRole("link");

  await expect(rows).toHaveCount(100);
  await showMore(page).click();
  await expect(rows).toHaveCount(102);
  await expect(showMore(page)).toHaveCount(0);
  const names = await rows.locator(".upload-name").allTextContents();
  expect(new Set(names).size, "no file listed twice").toBe(102);
  expect(names.toSorted()).toEqual(Array.from({ length: 102 }, (_, i) => `file-${String(i).padStart(3, "0")}.txt`));

  await page.getByRole("searchbox", { name: "Find uploads" }).fill("sort:name-asc");
  await expect(rows.first()).toContainText("file-000.txt");
  await expect(rows).toHaveCount(100);
  await expect(rows.last()).toContainText("file-099.txt");
  await showMore(page).click();
  await expect(rows).toHaveCount(102);
  await expect(rows.last()).toContainText("file-101.txt");
});
