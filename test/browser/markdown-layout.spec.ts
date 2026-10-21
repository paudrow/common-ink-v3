import { expect, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson, test } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

/** What a line shows: its text without the marks that are there but not painted. */
const shownIn = (el: Element) => {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let painted = true;
    for (let up = node.parentElement; up && up !== el.parentElement; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.opacity === "0" || style.visibility === "hidden" || style.webkitTextFillColor === "rgba(0, 0, 0, 0)") painted = false;
    }
    if (painted) text += node.textContent;
  }
  return text;
};
const expectShown = (line: Locator, text: string | RegExp, message?: string) => (typeof text === "string" ? expect.poll(() => line.evaluate(shownIn), message).toBe(text) : expect.poll(() => line.evaluate(shownIn), message).toMatch(text));

interface Place {
  /** Where the first letter of the line's own words is, from the left. */
  x: number;
  top: number;
  height: number;
  /** The top of the row that first letter is on, which is the line's top unless the line wraps before it. */
  rowTop: number;
}

/**
 * Where each of these words is on the page: the left edge of its first letter, and the top and
 * height of the line it is on, or of the table row for a word in a table.
 */
const places = (page: Page, words: readonly string[]) =>
  page.evaluate((all) => {
    const found: Record<string, Place> = {};
    for (const word of all) {
      // A word of a table is looked for in the table drawn first: its own lines, when they are shown above it, say the word too.
      const box = [...document.querySelectorAll<HTMLElement>(".cm-content tr"), ...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(word));
      if (!box) throw new Error(`No line says "${word}"`);
      // The text node the word starts in, counting letters through the nodes before it.
      let start = box.textContent!.indexOf(word);
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && start >= node.textContent!.length) {
        start -= node.textContent!.length;
        node = walker.nextNode();
      }
      const range = document.createRange();
      range.setStart(node!, start);
      range.setEnd(node!, start + 1);
      const line = box.getBoundingClientRect();
      const letter = range.getBoundingClientRect();
      found[word] = { x: letter.x, top: line.top, height: line.height, rowTop: letter.top };
    }
    return found;
  }, words);

function expectUnmoved(now: Record<string, Place>, before: Record<string, Place>, when: string) {
  for (const [word, was] of Object.entries(before)) {
    for (const side of ["x", "top", "height"] as const) expect(Math.abs(now[word]![side] - was[side]), `${side} of "${word}" ${when}: ${was[side]} -> ${now[word]![side]}`).toBeLessThanOrEqual(1);
  }
}

async function open(page: Page, text: string, settings?: Record<string, unknown>, width = 1280) {
  // Tall enough that the whole of the note that is measured is drawn, at whatever width its column is.
  await page.setViewportSize({ width, height: 3200 });
  await signInAsNewPerson(page, "Ada Lovelace");
  if (settings) await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!.replace(/^# /, ""));
  // The folder's name arrives in the note's bar after the note does, and in a narrow column, with a wide
  // face, it puts the bar on two rows: everything under it is lower from then on. Measure after it.
  await expect(page.locator(".note-tools")).toBeVisible();
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  return note;
}

/** Everything drawn has arrived: the math and its faces, and the colors of the code. */
async function settled(page: Page) {
  await expect(editor(page).locator(".math-block .katex").first()).toBeVisible();
  await expect(editor(page).locator(".tok-keyword").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

const LONG = "Long paragraph with **bold words** and `inline code here` and [a link](https://example.com/some/long/path) that goes on and on. ".repeat(3) + "End of long.";
const NOTE = [
  "# Layout",
  "",
  "Top words.",
  "",
  "## Heading two",
  "",
  "### Heading three",
  "",
  "Some **b** `c` [l](x.co)",
  "",
  "> Quoted words",
  "",
  "- Bullet one",
  "  - Nested bullet",
  "    - Deeper bullet",
  "- [ ] Open task",
  "  - [x] Nested done task",
  "\t- Tab child",
  "  - Space child",
  "",
  "1. Numbered one",
  "2. Numbered two",
  "   - Under numbered",
  "",
  "---",
  "",
  "With $e = mc^2$ inline.",
  "",
  // Short enough to stay on one row as written in the narrow column, in any font: a line that wraps is the exception measured further down.
  "Tall $\\frac{\\frac ab}c$",
  "",
  "$$",
  "\\begin{pmatrix} a \\\\ b \\\\ c \\\\ d \\\\ e \\end{pmatrix}",
  "$$",
  "",
  "After math.",
  "",
  "$$",
  "a",
  "+ b",
  "+ c",
  "+ d",
  "$$",
  "",
  "After tall source.",
  "",
  "$$",
  "",
  "y = x",
  "",
  "$$",
  "",
  "After padded math.",
  "",
  "$$",
  "\\text{a long formula whose own line is far too long for a narrow column} + \\text{so that it wraps when it is shown as written} = z",
  "$$",
  "",
  "After wrapping math.",
  "",
  "| Name  | Qty |",
  "| ----- | --: |",
  "| Pens  | 12  |",
  "| **Paper** and a `long` cell with [a link](https://example.com/a/b/c) and more words that make it wide | 500 |",
  "",
  "After table.",
  "",
  "```ts",
  "const first = 1;",
  "  const indented = 2;",
  "```",
  "",
  "After code.",
  "",
  "T ::timer{5m} embed here",
  "",
  LONG,
  "",
  "Last words.",
].join("\n");

const WORDS = [
  "Top words", "Heading two", "Heading three", "Some", "Quoted words", "Bullet one", "Nested bullet", "Deeper bullet", "Open task", "Nested done task", "Tab child", "Space child",
  "Numbered one", "Numbered two", "Under numbered", "With", "Tall", "After math", "After tall source", "After padded math", "After wrapping math", "Pens", "Paper", "After table",
  "const first", "const indented", "After code", "embed here", "Long paragraph", "End of long", "Last words",
] as const;

/** The lines the cursor is put on in turn. A table's rows are gone into by their cells, further down. */
const LINES = WORDS.filter((word) => !["Pens", "Paper", "Long paragraph", "End of long"].includes(word));

/** The column is 720px wide in the first and 314px in the second, where far more wraps. */
for (const width of [1600, 820]) {
  test(`nothing moves when the cursor comes to a line and it is shown as written: not its first letter, not its height, not the lines after it (${width}px window)`, async ({ page }) => {
    await open(page, NOTE, undefined, width);
    await settled(page);
    const before = await places(page, WORDS);

    /**
     * Puts the cursor on the line that says `word`, by a click just inside the line's right edge on
     * the row the word is on: a line with a clock in it is three rows in the narrow column, and a
     * click beside the clock would show the clock's text above it, which is a row more by design.
     */
    const clickOn = async (word: string) => {
      const row = (await places(page, [word]))[word]!;
      const right = await page.evaluate((w) => [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(w))!.getBoundingClientRect().right, word);
      await page.mouse.click(right - 4, row.rowTop + 8);
    };
    const cursorLine = () =>
      page.evaluate(() => {
        const at = getSelection()!.anchorNode;
        return (at instanceof Element ? at : at?.parentElement)?.closest(".cm-line")?.textContent;
      });
    const lineOf = (word: string) => page.locator(".cm-line").filter({ hasText: word });

    for (const word of LINES) {
      await clickOn(word);
      await expect.poll(() => cursorLine(), `the cursor is on "${word}"`).toContain(word);
      expectUnmoved(await places(page, WORDS), before, `with the cursor on "${word}"`);
    }

    // A heading's mark goes by its line. In a line, only what the cursor is on is shown as written: at the end of this
    // one that is the link, and the bold and the code before it stay drawn. A box and a formula the cursor is not on stay drawn.
    await clickOn("Heading three");
    await expectShown(lineOf("Heading three"), "### Heading three");
    await clickOn("Some");
    await expectShown(lineOf("Some"), "Some b c [l](x.co)");
    await clickOn("Nested done task");
    await expectShown(lineOf("Nested done task"), /^\s*▾?\s*Nested done task$/);
    await expect(lineOf("Nested done task").getByRole("checkbox")).toHaveCount(1);
    await clickOn("With");
    await expect(lineOf("With").locator(".katex")).toHaveCount(1);

    // The rule, written out and drawn.
    await page.locator(".cm-line.md-rule").click();
    await expectShown(page.locator(".cm-line").filter({ hasText: /^---$/ }), "---");
    expectUnmoved(await places(page, WORDS), before, "with the cursor on the rule");

    // A block of math is as tall written as drawn, whichever is taller: a formula taller than its lines, lines taller than
    // their formula, blank lines around a formula, and a line of it that wraps when written.
    for (const [n, says] of [[0, "pmatrix"], [1, "+ c"], [2, "y = x"], [3, "\\text{a long"]] as const) {
      await clickOn("Top words");
      expectUnmoved(await places(page, WORDS), before, `before math block ${n + 1}`);
      await editor(page).locator(".math-block").nth(n).click();
      await expect(page.locator(".cm-line").filter({ hasText: says })).toBeVisible();
      await expect(editor(page).locator(".math-block")).toHaveCount(3);
      expectUnmoved(await places(page, WORDS), before, `with the cursor in math block ${n + 1}`);
    }

    // A table's cell, typed in where it is drawn: a plain one, and one whose markdown is far wider than the cell.
    await clickOn("Top words");
    for (const at of ["1,0", "1,1", "2,0", "2,1"]) {
      await editor(page).locator(`[data-focus="${at}"]`).click();
      await expect(editor(page).locator(`[data-focus="${at}"]`)).toBeFocused();
      // The cell shows its own source, so its first letter gives way to its marks. The row and all after it stay put.
      expectUnmoved({ ...(await places(page, WORDS)), ...(at === "2,0" ? { Paper: before.Paper! } : {}) }, before, `with the cursor in table cell ${at}`);
      expect(Math.abs((await places(page, ["Pens"])).Pens!.height - before.Pens!.height)).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press("Shift+Tab");
    await expect(editor(page).locator('[data-focus="2,0"]')).toBeFocused();
    await expect(editor(page).locator('[data-focus="2,0"]')).toHaveText("**Paper** and a `long` cell with [a link](https://example.com/a/b/c) and more words that make it wide");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type(" and typed words on the end of it");
    // Typing may scroll the note to keep the cell in view, which moves everything alike. What is held to is that nothing moves against anything else.
    const typing = await places(page, WORDS);
    const scrolled = typing["Top words"]!.top - before["Top words"]!.top;
    expectUnmoved(Object.fromEntries(Object.entries(typing).map(([word, at]) => [word, word === "Paper" ? before.Paper! : { ...at, top: at.top - scrolled }])), before, "while typing in a long cell");
    await page.keyboard.press("Escape");

    await clickOn("Top words");
    expectUnmoved(await places(page, WORDS), before, "with the cursor back where it started");
  });

  // The one case that moves, by the maintainer's call: the marks inside a line are taken out when it is drawn, so a
  // paragraph that fills its rows can need more rows with its marks put back. What is held to is that it is only that:
  // the paragraph starts where it did, it grows by whole rows, and everything after it moves down by exactly those rows.
  test(`a long paragraph with marks in it may grow by whole rows under the cursor, and nothing else about it moves (${width}px window)`, async ({ page }) => {
    await open(page, NOTE, undefined, width);
    await settled(page);
    const words = ["After code", "embed here", "Long paragraph", "Last words"] as const;
    const before = await places(page, words);
    const row = before["Last words"]!.height;

    const box = (await page.locator(".cm-line").filter({ hasText: "Long paragraph" }).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 8);
    const now = await places(page, words);
    const [was, is] = [before["Long paragraph"]!, now["Long paragraph"]!];
    const grown = is.height - was.height;

    expectUnmoved({ "After code": now["After code"]!, "embed here": now["embed here"]! }, { "After code": before["After code"]!, "embed here": before["embed here"]! }, "above the long paragraph");
    expect(Math.abs(is.x - was.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(is.top - was.top)).toBeLessThanOrEqual(1);
    expect(grown, "it never gets shorter").toBeGreaterThanOrEqual(-1);
    expect(Math.abs(grown / row - Math.round(grown / row)), `it grew by ${grown}px, with rows of ${row}px`).toBeLessThan(0.1);
    expect(Math.abs(now["Last words"]!.top - before["Last words"]!.top - grown)).toBeLessThanOrEqual(1);
    test.info().annotations.push({ type: "known exception", description: `at a ${width}px window the paragraph grew by ${Math.round(grown / row)} rows (${Math.round(grown)}px)` });

    await page.keyboard.press("ControlOrMeta+Home");
    expectUnmoved(await places(page, words), before, "with the cursor gone again");
  });
}

for (const width of [1600, 820]) {
  test(`the cursor moved into a table's lines with the keys shows them above the table, which stays drawn, and what follows is lower by exactly those lines; the two plus controls are on the table's edges and take no room (${width}px window)`, async ({ page }) => {
    await open(page, NOTE, undefined, width);
    await settled(page);
    const before = await places(page, WORDS);
    const above = WORDS.slice(0, WORDS.indexOf("Pens"));
    const from = WORDS.slice(WORDS.indexOf("Pens"));
    const source = editor(page).locator(".cm-line.md-table-source");
    const table = editor(page).locator(".md-table");
    await table.evaluate((el) => ((el as HTMLElement).dataset.first = "yes"));

    // Down from the line above the table, through the blank line, into its first line.
    await page.locator(".cm-line").filter({ hasText: "After wrapping math" }).click();
    expectUnmoved(await places(page, WORDS), before, "with the cursor on the line above the table");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(source).toHaveCount(4);
    const rows = await source.evaluateAll((lines) => lines.reduce((sum, line) => sum + line.getBoundingClientRect().height, 0));
    expect(rows).toBeGreaterThan(60);
    const shown = await places(page, WORDS);
    const part = (all: Record<string, Place>, words: readonly string[]) => Object.fromEntries(words.map((word) => [word, all[word]!]));
    expectUnmoved(part(shown, above), part(before, above), "above the table with its lines shown");
    const lowered = Object.fromEntries(from.map((word) => [word, { ...shown[word]!, top: shown[word]!.top - rows }]));
    expectUnmoved(lowered, part(before, from), `from the table on, lifted by the ${rows}px of its lines`);
    // It is the table that was drawn before, not one drawn anew.
    await expect(table).toHaveAttribute("data-first", "yes");

    // Through the lines and out below: all of it is back where it was.
    // In the narrow column the long row is several rows as written, and the key goes through each.
    for (let n = 0; n < 16 && (await source.count()) > 0; n++) await page.keyboard.press("ArrowDown");
    await expect(source).toHaveCount(0);
    await expect(table).toHaveAttribute("data-first", "yes");
    expectUnmoved(await places(page, WORDS), before, "with the cursor below the table");

    // The plus controls are not seen until the pointer is over the table. Seen, each is centered on its edge and nothing has moved.
    const addRow = editor(page).getByRole("button", { name: "Add a row at the end" });
    const addColumn = editor(page).getByRole("button", { name: "Add a column at the end" });
    await expect(addRow).toHaveCSS("opacity", "0");
    await expect(addColumn).toHaveCSS("opacity", "0");
    await editor(page).locator('[data-focus="1,0"]').hover();
    await expect(addRow).toHaveCSS("opacity", "1");
    await expect(addColumn).toHaveCSS("opacity", "1");
    expectUnmoved(await places(page, WORDS), before, "with the pointer over the table");
    const frame = (await editor(page).locator(".md-table-frame").boundingBox())!;
    const [row, column] = [(await addRow.boundingBox())!, (await addColumn.boundingBox())!];
    expect(Math.abs(row.y + row.height / 2 - (frame.y + frame.height)), "the row's plus is on the bottom edge").toBeLessThanOrEqual(1);
    expect(Math.abs(column.x + column.width / 2 - (frame.x + frame.width)), "the column's plus is on the right edge").toBeLessThanOrEqual(1);
    // A table wider than the column scrolls inside it: its frame, and the plus on it, end where the column of text does.
    const column0 = (await page.locator(".cm-line").filter({ hasText: "Top words" }).boundingBox())!;
    expect(frame.x + frame.width).toBeLessThanOrEqual(column0.x + column0.width + 1);
  });
}

/** Where each row of the line that says `word` starts: the left edge of its first letter after the quote's `>`s, which are there but not painted. */
const rowStarts = (page: Page, word: string) =>
  page.evaluate((w) => {
    const line = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(w))!;
    const rows = new Map<number, number>();
    let skip = /^[ \t]*(?:>[ \t]?)*/.exec(line.textContent!)![0].length;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let i = 0; i < node.textContent!.length; i++) {
        if (skip-- > 0) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const { x, top, width } = range.getBoundingClientRect();
        if (!width) continue;
        const row = Math.round(top);
        rows.set(row, Math.min(rows.get(row) ?? Infinity, Math.round(x)));
      }
    }
    return [...rows.entries()].sort(([a], [b]) => a - b).map(([, x]) => x);
  }, word);

test("a quote that wraps starts every row at one place, written or drawn, and a quote in a quote one step further in", async ({ page }) => {
  const long = "words that go on and on until the line wraps onto the next row of the column ".repeat(3);
  await open(page, ["# Quotes", "", `> Goal ${long}`, "> Short line", "", `> > Inner ${long}`, "", "- Item words", "  > Listed quote"].join("\n"), undefined, 820);
  await page.evaluate(() => document.fonts.ready);

  const goal = await rowStarts(page, "Goal");
  expect(goal.length).toBeGreaterThan(2);
  expect(new Set(goal).size, `rows start at ${goal}`).toBe(1);
  expect((await rowStarts(page, "Short line"))).toEqual([goal[0]]);
  const inner = await rowStarts(page, "Inner");
  expect(inner.length).toBeGreaterThan(2);
  expect(new Set(inner).size, `rows start at ${inner}`).toBe(1);
  expect(inner[0]! - goal[0]!).toBeGreaterThan(8);
  // A quote under a list item is hung by the item's words, and its own words start after its mark, which is there whether it is painted or not.
  const listed = await places(page, ["Item words", "Listed quote"]);
  expect(listed["Listed quote"]!.x - listed["Item words"]!.x).toBeGreaterThan(4);
  const markEnd = await page.locator(".cm-line").filter({ hasText: "Listed quote" }).evaluate((el) => {
    // The right edge of the space after the `>`, which can be a text node of its own.
    let space = el.textContent!.indexOf(">") + 1;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (space >= node.textContent!.length) {
        space -= node.textContent!.length;
        continue;
      }
      const range = document.createRange();
      range.setStart(node, space);
      range.setEnd(node, space + 1);
      return range.getBoundingClientRect().right;
    }
    return Infinity;
  });
  expect((await places(page, ["Listed quote"]))["Listed quote"]!.x).toBeGreaterThanOrEqual(markEnd - 0.5);
  expect(listed["Listed quote"]!.x - listed["Item words"]!.x).toBeGreaterThan(4);

  await page.locator(".cm-line").filter({ hasText: "Short line" }).click();
  await page.keyboard.press("Home");
  await expectShown(page.locator(".cm-line").filter({ hasText: "Short line" }), "> Short line");
  expect(await rowStarts(page, "Goal")).toEqual(goal);
  expect(await rowStarts(page, "Short line")).toEqual([goal[0]]);
});

test("lines after a block of math never move up when the drawing arrives, and don't move at all for a formula seen before", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  let holding = true;
  await page.route(/math\/rendering|assets\/rendering-/, async (route) => {
    if (holding) await held;
    await route.continue();
  });
  const text = "# Sums\n\n$$\n\\begin{pmatrix} a \\\\ b \\\\ c \\\\ d \\\\ e \\end{pmatrix}\n$$\n\nAfter tall.\n\n$$\na\n+ b\n+ c\n+ d\n$$\n\nAfter short.\n\n$$\n\\text{a long formula whose own line is far too long for the column it is in} + \\text{so that it wraps when it is shown as written} + \\text{and wraps again} = z\n$$\n\nAfter wrapping.\n";
  const words = ["After tall", "After short", "After wrapping"] as const;
  await open(page, text, undefined, 820);
  await expect(page.locator(".cm-line").filter({ hasText: "After wrapping" })).toBeVisible();
  await page.waitForTimeout(300);
  const topsOf = async () => {
    const at = await places(page, words);
    return words.map((word) => at[word]!.top) as [number, number, number];
  };
  const written = await topsOf();
  await expect(editor(page).locator(".math-block")).toHaveCount(0);

  holding = false;
  release();
  await expect(editor(page).locator(".math-block .katex")).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const drawn = await topsOf();
  const all = await places(page, words);
  // The first formula is taller than its one line, so the first time it is ever drawn what follows it moves down, once.
  drawn.forEach((top, n) => expect(top - written[n]!, `"${words[n]}" moved up when the math was drawn`).toBeGreaterThanOrEqual(-1));
  expect(drawn[0] - written[0]).toBeGreaterThan(1);
  // Nothing after that first block grows or shrinks: lines taller than their formula, and a line that wraps, keep their room.
  expect(Math.abs(drawn[1] - drawn[0] - (written[1] - written[0]))).toBeLessThanOrEqual(1);
  expect(Math.abs(drawn[2] - drawn[1] - (written[2] - written[1]))).toBeLessThanOrEqual(1);

  // Seen before, each formula has its room before the drawing arrives: nothing moves at all.
  let releaseAgain!: () => void;
  const heldAgain = new Promise<void>((done) => (releaseAgain = done));
  await page.unroute(/math\/rendering|assets\/rendering-/);
  await page.route(/math\/rendering|assets\/rendering-/, async (route) => {
    await heldAgain;
    await route.continue();
  });
  await page.reload();
  await expect(page.locator(".cm-line").filter({ hasText: "After wrapping" })).toBeVisible();
  await page.waitForTimeout(300);
  await expect(editor(page).locator(".math-block")).toHaveCount(0);
  const again = await places(page, words);
  expectUnmoved(again, all, "written again, before the drawing arrives a second time");
  releaseAgain();
  await expect(editor(page).locator(".math-block .katex")).toHaveCount(3);
  await page.waitForTimeout(300);
  expectUnmoved(await places(page, words), all, "drawn a second time");
});

for (const vim of [false, true]) {
  test(`a code block's lines, and the lines after it, stay where they are as the cursor goes down through it and back up${vim ? ", in vim mode" : ""}`, async ({ page }) => {
    await open(page, NOTE, vim ? { "vim.enabled": true } : undefined);
    if (vim) await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
    await settled(page);
    const words = ["After table", "ts", "const first", "const indented", "After code", "Last words"];
    const fence = (n: number) => page.locator(".cm-line.code-line").nth(n);
    const [down, up] = vim ? ["j", "k"] : ["ArrowDown", "ArrowUp"];

    const box = (await page.locator(".cm-line").filter({ hasText: "After table" }).boundingBox())!;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    const before = await places(page, words);
    await expectShown(fence(0), /^\s*ts/);

    // The blank line, the opening fence, two lines of code, the closing fence, the blank line, and the line after.
    const stops: [string, RegExp, RegExp][] = [
      ["the blank line above", /^\s*ts/, /^\s*$/],
      ["the opening fence", /^```ts/, /^\s*$/],
      ["the first line of code", /^\s*ts/, /^\s*$/],
      ["the second line of code", /^\s*ts/, /^\s*$/],
      ["the closing fence", /^\s*ts/, /^```\s*$/],
      ["the blank line below", /^\s*ts/, /^\s*$/],
      ["the line after", /^\s*ts/, /^\s*$/],
    ];
    const check = async ([where, opening, closing]: [string, RegExp, RegExp]) => {
      await expectShown(fence(0), opening, where);
      await expectShown(fence(3), closing, where);
      await expect(page.locator(".cm-line").filter({ hasText: "const first" }).locator(".tok-keyword"), where).toHaveText("const");
      await expect(editor(page).getByRole("button", { name: "Copy" }), where).toBeVisible();
      expectUnmoved(await places(page, words), before, `with the cursor on ${where}`);
    };
    for (const stop of stops) {
      await page.keyboard.press(down!);
      await check(stop);
    }
    for (const stop of stops.slice(0, -1).reverse()) {
      await page.keyboard.press(up!);
      await check(stop);
    }
  });
}

test("in a long note, lines keep their place on screen as tables, math and code come into view while scrolling", async ({ page }) => {
  const section = (n: number) =>
    `## Part ${n}\n\nSome **bold** and $x_{${n}}^2$ and \`code\`.\n\n- [ ] item ${n}\n  - under ${n}\n\n| a | b |\n| - | - |\n| ${n} | 2 |\n| ${n} | 3 |\n\n$$\n\\sum_{i=1}^{${n}} i = \\frac{${n}(${n}+1)}{2}\n$$\n\n\`\`\`js\nconst part = ${n};\n\`\`\`\n`;
  await open(page, `# Long\n\n${Array.from({ length: 200 }, (_, n) => section(n)).join("\n")}`);
  await settled(page);
  const scroller = page.locator(".note-scroll");
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));

  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  await frames();
  await expect(editor(page).locator(".math-block .katex").first()).toBeVisible();

  /** The line nearest the middle of the screen that says something no other line does, to be found again after scrolling. */
  const anchor = () =>
    page.evaluate(() => {
      const middle = innerHeight / 2;
      const line = [...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line")]
        .filter((el) => /(Part|item|under|const part =) \d+/.test(el.textContent!))
        .sort((a, b) => Math.abs(a.getBoundingClientRect().top - middle) - Math.abs(b.getBoundingClientRect().top - middle))[0]!;
      return { says: line.textContent!, top: line.getBoundingClientRect().top };
    });
  const topOf = (says: string) => page.evaluate((text) => [...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line")].find((el) => el.textContent === text)?.getBoundingClientRect().top ?? null, says);

  // Standing still, nothing drifts as what was just drawn settles.
  const still = await anchor();
  await page.waitForTimeout(700);
  expect(Math.abs((await topOf(still.says))! - still.top)).toBeLessThanOrEqual(1);

  // Each step of the wheel moves what is on screen by that step, and by nothing more, though tables, math and code are drawn above and below as it goes.
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const step of [...Array<number>(14).fill(-160), ...Array<number>(28).fill(160), ...Array<number>(14).fill(-160)]) {
    const from = await anchor();
    const top = await scroller.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, step);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).not.toBe(top);
    await frames();
    const to = await topOf(from.says);
    expect(to, `"${from.says}" is still drawn`).not.toBeNull();
    expect(Math.abs(to! - from.top + step), `a step of ${step} moved "${from.says}" from ${from.top} to ${to}`).toBeLessThanOrEqual(1.5);
  }
});
