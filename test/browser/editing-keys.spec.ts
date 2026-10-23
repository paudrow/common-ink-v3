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
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};

/** Signs in and opens a note with this text, with the cursor at its very start. */
async function open(page: Page, text: string, settings?: Record<string, unknown>) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (settings) await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!);
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  return note;
}

/** Puts the cursor at the end of the first line that says `text`, by a click past its end. */
async function clickLine(page: Page, text: string | RegExp) {
  const box = (await line(page, text).boundingBox())!;
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

const OUTLINE = "# Trip\n\n- pack\n  - socks\n  - maps\n- book\n  - train\n- go\n\nAfter.";

test("Tab indents a line where the cursor is and Shift+Tab outdents it, and neither leaves the note", async ({ page }) => {
  const note = await open(page, "# Plan\n\nfirst\nsecond\nthird");

  await clickLine(page, "first");
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await page.keyboard.type(">");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n  >first\nsecond\nthird");
  await expect(editor(page)).toBeFocused();
  // Mid-line it is room to the next stop of two, as a tab in a text editor is.
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await page.keyboard.type("|");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n  >first  |\nsecond\nthird");
  await keys(page, "Shift+Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n>first  |\nsecond\nthird");
  await expect(editor(page)).toBeFocused();

  // With lines selected, each of them moves.
  await clickLine(page, "second");
  await keys(page, "Home", "Shift+ArrowDown", "Shift+End", "Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n>first  |\n  second\n  third");
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n>first  |\nsecond\nthird");
  await expect(editor(page)).toBeFocused();
});

test("Tab on a bullet with nowhere to go under keeps the cursor in the note and changes nothing", async ({ page }) => {
  const note = await open(page, OUTLINE);

  await clickLine(page, "pack");
  await page.keyboard.press("Tab");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE.replace("- pack", "- pack!"));
});

test("with the outline plugin off, Tab and Shift+Tab still move a list item with what is under it", async ({ page }) => {
  const note = await open(page, OUTLINE, { "bullets.enabled": false });
  await expect(editor(page).locator(".bullet-dot")).toHaveCount(0);

  await clickLine(page, "book");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- pack\n  - socks\n  - maps\n  - book\n    - train\n- go\n\nAfter.");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toContain("  - book!\n    - train");
  await keys(page, "Backspace", "Shift+Tab");
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE);
  await expect(editor(page)).toBeFocused();

  // From before its mark, the cursor moves in with the item, not left behind before the new indent.
  await keys(page, "Home", "Tab");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe("# Trip\n\n- pack\n  - socks\n  - maps\n  !- book\n    - train\n- go\n\nAfter.");
});

test("Escape and then Tab leaves the note for what comes next on the page, on a bullet too", async ({ page }) => {
  const note = await open(page, OUTLINE);

  await clickLine(page, "book");
  await keys(page, "Escape", "Tab");
  await expect(editor(page)).not.toBeFocused();
  await expect.poll(() => read(page, note.id)).toBe(OUTLINE);

  // Another key between them, and Tab is the note's again.
  await clickLine(page, "book");
  await keys(page, "Escape", "ArrowLeft", "Tab");
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => read(page, note.id)).toContain("  - book\n    - train");
});

test("with vim on, Tab indents in insert mode, does nothing in normal mode, and Escape and then Tab leaves the note", async ({ page }) => {
  const note = await open(page, "# Plan\n\nwords", { "vim.enabled": true });
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");

  // In normal mode Tab is nobody's: it changes nothing and stays in the note.
  await keys(page, "j", "j", "Tab", "Shift+Tab");
  await expect(editor(page)).toBeFocused();
  await keys(page, "i", "Tab");
  await page.keyboard.type(">");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n  >words");
  await expect(editor(page)).toBeFocused();
  await keys(page, "Escape", "Tab");
  await expect(editor(page)).not.toBeFocused();
});

test("the keyboard shortcuts say Tab indents in a note and how to leave it", async ({ page }) => {
  await open(page, "# Plan");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Keyboard shortcuts");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toContainText("In a note, Tab indents and Shift+Tab outdents. To leave the note from the keyboard, press Esc and then Tab.");
});

test("Enter on a todo starts the next one directly below, and Enter on an empty one ends the list, never with a blank line", async ({ page }) => {
  const note = await open(page, "# Chores\n\n- [ ] sweep");

  await clickLine(page, "sweep");
  await page.keyboard.press("Enter");
  await page.keyboard.type("mop");
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe("# Chores\n\n- [ ] sweep\n- [ ] mop\n- [ ] ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Done.");
  await expect.poll(() => read(page, note.id)).toBe("# Chores\n\n- [ ] sweep\n- [ ] mop\nDone.");
});

test("Enter on the second todo of a list, with nothing in it yet, ends the list instead of putting a blank line above it", async ({ page }) => {
  const note = await open(page, "# Chores\n\n- [ ] sweep");

  await clickLine(page, "sweep");
  await keys(page, "Enter", "Enter");
  await page.keyboard.type("Done.");
  await expect.poll(() => read(page, note.id)).toBe("# Chores\n\n- [ ] sweep\nDone.");
});

test("Enter in a list written with blank lines between its items adds the next item directly below", async ({ page }) => {
  const note = await open(page, "# Mixed\n\n- [ ] one\n\n- [ ] two\n\n- three\n\n- four\n\n> - quoted\n>\n> - again");

  await clickLine(page, "two");
  await page.keyboard.press("Enter");
  await page.keyboard.type("between");
  await clickLine(page, "four");
  await page.keyboard.press("Enter");
  await page.keyboard.type("five");
  await clickLine(page, "again");
  await page.keyboard.press("Enter");
  await page.keyboard.type("more");
  await expect.poll(() => read(page, note.id)).toBe("# Mixed\n\n- [ ] one\n\n- [ ] two\n- [ ] between\n\n- three\n\n- four\n- five\n\n> - quoted\n>\n> - again\n> - more");
});
