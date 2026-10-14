import { expect, test, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

const tail = (word: string) => `${word} ${"and more words that go on ".repeat(5)}to the end.`;
/** Each item's own words begin with a word no other line has, and are long enough to wrap at either width. */
const ITEMS: [mark: string, word: string][] = [
  ["- ", "Dash"],
  ["* ", "Star"],
  ["1. ", "Single"],
  ["10. ", "Tenth"],
  ["- [ ] ", "Pending"],
  ["- [x] ", "Checked"],
  ["  - ", "Nested"],
  ["    - ", "Deeper"],
  ["    1. ", "Numbered"],
  ["      - [ ] ", "Subtask"],
  ["\t- ", "Tabbed"],
];
/** A line with a clock in it, whose words go on after the clock. */
const CLOCK: [mark: string, word: string] = ["- Timed ::stopwatch{} ", "Clocked"];
const NOTE = ["# Lists", "", "Body words.", "", ...[...ITEMS, CLOCK].map(([mark, word]) => mark + tail(word)), "", "Last words."].join("\n");

interface Item {
  /** The left edge of the first letter of the item's own words. */
  first: number;
  /** The left edge of each row of the item's words, the first row's from that letter on. */
  rows: number[];
  top: number;
  height: number;
}

/** Where the words of the line that says `word` are, row by row, in whatever `within` holds. */
const itemAt = (within: Locator, word: string, from = word) =>
  within.evaluate(
    (root, { word, from }) => {
      const line = [...root.querySelectorAll<HTMLElement>(".cm-line")].find((el) => el.textContent!.includes(word))!;
      const range = document.createRange();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let start = line.textContent!.indexOf(from);
      let node = walker.nextNode();
      while (node && start >= node.textContent!.length) {
        start -= node.textContent!.length;
        node = walker.nextNode();
      }
      range.setStart(node!, start);
      range.setEndAfter(line.lastChild!);
      const rows = new Map<number, number>();
      for (const rect of range.getClientRects()) {
        if (!rect.width) continue;
        const row = [...rows.keys()].find((top) => Math.abs(top - rect.top) < rect.height / 2) ?? rect.top;
        rows.set(row, Math.min(rows.get(row) ?? Infinity, rect.left));
      }
      const tops = [...rows.keys()].sort((a, b) => a - b);
      const box = line.getBoundingClientRect();
      return { first: rows.get(tops[0]!)!, rows: tops.map((top) => rows.get(top)!), top: box.top, height: box.height };
    },
    { word, from },
  ) as Promise<Item>;

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 2600 });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: NOTE });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Last words.");
  await expect(page.locator(".note-meta .crumbs")).not.toBeEmpty();
  await expect(editor(page).locator(".embed-card")).toBeVisible();
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.evaluate(() => document.fonts.ready);
  return note;
}

/** Every item, and the line with the clock from its first word on. */
const all = async (page: Page) => Object.fromEntries(await Promise.all([...ITEMS, CLOCK].map(async ([, word]) => [word, await itemAt(editor(page), word, word === CLOCK[1] ? "Timed" : word)] as const)));

for (const width of [1280, 760]) {
  test(`a list item's wrapped rows start under the first letter of its words, at every mark and depth, and nothing moves when the cursor comes to its line (${width}px window)`, async ({ page }) => {
    await open(page, width);
    const drawn = await all(page);

    for (const [mark, word] of ITEMS) {
      const item = drawn[word]!;
      const says = `"${mark.trim()}" ${word}`;
      expect(item.rows.length, `${says} wraps`).toBeGreaterThanOrEqual(2);
      // Under the first letter, and to the right of where the line itself starts: this is a hang, not a line with no indent.
      for (const [n, left] of item.rows.entries()) expect(Math.abs(left - item.first), `${says}: row ${n + 1} starts at ${left}, the first letter at ${item.first}`).toBeLessThanOrEqual(1);
      expect(item.first, `${says}: the words start after the mark`).toBeGreaterThan(drawn.Dash!.first - 1);
    }
    // Deeper items start further in, and a longer mark puts its words further in.
    expect(drawn.Nested!.first).toBeGreaterThan(drawn.Dash!.first + 4);
    expect(drawn.Deeper!.first).toBeGreaterThan(drawn.Nested!.first + 4);
    expect(drawn.Tenth!.first).toBeGreaterThan(drawn.Single!.first + 4);
    expect(drawn.Pending!.first).toBeGreaterThan(drawn.Dash!.first + 8);

    // A line with a clock in it: the words before the clock are the item's first, and the rows after it come back under them.
    const timed = drawn.Clocked!;
    expect(timed.rows.filter((left) => Math.abs(left - timed.first) <= 1).length, `rows of the line with a clock under its first letter: ${timed.rows}`).toBeGreaterThanOrEqual(2);
    for (const left of timed.rows) expect(left).toBeGreaterThanOrEqual(timed.first - 1);

    for (const [mark, word] of [...ITEMS, CLOCK]) {
      // The cursor is put at the end of the item's words, on its last row.
      const line = editor(page).locator(".cm-line").filter({ hasText: word });
      const box = (await line.boundingBox())!;
      await page.mouse.click(box.x + box.width - 3, box.y + box.height - 8);
      await expect.poll(() => page.evaluate(() => {
        const at = getSelection()!.anchorNode;
        return (at instanceof Element ? at : at?.parentElement)?.closest(".cm-line")?.textContent;
      })).toContain(word);
      // The cursor is on the item's words, not on its box: the box stays drawn.
      if (mark.includes("[")) await expect(line.getByRole("checkbox")).toHaveCount(1);
      const now = await all(page);
      for (const [, other] of [...ITEMS, CLOCK]) {
        const [was, is] = [drawn[other]!, now[other]!];
        const when = `of ${other} with the cursor on "${mark.trim()}" ${word}`;
        expect(Math.abs(is.first - was.first), `first letter ${when}: ${was.first} -> ${is.first}`).toBeLessThanOrEqual(0.5);
        expect(is.rows.length, `rows ${when}`).toBe(was.rows.length);
        is.rows.forEach((left, n) => expect(Math.abs(left - was.rows[n]!), `row ${n + 1} ${when}: ${was.rows[n]} -> ${left}`).toBeLessThanOrEqual(0.5));
        expect(Math.abs(is.top - was.top), `top ${when}`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(is.height - was.height), `height ${when}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
}

test("a note read in a folder's card hangs its list items the same way", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 2600 });
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: NOTE });
  await page.goto("/folder/all");
  const card = page.getByRole("article", { name: "Lists" });
  await card.getByRole("button", { name: "Expand Lists" }).click();
  await card.getByRole("button", { name: "Show whole note" }).click();
  await expect(card.locator(".cm-line").filter({ hasText: "Tabbed" })).toBeVisible();
  // A reading takes no keys, so it is no stop for Tab, though a note a member can only read is.
  await expect(card.locator(".cm-content")).not.toHaveAttribute("tabindex");
  for (const [mark, word] of ITEMS) {
    const item = await itemAt(card, word);
    expect(item.rows.length, `"${mark.trim()}" ${word} wraps`).toBeGreaterThanOrEqual(2);
    for (const left of item.rows) expect(Math.abs(left - item.first), `"${mark.trim()}" ${word}: a row starts at ${left}, the first letter at ${item.first}`).toBeLessThanOrEqual(1);
  }
});
