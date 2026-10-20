import { expect, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const settle = async (page: Page, document: Record<string, unknown>) => {
  await perform(page, { type: "settings.write", text: JSON.stringify(document), baseRevision: (await perform(page, { type: "settings.read" })).revision });
  await page.reload();
  await expect(editor(page)).toBeVisible();
};
const px = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((el, p) => parseFloat(getComputedStyle(el).getPropertyValue(p)), property);
const family = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).fontFamily);

async function aNote(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toBeVisible();
  return note;
}

test("Text size sizes the whole app, and a note's text with it until Editor text size is set", async ({ page }) => {
  await aNote(page, "# Sizes\n\nWords.");
  const menu = await px(page, ".sidebar a, .sidebar button", "font-size");
  const bar = await px(page, ".bar", "font-size");
  const text = await px(page, ".editor .cm-editor", "font-size");

  await settle(page, { "core.textSize": 125 });
  expect(await px(page, ".sidebar a, .sidebar button", "font-size")).toBeCloseTo(menu * 1.25, 1);
  expect(await px(page, ".bar", "font-size")).toBeCloseTo(bar * 1.25, 1);
  expect(await px(page, ".editor .cm-editor", "font-size"), "the note's text follows").toBeCloseTo(text * 1.25, 1);

  // The settings over the window are sized by it too.
  await page.goto("/settings/appearance");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("spinbutton", { name: "Text size" })).toHaveValue("125");
  const head = await dialog.getByRole("heading", { name: "Settings" }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(head).toBeCloseTo(22 * 1.25, 1);
  await page.keyboard.press("Escape");

  await settle(page, { "core.textSize": 125, "core.editorTextSize": 100 });
  expect(await px(page, ".editor .cm-editor", "font-size"), "set, the editor's own size is used").toBeCloseTo(text, 1);
  expect(await px(page, ".bar", "font-size"), "and the rest of the app keeps its").toBeCloseTo(bar * 1.25, 1);

  // Set to 100 in Settings, the same as its default, it is still the member's: the note's text stays at 100 under a Text size of 125.
  await settle(page, { "core.textSize": 125 });
  await page.goto("/settings/editor");
  const size = page.getByRole("dialog", { name: "Settings" }).getByRole("spinbutton", { name: "Editor text size" });
  await size.fill("100");
  await page.keyboard.press("Enter");
  await expect.poll(async () => JSON.parse((await perform(page, { type: "settings.read" })).text)).toEqual({ "core.textSize": 125, "core.editorTextSize": 100 });
  await page.keyboard.press("Escape");
  await expect.poll(() => px(page, ".editor .cm-editor", "font-size")).toBeCloseTo(text, 1);

  await settle(page, { "core.textSize": 90, "core.editorTextSize": 120 });
  expect(await px(page, ".editor .cm-editor", "font-size")).toBeCloseTo(text * 1.2, 1);
  expect(await px(page, ".bar", "font-size")).toBeCloseTo(bar * 0.9, 1);
});

const FONTS = [
  ["iA Writer Mono", "iA Writer Mono", "ia-writer-mono"],
  ["IBM Plex Mono", "IBM Plex Mono", "ibm-plex-mono"],
  ["Source Serif", "Source Serif 4", "source-serif-4"],
] as const;

for (const [name, face, file] of FONTS) {
  test(`${name} is a note's font, loaded from the app's own files and only when chosen, its headings in it, its code still mono, and typing in it moves nothing`, async ({ page }) => {
    const fetched: string[] = [];
    page.on("request", (r) => r.url().includes("/fonts/") && fetched.push(new URL(r.url()).pathname));
    await aNote(page, "# Heading\n\nSome words, then more.\n\n```\ncode\n```");
    // What the app loaded before the font was chosen is its default's, whichever font it was built to start in.
    await page.evaluate(() => document.fonts.ready);
    const loaded = fetched.length;
    await settle(page, { "core.editorFont": name });
    expect(await family(page, ".editor .cm-content")).toContain(face);
    expect(await family(page, ".editor .cm-line")).toContain(face);
    expect(await family(page, ".code-line"), "code keeps a monospaced font").not.toContain(face);
    await expect.poll(() => page.evaluate((f) => document.fonts.check(`16px "${f}"`), face)).toBe(true);
    await expect.poll(() => fetched.some((path) => path.startsWith(`/fonts/${file}/`))).toBe(true);
    expect(fetched.slice(loaded).every((path) => path.startsWith(`/fonts/${file}/`)), `only ${name} is fetched once it is chosen: ${fetched.slice(loaded)}`).toBe(true);
    expect(new Set(fetched.slice(0, loaded).map((path) => path.split("/")[2])).size, `one font before: ${fetched.slice(0, loaded)}`).toBeLessThanOrEqual(1);

    // Typing a letter at a time moves nothing that is already there.
    const line = page.locator(".cm-line", { hasText: "Some words" });
    await line.click();
    await page.keyboard.press("End");
    const place = () =>
      line.evaluate((el) => {
        const range = document.createRange();
        range.setStart(el.firstChild!, 0);
        range.setEnd(el.firstChild!, 4);
        const box = range.getBoundingClientRect();
        const heading = document.querySelector(".cm-line")!.getBoundingClientRect();
        return [box.left, box.top, heading.top, heading.height];
      });
    const before = await place();
    for (const letter of " and a few more") {
      await page.keyboard.type(letter);
      expect(await place(), `after typing "${letter}"`).toEqual(before);
    }
  });
}

test("a custom font is any CSS family list, such as one installed on this device", async ({ page }) => {
  await aNote(page, "Words.");
  await settle(page, { "core.editorFont": "Custom", "core.editorFontFamily": '"Courier New", monospace' });
  expect(await family(page, ".editor .cm-content")).toMatch(/^"Courier New", monospace/);
});

test("Line height and Reading width are the note's line and column", async ({ page }) => {
  await aNote(page, `${"A long paragraph that wraps across the column more than once. ".repeat(12)}`);
  const size = await px(page, ".editor .cm-editor", "font-size");
  await settle(page, { "core.editorLineHeight": 2, "core.editorReadingWidth": 600 });
  expect(await px(page, ".editor .cm-scroller", "line-height")).toBeCloseTo(size * 2, 0);
  const column = (await page.locator(".editor").boundingBox())!;
  expect(column.width).toBeCloseTo(600, 0);
  // Each row of the wrapped paragraph is a line's height below the one before.
  const tops = await page.locator(".cm-line").first().evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...new Set([...range.getClientRects()].map((r) => Math.round(r.top)))];
  });
  expect(tops.length).toBeGreaterThan(2);
  expect(Math.round(tops[1]! - tops[0]!)).toBeCloseTo(size * 2, -0.5);

  await settle(page, { "core.editorLineHeight": 1.4, "core.editorReadingWidth": 1200 });
  const wide = (await page.locator(".editor").boundingBox())!;
  expect(wide.width).toBeGreaterThan(900);
});
