import { expect, test, type Page } from "@playwright/test";
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

test("a running stopwatch is the same element, in the same place, still counting, with the cursor on its line, through it, and typing around it", async ({ page }) => {
  const note = await open(page, "# Laps\n\nbefore\nLap ::stopwatch{} here.\nafter\n");
  await editor(page).getByRole("button", { name: "Start stopwatch" }).click();
  await expect(editor(page).getByRole("button", { name: "Stop stopwatch" })).toBeVisible();
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThanOrEqual(1);
  await mark(page);
  const at = await place(page, ".embed");
  const rows = { line: await line(page, "Lap").boundingBox(), after: await line(page, "after").boundingBox() };

  await line(page, "Lap").click({ position: { x: 2, y: 5 } });
  const started = Date.now();
  // Right through the whole line, a character at a time: onto the embed, through it as written, and off its far end.
  const written = (await read(page, note.id)).split("\n")[3]!;
  for (let i = 0; i < written.length; i++) {
    await page.keyboard.press("ArrowRight");
    expect(await marked(page)).toEqual({ same: true, removed: 0 });
    expect(await place(page, ".embed")).toEqual(at);
  }
  await expect(line(page, "Lap")).not.toContainText("::stopwatch");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  // With the cursor in it, the line shows the embed as the note writes it, after the drawing, and the rows keep their place and height.
  await expect(line(page, "Lap")).toContainText(/^Lap \d:\d\d::stopwatch\{since=[^}]+\} here\.$/);
  expect(await place(page, ".embed")).toEqual(at);
  expect({ line: await line(page, "Lap").boundingBox(), after: await line(page, "after").boundingBox() }).toEqual(rows);

  await page.keyboard.press("ArrowUp");
  await page.keyboard.type(" typed above");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type(" typed below");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" And on its own line.");
  await expect.poll(() => read(page, note.id)).toMatch(/before typed above\nLap ::stopwatch\{since=[^}]+\} here\. And on its own line\.\nafter typed below\n/);
  expect(await marked(page)).toEqual({ same: true, removed: 0 });
  expect(await place(page, ".embed")).toEqual(at);

  // It never stopped: it shows at least the time that has gone by since the cursor first came, and is still running.
  const gone = Math.floor((Date.now() - started) / 1000);
  expect(gone).toBeGreaterThanOrEqual(1);
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThanOrEqual(1 + gone);
  await expect(editor(page).getByRole("button", { name: /^Stopwatch, / })).toHaveAttribute("aria-pressed", "true");
  const now = await seconds(page, /^Stopwatch, /);
  await expect.poll(() => seconds(page, /^Stopwatch, /)).toBeGreaterThan(now);
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
  expect(await says(stopwatch)).toEqual(["0:00", "Start", "Reset (off)"]);
  expect(await says(timer)).toEqual(["5:00", "Start", "Reset (off)"]);
  const width = (await timer.boundingBox())!.width;

  await timer.getByRole("button", { name: "Start timer" }).click();
  await expect(timer.getByRole("button", { name: "Pause timer" })).toBeFocused();
  expect((await says(timer)).slice(1)).toEqual(["Pause", "Reset"]);
  await expect.poll(() => read(page, note.id)).toMatch(/::timer\{5m since=[^}]+\}/);
  await timer.getByRole("button", { name: "Pause timer" }).click();
  await expect.poll(() => read(page, note.id)).toMatch(/::timer\{5m at=\d+s\}|::timer\{5m\}/);
  expect((await says(timer)).slice(1)).toEqual(["Start", "Reset"]);
  await timer.getByRole("button", { name: "Reset timer" }).click();
  await expect.poll(() => read(page, note.id)).toContain("::timer{5m}");
  expect(await says(timer)).toEqual(["5:00", "Start", "Reset (off)"]);
  expect((await timer.boundingBox())!.width).toBe(width);

  await stopwatch.getByRole("button", { name: "Start stopwatch" }).click();
  expect((await says(stopwatch)).slice(1)).toEqual(["Stop", "Reset"]);
  await stopwatch.getByRole("button", { name: "Stop stopwatch" }).click();
  await stopwatch.getByRole("button", { name: "Reset stopwatch" }).click();
  await expect.poll(() => read(page, note.id)).toContain("::stopwatch{} and");
  // What the buttons say is not text in the line: the time is all a clock adds to it.
  await expect(line(page, "Lap")).toHaveText("Lap 0:00 and tea 5:00 here.");
});

test("an embed's options button opens its options, and setting one rewrites the embed as the member's change, where it stands", async ({ page }) => {
  const note = await open(page, "# Options\n\nTea ::timer{5m} and lap ::stopwatch{} here.\n\nlast\n");
  await mark(page);
  const at = await place(page, ".embed");

  await editor(page).getByRole("button", { name: "Options for Timer" }).click();
  const options = page.getByRole("dialog", { name: "Options for Timer" });
  await expect(options.getByRole("textbox", { name: "Length" })).toBeFocused();
  await expect(options.getByRole("textbox", { name: "Length" })).toHaveValue("5m");
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  await expect(options.getByRole("alert")).toHaveText("Write it like 25m, 1h30m or 90s.");
  expect(await read(page, note.id)).toContain("::timer{5m}");
  await options.getByRole("textbox", { name: "Length" }).fill("25m");
  await page.keyboard.press("Enter");
  await expect(editor(page).getByRole("button", { name: "Timer, 25:00 left" })).toBeVisible();
  await expect.poll(() => read(page, note.id)).toContain("Tea ::timer{25m} and");
  await expect(options.getByRole("textbox", { name: "Length" })).toHaveValue("25m");
  expect(await marked(page)).toEqual({ same: true, removed: 0 });
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

  // "Edit as markdown" puts the cursor in the embed as written, which is shown after the drawing that stays.
  await page.getByRole("dialog", { name: "Options for Stopwatch" }).getByRole("button", { name: "Edit as markdown" }).click();
  await expect(line(page, "Tea")).toContainText("::stopwatch{at=1m5s}");
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
  // With no menu open, Tab is not taken from the note.
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Tab");
  await expect.poll(() => read(page, note.id)).toMatch(/\n- one\n[ \t]+- two$/);
});

const BOARD = "# Board\n\nabove\n:::kanban{}\n## To do\n- write\n- review\n\n## Doing\n- build\n\n## Done\n:::\nbelow\n";

test("the arrow keys go from the line above into a board, through its cards, and out to the line below, and back up", async ({ page }) => {
  const note = await open(page, BOARD);
  await expect(column(page, "Done")).toBeVisible();
  const card = (name: string) => editor(page).getByRole("listitem").filter({ hasText: name });
  await line(page, "above").click();

  await page.keyboard.press("ArrowDown");
  await expect(card("write")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(card("review")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(card("build")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(editor(page).getByRole("button", { name: "Add a card to Done" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(editor(page).getByRole("button", { name: "Add a card to Doing" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(card("build")).toBeFocused();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(column(page, "Done").getByRole("listitem").filter({ hasText: "build" })).toBeFocused();
  await expect.poll(() => read(page, note.id)).toContain("## Doing\n\n## Done\n- build\n:::");
  await page.keyboard.press("ArrowDown");
  await expect(editor(page).getByRole("button", { name: "Add a card to Done" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("X");
  await expect.poll(() => read(page, note.id)).toContain(":::\nXbelow\n");
  // Nothing was shown as written on the way through.
  await expect(lines(page).filter({ hasText: ":::kanban" })).toHaveCount(0);

  await page.keyboard.press("ArrowUp");
  await expect(editor(page).getByRole("button", { name: "Add a card to To do" })).toBeFocused();
  for (const name of ["review", "write"]) {
    await page.keyboard.press("ArrowUp");
    await expect(card(name)).toBeFocused();
  }
  await page.keyboard.press("ArrowUp");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("Y");
  await expect.poll(() => read(page, note.id)).toContain("\naboveY\n:::kanban{}");
});

test("with vim on, j and k go into a board and out the other side, and h, l and Shift move through it and move cards", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: BOARD });
  await page.goto(`/note/${note.id}`);
  await expect(column(page, "Done")).toBeVisible();
  const card = (name: string) => editor(page).getByRole("listitem").filter({ hasText: name });
  await line(page, "above").click();
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");

  await page.keyboard.press("j");
  await expect(card("write")).toBeFocused();
  await page.keyboard.press("j");
  await expect(card("review")).toBeFocused();
  await page.keyboard.press("l");
  await expect(card("build")).toBeFocused();
  await page.keyboard.press("Shift+H");
  await expect(column(page, "To do").getByRole("listitem").filter({ hasText: "build" })).toBeFocused();
  await expect.poll(() => read(page, note.id)).toContain("## To do\n- build\n- write\n- review\n");
  for (let i = 0; i < 4; i++) await page.keyboard.press("j");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("X");
  await page.keyboard.press("Escape");
  await expect.poll(() => read(page, note.id)).toContain(":::\nXbelow\n");
  await page.keyboard.press("k");
  await expect(editor(page).getByRole("button", { name: "Add a card to To do" })).toBeFocused();
  for (let i = 0; i < 4; i++) await page.keyboard.press("k");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("i");
  await page.keyboard.type("Y");
  await expect.poll(() => read(page, note.id)).toMatch(/\nabov(Ye|eY)\n:::kanban\{\}/);
});

test("with vim on, a key pressed on a board's card is the board's and never a list's, and Ctrl-w still leaves the board for the lists beside it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  for (const name of ["Apple", "Zebra"]) await perform(page, { type: "folder.create", name });
  const note = await perform(page, { type: "note.create", text: BOARD });
  await page.goto(`/note/${note.id}`);
  await expect(column(page, "Done")).toBeVisible();
  await expect(page.locator("html[data-vim-keys]")).toHaveCount(1);
  const card = (name: string) => editor(page).getByRole("listitem").filter({ hasText: name });
  await line(page, "above").click();
  await page.keyboard.press("j");
  await expect(card("write")).toBeFocused();

  // A column's cards are a list with a name, which vim's list keys would otherwise move through, open and leave.
  for (const key of ["Shift+G", "g", "g", "Control+d", "/", "g", "t"]) await page.keyboard.press(key);
  await expect(card("write")).toBeFocused();
  await expect(page.locator("[data-vim-at]")).toHaveCount(0);
  await page.keyboard.press("j");
  await expect(card("review")).toBeFocused();
  await page.keyboard.press("l");
  await expect(card("build")).toBeFocused();
  await page.keyboard.press("h");
  await expect(card("write")).toBeFocused();
  await page.keyboard.press("Shift+L");
  await expect(column(page, "Doing").getByRole("listitem").filter({ hasText: "write" })).toBeFocused();
  await expect.poll(() => read(page, note.id)).toContain("## Doing\n- write\n- build\n");

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
  expect(await place(page, ".embed-block")).toEqual(board);

  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await column(page, "Doing").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dark).not.toBe(light);
  expect(dark).not.toBe(await column(page, "Done").evaluate((el) => getComputedStyle(el).backgroundColor));
  await page.emulateMedia({ colorScheme: "light" });

  // The board's options set it too, and take it away.
  await editor(page).getByRole("button", { name: "Options for Kanban board" }).click();
  const options = page.getByRole("dialog", { name: "Options for Kanban board" });
  await expect(options.getByRole("radiogroup", { name: "Doing colour" }).getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  await options.getByRole("radiogroup", { name: "Done colour" }).getByRole("radio", { name: "Green" }).click();
  await expect.poll(() => read(page, note.id)).toContain("## Done {.green}\n:::");
  await expect(options.getByRole("radiogroup", { name: "Done colour" }).getByRole("radio", { name: "Green" })).toHaveAttribute("aria-checked", "true");
  await options.getByRole("radiogroup", { name: "Doing colour" }).getByRole("radio", { name: "No colour" }).click();
  await expect.poll(() => read(page, note.id)).toContain("## Doing\n- build\n");

  await page.reload();
  await expect(column(page, "Done")).toHaveAttribute("data-colour", "green");
  await expect(column(page, "Doing")).not.toHaveAttribute("data-colour");
});

test("a key that jumps past a board doesn't go into it, and a half-typed card is a stop like any other", async ({ page }) => {
  const note = await open(page, "above\n:::kanban{}\n## To do\n- write\n:::\nbelow");
  await expect(column(page, "To do")).toBeVisible();
  await line(page, "above").click();
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toMatch(/\nbelow!$/);

  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowDown");
  await expect(editor(page).getByRole("listitem").filter({ hasText: "write" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("half");
  await page.keyboard.press("Shift+Tab");
  await expect(editor(page).getByRole("listitem").filter({ hasText: "write" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(editor(page).getByRole("textbox", { name: "New card in To do" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor(page).getByRole("button", { name: "Add a card to To do" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("X");
  await expect.poll(() => read(page, note.id)).toMatch(/- write\n:::\nXbelow!$/);
});
