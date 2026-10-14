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

const BLOCK = [
  "# Lines",
  "A paragraph above the block, long enough that it runs on past the width of the column and wraps onto a second row of its own here.",
  "```python",
  "def first(x):",
  "    return x + 1",
  "    # a comment in the block that is long enough to run on past the width of the column, wrapping or scrolling with the toggle",
  "print(first(2))",
  "```",
  "- a list item under the block",
  "  - and one under it",
  "The end.",
].join("\n");

/**
 * Where the selection is painted on the row through the middle of each line that says one of `texts`, left and right, as the
 * union of every painted rectangle there, cut at the text's margin as the page cuts it; and where the line itself is.
 */
const paintedRows = (page: Page, texts: readonly string[]) =>
  page.evaluate((texts) => {
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    const margin = content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft);
    const rects = [...document.querySelectorAll(".cm-selectionBackground")].map((el) => el.getBoundingClientRect());
    return texts.map((text) => {
      const line = [...content.querySelectorAll<HTMLElement>(".cm-line")].find((el) => el.textContent!.startsWith(text))!.getBoundingClientRect();
      const middle = line.top + line.height / 2;
      const spans = rects.filter((r) => r.top <= middle && r.bottom >= middle && r.width > 0).map((r) => [Math.max(r.left, margin), r.right] as const).sort((a, b) => a[0] - b[0]);
      let [from, to] = spans[0] ?? [NaN, NaN];
      let gaps = 0;
      for (const [l, r] of spans.slice(1)) {
        if (l > to + 0.5) gaps++;
        to = Math.max(to, r);
      }
      return { text, painted: [Math.round(from), Math.round(to)], line: [Math.round(line.left), Math.round(line.right)], gaps };
    });
  }, texts);

/** The rows of `paintedRows` that are not painted in one piece from the line's left edge to its right: none, once the selection is drawn. */
const unevenRows = async (page: Page, texts: readonly string[]) => (await paintedRows(page, texts)).filter((row) => row.gaps || row.painted.join() !== row.line.join());

for (const wrap of ["wrap", "scroll"] as const) {
  test(`with vim on, every line visual line mode selects is painted across its whole width, a code block's from edge to edge, selected down or up (long lines ${wrap})`, async ({ page }) => {
    await signInAsNewPerson(page, "Ada Lovelace");
    await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
    const note = await perform(page, { type: "note.create", text: BLOCK });
    await page.goto(`/note/${note.id}`);
    await expect(statusLine(page)).toHaveText("--NORMAL--");
    await expect(editor(page).locator(".tok-keyword").first()).toBeVisible();
    if (wrap === "scroll") {
      await editor(page).getByRole("button", { name: "Wrap long lines" }).click();
      await expect(editor(page).locator(".code-nowrap").first()).toBeVisible();
    }
    await editor(page).focus();
    await keys(page, "g", "g");

    const CODE = ["def first", "    return", "    # a comment", "print(first"];
    // Down from the block's first line of code to its last, then up from its last to its first.
    for (const [from, keysTo] of [["j", "j"], ["k", "k"]] as const) {
      await keys(page, "g", "g", ...(from === "j" ? ["j", "j", "j"] : ["j", "j", "j", "j", "j", "j"]));
      await keys(page, "Shift+V", keysTo, keysTo, keysTo);
      await expect(statusLine(page)).toHaveText("--VISUAL LINE--");
      await expect.poll(() => unevenRows(page, CODE), `selected with ${keysTo}: each line runs from the block's left edge to its right`).toEqual([]);
      await keys(page, "Escape");
      await expect.poll(async () => (await paintedRows(page, CODE)).filter((row) => !Number.isNaN(row.painted[0])), "nothing is painted after Escape").toEqual([]);
    }

    // Prose and list items are painted across the column the same way, from the text's margin.
    await keys(page, "g", "g", "j", "Shift+V");
    for (let n = 0; n < 9; n++) await keys(page, "j");
    await expect.poll(() => unevenRows(page, ["A paragraph above", "```python", ...CODE, "- a list item", "  - and one under", "The end."])).toEqual([]);
  });
}
