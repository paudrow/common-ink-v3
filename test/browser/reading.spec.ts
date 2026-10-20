import { expect, type Page } from "@playwright/test";
import { folderRow, noteCard, openAllNotes, perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

for (const settings of [{ "vim.enabled": true, "lineNumbers.enabled": true }, {}]) {
  const vim = "vim.enabled" in settings;
  test(`a card is a reading, not an editor: no cursor, no mode bar, no keys, and its text can still be selected and copied${vim ? " (vim and line numbers on)" : ""}`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signInAsNewPerson(page, "Ada Lovelace");
    await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
    const body = "# Test\n\nWhat's up with **this**\n\nhttps://www.youtube.com/watch?v=NgRkyAlJx5s\n\nlast line";
    const note = await perform(page, { type: "note.create", text: body });
    await page.reload();
    await openAllNotes(page);
    const card = noteCard(page, "Test");
    const reading = card.locator(".editor.reading");
    await expect(reading.locator(".cm-line").first()).toHaveText("# Test");
    await card.getByRole("button", { name: "Show whole note" }).click();

    // No vim: no mode bar anywhere on the page, and no cursor of vim's or the browser's in the reading.
    await expect(page.locator(".cm-vim-panel")).toHaveCount(0);
    await expect(page.locator(".cm-panels")).toHaveCount(0);
    await expect(reading.locator(".cm-fat-cursor, .cm-cursor, .cm-cursorLayer, .cm-gutters")).toHaveCount(0);
    await expect(reading.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
    await expect(reading.locator(".cm-content")).toHaveAttribute("aria-readonly", "true");

    // A click in it and keys pressed after change nothing, in the note or on the page.
    await reading.locator(".cm-line").filter({ hasText: "What's up" }).click();
    await expect(page.locator(".cm-vim-panel")).toHaveCount(0);
    for (const key of ["x", "d", "d", "i", "Z", "Backspace", "Enter"]) await page.keyboard.press(key);
    await page.keyboard.type("typed");
    await expect(reading.locator(".cm-line").filter({ hasText: "What's up" })).toHaveText("What's up with this");
    await expect(page.locator(".cm-vim-panel")).toHaveCount(0);

    // Its text is selected with the mouse, and copied. The line sits under the video, so it is brought into view first.
    const last = reading.locator(".cm-line").filter({ hasText: "last line" });
    await last.scrollIntoViewIfNeeded();
    const line = (await last.boundingBox())!;
    await page.mouse.move(line.x + 1, line.y + line.height / 2);
    await page.mouse.down();
    await page.mouse.move(line.x + 200, line.y + line.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => getSelection()!.toString().trim())).toBe("last line");
    await page.keyboard.press("ControlOrMeta+c");
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe("last line");

    // What is drawn below a line is there as on a shared page: the video's picture and its play button, with its player not loaded.
    await expect(reading.locator('.embed-below[data-embed="video"]').getByRole("button", { name: /Play video/ })).toBeVisible();
    expect(page.frames().filter((f) => /youtube/.test(f.url()))).toEqual([]);

    await expect.poll(() => text(page, note.id)).toBe(body);
    await expect(folderRow(page, "All notes")).toBeVisible();
  });
}
