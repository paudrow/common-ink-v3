import { expect, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

/** A built-in plugin that runs in its own frame, as the word count and the quick timer do. */
const pluginIn = (root: Page | Locator, view: string) => root.locator(`.plugin-frame[aria-label="${view}"] > iframe`).contentFrame().locator("iframe").contentFrame();

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page, group = 0) => page.getByRole("textbox", { name: "Note text" }).nth(group);
const statusLine = (page: Page, group = 0) => page.locator(".cm-vim-panel").nth(group);
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};
const run = async (page: Page, command: string) => {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill(command);
  await page.keyboard.press("Enter");
};

const LINES = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the note.`);

/** Where the line that says `word` is in the note's pane, as a share of the pane's height from its top: 0 at the top, 1 at the foot. */
const at = (page: Page, word: string) =>
  page.evaluate((w) => {
    const pane = document.querySelector(".note-scroll")!.getBoundingClientRect();
    const line = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent === w)!.getBoundingClientRect();
    return { top: line.top - pane.top, bottom: pane.bottom - line.bottom, middle: (line.top + line.bottom) / 2 - (pane.top + pane.bottom) / 2, height: line.height };
  }, word);
const cursorLine = (page: Page) =>
  page.evaluate(() => {
    const at = getSelection()?.focusNode;
    return (at instanceof Element ? at : at?.parentElement)?.closest(".cm-line")?.textContent ?? null;
  });

async function withVim(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await editor(page).click();
  await keys(page, "g", "g");
  return note;
}

/** Puts the cursor on line `n` with vim's own keys. */
const toLine = async (page: Page, n: number) => {
  await page.keyboard.type(`${n}G`);
  await expect.poll(() => cursorLine(page)).toBe(LINES[n - 1]);
};

test("zz, zt and zb put the cursor's line in the middle, at the top and at the foot of the pane, and the cursor stays where it was in the line", async ({ page }) => {
  await withVim(page, LINES.join("\n"));
  await toLine(page, 40);
  await keys(page, "l", "l", "l");
  const column = () => page.evaluate(() => getSelection()!.focusOffset);

  const before = await column();

  await page.keyboard.type("zt");
  await expect.poll(async () => Math.abs((await at(page, "Line 40 of the note.")).top)).toBeLessThanOrEqual(4);
  await page.keyboard.type("zb");
  await expect.poll(async () => Math.abs((await at(page, "Line 40 of the note.")).bottom)).toBeLessThanOrEqual(4);
  await page.keyboard.type("zz");
  await expect.poll(async () => Math.abs((await at(page, "Line 40 of the note.")).middle)).toBeLessThanOrEqual(4);
  expect(await cursorLine(page)).toBe("Line 40 of the note.");
  expect(await column()).toBe(before);
});

test("zz brings a line near the end to the middle, for the room kept under the last line, and the room moves nothing above it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: LINES.join("\n") });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Line 1 of");
  const without = await at(page, "Line 1 of the note.");

  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  expect((await at(page, "Line 1 of the note.")).top, "the first line is where it was without vim").toBe(without.top);

  await editor(page).click();
  await page.keyboard.type("G");
  await expect.poll(() => cursorLine(page)).toBe("Line 80 of the note.");
  await page.keyboard.type("zz");
  await expect.poll(async () => Math.abs((await at(page, "Line 80 of the note.")).middle)).toBeLessThanOrEqual(4);
});

test("z<Enter>, z. and z- do what zt, zz and zb do with the cursor on the line's first letter", async ({ page }) => {
  await withVim(page, LINES.map((line) => `    ${line}`).join("\n"));
  const indented = (n: number) => `    ${LINES[n - 1]}`;
  /** How far into its line the cursor is, in letters. */
  const offset = () =>
    page.evaluate(() => {
      const selection = getSelection()!;
      const node = selection.focusNode!;
      const line = (node instanceof Element ? node : node.parentElement)!.closest(".cm-line")!;
      const range = document.createRange();
      range.setStart(line, 0);
      range.setEnd(node, selection.focusOffset);
      return range.toString().length;
    });
  const place = async (n: number) => {
    await page.keyboard.type(`${n}G$`);
    await expect.poll(() => cursorLine(page)).toBe(indented(n));
  };

  await place(40);
  await page.keyboard.type("z");
  await page.keyboard.press("Enter");
  await expect.poll(async () => Math.abs((await at(page, indented(40))).top)).toBeLessThanOrEqual(4);
  expect(await offset()).toBe(4);

  await place(30);
  await page.keyboard.type("z.");
  await expect.poll(async () => Math.abs((await at(page, indented(30))).middle)).toBeLessThanOrEqual(4);
  expect(await offset()).toBe(4);

  await place(50);
  await page.keyboard.type("z-");
  await expect.poll(async () => Math.abs((await at(page, indented(50))).bottom)).toBeLessThanOrEqual(4);
  expect(await offset()).toBe(4);
});

/** Where a note's first letter is across the window, and where vim's mode begins. */
const lefts = (page: Page, group = 0) =>
  page.evaluate((g) => {
    const notes = [...document.querySelectorAll<HTMLElement>(".note")].filter((n) => n.getBoundingClientRect().width > 0);
    const note = notes[g]!;
    const range = document.createRange();
    const first = note.querySelector(".cm-content .cm-line")!.firstChild!;
    range.setStart(first, 0);
    range.setEnd(first, 1);
    const panel = note.querySelector<HTMLElement>(".cm-vim-panel")!;
    const words = document.createRange();
    words.selectNodeContents(panel);
    return { text: Math.round(range.getBoundingClientRect().left), mode: Math.round(words.getClientRects()[0]!.left) };
  }, group);

test("vim's mode begins where the note's text does, and moves with it in a split, in focus, and at another reading width", async ({ page }) => {
  await withVim(page, "Words at the start of the line.");
  const aligned = async (when: string, group = 0) => {
    await expect.poll(async () => {
      const { text, mode } = await lefts(page, group);
      return Math.abs(text - mode);
    }, when).toBeLessThanOrEqual(1);
  };
  await aligned("alone");

  const whole = await lefts(page);
  await perform(page, { type: "note.create", text: "Right of the split." });
  await run(page, "Keep tab open");
  await page.keyboard.press("ControlOrMeta+p");
  await page.keyboard.type("Right of");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Right of");
  await page.keyboard.press("Enter");
  await run(page, "Split editor right");
  await expect(page.locator(".cm-vim-panel")).toHaveCount(2);
  await aligned("on the left of a split", 0);
  await aligned("on the right of a split", 1);
  const narrow = await lefts(page, 0);
  expect(narrow.text, "the left half's text is further left than the whole pane's").toBeLessThan(whole.text);
  await page.getByRole("textbox", { name: "Note text" }).first().click();
  await run(page, "Toggle focus");
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  await aligned("in focus");
  expect((await lefts(page)).text, "focus is wider, so the text is further in").toBeGreaterThan(narrow.text);
  await run(page, "Toggle focus");

  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true, "core.editorReadingWidth": 480 }), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(statusLine(page)).toHaveText("--NORMAL--");
  await aligned("in a narrower column");
});

test("focus keeps a quiet line at its foot with only what is live: vim's mode, a running timer, and whether the note is saved", async ({ page }) => {
  await withVim(page, "# Plan\n\nWrite it.");
  const bar = page.getByRole("group", { name: "Bottom bar" });
  await expect(pluginIn(bar, "Word count").getByLabel("Word count")).toContainText("words");
  await run(page, "Start a quick timer…");
  await page.getByRole("textbox", { name: "How long" }).fill("10m");
  await page.keyboard.press("Enter");
  await expect(pluginIn(bar, "Quick timer").getByRole("button", { name: /Quick timer/ })).toBeVisible();

  await editor(page).click();
  await run(page, "Toggle focus");
  await expect(page.locator(".app[data-focus-mode]")).toBeVisible();
  const foot = page.locator(".group[data-front] .note-foot");
  await expect(foot.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await expect(pluginIn(foot, "Quick timer").getByRole("button", { name: /Quick timer/ })).toBeVisible();
  await expect(foot.locator(".note-live-save")).toHaveText("Saved");
  await expect(foot.locator('.plugin-frame[aria-label="Word count"]'), "a count is not live").toHaveCount(0);
  await expect(page.getByRole("group", { name: "Bottom bar" })).toBeHidden();
  await expect(page.locator(".group[data-front] .note-bar")).toBeHidden();

  // The foot is at the window's foot, and the save state says what typing does.
  const window = page.viewportSize()!;
  const box = (await foot.boundingBox())!;
  expect(Math.abs(box.y + box.height - window.height)).toBeLessThanOrEqual(1);
  await editor(page).click();
  await page.keyboard.type("A");
  await page.keyboard.type(" Soon.");
  await expect(foot.locator(".note-live-save")).not.toHaveText("Saved");
  await expect(foot.locator(".note-live-save")).toHaveText("Saved");

  await page.keyboard.press("Escape");
  await run(page, "Toggle focus");
  await expect(page.locator(".group[data-front] .note-live")).toHaveCount(0);
  await expect(page.locator(".bar .save-state")).toHaveText("Saved");
});

test("the z commands are no jumps: ctrl+o after them goes back to where the last real jump came from", async ({ page }) => {
  await withVim(page, LINES.join("\n"));
  await toLine(page, 40);
  await keys(page, "z", "z");
  await keys(page, "z", "t");
  await page.keyboard.type("z.");
  await page.keyboard.type("z-");
  await expect.poll(() => cursorLine(page)).toBe(LINES[39]);
  await page.keyboard.press("Control+o");
  await expect.poll(() => cursorLine(page)).toBe(LINES[0]);
});
