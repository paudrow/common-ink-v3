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

const OUTLINE = "# Trip\n\n- pack\n  - socks\n    - wool\n  - maps\n- book\n  - train\n- go\n\nAfter.";

/** Signs in and opens a note with this text. */
async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!);
  return note;
}

/** Puts the cursor at the end of the first line that says `text`, by a click past its end. */
async function clickLine(page: Page, text: string | RegExp) {
  const box = (await line(page, text).boundingBox())!;
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

test("a key selects a bullet with everything under it, and again the bullet it is under, so what is selected moves or goes as one", async ({ page }) => {
  const note = await open(page, OUTLINE);

  await clickLine(page, "socks");
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- pack\n  - maps\n  - socks\n    - wool\n- book\n  - train\n- go\n\nAfter.");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE);

  // From a bullet deep in, each press takes in one more level, and stops at the outermost.
  await clickLine(page, "wool");
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await page.keyboard.type("knit");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE.replace("    - wool", "knit"));
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE);

  await clickLine(page, "wool");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ControlOrMeta+Shift+L");
  await page.keyboard.press("Backspace");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n\n- book\n  - train\n- go\n\nAfter.");

  // Off a bullet the key is nobody's.
  await clickLine(page, "After.");
  await page.keyboard.press("ControlOrMeta+Shift+L");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n\n- book\n  - train\n- go\n\nAfter.!");
});
