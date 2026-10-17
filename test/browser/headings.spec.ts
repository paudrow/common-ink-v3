import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

interface Measured {
  text: string;
  /** The line's own box. */
  top: number;
  height: number;
  /** The first row of the line: of its words, or of the line itself when it has none. */
  row: { top: number; bottom: number };
  /** The left edge of the line's first word, or of where it would be. */
  x: number;
  /** The heading's mark as it is painted, when the line has one. */
  mark: { left: number; right: number; top: number; bottom: number; painted: boolean; fontSize: number; weight: number } | null;
  fontSize: number;
  weight: number;
  /** How wide a space is in the face of the line's words. */
  space: number;
}

/** Every line of the note, measured. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    return [...content.querySelectorAll<HTMLElement>(":scope > .cm-line")].map((line) => {
      const box = line.getBoundingClientRect();
      const hang = line.querySelector<HTMLElement>(".md-hang");
      // The first letter that isn't the mark's.
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let first: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!hang?.contains(node) && node.textContent) {
          first = node as Text;
          break;
        }
      }
      let row = { top: box.top, bottom: box.bottom };
      let x = box.left + parseFloat(getComputedStyle(line).paddingLeft);
      let words: Element = line;
      if (first) {
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(first, 1);
        const letter = range.getClientRects()[0]!;
        row = { top: letter.top, bottom: letter.bottom };
        x = letter.left;
        words = first.parentElement!;
      }
      let mark = null;
      if (hang) {
        // The mark's own letters, as they are painted.
        const letters = document.createTreeWalker(hang, NodeFilter.SHOW_TEXT).nextNode()!;
        const glyph = document.createRange();
        glyph.selectNodeContents(letters);
        const rect = glyph.getBoundingClientRect();
        let painted = true;
        for (let up = letters.parentElement; up && up !== content; up = up.parentElement) if (getComputedStyle(up).opacity === "0") painted = false;
        const style = getComputedStyle(hang.querySelector("span") ?? hang);
        mark = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, painted, fontSize: parseFloat(style.fontSize), weight: Number(style.fontWeight) };
      }
      const style = getComputedStyle(words);
      // A space in the mark's face, which is the heading's whether or not it has words yet, laid out on the line.
      const space = document.createElement("span");
      space.style.cssText = "position: absolute; white-space: pre; visibility: hidden";
      const face = getComputedStyle(hang?.querySelector("span") ?? hang ?? words);
      Object.assign(space.style, { fontFamily: face.fontFamily, fontSize: face.fontSize, fontWeight: face.fontWeight, fontStyle: face.fontStyle, fontKerning: face.fontKerning });
      space.textContent = " ";
      words.append(space);
      const spaceWidth = space.getBoundingClientRect().width;
      space.remove();
      return { text: line.textContent!, top: box.top, height: box.height, row, x, mark, fontSize: parseFloat(style.fontSize), weight: Number(style.fontWeight), space: spaceWidth };
    });
  }) as Promise<Measured[]>;

async function open(page: Page, text: string, width = 1280) {
  await page.setViewportSize({ width, height: 1600 });
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Body");
  // The folder's name arrives in the note's bar after the note does, and in a narrow column, with a wide
  // face, it puts the bar on two rows: everything under it is lower from then on. Measure after it.
  await expect(page.locator(".note-meta .crumbs")).not.toBeEmpty();
  await editor(page).focus();
  await page.evaluate(() => document.fonts.ready);
  return note;
}

const WRAPPING = "A heading long enough that it wraps onto a second row and a third in a narrow column of text";
const NOTE = ["Body before", "# One", "## Two", "Body between", "### Three", "#### Four", "##### Five", "###### Six", "#", "## ", "Body after empties", `# ${WRAPPING}`, "Body last"].join("\n");
/** The index of each heading's line, and how many `#` it has. */
const HEADINGS = [[1, 1], [2, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 1], [9, 2], [11, 1]] as const;

/** Puts the cursor on line `index` by the keyboard, at its end. */
async function cursorOn(page: Page, index: number) {
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
  // A wrapped line takes a key for each of its rows, so the line is found by where the cursor is and not by counting.
  for (let tries = 0; tries < 6; tries++) {
    const at = await page.evaluate(() => {
      const line = getSelection()!.anchorNode;
      const el = (line instanceof Element ? line : line!.parentElement)!.closest(".cm-line")!;
      return [...el.parentElement!.querySelectorAll(":scope > .cm-line")].indexOf(el);
    });
    if (at === index) break;
    await page.keyboard.press(at < index ? "ArrowDown" : "ArrowUp");
  }
  await page.keyboard.press("End");
}

for (const width of [1280, 760]) {
  test(`a heading's mark is level with its first row and in the margin, painted only with the cursor on its line, and nothing moves either way (${width}px window)`, async ({ page }) => {
    await open(page, NOTE, width);
    await cursorOn(page, 0);
    const drawn = await measure(page);
    const body = drawn[0]!;

    for (const [index, level] of HEADINGS) {
      const off = drawn[index]!;
      const says = `line ${index} (${"#".repeat(level)})`;
      expect(off.mark, `${says} has a mark`).not.toBeNull();
      expect(off.mark!.painted, `${says}: the mark is not painted with the cursor elsewhere`).toBe(false);
      // A heading with no words yet is a line as tall as one with words.
      expect(off.height, `${says} has a row's height`).toBeGreaterThanOrEqual(body.height - 1);

      await cursorOn(page, index);
      const all = await measure(page);
      const on = all[index]!;
      expect(on.mark!.painted, `${says}: the mark is painted with the cursor on its line`).toBe(true);

      // Level with the first row: inside it from top to bottom, and not with a row above or below.
      expect(on.mark!.top, `${says}: the mark's top ${on.mark!.top} is within its first row ${JSON.stringify(on.row)}`).toBeGreaterThanOrEqual(on.row.top - 1);
      expect(on.mark!.bottom, `${says}: the mark's bottom ${on.mark!.bottom} is within its first row ${JSON.stringify(on.row)}`).toBeLessThanOrEqual(on.row.bottom + 1);
      expect(Math.abs((on.mark!.top + on.mark!.bottom) / 2 - (on.row.top + on.row.bottom) / 2), `${says}: the mark's middle is within a few pixels of its row's`).toBeLessThanOrEqual(Math.max(4, (on.row.bottom - on.row.top) * 0.2));
      expect(on.mark!.bottom - on.mark!.top, `${says}: the mark has a height`).toBeGreaterThan(8);
      // In the margin: it ends where the words start, and it starts inside the page.
      expect(on.mark!.right, `${says}: the mark ends at the words' left edge`).toBeLessThanOrEqual(on.x + 1);
      // As far as the space the note writes after it, which in a monospaced face is wider than 12px.
      expect(on.x - on.mark!.right, `${says}: the mark stands right beside the words`).toBeLessThanOrEqual(Math.max(12, on.space + 1));
      expect(on.mark!.left, `${says}: the mark is on the page`).toBeGreaterThanOrEqual(0);
      // Clearly there: as heavy as its heading, and not smaller than body text unless six have to fit.
      expect(on.mark!.weight).toBeGreaterThanOrEqual(600);

      // Nothing moved: no line's top, height or first letter.
      all.forEach((now, i) => {
        for (const side of ["top", "height", "x"] as const) expect(Math.abs(now[side] - drawn[i]![side]), `${side} of line ${i} with the cursor on ${says}`).toBeLessThanOrEqual(1);
      });
    }

    // A wrapped heading's mark is on its first row, not centred on the whole line.
    await cursorOn(page, 11);
    const wrapped = (await measure(page))[11]!;
    expect(wrapped.height, "the long heading wraps").toBeGreaterThan(2 * (wrapped.row.bottom - wrapped.row.top) * 0.8);
    expect(wrapped.mark!.bottom).toBeLessThanOrEqual(wrapped.row.bottom + 1);
  });
}

test("a heading reads as a heading with the cursor elsewhere: larger or heavier than body text at every level", async ({ page }) => {
  await open(page, NOTE);
  await cursorOn(page, 0);
  const lines = await measure(page);
  const body = lines[0]!;
  expect(body.weight).toBeLessThan(600);
  for (const [index, level] of HEADINGS) {
    if (!lines[index]!.text.replace(/#/g, "").trim()) continue;
    const heading = lines[index]!;
    expect(heading.weight, `h${level} is bold`).toBeGreaterThanOrEqual(700);
    if (level <= 3) expect(heading.fontSize, `h${level} is larger than body text`).toBeGreaterThan(body.fontSize * 1.1);
  }
  const size = (index: number) => lines[index]!.fontSize;
  expect(size(1)).toBeGreaterThan(size(2));
  expect(size(2)).toBeGreaterThan(size(4));
  expect(size(4)).toBeGreaterThan(size(5));
});

test("typing # on a new line is a line of its own height from the first key, with its mark on it, and the lines around it stay where they are", async ({ page }) => {
  await open(page, "Body one\n\nBody two");
  await cursorOn(page, 1);
  const before = await measure(page);

  for (const typed of ["#", " ", "T"]) {
    await page.keyboard.type(typed);
    const now = await measure(page);
    const line = now[1]!;
    expect(line.height, `after "${typed}" the line has a row's height`).toBeGreaterThanOrEqual(before[1]!.height - 1);
    expect(line.mark, `after "${typed}" the line has its mark`).not.toBeNull();
    expect(line.mark!.painted).toBe(true);
    expect(line.mark!.top).toBeGreaterThanOrEqual(line.top - 1);
    expect(line.mark!.bottom).toBeLessThanOrEqual(line.top + line.height + 1);
    expect(Math.abs(now[0]!.top - before[0]!.top), "the line above stays").toBeLessThanOrEqual(1);
    expect(now[2]!.top, "the line below is under it").toBeGreaterThanOrEqual(line.top + line.height - 1);
  }
  // A heading with words is as tall as it was with none: typing the first letter moves nothing below.
  await page.keyboard.press("Backspace");
  const empty = await measure(page);
  await page.keyboard.type("T");
  const worded = await measure(page);
  expect(Math.abs(worded[2]!.top - empty[2]!.top)).toBeLessThanOrEqual(1);
});
