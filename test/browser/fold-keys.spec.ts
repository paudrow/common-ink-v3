import { expect, type Page } from "@playwright/test";
import { perform, runCommand, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string | RegExp) => page.locator(".cm-line").filter({ hasText: text }).first();
const statusLine = (page: Page) => page.locator(".cm-vim-panel");
const sheet = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const keysOf = (page: Page, table: string, title: string) => sheet(page).getByRole("table", { name: table }).getByRole("row").filter({ has: page.getByRole("rowheader", { name: title, exact: true }) }).locator("kbd");
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};

const OUTLINE = "# Trip\n\n- pack\n  - socks\n- go\n\nOne two three";

/** Signs in, with vim's keys or without, and opens the outline, or `text`. `lines` reads the note's lines from the server. */
async function open(page: Page, vim = false, text = OUTLINE) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (vim) await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("One two three");
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(vim ? 1 : 0);
  return async () => (await perform(page, { type: "note.read", id: note.id })).text.split("\n");
}

/** Whether the pack bullet is drawn folded: its socks hidden, an ellipsis after it, and its disclosure saying so. */
async function expectFolded(page: Page, folded: boolean) {
  await expect(editor(page).getByText("socks")).toHaveCount(folded ? 0 : 1);
  await expect(line(page, "pack").locator(".bullet-folded")).toHaveCount(folded ? 1 : 0);
  await expect(line(page, "pack").locator(".bullet-disclosure")).toHaveAttribute("aria-expanded", String(!folded));
}

test("⌥⌘[ folds the bullet the cursor is on and ⌥⌘] unfolds it, each only where it can; on a bullet with nothing under it they do nothing", async ({ page }) => {
  const lines = await open(page);
  await line(page, "pack").getByText("pack").click();
  await page.keyboard.press("End");

  await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
  await expectFolded(page, true);
  await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
  await expectFolded(page, true);
  await page.keyboard.press("ControlOrMeta+Alt+BracketRight");
  await expectFolded(page, false);
  await page.keyboard.press("ControlOrMeta+Alt+BracketRight");
  await expectFolded(page, false);

  await line(page, "go").getByText("go").click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+Alt+BracketLeft");
  await page.keyboard.press("ControlOrMeta+Alt+BracketRight");
  await page.keyboard.type("!");
  await expect.poll(lines).toEqual(["# Trip", "", "- pack", "  - socks", "- go!", "", "One two three"]);
});

test("on a Mac with a Dvorak keyboard, ⌥⌘ and the keys that type [ and ] there fold and unfold, and the key where a US keyboard has [ doesn't", async ({ page }) => {
  // What Chrome on a Mac says: Option writes its own character, and the keyboard's layout says what each key types without it.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    const dvorak = new Map([["Minus", "["], ["Equal", "]"], ["BracketLeft", "/"], ["BracketRight", "="]]);
    Object.defineProperty(navigator, "keyboard", { get: () => ({ getLayoutMap: () => Promise.resolve(dvorak) }) });
  });
  await open(page);
  await line(page, "pack").getByText("pack").click();
  await page.keyboard.press("End");
  const press = (key: string, code: string) => editor(page).evaluate((el, [key, code]) => el.dispatchEvent(new KeyboardEvent("keydown", { key, code, metaKey: true, altKey: true, bubbles: true, cancelable: true })), [key, code]);

  await press("“", "BracketLeft");
  await expectFolded(page, false);
  await press("“", "Minus");
  await expectFolded(page, true);
  await press("‘", "Equal");
  await expectFolded(page, false);
});

test("in vim's normal mode za, zc and zo toggle, close and open a bullet's fold, zM and zR close and open them all, and each does nothing where there is no fold", async ({ page }) => {
  const lines = await open(page, true, "# Trip\n\n- pack\n  - socks\n- go\n  - by train\n\nOne two three");
  const drawn = (bullet: string) => line(page, bullet).locator(".bullet-disclosure");
  await editor(page).click();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await keys(page, "g", "g", "j", "j");

  await keys(page, "z", "a");
  await expectFolded(page, true);
  await keys(page, "z", "a");
  await expectFolded(page, false);
  await keys(page, "z", "c");
  await expectFolded(page, true);
  await keys(page, "z", "c");
  await expectFolded(page, true);
  await keys(page, "z", "o");
  await expectFolded(page, false);
  await keys(page, "z", "o");
  await expectFolded(page, false);

  await keys(page, "z", "Shift+M");
  await expectFolded(page, true);
  await expect(drawn("go")).toHaveAttribute("aria-expanded", "false");
  await keys(page, "z", "Shift+R");
  await expectFolded(page, false);
  await expect(drawn("go")).toHaveAttribute("aria-expanded", "true");

  // On a bullet with nothing under it they do nothing.
  await keys(page, "j", "0", "z", "a", "z", "c", "z", "o", "x");
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await expect.poll(lines).toEqual(["# Trip", "", "- pack", " - socks", "- go", "  - by train", "", "One two three"]);
});

test("in vim's normal mode Space is vim's own again: it moves right, as far as its count, and folds nothing; f, r and d take it as a space", async ({ page }) => {
  const lines = await open(page, true);
  await editor(page).click();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await keys(page, "g", "g", "j", "j", "Space");
  await expectFolded(page, false);

  await keys(page, "Shift+G", "0", "3", "Space", "x");
  await expect.poll(async () => (await lines())[6]).toBe("Onetwo three");
  await keys(page, "0", "f", "Space", "x");
  await expect.poll(async () => (await lines())[6]).toBe("Onetwothree");
  await keys(page, "0", "r", "Space");
  await expect.poll(async () => (await lines())[6]).toBe(" netwothree");
  await keys(page, "d", "Space");
  await expect.poll(async () => (await lines())[6]).toBe("netwothree");
  await expect(statusLine(page)).toHaveText("--NORMAL--");
});

test("the keyboard shortcuts list the fold keys under Folding, and vim's z keys only with vim on", async ({ page }) => {
  await open(page);
  await runCommand(page, "Keyboard shortcuts");
  await expect(keysOf(page, "Folding", "Fold or unfold bullet")).toHaveText([/^(⇧⌘\.|Ctrl\+Shift\+\.)$/]);
  await expect(keysOf(page, "Folding", "Fold bullet")).toHaveText([/^(⌥⌘\[|Ctrl\+Alt\+\[)$/]);
  await expect(keysOf(page, "Folding", "Unfold bullet")).toHaveText([/^(⌥⌘\]|Ctrl\+Alt\+\])$/]);
  await expect(keysOf(page, "Folding", "Vim: fold or unfold the bullet")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await page.reload();
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  await runCommand(page, "Keyboard shortcuts");
  await expect(keysOf(page, "Folding", "Vim: fold or unfold the bullet")).toHaveText(["Z A"]);
  await expect(keysOf(page, "Folding", "Vim: fold the bullet")).toHaveText(["Z C"]);
  await expect(keysOf(page, "Folding", "Vim: unfold the bullet")).toHaveText(["Z O"]);
  await expect(keysOf(page, "Folding", "Vim: fold all bullets")).toHaveText([/^Z (⇧M|Shift\+M)$/]);
  await expect(keysOf(page, "Folding", "Vim: unfold all bullets")).toHaveText([/^Z (⇧R|Shift\+R)$/]);
  await expect(keysOf(page, "Folding", "Fold bullet")).toHaveText([/^(⌥⌘\[|Ctrl\+Alt\+\[)$/]);
});
