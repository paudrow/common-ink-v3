import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const statusLine = (page: Page) => page.locator(".cm-vim-panel");
const keys = async (page: Page, ...presses: string[]) => {
  for (const press of presses) await page.keyboard.press(press);
};

const NOTE = ["# Selecting", "above words here", "```ts", "const first = 1;", "const second = 2;", "const third = 3;", "```", "below words `in code` here"].join("\n");
const LINES = ["above words", "```ts", "const first", "const second", "const third", "```", "below words"] as const;

type Rgb = [number, number, number];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The color painted behind each letter, read from a picture of the page: the color most of the
 * letter's box has. A letter's ink covers less than half its box in any font, so this is what is
 * painted under it, whichever letter it is and wherever its strokes fall.
 */
async function painted(page: Page, boxes: Box[]): Promise<Rgb[]> {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, boxes }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [img.width, img.height];
      const pen = canvas.getContext("2d")!;
      pen.drawImage(img, 0, 0);
      return boxes.map(({ x, y, width, height }) => {
        const { data } = pen.getImageData(Math.ceil(x), Math.ceil(y), Math.max(1, Math.floor(width) - 1), Math.max(1, Math.floor(height) - 1));
        const counts = new Map<string, number>();
        for (let i = 0; i < data.length; i += 4) {
          const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const [most] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
        return most.split(",").map(Number) as [number, number, number];
      });
    },
    { png, boxes },
  );
}

/** The box of the letter at `column` of the line that says `text`. */
const letterAt = (page: Page, text: string, column: number) =>
  page.evaluate(
    ({ text, column }) => {
      const line = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.startsWith(text) || el.textContent!.includes(text))!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      let at = column;
      while (node && at >= node.textContent!.length) {
        at -= node.textContent!.length;
        node = walker.nextNode();
      }
      const range = document.createRange();
      range.setStart(node!, at);
      range.setEnd(node!, at + 1);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    },
    { text, column },
  );

const far = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

for (const scheme of ["light", "dark"] as const) {
  test(`with vim on, what is selected in a code block is painted as selected, by line, by character and by block, across its fences and into the text around it (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signInAsNewPerson(page, "Ada Lovelace");
    await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
    const note = await perform(page, { type: "note.create", text: NOTE });
    await page.goto(`/note/${note.id}`);
    await expect(statusLine(page)).toHaveText("--NORMAL--");
    await expect(editor(page).locator(".tok-keyword").first()).toBeVisible();
    await editor(page).focus();
    await keys(page, "g", "g");

    const selection = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.color = "var(--selection)";
      const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
      probe.remove();
      return [r, g, b] as [number, number, number];
    });
    // The first letter's place on every line, and the tenth's on the three lines of code.
    const starts = await Promise.all(LINES.map((text) => letterAt(page, text, 0)));
    const tenths = await Promise.all(LINES.slice(2, 5).map((text) => letterAt(page, text, 10)));
    const plain = await painted(page, [...starts, ...tenths]);
    for (const [n, color] of plain.entries()) expect(far(color, selection), `nothing is selected yet behind letter ${n}: ${color}`).toBeGreaterThan(20);

    /** Which of the points are painted in the selection's color, give or take the tint of the block over it. */
    const selected = async () => (await painted(page, [...starts, ...tenths])).map((color) => far(color, selection) <= 12);
    const T = true;
    const F = false;

    // By line, from the line above the block to the line below it: every line, both fences among them.
    await keys(page, "j", "Shift+V", "j", "j", "j", "j", "j", "j");
    await expect(statusLine(page)).toHaveText("--VISUAL LINE--");
    await expect.poll(selected).toEqual([T, T, T, T, T, T, T, T, T, T]);
    // It stops at the text's margin: the room left of the column, where a heading's marks hang, is not painted.
    const margin = await painted(page, starts.slice(2, 5).map((box) => ({ ...box, x: box.x - 40 })));
    for (const color of margin) expect(far(color, selection), `the margin beside a selected line: ${color}`).toBeGreaterThan(20);
    await keys(page, "Escape");
    await expect.poll(selected).toEqual([F, F, F, F, F, F, F, F, F, F]);

    // By character, from the sixth letter of the first line of code to the third line: the first line from there on, all of the second.
    await keys(page, "g", "g", "j", "j", "j", "5", "l", "v", "j", "j");
    await expect(statusLine(page)).toHaveText("--VISUAL--");
    await expect.poll(selected).toEqual([F, F, F, T, T, F, F, T, T, F]);
    await keys(page, "Escape");

    // By block, the sixth to the twelfth letter of the three lines of code: that column on each, and not the lines' starts.
    await keys(page, "g", "g", "j", "j", "j", "5", "l", "Control+v", "j", "j", "6", "l");
    await expect(statusLine(page)).toHaveText("--VISUAL BLOCK--");
    await expect.poll(selected).toEqual([F, F, F, F, F, F, F, T, T, T]);

    // Yanked, the three lines of code are what is put back.
    await keys(page, "Escape", "g", "g", "j", "j", "j", "Shift+V", "j", "j", "y", "Shift+G", "p");
    await expect(page.locator(".cm-line")).toHaveCount(11);
    await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(`${NOTE}\nconst first = 1;\nconst second = 2;\nconst third = 3;`);
  });
}
