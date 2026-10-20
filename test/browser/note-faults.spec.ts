import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const saveState = (page: Page) => page.locator(".save-state");
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** Answers each operation of one kind that `when` picks with `status`, in place of the server. `seen` counts every one sent. */
async function answering(page: Page, type: string, status: number, body: object, when: (nth: number) => boolean) {
  const sent = { seen: 0 };
  await page.route("**/ops", async (route) => {
    if ((route.request().postDataJSON() as { type: string }).type !== type) return route.continue();
    if (when(++sent.seen)) return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    await route.continue();
  });
  return sent;
}

test("a note whose first read fails says so, never says Saved, and is read again by itself", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Flaky\n\nStill here." });
  const reads = await answering(page, "note.read", 500, { error: "unknown" }, (nth) => nth <= 2);

  await page.goto(`/note/${note.id}`);

  const failed = page.getByRole("alert").filter({ hasText: "This note couldn't be loaded" });
  await expect(failed).toBeVisible();
  await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(saveState(page)).not.toHaveText(/Saved/);
  await expect(editor(page)).toHaveCount(0);
  // The second read fails too, and the third is let through.
  await expect(editor(page)).toContainText("Still here.", { timeout: 15_000 });
  await expect(failed).toHaveCount(0);
  await expect(saveState(page)).toHaveText("Saved");
  expect(reads.seen).toBe(3);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" And typed.");
  await expect.poll(() => read(page, note.id)).toBe("# Flaky\n\nStill here. And typed.");
});

test("Try again reads a note that couldn't be loaded, without waiting", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Flaky\n\nStill here." });
  let down = true;
  // Refused, so asking again by itself would get the same answer.
  await answering(page, "note.read", 400, { error: "invalid", message: "Not now" }, () => down);

  await page.goto(`/note/${note.id}`);

  const failed = page.getByRole("alert").filter({ hasText: "This note couldn't be loaded" });
  await expect(failed).toContainText("Not now");
  await expect(saveState(page)).not.toHaveText(/Saved/);
  down = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(editor(page)).toContainText("Still here.");
  await expect(saveState(page)).toHaveText("Saved");
});

test("a session that ends while a note is open stops the saving, says to sign in, and saves what was typed once signed in", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Draft\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Draft");
  // A dev host signs a browser with no session in as the dev user, so every request is answered here as a signed-out browser's is.
  let signedOut = true;
  const writes = { seen: 0 };
  await page.route("**/api/**", async (route) => {
    if (!signedOut) return route.continue();
    if ((route.request().postDataJSON() as { type?: string } | null)?.type === "note.write") writes.seen++;
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "signed_out" }) });
  });
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Typed while signed out.");

  const banner = page.getByRole("alert").filter({ hasText: "signed out" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", `/auth/google?next=${encodeURIComponent(new URL(page.url()).pathname)}`);
  await expect(banner.getByRole("link", { name: "Sign in" })).toHaveAttribute("target", "_blank");
  await expect(saveState(page)).toHaveText(/signed out/);
  await expect(saveState(page)).not.toHaveText(/Retrying/);
  // It used to send the write again every 3 seconds for as long as the tab was open.
  const sent = writes.seen;
  await page.waitForTimeout(7000);
  expect(writes.seen).toBe(sent);
  await expect(editor(page)).toContainText("Typed while signed out.");

  signedOut = false;
  // Coming back to the tab after signing in.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => read(page, note.id)).toBe("# Draft\n\nTyped while signed out.");
  await expect(saveState(page)).toHaveText("Saved");
  await expect(banner).toHaveCount(0);
  expect((await perform(page, { type: "note.history", id: note.id })).length).toBe(2);
});
