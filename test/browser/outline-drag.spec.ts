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

const LISTS = "# Plan\n\n- Bake\n  - Preheat\n  - Mix\n- Shop\n  - Flour\n- Clean\n\n1. One\n2. Two\n3. Three\n\nAfter.";

/** Presses on the mark of the line that says `from`, and lets go over the line that says `to`: in its upper half, its lower half, or its lower half past the start of its text. */
async function drag(page: Page, from: string | RegExp, to: string | RegExp, where: "above" | "below" | "under") {
  const mark = (await line(page, from).locator(".bullet-dot, .bullet-number").first().boundingBox())!;
  const target = (await line(page, to).boundingBox())!;
  const its = (await line(page, to).locator(".bullet-dot, .bullet-number").first().boundingBox())!;
  await page.mouse.move(mark.x + mark.width / 2, mark.y + mark.height / 2);
  await page.mouse.down();
  const x = where === "under" ? its.x + 80 : its.x + 20;
  const y = where === "above" ? target.y + target.height * 0.25 : target.y + target.height * 0.75;
  await page.mouse.move(x, y, { steps: 8 });
  await expect(page.locator(".bullet-drop")).toHaveCount(1);
  await page.mouse.up();
}

test("a bullet dragged by its dot lands before, after or under another, with what is under it, and numbers follow", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: LISTS });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");

  await drag(page, "Shop", "Bake", "above");
  await expect.poll(() => read(page, note.id)).toBe(LISTS.replace("- Bake\n  - Preheat\n  - Mix\n- Shop\n  - Flour\n", "- Shop\n  - Flour\n- Bake\n  - Preheat\n  - Mix\n"));
  await expect(page.locator(".bullet-drop")).toHaveCount(0);

  // In the lower half of a bullet with something under it, it goes first under it.
  await drag(page, "Clean", /^\s*- Bake$/, "below");
  await expect.poll(() => read(page, note.id)).toBe(LISTS.replace("- Bake\n  - Preheat\n  - Mix\n- Shop\n  - Flour\n- Clean\n", "- Shop\n  - Flour\n- Bake\n  - Clean\n  - Preheat\n  - Mix\n"));

  // Past the start of a bullet's text, it goes under that bullet.
  await drag(page, "Mix", "Flour", "under");
  await expect.poll(() => read(page, note.id)).toBe(LISTS.replace("- Bake\n  - Preheat\n  - Mix\n- Shop\n  - Flour\n- Clean\n", "- Shop\n  - Flour\n    - Mix\n- Bake\n  - Clean\n  - Preheat\n"));

  // A numbered item is dragged by its number, and the list is numbered again.
  await drag(page, "Three", "One", "above");
  await expect.poll(() => read(page, note.id)).toContain("1. Three\n2. One\n3. Two\n");
});

test("a bullet isn't dropped among its own lines, Escape leaves it where it was, and a press that doesn't move puts the cursor on its line", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: LISTS });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");

  const mark = (await line(page, /^\s*- Bake$/).locator(".bullet-dot").boundingBox())!;
  const into = (await line(page, "Mix").boundingBox())!;
  await page.mouse.move(mark.x + 2, mark.y + mark.height / 2);
  await page.mouse.down();
  await page.mouse.move(into.x + 40, into.y + into.height / 2, { steps: 6 });
  await expect(page.locator(".bullet-drop")).toHaveCount(0);
  await page.mouse.up();

  const shop = (await line(page, "Shop").locator(".bullet-dot").boundingBox())!;
  const clean = (await line(page, "Clean").boundingBox())!;
  await page.mouse.move(shop.x + 2, shop.y + shop.height / 2);
  await page.mouse.down();
  await page.mouse.move(clean.x + 20, clean.y + clean.height * 0.75, { steps: 6 });
  await expect(page.locator(".bullet-drop")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".bullet-drop")).toHaveCount(0);
  await page.mouse.up();

  await page.mouse.click(shop.x + 2, shop.y + shop.height / 2);
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(LISTS.replace("- Shop", "- Shop!"));
});

test("a bullet goes under another past that bullet's own text, and a bullet in a quote, which no key moves, isn't dragged", async ({ page }) => {
  const text = "# Notes\n\n- A\n  said more\n  - child\n- B\n\n> - quoted\n> - also";
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Notes");

  await drag(page, /^\s*- B$/, /^\s*- A$/, "below");
  await expect.poll(() => read(page, note.id)).toBe("# Notes\n\n- A\n  said more\n  - B\n  - child\n\n> - quoted\n> - also");

  const quoted = (await line(page, "quoted").locator(".bullet-dot").boundingBox())!;
  await page.mouse.move(quoted.x + 2, quoted.y + quoted.height / 2);
  await page.mouse.down();
  await page.mouse.move(quoted.x + 10, quoted.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".bullet-drop")).toHaveCount(0);
  await expect.poll(() => read(page, note.id)).toBe("# Notes\n\n- A\n  said more\n  - B\n  - child\n\n> - quoted\n> - also");
});

test("in a long note scrolled down to its list, a drop leaves the note where it was, with the moved bullet in view", async ({ page }) => {
  const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of what comes before the list.`).join("\n\n");
  const text = `# Long\n\n${filler}\n\n- Bake\n  - Preheat\n- Shop\n  - Flour\n- Clean\n\n${filler.replaceAll("before", "after")}`;
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Long");
  // The editor draws only the lines near the screen, so the wheel brings the list into view and to the middle of it.
  const box = (await editor(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 400);
  for (let i = 0; i < 60 && !(await line(page, "Shop").count()); i++) await page.mouse.wheel(0, 500);
  await expect(async () => {
    await page.mouse.wheel(0, (await line(page, "Shop").boundingBox())!.y - 360);
    await expect(line(page, "Shop")).toBeInViewport({ timeout: 500 });
  }).toPass();
  const before = (await line(page, "Shop").boundingBox())!;

  await drag(page, "Clean", /^\s*- Bake$/, "above");
  await expect.poll(() => read(page, note.id)).toContain("- Clean\n- Bake\n  - Preheat\n- Shop\n  - Flour\n\n");
  await page.waitForTimeout(300);
  // Shop didn't move in the note, so it is where it was on screen, give or take a line.
  const after = (await line(page, "Shop").boundingBox())!;
  expect(Math.abs(after.y - before.y), `Shop was at ${before.y} and is at ${after.y}`).toBeLessThan(before.height * 1.5);
  await expect(line(page, /^\s*- Clean$/)).toBeInViewport();
});
