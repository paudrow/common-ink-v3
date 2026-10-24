import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string) => page.locator(".cm-line", { hasText: text });
/** A block's lines as written, shown above its card while the cursor is in them. */
const sourceLines = (page: Page) => page.locator(".cm-line.embed-source-line");
/** An inline embed's text as written, shown before its drawing while the cursor is on it. */
const inlineSource = (page: Page) => editor(page).locator(".embed-source");
const board = (page: Page) => editor(page).locator(".embed-frame-block");
const BOARD = ["/kanban()", "```markdown", "## To do", "- write", "```"];

async function open(page: Page, text: string, vim = false) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (vim) await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page).getByRole("region", { name: "To do", exact: true })).toBeVisible();
  return note;
}

const NOTE = `# Plan\n\nabove\n${BOARD.join("\n")}\nbelow\nSteep /timer(5m) now.`;

for (const vim of [false, true]) {
  const [down, up] = vim ? ["j", "k"] : ["ArrowDown", "ArrowUp"];
  test(`${vim ? "vim's j and k" : "the arrow keys"} go into a board from the line above and from the line below, which shows it as written, and out again, which draws it again`, async ({ page }) => {
    await open(page, NOTE, vim);
    await line(page, "above").click();
    if (vim) await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
    await expect(sourceLines(page)).toHaveCount(0);

    // Down from the line above is the board's first line, which shows all of it, and the board is still drawn under it.
    await page.keyboard.press(down);
    await expect(sourceLines(page)).toHaveText(BOARD);
    await expect(board(page)).toBeVisible();
    for (let i = 1; i < BOARD.length; i++) await page.keyboard.press(down);
    await expect(sourceLines(page)).toHaveText(BOARD);
    // One more is the line below: it is drawn again, and its lines are gone.
    await page.keyboard.press(down);
    await expect(sourceLines(page)).toHaveCount(0);
    await expect(board(page)).toBeVisible();

    // Up from the line below is its last line, and up from its first is the line above.
    await page.keyboard.press(up);
    await expect(sourceLines(page)).toHaveText(BOARD);
    for (let i = 1; i < BOARD.length; i++) await page.keyboard.press(up);
    await expect(sourceLines(page)).toHaveText(BOARD);
    await page.keyboard.press(up);
    await expect(sourceLines(page)).toHaveCount(0);
  });
}

test("a press on a board's body, off its controls, shows it as written, and a press elsewhere draws it again", async ({ page }) => {
  await open(page, NOTE);
  await editor(page).locator(".embed-frame-block .embed-head").click({ position: { x: 120, y: 12 } });
  await expect(sourceLines(page)).toHaveText(BOARD);
  await line(page, "below").click();
  await expect(sourceLines(page)).toHaveCount(0);
  await expect(board(page)).toBeVisible();
});

test("Edit source in an embed's settings puts the cursor at the start of its line, which shows it as written, and leaving draws it again", async ({ page }) => {
  const note = await open(page, NOTE);
  const lineStart = async () => {
    const at = await page.evaluate(() => getSelection()?.anchorOffset);
    return at;
  };

  await editor(page).getByRole("button", { name: "Settings for Kanban board" }).click();
  await page.getByRole("dialog", { name: "Settings for Kanban board" }).getByRole("button", { name: "Edit source" }).click();
  await expect(sourceLines(page)).toHaveText(BOARD);
  await expect(editor(page)).toBeFocused();
  await expect.poll(lineStart).toBe(0);
  await page.keyboard.type("x");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("\nx/kanban()\n");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toContain("\n/kanban()\n");
  await line(page, "above").click();
  await expect(sourceLines(page)).toHaveCount(0);

  await editor(page).getByRole("button", { name: "Settings for Timer" }).click();
  await page.getByRole("dialog", { name: "Settings for Timer" }).getByRole("button", { name: "Edit source" }).click();
  await expect(inlineSource(page)).toHaveText("/timer(5m)");
  await page.keyboard.press("End");
  await expect(inlineSource(page)).toHaveCount(0);
  await expect(editor(page).getByRole("button", { name: "Timer, 5:00 left" })).toBeVisible();
});

test("the cursor onto an inline embed shows it as written, and a press on its own button runs it without showing it", async ({ page }) => {
  await open(page, NOTE);
  await editor(page).getByRole("button", { name: "Start timer" }).click();
  await expect(editor(page).getByRole("button", { name: "Pause timer" })).toBeVisible();
  await expect(inlineSource(page)).toHaveCount(0);

  await line(page, "now.").click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Home");
  for (let i = 0; i < "Steep ".length; i++) await page.keyboard.press("ArrowRight");
  await expect(inlineSource(page)).toHaveText(/^\/timer\(5m since=/);
  await page.keyboard.press("End");
  await expect(inlineSource(page)).toHaveCount(0);
});
