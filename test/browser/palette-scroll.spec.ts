import { expect, type Locator, type Page } from "@playwright/test";
import { editOf, openAllNotes, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const LONG = `# Long\n\n${Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the long note.`).join("\n\n")}`;
const SHORTCUTS = [
  ["ControlOrMeta+P", "Go to note"],
  ["ControlOrMeta+Shift+P", "Commands"],
] as const;

const scrollOf = (scroller: Locator) => scroller.evaluate((el) => el.scrollTop);

/** Opens quick open or the command palette and closes it with Escape, the scroll of `scroller` at `at` before, while it is open and after. */
async function openAndClose(page: Page, scroller: Locator, keys: string, name: string, at: number) {
  await expect.poll(() => scrollOf(scroller), `before ${keys}`).toBe(at);
  await page.keyboard.press(keys);
  await expect(page.getByRole("dialog", { name })).toBeVisible();
  expect(await scrollOf(scroller), `while ${keys} is open`).toBe(at);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name })).toHaveCount(0);
  expect(await scrollOf(scroller), `after ${keys} closes`).toBe(at);
}

test("quick open and the command palette leave a note where it was scrolled to, and give the editor back its cursor", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: LONG });
  await page.goto("/");
  await openAllNotes(page);
  await editOf(page, "Long").click();
  const editor = page.getByRole("textbox", { name: "Note text" });
  const scroller = page.locator(".note-scroll");
  await editor.locator(".cm-line", { hasText: "Line 2 of" }).click();
  await scroller.hover();
  await page.mouse.wheel(0, 1200);
  await editor.locator(".cm-line", { hasText: "Line 30 of" }).click();
  const cursorLine = () => page.evaluate(() => getSelection()!.focusNode!.parentElement!.closest(".cm-line")!.textContent);
  // The editor settles near the wheel's 1200 once it has measured its lines, by an amount that depends on the font.
  let at = -1;
  await expect.poll(async () => at === (at = await scrollOf(scroller))).toBe(true);
  expect(at).toBeGreaterThan(1100);

  for (const [keys, name] of SHORTCUTS) {
    await openAndClose(page, scroller, keys, name, at);
    await expect(editor).toBeFocused();
    expect(await cursorLine()).toBe("Line 30 of the long note.");
  }

  await page.keyboard.press("ControlOrMeta+P");
  await editor.locator(".cm-line", { hasText: "Line 31 of" }).click();
  await expect(page.getByRole("dialog", { name: "Go to note" })).toHaveCount(0);
  expect(await scrollOf(scroller), "after a click outside quick open").toBe(at);
});

test("quick open and the command palette leave a list where it was scrolled to, and give the card back the keyboard", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (let i = 0; i < 20; i++) await perform(page, { type: "note.create", text: `# Note ${i}\n\nSome text.` });
  await page.goto("/");
  await openAllNotes(page);
  const scroller = page.locator(".folder-list");
  const first = page.locator("article.card").first();
  await first.click({ position: { x: 4, y: 4 } });
  await expect(first).toBeFocused();
  await scroller.hover();
  await page.mouse.wheel(0, 1200);

  for (const [keys, name] of SHORTCUTS) {
    await openAndClose(page, scroller, keys, name, 1200);
    await expect(first).toBeFocused();
  }
});
