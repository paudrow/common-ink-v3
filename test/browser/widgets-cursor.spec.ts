import { expect, test, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const lines = (page: Page) => page.locator(".cm-line");
const line = (page: Page, start: string) => lines(page).filter({ hasText: new RegExp(`^${start}`) });
const column = (page: Page, name: string) => editor(page).getByRole("region", { name, exact: true });
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;

async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toBeVisible();
  return note;
}

/** Marks the drawn stopwatch's elements, to ask later whether they are still the ones on the page, and counts every embed element taken out of it. */
async function mark(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __MARKED__: Element[]; __REMOVED__: number };
    w.__MARKED__ = [...document.querySelectorAll(".cm-content .embed, .cm-content .embed .clock")];
    w.__REMOVED__ = 0;
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) if (node instanceof Element && (node.matches(".embed, .embed-frame") || node.querySelector(".embed"))) w.__REMOVED__++;
    }).observe(document.querySelector(".cm-content")!, { childList: true, subtree: true });
  });
}
const marked = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __MARKED__: Element[]; __REMOVED__: number };
    const now = [...document.querySelectorAll(".cm-content .embed, .cm-content .embed .clock")];
    return { same: now.length === w.__MARKED__.length && now.every((el, i) => el === w.__MARKED__[i]), removed: w.__REMOVED__ };
  });

/** A clock's time as seconds. */
const seconds = async (page: Page, name: RegExp) => {
  const [m, s] = (await editor(page).getByRole("button", { name }).textContent())!.split(":").map(Number);
  return m! * 60 + s!;
};
const place = async (page: Page, selector: string) => {
  const box = (await editor(page).locator(selector).first().boundingBox())!;
  return [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 10) / 10);
};
/** A box as it is laid out, unrounded: the browser lays out in 64ths of a pixel, which add up exactly, so two of these can be added and compared. */
const boxOf = async (locator: Locator) => (await locator.first().boundingBox())!;
const lower = (box: { x: number; y: number; width: number; height: number }, by: number) => ({ ...box, y: box.y + by });
/** An inline embed's text as written, shown above its line, and the rows made for it there. */
const source = (page: Page) => editor(page).locator(".embed-source");
const sourceRows = (page: Page) => editor(page).locator(".embed-source-rows");
/** Measures are taken once the fonts are in, as a font that arrives later would move what was measured. */
const fonts = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => undefined));

test("a running stopwatch is the same element, still counting, with the cursor on it, through it, and typing around it: its text is shown in a row above its line, and it is lower by that row and no more", async ({ page }) => {
  const note = await open(page, "# Laps\n\nbefore\nLap ::stopwatch{} here.\nafter\n");
  await fonts(page);
  await editor(page).getByRole("button", { name: "Start stopwatch" }).click();
  await expect(editor(page).getByRole("button", { name: "Stop stopwatch" })).toBeVisible();
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThanOrEqual(1);
  await mark(page);
  const card = editor(page).locator(".embed-card");
  const off = { before: await boxOf(line(page, "before")), line: await boxOf(line(page, "Lap")), card: await boxOf(card), after: await boxOf(line(page, "after")) };
  const now = async () => ({ before: await boxOf(line(page, "before")), line: await boxOf(line(page, "Lap")), card: await boxOf(card), after: await boxOf(line(page, "after")) });

  await line(page, "Lap").click({ position: { x: 2, y: 5 } });
  const started = Date.now();
  // Right through the whole line, a character at a time: onto the embed, through it as written, and off its far end.
  const written = (await read(page, note.id)).split("\n")[3]!;
  let shown = 0;
  for (let i = 0; i < written.length; i++) {
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => marked(page)).toEqual({ same: true, removed: 0 });
    const rows = (await source(page).count()) ? (await boxOf(sourceRows(page))).height : 0;
    if (rows) shown++;
    // The rows of its text are all that is added: the card and the line after are lower by them, and nothing is anywhere else.
    await expect.poll(() => now()).toEqual({ before: off.before, line: { ...off.line, height: off.line.height + rows }, card: lower(off.card, rows), after: lower(off.after, rows) });
  }
  // The cursor was on the embed from its first character to its last, and on nothing before or after.
  expect(shown).toBe(written.indexOf("}") - written.indexOf("::") + 2);
  await expect(source(page)).toHaveCount(0);
  await expect(line(page, "Lap")).not.toContainText("::stopwatch");
  await expect.poll(() => now()).toEqual(off);

  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  // With the cursor in it, the embed is shown as the note writes it, above the line and from the line's left edge, over the rows made for it, and the card is under it.
  await expect(source(page)).toHaveText(/^::stopwatch\{since=[^}]+\}$/);
  const [text, rows, on] = [await boxOf(source(page)), await boxOf(sourceRows(page)), await now()];
  expect(rows.height).toBeGreaterThan(10);
  expect({ y: text.y, height: text.height }).toEqual({ y: off.line.y, height: rows.height });
  expect(text.y + text.height).toBeLessThanOrEqual(on.card.y);
  expect(on).toEqual({ before: off.before, line: { ...off.line, height: off.line.height + rows.height }, card: lower(off.card, rows.height), after: lower(off.after, rows.height) });

  await page.keyboard.press("ArrowUp");
  await page.keyboard.type(" typed above");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type(" typed below");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" And on its own line.");
  await expect.poll(() => read(page, note.id)).toMatch(/before typed above\nLap ::stopwatch\{since=[^}]+\} here\. And on its own line\.\nafter typed below\n/);
  await expect.poll(() => marked(page)).toEqual({ same: true, removed: 0 });
  await expect(source(page)).toHaveCount(0);
  await expect.poll(async () => (await now()).card).toEqual(off.card);

  // It never stopped: it shows at least the time that has gone by since the cursor first came, and is still running.
  const gone = Math.floor((Date.now() - started) / 1000);
  expect(gone).toBeGreaterThanOrEqual(1);
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThanOrEqual(1 + gone);
  await expect(editor(page).getByRole("button", { name: /^Stopwatch, / })).toHaveAttribute("aria-pressed", "true");
  const later = await seconds(page, /^Stopwatch, /);
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThan(later);
});

test("an embed's text takes as many rows above its line as it needs at the width there is, two embeds on a line each have their own, and a press on a button of the embed leaves them where they are", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const since = new Date(Date.now() - 65_000).toISOString();
  await open(page, `# Rows\n\nbefore\nTea ::timer{25m since=${since}} ::stopwatch{at=1m5s}\nafter\n`);
  await fonts(page);
  const cards = editor(page).locator(".embed-card");
  const off = { line: await boxOf(line(page, "Tea")), timer: await boxOf(cards.nth(0)), stopwatch: await boxOf(cards.nth(1)), after: await boxOf(line(page, "after")) };

  // Every embed the selection touches is shown: the first one's text over the first rows, the second one's under it.
  await line(page, "Tea").click({ position: { x: 2, y: 5 } });
  await page.keyboard.press("Shift+End");
  await expect(source(page)).toHaveText([`::timer{25m since=${since}}`, "::stopwatch{at=1m5s}"]);
  const wide = await boxOf(sourceRows(page));
  const [first, second] = [await boxOf(source(page).nth(0)), await boxOf(source(page).nth(1))];
  expect(first.height).toBeLessThan(second.height);
  expect(first.y + first.height).toBeLessThan(second.y + second.height);
  expect(second.y + second.height).toBe(wide.y + wide.height);
  expect({ timer: await boxOf(cards.nth(0)), stopwatch: await boxOf(cards.nth(1)), after: await boxOf(line(page, "after")) }).toEqual({ timer: lower(off.timer, wide.height), stopwatch: lower(off.stopwatch, wide.height), after: lower(off.after, wide.height) });

  // A press on the clock's own button takes the keyboard out of the text. The rows stay, so the button is still under the pointer when it is let go.
  await line(page, "before").click({ position: { x: 2, y: 5 } });
  await expect(source(page)).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(source(page)).toHaveText([`::timer{25m since=${since}}`]);
  const shown = await boxOf(cards.nth(0));
  await editor(page).getByRole("button", { name: "Pause timer" }).click();
  await expect(editor(page).getByRole("button", { name: "Start timer" })).toBeFocused();
  await expect(source(page)).toHaveText(/^::timer\{25m at=\d+m\d+s\}$/);
  await expect.poll(() => boxOf(cards.nth(0))).toEqual(shown);

  // In a narrow window the same text takes more rows, and the rows are still exactly what it takes.
  await page.keyboard.press("ControlOrMeta+z");
  await editor(page).focus();
  await expect(source(page)).toHaveText([`::timer{25m since=${since}}`]);
  const one = (await boxOf(sourceRows(page))).height;
  await page.setViewportSize({ width: 300, height: 900 });
  await expect.poll(async () => (await boxOf(sourceRows(page))).height).toBeGreaterThan(one);
  const [text, rows] = [await boxOf(source(page)), await boxOf(sourceRows(page))];
  expect({ y: text.y, height: text.height }).toEqual({ y: rows.y, height: rows.height });
  expect(text.y + text.height).toBeLessThanOrEqual((await boxOf(cards.nth(0))).y);
});

test("a running stopwatch scrolled far out of sight and back shows the time that went by, and is still counting", async ({ page }) => {
  await open(page, `# Long\n\nLap ::stopwatch{} here.\n\n${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}\n`);
  await editor(page).getByRole("button", { name: "Start stopwatch" }).click();
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThanOrEqual(1);
  const before = await seconds(page, /^Stopwatch, /);
  const started = Date.now();

  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(line(page, "line 399")).toBeInViewport();
  await expect(editor(page).getByRole("button", { name: /^Stopwatch, / })).not.toBeInViewport();
  await page.waitForTimeout(1200);
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(editor(page).getByRole("button", { name: /^Stopwatch, / })).toBeInViewport();
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThanOrEqual(before + Math.floor((Date.now() - started) / 1000));
  await expect(editor(page).getByRole("button", { name: "Stop stopwatch" })).toBeVisible();
});

test("a stopwatch and a timer say what their buttons do, and each button does it", async ({ page }) => {
  const note = await open(page, "# Clocks\n\nLap ::stopwatch{} and tea ::timer{5m} here.\n");
  const stopwatch = editor(page).locator('.embed[data-embed="stopwatch"]');
  const timer = editor(page).locator('.embed[data-embed="timer"]');
  const says = (clock: typeof timer) => clock.locator("button").evaluateAll((buttons) => buttons.map((b) => (b.textContent || getComputedStyle(b, "::before").content.replaceAll('"', "")) + (b.hasAttribute("disabled") ? " (off)" : "")));
  await expect.poll(() => says(stopwatch)).toEqual(["0:00", "Start", "Reset (off)"]);
  await expect.poll(() => says(timer)).toEqual(["5:00", "Start", "Reset (off)"]);
  const width = (await timer.boundingBox())!.width;

  await timer.getByRole("button", { name: "Start timer" }).click();
  await expect(timer.getByRole("button", { name: "Pause timer" })).toBeFocused();
  await expect.poll(async () => (await says(timer)).slice(1)).toEqual(["Pause", "Reset"]);
  await expect.poll(() => read(page, note.id)).toMatch(/::timer\{5m since=[^}]+\}/);
  await timer.getByRole("button", { name: "Pause timer" }).click();
  await expect.poll(() => read(page, note.id)).toMatch(/::timer\{5m at=\d+s\}|::timer\{5m\}/);
  await expect.poll(async () => (await says(timer)).slice(1)).toEqual(["Start", "Reset"]);
  await timer.getByRole("button", { name: "Reset timer" }).click();
  await expect.poll(() => read(page, note.id)).toContain("::timer{5m}");
  await expect.poll(() => says(timer)).toEqual(["5:00", "Start", "Reset (off)"]);
  await expect.poll(async () => (await timer.boundingBox())!.width).toBe(width);

  await stopwatch.getByRole("button", { name: "Start stopwatch" }).click();
  await expect.poll(async () => (await says(stopwatch)).slice(1)).toEqual(["Stop", "Reset"]);
  await stopwatch.getByRole("button", { name: "Stop stopwatch" }).click();
  await stopwatch.getByRole("button", { name: "Reset stopwatch" }).click();
  await expect.poll(() => read(page, note.id)).toContain("::stopwatch{} and");
  // What the buttons say is not text in the line: the time is all a clock adds to it.
  await expect(line(page, "Lap")).toHaveText("Lap 0:00 and tea 5:00 here.");
});

test("an embed's one options button, in its card, opens its options beneath the card, and setting one rewrites the embed as the member's change, where it stands", async ({ page }) => {
  const note = await open(page, "# Options\n\nTea ::timer{5m} and lap ::stopwatch{} here.\n\nlast\n");
  await mark(page);
  const at = await place(page, ".embed");

  // One options button, in the embed's own card, and its options open beneath the card from its left edge.
  const card = editor(page).locator('.embed-card:has([data-embed="timer"])');
  await expect(card.getByRole("button")).toHaveCount(4);
  await card.getByRole("button", { name: "Options for Timer" }).click();
  const options = page.getByRole("dialog", { name: "Options for Timer" });
  await expect(options.getByRole("textbox", { name: "Length" })).toBeFocused();
  const [under, panel] = [await boxOf(card), await boxOf(options)];
  expect(panel.y).toBeGreaterThanOrEqual(under.y + under.height);
  expect(panel.y - (under.y + under.height)).toBeLessThan(8);
  expect(panel.x).toBe(under.x);
  // Only what can be set is in them.
  await expect(options.getByRole("button")).toHaveCount(0);
  await expect(options.getByRole("textbox")).toHaveCount(1);
  await expect(options.getByRole("textbox", { name: "Length" })).toHaveValue("5m");
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  await expect(options.getByRole("alert")).toHaveText("Write it like 25m, 1h30m or 90s.");
  await expect.poll(() => read(page, note.id)).toContain("::timer{5m}");
  await options.getByRole("textbox", { name: "Length" }).fill("25m");
  await page.keyboard.press("Enter");
  await expect(editor(page).getByRole("button", { name: "Timer, 25:00 left" })).toBeVisible();
  await expect.poll(() => read(page, note.id)).toContain("Tea ::timer{25m} and");
  await expect(options.getByRole("textbox", { name: "Length" })).toHaveValue("25m");
  await expect.poll(() => marked(page)).toEqual({ same: true, removed: 0 });
  // A longer time is wider. It starts where it did and is as tall.
  const now = await place(page, ".embed");
  expect([now[0], now[1], now[3]]).toEqual([at[0], at[1], at[3]]);
  await expect.poll(async () => (await perform(page, { type: "note.history", id: note.id })).map((c) => `${c.author.kind} ${c.author.name}`)).toEqual(["member Ada Lovelace", "member Ada Lovelace"]);

  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(editor(page).getByRole("button", { name: "Options for Timer" })).toBeFocused();
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toContain("Tea ::timer{5m} and");

  await editor(page).getByRole("button", { name: "Options for Stopwatch" }).click();
  await page.getByRole("dialog", { name: "Options for Stopwatch" }).getByRole("textbox", { name: "Time so far" }).fill("1m5s");
  await page.keyboard.press("Enter");
  await expect(editor(page).getByRole("button", { name: "Stopwatch, 1:05" })).toBeVisible();
  await expect.poll(() => read(page, note.id)).toContain("::stopwatch{at=1m5s}");

  // Nothing offers the embed "as markdown": the cursor is put in it instead, here by a press on its card's own edge, and it is shown as written above its line.
  await page.keyboard.press("Escape");
  await expect(page.getByText("Edit as markdown")).toHaveCount(0);
  const stopwatch = editor(page).locator('.embed-card:has([data-embed="stopwatch"])');
  await stopwatch.click({ position: { x: 4, y: 4 } });
  await expect(source(page)).toHaveText("::stopwatch{at=1m5s}");
  await expect(editor(page).getByRole("button", { name: "Stopwatch, 1:05" })).toBeVisible();
  await page.keyboard.type("0");
  await expect.poll(() => read(page, note.id)).toContain("::stopwatch{0at=1m5s}");
  await page.keyboard.press("Backspace");
});

test("Tab picks the highlighted item of the / menu, as Enter does", async ({ page }) => {
  const note = await open(page, "# Menu\n\n");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  // A list still waiting on what was just typed is shown, but no key picks from it.
  const menu = page.locator(".cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)").getByRole("option");
  await page.keyboard.type("/stop");
  await expect(menu.filter({ hasText: "Stopwatch" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toBe("# Menu\n\n::stopwatch{}");
  await expect(menu).toHaveCount(0);
  await page.keyboard.type(" /");
  await expect(menu.first()).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(menu.nth(1)).toHaveAttribute("aria-selected", "true");
  const second = (await menu.nth(1).locator(".cm-completionDetail").textContent())!;
  expect(second).toMatch(/^::[a-z]+\{/);
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toBe(`# Menu\n\n::stopwatch{} ${second}`);
  await expect(menu).toHaveCount(0);
});

const BOARD = "# Board\n\nabove\n:::kanban{}\n## To do\n- write\n- review\n\n## Doing\n- build\n\n## Done\n:::\nbelow\n";

test("the arrow keys go from the line above into a board's markdown, which is shown above the board that stays drawn, through it as through any text, and out to the line below, and back up", async ({ page }) => {
  const note = await open(page, BOARD);
  await fonts(page);
  await expect(column(page, "Done")).toBeVisible();
  await mark(page);
  const drawn = editor(page).locator(".embed-frame-block");
  const off = { above: await boxOf(line(page, "above")), board: await boxOf(drawn), below: await boxOf(line(page, "below")) };
  await line(page, "above").click();

  await page.keyboard.press("ArrowDown");
  await expect(lines(page)).toContainText(["above", ":::kanban{}", "## To do", "- write", "- review", "## Doing", "- build", "## Done", ":::", "below"]);
  // The board is the element it was, under its ten lines and lower by them and no more, and the line above is where it was.
  await expect.poll(() => marked(page)).toEqual({ same: true, removed: 0 });
  const [first, last] = [await boxOf(line(page, ":::kanban")), await boxOf(lines(page).filter({ hasText: /^:::$/ }))];
  const shown = last.y + last.height - first.y;
  // Ten lines, each drawn small, as an embed's text is.
  expect(shown).toBeGreaterThan(100);
  expect(shown).toBeLessThan(off.above.height * 10);
  expect(first.y).toBe(off.above.y + off.above.height);
  expect({ above: await boxOf(line(page, "above")), board: await boxOf(drawn), below: await boxOf(line(page, "below")) }).toEqual({ above: off.above, board: lower(off.board, shown), below: lower(off.below, shown) });

  // The cursor is in the lines as in any text: two lines down is a card's line, and what is typed there is the card's.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type(" it up");
  await expect(column(page, "To do").getByRole("listitem")).toHaveText(["write it up", "review"]);
  await expect.poll(() => read(page, note.id)).toContain("## To do\n- write it up\n- review\n");
  await expect.poll(() => marked(page)).toEqual({ same: true, removed: 0 });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect(editor(page)).toBeFocused();

  // Seven more lines to the board's last, and one more to the line below it: the lines are hidden again and everything is where it was.
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
  await expect(lines(page).filter({ hasText: ":::kanban" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);
  await expect(lines(page).filter({ hasText: /^:::$/ })).toHaveCount(0);
  expect({ above: await boxOf(line(page, "above")), board: await boxOf(drawn), below: await boxOf(line(page, "below")) }).toEqual(off);
  await page.keyboard.press("Home");
  await page.keyboard.type("X");
  await expect.poll(() => read(page, note.id)).toContain(":::\nXbelow\n");

  // Up from the line below is the board's last line, and up from its first is the line above.
  await page.keyboard.press("ArrowUp");
  await expect(lines(page).filter({ hasText: /^:::$/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => getSelection()?.anchorNode?.textContent)).toBe(":::");
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowUp");
  await expect(lines(page).filter({ hasText: ":::kanban" })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);
  await page.keyboard.press("End");
  await page.keyboard.type("Y");
  await expect.poll(() => read(page, note.id)).toContain("\naboveY\n:::kanban{}");
  await expect.poll(() => marked(page)).toEqual({ same: true, removed: 0 });
});

test("with vim on, j and k go into a board's markdown and out the other side, and its text is changed there as any text is", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: BOARD });
  await page.goto(`/note/${note.id}`);
  await expect(column(page, "Done")).toBeVisible();
  const cursor = page.locator(".cm-fat-cursor");
  await line(page, "above").click();
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await page.keyboard.press("0");

  await page.keyboard.press("j");
  await expect(lines(page).filter({ hasText: ":::kanban{}" })).toBeVisible();
  await expect(cursor).toHaveText(":");
  await expect(column(page, "Done")).toBeVisible();
  await page.keyboard.press("j");
  await expect(cursor).toHaveText("#");
  // l and h move along the line, and x takes a character of the card under the cursor.
  await page.keyboard.press("j");
  for (const key of ["l", "l", "l", "h"]) await page.keyboard.press(key);
  await expect(cursor).toHaveText("w");
  await page.keyboard.press("x");
  await expect(column(page, "To do").getByRole("listitem")).toHaveText(["rite", "review"]);
  await expect.poll(() => read(page, note.id)).toContain("## To do\n- rite\n- review\n");
  for (let i = 0; i < 7; i++) await page.keyboard.press("j");
  await expect(lines(page).filter({ hasText: /^:::$/ })).toBeVisible();
  await page.keyboard.press("j");
  await expect(lines(page).filter({ hasText: ":::kanban{}" })).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Shift+I");
  await page.keyboard.type("X");
  await page.keyboard.press("Escape");
  await expect.poll(() => read(page, note.id)).toContain(":::\nXbelow\n");

  await page.keyboard.press("k");
  await expect(lines(page).filter({ hasText: /^:::$/ })).toBeVisible();
  for (let i = 0; i < 9; i++) await page.keyboard.press("k");
  await expect(cursor).toHaveText(":");
  await page.keyboard.press("k");
  await expect(lines(page).filter({ hasText: ":::kanban{}" })).toHaveCount(0);
  await page.keyboard.press("Shift+A");
  await page.keyboard.type("Y");
  await expect.poll(() => read(page, note.id)).toContain("\naboveY\n:::kanban{}");
  await expect(column(page, "Done")).toBeVisible();
});

test("with vim on, a key pressed while the pointer has put focus in a board is the board's and never a list's, and Ctrl-w still leaves the board for the lists beside it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  for (const name of ["Apple", "Zebra"]) await perform(page, { type: "folder.create", name });
  const note = await perform(page, { type: "note.create", text: BOARD });
  await page.goto(`/note/${note.id}`);
  await expect(column(page, "Done")).toBeVisible();
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  const colour = editor(page).getByRole("button", { name: "Colour of To do: no colour" });
  await colour.focus();

  // A column's cards are a list with a name, which vim's list keys would otherwise move through, open and leave.
  for (const key of ["Shift+G", "g", "g", "Control+d", "/", "g", "t", "j", "k", "h", "l"]) await page.keyboard.press(key);
  await expect(colour).toBeFocused();
  await expect(page.locator("[data-vim-at]")).toHaveCount(0);
  await expect.poll(() => read(page, note.id)).toBe(BOARD);

  const tree = page.getByRole("tree");
  await page.keyboard.press("Control+w");
  await page.keyboard.press("h");
  await expect.poll(() => tree.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+G");
  await expect(tree.getByRole("treeitem", { name: "Zebra", exact: true })).toBeFocused();
  await page.keyboard.press("k");
  await expect(tree.getByRole("treeitem", { name: "Zebra", exact: true })).not.toBeFocused();
  await expect(page.locator("[data-vim-at]")).toHaveCount(1);
});

test("a column is given a colour from the board, which its heading keeps as markdown, in light and dark, and through a reload", async ({ page }) => {
  const note = await open(page, BOARD);
  await expect(column(page, "Done")).toBeVisible();
  const plain = await column(page, "Doing").evaluate((el) => getComputedStyle(el).backgroundColor);
  const board = await place(page, ".embed-block");

  await editor(page).getByRole("button", { name: "Colour of Doing: no colour" }).click();
  await page.getByRole("dialog", { name: "Colour of Doing" }).getByRole("radio", { name: "Blue" }).click();
  await expect.poll(() => read(page, note.id)).toContain("## Doing {.blue}\n- build\n");
  await expect(editor(page).getByRole("button", { name: "Colour of Doing: blue" })).toBeFocused();
  await expect(column(page, "Doing")).toHaveAttribute("data-colour", "blue");
  await expect(column(page, "Doing").getByRole("heading")).toHaveText("Doing1");
  const light = await column(page, "Doing").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(light).not.toBe(plain);
  await expect.poll(() => place(page, ".embed-block")).toEqual(board);

  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await column(page, "Doing").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dark).not.toBe(light);
  expect(dark).not.toBe(await column(page, "Done").evaluate((el) => getComputedStyle(el).backgroundColor));
  await page.emulateMedia({ colorScheme: "light" });

  // The board's options set it too, and take it away.
  await editor(page).getByRole("button", { name: "Options for Kanban board" }).click();
  const options = page.getByRole("dialog", { name: "Options for Kanban board" });
  await expect(options.getByRole("radiogroup", { name: "Doing colour" }).getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  // They are beneath the board's card, from its left edge.
  const [under, panel] = [await boxOf(editor(page).locator(".embed-frame-block .embed-card")), await boxOf(options)];
  expect(panel.y).toBeGreaterThanOrEqual(under.y + under.height);
  expect(panel.x).toBe(under.x);
  await options.getByRole("radiogroup", { name: "Done colour" }).getByRole("radio", { name: "Green" }).click();
  await expect.poll(() => read(page, note.id)).toContain("## Done {.green}\n:::");
  await expect(options.getByRole("radiogroup", { name: "Done colour" }).getByRole("radio", { name: "Green" })).toHaveAttribute("aria-checked", "true");
  await options.getByRole("radiogroup", { name: "Doing colour" }).getByRole("radio", { name: "No colour" }).click();
  await expect.poll(() => read(page, note.id)).toContain("## Doing\n- build\n");

  await page.reload();
  await expect(column(page, "Done")).toHaveAttribute("data-colour", "green");
  await expect(column(page, "Doing")).not.toHaveAttribute("data-colour");
});

test("a key that jumps past a board doesn't go into it, a press on a card puts the cursor at the end of that card's line, and a board with no columns has no options", async ({ page }) => {
  const note = await open(page, "above\n:::kanban{}\n## To do\n- write\n- review\n:::\nbetween\n:::kanban{}\n:::\nbelow");
  await expect(column(page, "To do")).toBeVisible();
  await line(page, "above").click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor(page)).toBeFocused();
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toMatch(/\nbelow!$/);

  await mark(page);
  await column(page, "To do").getByRole("listitem").filter({ hasText: "review" }).click();
  await expect(lines(page).filter({ hasText: ":::kanban{}" })).toHaveCount(1);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(" twice");
  await expect.poll(() => read(page, note.id)).toContain("- write\n- review twice\n:::\nbetween");
  await expect(column(page, "To do").getByRole("listitem")).toHaveText(["write", "review twice"]);
  await expect.poll(() => marked(page)).toEqual({ same: true, removed: 0 });

  // Each board is a card with its name. Only the one with columns, which have colours to set, has an options button.
  await expect(editor(page).locator(".embed-head")).toHaveCount(2);
  await expect(editor(page).getByRole("button", { name: "Options for Kanban board" })).toHaveCount(1);
});

test("with vim on and typing, Escape closes an embed's open options and leaves insert mode alone, and the next Escape is vim's", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: "# Options\n\nTea ::timer{5m} here.\n\nlast\n" });
  await page.goto(`/note/${note.id}`);
  const mode = page.locator(".cm-vim-panel");
  await line(page, "last").click();
  await expect(mode).toHaveText("--NORMAL--");
  await page.keyboard.press("i");
  await expect(mode).toHaveText("--INSERT--");

  await editor(page).getByRole("button", { name: "Options for Timer" }).click();
  const options = page.getByRole("dialog", { name: "Options for Timer" });
  await expect(options).toBeVisible();
  await editor(page).focus();
  await expect(mode).toHaveText("--INSERT--");
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  await expect(mode).toHaveText("--INSERT--");

  await editor(page).focus();
  await page.keyboard.press("Escape");
  await expect(mode).toHaveText("--NORMAL--");
});

test("a note that starts with an embed opens with it drawn, the first press on the note lands where it was made, and a press on a card's title past a board goes to that embed and not into the board", async ({ page }) => {
  const note = await open(page, "::timer{5m}\n:::kanban{}\n## To do\n- write\n:::\n\nSome words here.\n\nabove\n:::kanban{}\n## Next\n- later\n:::\n::stopwatch{} below the board\n\nlast\n");
  await fonts(page);
  await expect(column(page, "Next")).toBeVisible();
  // The cursor is at the start of the note, on the timer, and nobody put it there.
  await expect(source(page)).toHaveCount(0);
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);
  const words = await boxOf(line(page, "Some words"));

  await line(page, "Some words").click({ position: { x: 40, y: 8 } });
  await expect(source(page)).toHaveCount(0);
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);
  await expect.poll(() => boxOf(line(page, "Some words"))).toEqual(words);
  await expect.poll(() => page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  await page.keyboard.press("Home");
  await page.keyboard.type("X");
  await expect.poll(() => read(page, note.id)).toContain(":::\n\nXSome words here.\n");

  // From the line above the second board, a press on the stopwatch's own card below it.
  await line(page, "above").click();
  await editor(page).locator('.embed-card:has([data-embed="stopwatch"])').click({ position: { x: 4, y: 4 } });
  await expect(source(page)).toHaveText("::stopwatch{}");
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);
  await page.keyboard.type("at=5s");
  await expect.poll(() => read(page, note.id)).toContain("::stopwatch{at=5s} below the board");
});

test("an embed's text in a heading is the size its rows were made for, and a long board's options open inside the window", async ({ page }) => {
  const cards = Array.from({ length: 40 }, (_, i) => `- card ${i}`).join("\n");
  await open(page, `# Big ::stopwatch{at=1m5s} tail\n\nwords\n\n:::kanban{}\n## To do\n${cards}\n:::\n`);
  await fonts(page);
  await line(page, "words").click();
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await expect(source(page)).toHaveText("::stopwatch{at=1m5s}");
  const [text, rows, plain] = [await boxOf(source(page)), await boxOf(sourceRows(page)), await boxOf(line(page, "words"))];
  expect({ y: text.y, height: text.height }).toEqual({ y: rows.y, height: rows.height });
  expect(rows.height).toBeLessThan(plain.height);
  await expect.poll(() => source(page).evaluate((el) => [...el.querySelectorAll("*")].map((child) => getComputedStyle(child).fontSize))).toEqual(await source(page).evaluate((el) => [...el.querySelectorAll("*")].map(() => getComputedStyle(el).fontSize)));

  // The board is taller than the window, so its foot is out of sight: its options are under their button.
  await editor(page).getByRole("button", { name: "Options for Kanban board" }).click();
  const options = page.getByRole("dialog", { name: "Options for Kanban board" });
  await expect(options.getByRole("radiogroup", { name: "To do colour" })).toBeVisible();
  await expect(options).toBeInViewport({ ratio: 1 });
  const [panel, button] = [await boxOf(options), await boxOf(editor(page).getByRole("button", { name: "Options for Kanban board" }))];
  expect(panel.y).toBeGreaterThanOrEqual(button.y + button.height);
  expect(panel.y - (button.y + button.height)).toBeLessThan(8);
});

test("with vim on, j and k go into each of two boards that have no line between them, and into a board that ends the note from its first line", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: "plain\n:::kanban{}\n## One\n:::\n:::kanban{}\n## Two\n- last\n:::" });
  await page.goto(`/note/${note.id}`);
  await expect(column(page, "Two")).toBeVisible();
  const cursor = page.locator(".cm-fat-cursor");
  const at = () => page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent);
  await line(page, "plain").click();
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await page.keyboard.press("0");

  const down = [":::kanban{}", "## One", ":::", ":::kanban{}", "## Two", "- last", ":::"];
  for (const text of down) {
    await page.keyboard.press("j");
    await expect.poll(at).toBe(text);
  }
  await expect(cursor).toHaveText(":");
  for (const text of [...down].reverse().slice(1)) {
    await page.keyboard.press("k");
    await expect.poll(at).toBe(text);
  }
  await page.keyboard.press("k");
  await expect.poll(at).toBe("plain");
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);
  await expect(column(page, "One")).toBeVisible();
});
