import { expect, test, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });

async function open(page: Page, text: string, settings?: Record<string, unknown>) {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await signInAsNewPerson(page, "Ada Lovelace");
  if (settings) await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Last words.");
  await expect(page.locator(".note-meta .crumbs")).not.toBeEmpty();
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.evaluate(() => document.fonts.ready);
  return note;
}

/** One line with everything that is drawn in a line, a plain word between each two, so the cursor is never on two at once. */
const LINE = "- [ ] Alpha **bold** Bravo [link](x.co) Charlie `code` Delta $a^2$ Echo $b_1$ Foxtrot";
const WALK = ["# Walk", "", "Above words.", LINE, "Below words.", "", "Last words."].join("\n");

/** Each construct on the line: its name, and where it is written. The cursor is on it from its first edge to its last. */
const CONSTRUCTS = (
  [
    ["mark", "-"],
    ["box", "[ ]"],
    ["bold", "**bold**"],
    ["link", "[link](x.co)"],
    ["code", "`code`"],
    ["first formula", "$a^2$"],
    ["second formula", "$b_1$"],
  ] as const
).map(([name, written]) => ({ name, from: LINE.indexOf(written), to: LINE.indexOf(written) + written.length }));
const WORDS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"] as const;

interface Seen {
  /** The constructs shown as written. */
  written: string[];
  /** The left edge of each plain word on the line. */
  words: number[];
  top: number;
  height: number;
  /** The top of the line after it. */
  below: number;
}

/** What the walked line shows now, and where its plain words are. */
const seen = (page: Page) =>
  page.evaluate((words) => {
    const lines = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")];
    const line = lines.find((el) => el.textContent!.includes("Alpha"))!;
    const text = line.textContent!;
    const written = [
      ...(line.querySelector(".bullet-dot, .bullet-blank") ? [] : ["mark"]),
      ...(line.querySelector("input[type=checkbox]") ? [] : ["box"]),
      ...(text.includes("**bold**") ? ["bold"] : []),
      ...(text.includes("[link](x.co)") ? ["link"] : []),
      ...(text.includes("`code`") ? ["code"] : []),
      ...(text.includes("$a^2$") ? ["first formula"] : []),
      ...(text.includes("$b_1$") ? ["second formula"] : []),
    ];
    const left = (word: string) => {
      let start = text.indexOf(word);
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && start >= node.textContent!.length) {
        start -= node.textContent!.length;
        node = walker.nextNode();
      }
      const range = document.createRange();
      range.setStart(node!, start);
      range.setEnd(node!, start + 1);
      return range.getBoundingClientRect().left;
    };
    const box = line.getBoundingClientRect();
    return { written, words: words.map(left), top: box.top, height: box.height, below: lines.find((el) => el.textContent === "Below words.")!.getBoundingClientRect().top };
  }, WORDS) as Promise<Seen>;

for (const vim of [false, true]) {
  test(`walking the cursor along a line one letter at a time shows as written only what it is on, one construct at a time, and moves nothing else${vim ? ", in vim mode" : ""}`, async ({ page }) => {
    // A column wide enough for the line to be one row as written too, in a monospaced font as in any other.
    await open(page, WALK, { "core.editorReadingWidth": 1100, ...(vim ? { "vim.enabled": true } : {}) });
    if (vim) await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
    await expect(editor(page).locator(".katex").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // With the cursor on another line everything on this one is drawn.
    await expect.poll(async () => (await seen(page)).written).toEqual([]);
    const drawn = await seen(page);
    expect(drawn.words.every((left, n) => n === 0 || left > drawn.words[n - 1]!), `the line is one row, its words left to right: ${drawn.words}`).toBe(true);

    // Down the note to the line's first letter, then right, one letter at a time, to its end. Vim's cursor is on a letter, so it stops on the last.
    await page.keyboard.press(vim ? "j" : "ArrowDown");
    await page.keyboard.press(vim ? "j" : "ArrowDown");
    await page.keyboard.press(vim ? "j" : "ArrowDown");
    await page.keyboard.press(vim ? "0" : "Home");
    const end = vim ? LINE.length - 1 : LINE.length;
    for (let at = 0; at <= end; at++) {
      if (at > 0) await page.keyboard.press(vim ? "l" : "ArrowRight");
      const on = CONSTRUCTS.filter((c) => c.from <= at && at <= c.to);
      const when = `with the cursor ${at} letters along, at "${LINE.slice(Math.max(0, at - 3), at)}|${LINE.slice(at, at + 3)}"`;
      expect(on.length, `the line never has the cursor on two constructs: ${when}`).toBeLessThanOrEqual(1);
      await expect.poll(async () => (await seen(page)).written, `what is shown as written ${when}`).toEqual(on.map((c) => c.name));
      const now = await seen(page);

      // The words before what is shown as written are where they were. The words after it have all moved over together, by
      // the width of the marks that are now shown, and with nothing shown as written no word has moved at all.
      const before = on.length ? WORDS.filter((word) => LINE.indexOf(word) < on[0]!.from).length : WORDS.length;
      const moved = now.words.map((left, n) => left - drawn.words[n]!);
      for (const [n, by] of moved.entries()) {
        if (n < before) expect(Math.abs(by), `"${WORDS[n]}" moved by ${by} ${when}`).toBeLessThanOrEqual(0.5);
        else expect(Math.abs(by - moved[before]!), `"${WORDS[n]}" moved by ${by}, and "${WORDS[before]}" by ${moved[before]} ${when}`).toBeLessThanOrEqual(0.5);
      }
      // A box and a list mark keep their width, so nothing on the line moves for them.
      if (on[0]?.name === "mark" || on[0]?.name === "box") for (const by of moved) expect(Math.abs(by), `a word moved by ${by} ${when}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(now.top - drawn.top), `the line's top ${when}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(now.height - drawn.height), `the line's height ${when}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(now.below - drawn.below), `the line after it ${when}`).toBeLessThanOrEqual(0.5);
    }

    // Off the line again, all of it is drawn and where it was.
    await page.keyboard.press(vim ? "j" : "ArrowDown");
    await page.keyboard.press(vim ? "j" : "ArrowDown");
    await expect.poll(async () => (await seen(page)).written).toEqual([]);
    const after = await seen(page);
    after.words.forEach((left, n) => expect(Math.abs(left - drawn.words[n]!), `"${WORDS[n]}" with the cursor gone`).toBeLessThanOrEqual(0.5));
  });
}

test("a click on a word shows that word's marks alone, a selection shows what it reaches, and undo puts back what was typed in one", async ({ page }) => {
  const note = await open(page, WALK);
  await expect(editor(page).locator(".katex").first()).toBeVisible();
  const line = editor(page).locator(".cm-line").filter({ hasText: "Alpha" });

  await line.getByText("bold", { exact: true }).click();
  await expect.poll(async () => (await seen(page)).written).toEqual(["bold"]);
  await line.getByText("code", { exact: true }).click();
  await expect.poll(async () => (await seen(page)).written).toEqual(["code"]);
  await line.locator(".katex").nth(1).click();
  await expect.poll(async () => (await seen(page)).written).toEqual(["second formula"]);
  await page.keyboard.press("End");
  await expect.poll(async () => (await seen(page)).written).toEqual([]);

  // A selection from the middle of Bravo to the end of Delta reaches the link and the code between them, and no further.
  await page.keyboard.press("Home");
  for (let n = 0; n < LINE.indexOf("Bravo") + 2; n++) await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await seen(page)).written).toEqual([]);
  for (let n = LINE.indexOf("Bravo") + 2; n < LINE.indexOf("Delta") + 5; n++) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe("avo [link](x.co) Charlie `code` Delta");
  await expect.poll(async () => (await seen(page)).written).toEqual(["link", "code"]);

  // Typed in the bold word and undone: the note says what it said, and the word is drawn again once the cursor leaves.
  await line.getByText("bold", { exact: true }).click();
  await page.keyboard.type("er");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).not.toBe(WALK);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(WALK);
  await page.keyboard.press("End");
  await expect.poll(async () => (await seen(page)).written).toEqual([]);
});

test("bold and italic written as one, ***so***, show all their marks together or none of them", async ({ page }) => {
  await open(page, "# Both\n\nSome ***both*** here.\n\nLast words.");
  const line = editor(page).locator(".cm-line").filter({ hasText: "Some" });
  await expect(line).toHaveText("Some both here.");
  await line.click({ position: { x: 2, y: 8 } });
  await page.keyboard.press("Home");
  for (const [at, shown] of ["Some both here.", "Some both here.", "Some both here.", "Some both here.", "Some both here.", "Some ***both*** here.", "Some ***both*** here."].entries()) {
    if (at > 0) await page.keyboard.press("ArrowRight");
    await expect(line, `${at} letters along`).toHaveText(shown);
  }
  await page.keyboard.press("End");
  await expect(line).toHaveText("Some both here.");
  await page.keyboard.press("ArrowLeft");
  for (let n = 0; n < 4; n++) await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveText("Some both here.");
  await page.keyboard.press("ArrowLeft");
  await expect(line).toHaveText("Some ***both*** here.");
});

const DEPTHS = [
  "# Depths",
  "",
  "- Bullet one",
  "  - Bullet two",
  "    - Bullet three",
  "- [ ] Task one",
  "  - [ ] Task two",
  "    - [x] Task three",
  "1. Number one",
  "   1. Number two",
  "      1. Number three",
  "- Mixed one",
  "  1. Mixed two",
  "     - [ ] Mixed three",
  "       written under mixed three",
  "- Plain bullet",
  "",
  "Last words.",
].join("\n");

/** Where the mark of the line that says `word` starts, and where its words do, from the left edge of the lines. */
const startsOf = (page: Page, words: readonly string[]) =>
  page.evaluate((all) => {
    const lines = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")];
    const edge = lines.find((el) => el.textContent === "Last words.")!;
    const first = document.createRange();
    first.selectNodeContents(edge);
    const zero = first.getClientRects()[0]!.left;
    return all.map((word) => {
      const line = lines.find((el) => el.textContent!.includes(word))!;
      const text = line.textContent!;
      const at = (start: number) => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && start >= node.textContent!.length) {
          start -= node.textContent!.length;
          node = walker.nextNode();
        }
        const range = document.createRange();
        range.setStart(node!, start);
        range.setEnd(node!, start + 1);
        return range.getBoundingClientRect().left - zero;
      };
      return { mark: at(text.search(/(?<=^[\s▾▸]*)[^\s▾▸]/)), words: at(text.indexOf(word)), height: line.getBoundingClientRect().height };
    });
  }, words);

test("each level of a list starts a step further in than the one above it, the same step for bullets, tasks, numbers and a mix of them, and a line written under an item's words starts under them", async ({ page }) => {
  await open(page, DEPTHS);
  const size = await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const step = 1.5 * size;

  for (const kind of ["Bullet", "Task", "Number", "Mixed"]) {
    const [one, two, three] = await startsOf(page, [`${kind} one`, `${kind} two`, `${kind} three`]);
    expect(Math.abs(one!.mark), `${kind} one's mark is at the edge of the text: ${one!.mark}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(two!.mark - step), `${kind} two's mark is one step in: ${two!.mark}, a step is ${step}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(three!.mark - 2 * step), `${kind} three's mark is two steps in: ${three!.mark}`).toBeLessThanOrEqual(0.5);
    expect(two!.words, `${kind} two's words are right of ${kind} one's`).toBeGreaterThan(one!.words + step - 0.5);
  }
  const [item, under] = await startsOf(page, ["Mixed three", "written under mixed three"]);
  expect(Math.abs(under!.mark - item!.words), `a line under an item's words starts at ${under!.mark}, the words at ${item!.words}`).toBeLessThanOrEqual(0.5);

  // The cursor coming to a line, on its words or on its indent, moves none of it.
  const drawn = await startsOf(page, ["Bullet three", "Task three", "Number three", "Mixed three"]);
  for (const word of ["Bullet three", "Task three", "Number three", "Mixed three"]) {
    await editor(page).locator(".cm-line").filter({ hasText: word }).first().click();
    expect(await startsOf(page, ["Bullet three", "Task three", "Number three", "Mixed three"]), `with the cursor on ${word}`).toEqual(drawn);
    await page.keyboard.press("Home");
    const now = await startsOf(page, ["Bullet three", "Task three", "Number three", "Mixed three"]);
    now.forEach((at, n) => expect(Math.abs(at.words - drawn[n]!.words), `with the cursor at the start of ${word}`).toBeLessThanOrEqual(0.5));
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`a task's box is larger than the letters beside it, level with them, as tall a row as any other, and is ticked by a press a little off it, with the keyboard left in the note (${scheme})`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, DEPTHS);
    const size = await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const task = editor(page).locator(".cm-line").filter({ hasText: "Task one" });
    const box = (await task.getByRole("checkbox").boundingBox())!;

    // Square, and clearly larger than the 0.85 of the text's size it was.
    expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5);
    expect(box.width).toBeGreaterThanOrEqual(1.05 * size);
    expect(box.width).toBeLessThanOrEqual(1.2 * size);

    // Its row is as tall as a row with no box, and it is level with the row's letters: its middle is theirs.
    const [withBox, plain] = await startsOf(page, ["Task one", "Plain bullet"]);
    expect(Math.abs(withBox!.height - plain!.height)).toBeLessThanOrEqual(0.5);
    const letter = await task.evaluate((line) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent!.includes("Task one")) node = walker.nextNode();
      const range = document.createRange();
      range.setStart(node!, node!.textContent!.indexOf("T"));
      range.setEnd(node!, node!.textContent!.indexOf("T") + 1);
      const { top, height } = range.getBoundingClientRect();
      return top + height / 2;
    });
    expect(Math.abs(box.y + box.height / 2 - letter), `the box's middle is at ${box.y + box.height / 2}, the letters' at ${letter}`).toBeLessThanOrEqual(1.5);

    // A press two pixels left of it, near the top of its row, ticks it. The cursor stays where it was, in the note.
    await editor(page).locator(".cm-line").filter({ hasText: "Plain bullet" }).getByText("Plain bullet").click();
    const row = (await task.boundingBox())!;
    await page.mouse.click(box.x - 2, row.y + 3);
    await expect(task.getByRole("checkbox")).toBeChecked();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("!");
    await expect(editor(page).locator(".cm-line").filter({ hasText: "Plain bullet" })).toContainText("!");
    await page.screenshot({ path: info.outputPath(`boxes-${scheme}.png`) });
  });
}

test("a task has no dot beside its box, nothing is drawn beside a bullet with things under it, and a plain bullet keeps its dot", async ({ page }) => {
  await open(page, DEPTHS.replace("- Plain bullet", "- Plain bullet\n> - [ ] Quoted task\n- - [ ] Inner task"));
  const marks = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")]
      .filter((line) => /(Task|Bullet) (one|two)|Mixed three|Quoted|Inner/.test(line.textContent!))
      .map((line) => {
        const mark = line.querySelector<HTMLElement>(".bullet-dot, .bullet-blank");
        return {
          line: line.textContent!.trimStart(),
          painted: mark ? getComputedStyle(mark, "::before").content !== "none" || getComputedStyle(mark).webkitTextFillColor !== "rgba(0, 0, 0, 0)" : null,
          beside: line.querySelectorAll("[role=button]").length,
        };
      }),
  );
  expect(marks).toEqual([
    { line: "- Bullet one", painted: true, beside: 0 },
    { line: "- Bullet two", painted: true, beside: 0 },
    { line: "- [ ] Task one", painted: false, beside: 0 },
    { line: "- [ ] Task two", painted: false, beside: 0 },
    { line: "- [ ] Mixed three", painted: false, beside: 0 },
    // Where no box is drawn, in a quote or after another mark, the mark keeps its dot.
    { line: "> - [ ] Quoted task", painted: true, beside: 0 },
    { line: "- - [ ] Inner task", painted: true, beside: 0 },
  ]);

  // With the cursor on a task's mark it is shown as written, and nothing on the line moves.
  const task = editor(page).locator(".cm-line").filter({ hasText: "Task two" });
  const before = await startsOf(page, ["Task two"]);
  await task.getByText("Task two").click();
  await page.keyboard.press("Home");
  await expect(task.locator(".bullet-blank")).toHaveCount(0);
  await expect(task.getByRole("checkbox")).toHaveCount(1);
  expect(await startsOf(page, ["Task two"])).toEqual(before);
});

/**
 * A face whose X is twice as wide as the app's and whose letters are spread, put on the page before the note is drawn: its X
 * loads only once one is on screen, so anything that measured `[X]` before then measured another face's. On Linux an `[X]`
 * task's words once started 1.36px right of an `[ ]` one's, where the gap was made up from the letters' measured widths.
 */
const WIDE_X = `@font-face { font-family: "Ink wide X"; src: local("Helvetica"), local("Arial"), local("Liberation Sans"), local("DejaVu Sans"); unicode-range: U+58; size-adjust: 200%; }
.editor .cm-content { font-family: "Ink wide X", var(--prose) !important; letter-spacing: 0.6px; }`;

for (const face of ["the app's face", "a face with a wide X"] as const) {
  test(`a task's words start well clear of its box, the same distance ticked or not, and neither the cursor coming onto the box nor ticking it moves them (${face})`, async ({ page }) => {
    if (face === "a face with a wide X") await page.addInitScript((css) => document.addEventListener("DOMContentLoaded", () => document.head.append(Object.assign(document.createElement("style"), { textContent: css }))), WIDE_X);
    await open(page, "# Gap\n\n- [ ] Open task\n- [x] Done task\n- [X] Shouted task\n1. [ ] Numbered task\n\nLast words.");
    const size = await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const gaps = () =>
      page.evaluate((words) => {
        const lines = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")];
        return words.map((word) => {
          const line = lines.find((el) => el.textContent!.includes(word))!;
          const text = [...line.querySelectorAll("*")].flatMap((el) => [...el.childNodes]).concat([...line.childNodes]).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.includes(word))!;
          const range = document.createRange();
          range.setStart(text, text.textContent!.indexOf(word));
          range.setEnd(text, text.textContent!.indexOf(word) + 1);
          const words = range.getBoundingClientRect().left;
          const box = line.querySelector("input[type=checkbox]")?.getBoundingClientRect();
          const written = line.querySelector(".md-chip-task > :first-child, .md-task-box")!.getBoundingClientRect().width;
          return { words, gap: box ? words - box.right : null, boxLeft: box?.left ?? null, written };
        });
      }, ["Open task", "Done task", "Shouted task", "Numbered task"]);

    const drawn = await gaps();
    if (face === "a face with a wide X") expect(drawn[2]!.written - drawn[0]!.written, "the face's X is wider than a space by a lot").toBeGreaterThan(0.6 * size);
    for (const [n, { gap }] of drawn.entries()) expect(gap!, `the gap after box ${n} is ${gap}, the text is ${size}px`).toBeGreaterThanOrEqual(0.55 * size);
    expect(Math.abs(drawn[0]!.words - drawn[1]!.words), "an open and a done task's words start together").toBeLessThanOrEqual(0.5);
    expect(Math.abs(drawn[0]!.words - drawn[2]!.words), "and an [X] one's").toBeLessThanOrEqual(0.5);
    expect(Math.abs(drawn[0]!.boxLeft! - drawn[1]!.boxLeft!), "their boxes are in one place").toBeLessThanOrEqual(0.5);

    // The cursor on the box shows `[ ]` as written in the box's place: the words stay put.
    const first = editor(page).locator(".cm-line").filter({ hasText: "Open task" });
    await first.getByText("Open task").click();
    await page.keyboard.press("Home");
    for (let n = 0; n < 2; n++) await page.keyboard.press("ArrowRight");
    await expect(first.getByRole("checkbox")).toHaveCount(0);
    expect(Math.abs((await gaps())[0]!.words - drawn[0]!.words), "the words with the box shown as written").toBeLessThanOrEqual(0.5);
    // And an `[X]` as written, however wide its X.
    const shouted = editor(page).locator(".cm-line").filter({ hasText: "Shouted task" });
    await shouted.getByText("Shouted task").click();
    await page.keyboard.press("Home");
    for (let n = 0; n < 2; n++) await page.keyboard.press("ArrowRight");
    await expect(shouted.getByRole("checkbox")).toHaveCount(0);
    expect(Math.abs((await gaps())[2]!.words - drawn[2]!.words), "an [X] task's words with its box shown as written").toBeLessThanOrEqual(0.5);

    // Ticked from elsewhere, the words stay put too.
    await page.keyboard.press("ControlOrMeta+End");
    await first.getByRole("checkbox").click();
    await expect(first.getByRole("checkbox")).toBeChecked();
    const ticked = await gaps();
    expect(Math.abs(ticked[0]!.words - drawn[0]!.words), "the words once the box is ticked").toBeLessThanOrEqual(0.5);
    expect(Math.abs(ticked[0]!.boxLeft! - drawn[0]!.boxLeft!), "the box once it is ticked").toBeLessThanOrEqual(0.5);
  });
}

test("a formula in a line sits on the line's baseline where KaTeX itself puts it, and the line is no taller", async ({ page }) => {
  // A column wide enough for the line of formulas to be one row in a monospaced font too, so its baseline is the formulas'.
  await open(page, "# Inline $\\frac{a}{b}$ head\n\nA fraction $\\frac{a}{b}$ and a square $x^2$ and a sum $\\sum_{i=1}^{n} i$ and $a \\neq b$ and $x \\notin S$ in words.\n\nLast words.", { "core.editorReadingWidth": 1100 });
  await expect(editor(page).locator(".katex").first()).toBeVisible();
  // KaTeX's own script, served as a file of the app's origin: the page's policy runs no inline script.
  await page.route("**/test-only/katex.min.js", (route) => route.fulfill({ path: "node_modules/katex/dist/katex.min.js", contentType: "text/javascript" }));
  await page.addScriptTag({ url: "/test-only/katex.min.js" });
  const { ours, katex, plainHeight, ourHeight, headingBaselines } = await page.evaluate(() => {
    const line = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes("fraction"))!;
    const style = getComputedStyle(line);
    // The same formulas as KaTeX sets them in a paragraph of the line's own face, size and height.
    const plain = document.createElement("p");
    // Each part of the face, as `font` reads as nothing for a face with a part it can't say, such as no kerning.
    const face = { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle, fontKerning: style.fontKerning };
    Object.assign(plain.style, { position: "fixed", left: "0", top: "0", margin: "0", ...face, lineHeight: style.lineHeight, whiteSpace: "pre" });
    for (const tex of ["\\frac{a}{b}", "x^2", "\\sum_{i=1}^{n} i", "a \\neq b", "x \\notin S"]) {
      const el = document.createElement("span");
      (window as unknown as { katex: { render(tex: string, el: HTMLElement, options: object): void } }).katex.render(tex, el, { output: "htmlAndMathml" });
      plain.append(" words ", el);
    }
    document.body.append(plain);
    const baseline = (host: HTMLElement) => {
      const probe = host.appendChild(document.createElement("span"));
      probe.style.cssText = "display: inline-block; width: 0; height: 0";
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return y;
    };
    /** Where each letter of each formula is, above (less than 0) or below its line's baseline. */
    const letters = (host: HTMLElement): [number, number][][] => {
      const at = baseline(host);
      return [...host.querySelectorAll(".katex-html")].map((formula) =>
        [...formula.querySelectorAll(".mord, .mop, .mrel")]
          .filter((el) => el.children.length === 0)
          .map((el): [number, number] => {
            const box = el.getBoundingClientRect();
            return [Math.round((box.top - at) * 10) / 10, Math.round((box.bottom - at) * 10) / 10];
          }),
      );
    };
    const plainLine = document.createElement("p");
    Object.assign(plainLine.style, { margin: "0", ...face, lineHeight: style.lineHeight });
    plainLine.textContent = "words";
    document.body.append(plainLine);
    // In a heading, the formula's baseline is the heading's.
    const heading = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes("head"))!;
    const headingFormula = heading.querySelector<HTMLElement>(".katex-html")!;
    return { ours: letters(line), katex: letters(plain), plainHeight: plainLine.getBoundingClientRect().height, ourHeight: line.getBoundingClientRect().height, headingBaselines: [baseline(heading), baseline(headingFormula)] };
  });
  expect(ours.length).toBe(5);
  for (const [n, formula] of ours.entries()) for (const [m, [top, bottom]] of formula.entries()) {
    expect(Math.abs(top - katex[n]![m]![0]), `formula ${n} letter ${m}: ours from ${top} to ${bottom} of the baseline, KaTeX's ${katex[n]![m]}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(bottom - katex[n]![m]![1])).toBeLessThanOrEqual(0.5);
  }
  expect(Math.abs(ourHeight - plainHeight), `the line is ${ourHeight} tall, a line of words ${plainHeight}`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(headingBaselines[0]! - headingBaselines[1]!), `a heading's baseline and its formula's: ${headingBaselines}`).toBeLessThanOrEqual(0.5);
});
