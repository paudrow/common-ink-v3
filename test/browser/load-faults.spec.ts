import { expect, type Page } from "@playwright/test";
import { anotherPerson, folderRow, listedNotes, me, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const FAULT = { status: 500, contentType: "application/json", body: JSON.stringify({ error: "unknown", message: "Down for a moment" }) };

/** Fails each operation of one kind while `down` says so. `seen` counts every one sent. */
async function failing(page: Page, type: string, down: (nth: number) => boolean) {
  const sent = { seen: 0 };
  await page.route("**/ops", async (route) => {
    if ((route.request().postDataJSON() as { type: string }).type !== type) return route.continue();
    if (down(++sent.seen)) return route.fulfill(FAULT);
    await route.continue();
  });
  return sent;
}

const couldNotLoad = (page: Page) => page.getByRole("alert").filter({ hasText: "Couldn't load your notes" });

test("a first listing of the notes that fails says so in the list, and is asked for again by itself", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Still here" });
  const lists = await failing(page, "note.list", (nth) => nth <= 2);

  await page.goto("/folder/all");

  await expect(couldNotLoad(page)).toBeVisible();
  // The second listing fails too, and the third, a few seconds later, is let through.
  await expect(listedNotes(page)).toHaveText(["Still here"], { timeout: 10_000 });
  await expect(couldNotLoad(page)).toHaveCount(0);
  expect(lists.seen).toBe(3);
});

test("Try again lists the notes now, and so does a first listing of the folders that failed", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Still here" });
  let down = true;
  await failing(page, "note.list", () => down);
  await failing(page, "folder.list", () => down);

  await page.goto("/folder/all");

  await expect(couldNotLoad(page)).toBeVisible();
  await expect(folderRow(page, "All notes")).toHaveCount(0);
  down = false;
  await couldNotLoad(page).getByRole("button", { name: "Try again" }).click();
  await expect(listedNotes(page)).toHaveText(["Still here"]);
  await expect(folderRow(page, "All notes")).toBeVisible();
});

test("a first listing of the folders that fails is asked for again by itself", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Still here" });
  const lists = await failing(page, "folder.list", (nth) => nth <= 2);

  await page.goto("/folder/all");

  await expect(couldNotLoad(page)).toBeVisible();
  await expect(folderRow(page, "All notes")).toBeVisible({ timeout: 10_000 });
  await expect(listedNotes(page)).toHaveText(["Still here"]);
  expect(lists.seen).toBe(3);
});

test("when who is signed in can't be read, the page says so, offers Try again, and asks again by itself", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  let reads = 0;
  let down = (nth: number) => nth <= 2;
  await page.route("**/api/me", (route) => (down(++reads) ? route.fulfill(FAULT) : route.continue()));

  await page.goto("/folder/all");

  const failed = page.getByRole("alert").filter({ hasText: "Common Ink couldn't load: Down for a moment" });
  await expect(failed).toBeVisible();
  await expect(folderRow(page, "All notes")).toBeVisible({ timeout: 10_000 });
  expect(reads).toBe(3);

  down = () => true;
  await page.reload();
  await expect(failed).toBeVisible();
  down = () => false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(folderRow(page, "All notes")).toBeVisible();
});

test("a guest's app asks nothing that only a member may, so nothing is refused and who they are isn't read again for it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const workspaceId = (await me(page)).workspaces[0]!.id;
  const note = await perform(page, { type: "note.create", text: "# For Gus\n\nHello @Ada" });
  const gus = await anotherPerson(page, "Gus Guest");
  const { email } = (await me(gus)).person;
  await perform(page, { type: "grant.set", noteId: note.id, email, access: "view" });
  expect((await me(gus)).workspaces.find((w) => w.id === workspaceId)?.role).toBe("guest");
  const refused: string[] = [];
  gus.on("response", (res) => {
    if (res.url().endsWith("/ops") && res.status() === 403) refused.push((res.request().postDataJSON() as { type: string }).type);
  });

  await gus.goto(`/note/${note.id}`);
  await expect(gus.getByRole("textbox", { name: "Note text" })).toContainText("Hello");
  // What the app reads again every so often, it reads when the window comes back to the front.
  await gus.evaluate(() => dispatchEvent(new Event("focus")));
  await gus.waitForTimeout(1500);

  expect(refused).toEqual([]);
});
