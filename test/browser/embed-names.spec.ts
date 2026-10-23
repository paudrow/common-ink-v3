import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const hints = (page: Page) => editor(page).locator(".cm-lintRange-hint");

test("a name close to an embed's has a quiet hint that says which it was likely meant to be, and a press on its fix writes that name", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Tea\n\nSteep /timr(5m) now.\n\nlast" });
  await page.goto(`/note/${note.id}`);
  await expect(hints(page)).toHaveText("/timr");
  await hints(page).hover();
  const tip = page.locator(".cm-tooltip-lint");
  await expect(tip).toContainText("No embed called timr. Did you mean /timer?");
  await tip.getByRole("button", { name: "Write /timer" }).click();
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\nSteep /timer(5m) now.\n\nlast");
  await expect(editor(page).getByRole("button", { name: "Timer, 5:00 left" })).toBeVisible();
  await expect(hints(page)).toHaveCount(0);
});

test("ordinary text with a slash, a word nowhere near a name or too short to be taken for one, code, and a board's content have no hint", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Paths\n\nRun /usr/bin(x) and/or (y), /or(x), and /hello(world).\n\n`/timr(5m)` in code\n\n```\n/timr(5m)\n```\n\n/kanban()\n```markdown\n## To do\n- see /timr(5m)\n```\n\nlast" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("/hello(world)");
  // The linter has had its time to look.
  await page.waitForTimeout(800);
  await expect(hints(page)).toHaveCount(0);
});
