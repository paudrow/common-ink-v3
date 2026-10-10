import { expect, test, type Page } from "@playwright/test";
import type { ChangeEntry, Me } from "../../src/core/protocol.ts";

async function signInAsNewPerson(page: Page, name: string) {
  const email = `browser-${crypto.randomUUID()}@example.com`;
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in as a dev user" })).toBeVisible();
  await page.goto(`/auth/dev?${new URLSearchParams({ email, name })}`);
}

function history(page: Page, noteId: string): Promise<ChangeEntry[]> {
  return page.evaluate(async (id) => {
    const me = (await (await fetch("/api/me")).json()) as Me;
    const res = await fetch(`/api/workspaces/${me.workspaces[0]!.id}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "note.history", id }),
    });
    return res.json();
  }, noteId);
}

function writeElsewhere(page: Page, op: { id: string; baseRevision: number; text: string }) {
  return page.evaluate(async (write) => {
    const me = (await (await fetch("/api/me")).json()) as Me;
    await fetch(`/api/workspaces/${me.workspaces[0]!.id}/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "note.write", ...write }),
    });
  }, op);
}

const noteIdIn = (page: Page) => /([a-z0-9]{12})$/.exec(new URL(page.url()).pathname)![1]!;

test("a new person signs in, writes a note, and finds it intact after reloading", async ({ page }) => {
  await signInAsNewPerson(page, "Mary Somerville");
  await expect(page.getByText("Mary's workspace")).toBeVisible();

  await page.getByRole("button", { name: "New note" }).click();
  const editor = page.getByRole("textbox", { name: "Note text" });
  await expect(editor).toBeFocused();
  await page.keyboard.type("# Field notes\n\nTyped in one go.");

  await expect(page).toHaveURL(/\/note\/field-notes-[a-z0-9]{12}$/);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(page.getByRole("navigation", { name: "Notes" }).getByRole("link")).toHaveText(["Field notes"]);
  const changes = await history(page, noteIdIn(page));
  expect(changes.map((c) => ({ revision: c.revision, baseRevision: c.baseRevision, author: c.author.name }))).toEqual([
    { revision: 1, baseRevision: 0, author: "Mary Somerville" },
  ]);

  await page.reload();
  await expect(page.locator(".cm-line")).toHaveText(["# Field notes", "", "Typed in one go."]);
});

test("typing is committed as soon as the note loses focus", async ({ page }) => {
  await signInAsNewPerson(page, "Emmy Noether");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Draft");

  const saved = page.waitForResponse((res) => res.url().endsWith("/ops") && res.request().postDataJSON()?.type === "note.write", { timeout: 600 });
  await page.getByText("Emmy's workspace").click();
  await saved;

  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await history(page, noteIdIn(page))).toHaveLength(1);
});

test("a save based on an old revision keeps the other writer's change, and the editor shows both", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Shared\n\nmine");
  await expect(page).toHaveURL(/\/note\/shared-[a-z0-9]{12}$/);
  await expect(page.getByRole("status")).toHaveText("Saved");

  await writeElsewhere(page, { id: noteIdIn(page), baseRevision: 1, text: "# Shared\n\nmine\n\ntheirs" });
  await page.keyboard.type(" too");
  await page.getByText("Ada's workspace").click();

  await expect(page.locator(".cm-line")).toHaveText(["# Shared", "", "mine too", "", "theirs"]);
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await history(page, noteIdIn(page))).map((c) => c.baseRevision)).toEqual([0, 1, 1]);
});

test("an old link with an outdated slug still opens the note", async ({ page }) => {
  await signInAsNewPerson(page, "Sofia Kovalevskaya");
  await page.getByRole("button", { name: "New note" }).click();
  await expect(page.getByRole("textbox", { name: "Note text" })).toBeFocused();
  await page.keyboard.type("# Current title");
  await expect(page).toHaveURL(/\/note\/current-title-[a-z0-9]{12}$/);
  const id = noteIdIn(page);

  await page.goto(`/note/an-old-title-${id}`);

  await expect(page.locator(".cm-line")).toHaveText(["# Current title"]);
  await expect(page).toHaveURL(new RegExp(`/note/current-title-${id}$`));
});
