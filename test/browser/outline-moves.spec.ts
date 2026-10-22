import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string | RegExp) => page.locator(".cm-line").filter({ hasText: text }).first();
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

/** Puts the cursor at the end of the first line that says `text`, by a click past its end. */
async function clickLine(page: Page, text: string | RegExp) {
  const box = (await line(page, text).boundingBox())!;
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

test("Option+↑ and Option+↓ take a bullet past the end of its list into the list beside it, numbered there, and the cursor goes with it", async ({ page }) => {
  const text = "# Plan\n\n1. home\n   1. sweep\n   2. dust\n2. shop\n   1. bread\n\nAfter.";
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");

  await clickLine(page, "dust");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n1. home\n   1. sweep\n2. shop\n   1. dust\n   2. bread\n\nAfter.");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toContain("   1. dust!\n");
  await page.keyboard.press("Backspace");

  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => read(page, note.id)).toBe(text);

  // The first of the first list has nothing before it to go into.
  await clickLine(page, "sweep");
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.type("?");
  await expect.poll(() => read(page, note.id)).toBe(text.replace("sweep", "sweep?"));
});
