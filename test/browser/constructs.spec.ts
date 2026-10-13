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
      ...(line.querySelector(".bullet-dot") ? [] : ["mark"]),
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
    await open(page, WALK, vim ? { "vim.enabled": true } : undefined);
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
