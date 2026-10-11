import { expect, test, type Locator, type Page } from "@playwright/test";
import { perform, signInAsNewPerson } from "./helpers.ts";
import { openPlugins } from "./plugins-helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const lines = (page: Page) => page.locator(".cm-line");
const menu = (page: Page) => page.getByRole("listbox");
// A list still waiting on what was just typed is shown, but no key picks from it: these are its items once it has caught up.
const options = (page: Page) => page.locator(".cm-tooltip-autocomplete:not(.cm-tooltip-autocomplete-disabled)").getByRole("option");
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const authors = async (page: Page, id: string) => (await perform(page, { type: "note.history", id })).map((c) => `${c.author.kind} ${c.author.name}`);
const column = (page: Page, name: string) => editor(page).getByRole("region", { name, exact: true });
const cards = (within: Locator) => within.getByRole("listitem");
const board = async (page: Page) => Object.fromEntries(await Promise.all((await editor(page).getByRole("region").all()).map(async (c) => [await c.getAttribute("aria-label"), await cards(c).locator(".kanban-card-text").allTextContents()])));

/** Signs in and opens a note with this text, with the cursor at its end. */
async function open(page: Page, text: string, settings?: Record<string, unknown>) {
  await signInAsNewPerson(page, "Ada Lovelace");
  if (settings) await perform(page, { type: "settings.write", text: JSON.stringify(settings), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!);
  // Not a click, which could land on a drawn embed and leave the cursor where it was.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return note;
}

/**
 * Time for the list to have caught up with the last key: it is asked again on the turn after a key
 * and drawn on the frame after that. Until then it doesn't take Enter, and one that is about to
 * open hasn't. No hand leaves less than this between two keys.
 */
const settled = (page: Page) => page.evaluate(() => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), 50)));

/** Types what opens a list at the cursor, and waits for the list. */
async function slash(page: Page, typed: string) {
  await page.keyboard.type(typed);
  await expect(menu(page)).toBeVisible();
  await settled(page);
}

/** Drags with the mouse in steps, as a hand does: a drag starts only once the pointer has moved a little with the button down. */
async function drag(page: Page, from: Locator, to: Locator, at: { x: number; y: number } = { x: 30, y: 30 }) {
  const [a, b] = [(await from.boundingBox())!, (await to.boundingBox())!];
  await page.mouse.move(a.x + 20, a.y + 10);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 20, { steps: 5 });
  await page.mouse.move(b.x + at.x, b.y + at.y, { steps: 10 });
  await page.mouse.up();
}

/** Asks for a board's markdown from its options, which is the only way to it. */
async function editAsMarkdown(page: Page) {
  await editor(page).getByRole("button", { name: "Options for Kanban board" }).click();
  await page.getByRole("dialog", { name: "Options for Kanban board" }).getByRole("button", { name: "Edit as markdown" }).click();
}

const BOARD = "# Plan\n\n:::kanban{}\n## To do\n- write\n- review\n\n## Doing\n- build\n\n## Done\n:::\n\nAfter the board.\n";

test("/ opens the embed menu, typing filters it, and picking a timer writes it with its length ready to type over", async ({ page }) => {
  const note = await open(page, "# Tea\n\n");

  await page.keyboard.type("/");
  await expect(options(page)).toHaveText([/^Timer/, /^Stopwatch/, /^Kanban board/, /^YouTube video/, /^Social post/, /^Link/, /^HTML/]);
  await expect(options(page).nth(0)).toContainText("::timer{5m}");
  await expect(options(page).nth(2)).toContainText(":::kanban{}");
  await page.keyboard.type("st");
  await expect(options(page)).toHaveText([/^Stopwatch/, /^Social post/]);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("tim");
  await expect(options(page)).toHaveText([/^Timer/]);
  await settled(page);
  await page.keyboard.press("Enter");
  await expect(menu(page)).toHaveCount(0);
  // The timer is drawn at once, and with the cursor in it the line shows it as written after the drawing.
  await expect(lines(page).nth(2)).toHaveText("5:00::timer{5m}");

  await page.keyboard.type("10m");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" steep");
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\n::timer{10m} steep");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(editor(page).getByRole("button", { name: "Timer, 10:00 left" })).toBeVisible();
});

test("the menu is moved through with the arrow keys, picked from with a click, and closed with Escape or a space", async ({ page }) => {
  const note = await open(page, "# Tea\n\n");

  await slash(page, "/");
  await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await page.keyboard.type(" then ");
  await expect(lines(page).nth(2)).toHaveText("0:00 then ");

  await slash(page, "/");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await slash(page, "x /");
  await page.keyboard.type(" y /zzz");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(" /");
  await options(page).filter({ hasText: "Timer" }).click();
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\n::stopwatch{} then /x / y /zzz ::timer{5m}");
});

test("/ in the middle of a word, in a URL, in a path, or in code opens nothing", async ({ page }) => {
  const note = await open(page, "# Paths\n\n");

  for (const typed of ["and/or", " https://example.com/t", " src/web/t", " 10/10"]) {
    await page.keyboard.type(typed);
    await expect(lines(page).nth(2)).toContainText(typed.trim());
    await settled(page);
    await expect(menu(page)).toHaveCount(0);
  }
  await page.keyboard.type(" `code `");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("/t");
  await settled(page);
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\n```\n/t");
  await expect(lines(page).last()).toHaveText("/t");
  await settled(page);
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type("\n```\n/ti");
  await expect(options(page)).toHaveText([/^Timer/, /^YouTube video/, /^Social post/]);
  await page.keyboard.press("Escape");
  await expect.poll(() => read(page, note.id)).toBe("# Paths\n\nand/or https://example.com/t src/web/t 10/10 `code /t`\n\n```\n/t\n```\n/ti");
});

test("picking a kanban board writes its block on lines of its own and draws it, with the cursor on the line after", async ({ page }) => {
  const note = await open(page, "# Plan\n\nBoard: ");

  await slash(page, "/kan");
  await expect(options(page)).toHaveText([/^Kanban board/]);
  await page.keyboard.press("Enter");
  await expect(editor(page).getByRole("region")).toHaveCount(3);
  expect(await board(page)).toEqual({ "To do": [], Doing: [], Done: [] });
  await page.keyboard.type("after");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\nBoard: \n:::kanban{}\n## To do\n\n## Doing\n\n## Done\n:::\nafter");
});

test("a kanban block draws a column for each heading and a card for each list item, shows its markdown under the board to be edited, and is only markdown with its plugin off", async ({ page }) => {
  const note = await open(page, BOARD);

  expect(await board(page)).toEqual({ "To do": ["write", "review"], Doing: ["build"], Done: [] });
  await expect(editor(page)).not.toContainText(":::kanban{}");
  await expect(editor(page)).toContainText("After the board.");

  // The arrow keys go through the board's cards and never into its hidden lines, so what is typed after them lands above the board.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(editor(page).getByRole("button", { name: "Add a card to To do" })).toBeFocused();
  for (const card of ["review", "write"]) {
    await page.keyboard.press("ArrowUp");
    await expect(column(page, "To do").getByRole("listitem").filter({ hasText: card })).toBeFocused();
  }
  await page.keyboard.press("ArrowUp");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type("above");
  await expect(lines(page).nth(1)).toHaveText("above");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.type("below ");
  await expect(editor(page)).toContainText("below After the board.");
  await expect(editor(page)).not.toContainText(":::kanban{}");

  await editAsMarkdown(page);
  await expect(lines(page)).toContainText([":::kanban{}", "## To do", "- write"]);
  await expect(editor(page).getByRole("region")).toHaveCount(3);
  await page.keyboard.press("End");
  await page.keyboard.type("\n- first");
  expect(await board(page)).toEqual({ "To do": ["first", "write", "review"], Doing: ["build"], Done: [] });
  await page.keyboard.press("ControlOrMeta+End");
  await expect(editor(page)).not.toContainText(":::kanban{}");
  expect(await board(page)).toEqual({ "To do": ["first", "write", "review"], Doing: ["build"], Done: [] });
  await expect.poll(() => read(page, note.id)).toBe(BOARD.replace("# Plan\n\n", "# Plan\nabove\n").replace("## To do\n", "## To do\n- first\n").replace("After the board.", "below After the board."));

  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Disable plugin: Kanban");
  await page.keyboard.press("Enter");
  await expect(editor(page).getByRole("region")).toHaveCount(0);
  await expect(lines(page)).toContainText([":::kanban{}", "## To do", "- first"]);
});

test("moving a card with the keyboard rewrites the markdown, is recorded as the member's change, and is undone like typing", async ({ page }) => {
  const note = await open(page, BOARD);
  const write = (name: string) => column(page, name).getByRole("listitem").filter({ hasText: "write" });
  const start = { "To do": ["write", "review"], Doing: ["build"], Done: [] };

  // Undone before it is saved, it is taken back in the editor and never recorded.
  await write("To do").focus();
  await page.keyboard.press("Shift+ArrowRight");
  expect(await board(page)).toEqual({ "To do": ["review"], Doing: ["write", "build"], Done: [] });
  await page.keyboard.press("ControlOrMeta+z");
  expect(await board(page)).toEqual(start);
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect(await authors(page, note.id)).toEqual(["member Ada Lovelace"]);

  await write("To do").focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(write("Doing")).toBeFocused();
  const moved = BOARD.replace("- write\n- review\n\n## Doing\n- build\n", "- review\n\n## Doing\n- write\n- build\n");
  await expect.poll(() => read(page, note.id)).toBe(moved);
  expect(await authors(page, note.id)).toEqual(["member Ada Lovelace", "member Ada Lovelace"]);

  // Undone once saved, it is taken back through the note's history, as saved typing is.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => board(page)).toEqual(start);
  await expect.poll(() => read(page, note.id)).toBe(BOARD);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => read(page, note.id)).toBe(moved);
  await expect.poll(() => board(page)).toEqual({ "To do": ["review"], Doing: ["write", "build"], Done: [] });

  await write("Doing").focus();
  await page.keyboard.press("Shift+ArrowDown");
  expect(await board(page)).toEqual({ "To do": ["review"], Doing: ["build", "write"], Done: [] });
  await page.keyboard.press("Shift+ArrowRight");
  expect(await board(page)).toEqual({ "To do": ["review"], Doing: ["build"], Done: ["write"] });
  await page.keyboard.press("ArrowLeft");
  await expect(column(page, "Doing").getByRole("listitem").filter({ hasText: "build" })).toBeFocused();
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n:::kanban{}\n## To do\n- review\n\n## Doing\n- build\n\n## Done\n- write\n:::\n\nAfter the board.\n");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));
});

test("dragging a card to another column, and to a place among its cards, rewrites the markdown", async ({ page }) => {
  const note = await open(page, BOARD);

  await drag(page, column(page, "To do").getByRole("listitem").filter({ hasText: "review" }), column(page, "Done"));
  expect(await board(page)).toEqual({ "To do": ["write"], Doing: ["build"], Done: ["review"] });
  await drag(page, column(page, "To do").getByRole("listitem").filter({ hasText: "write" }), column(page, "Doing").getByRole("listitem").filter({ hasText: "build" }), { x: 20, y: 2 });
  expect(await board(page)).toEqual({ "To do": [], Doing: ["write", "build"], Done: ["review"] });
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n:::kanban{}\n## To do\n\n## Doing\n- write\n- build\n\n## Done\n- review\n:::\n\nAfter the board.\n");
});

test("a card is added from the board, and what the board doesn't understand stays in the note", async ({ page }) => {
  const body = "intro words\n## To do\n\nA paragraph.\n\n- write\n  - the intro\n\n```\n## not a column\n```\n## Done\n";
  const note = await open(page, `# Plan\n\n:::kanban{keep=me}\n${body}:::\n`);

  expect(await board(page)).toEqual({ "To do": ["write"], Done: [] });
  await expect(column(page, "To do").getByRole("listitem")).toContainText("- the intro");
  await editor(page).getByRole("button", { name: "Add a card to Done" }).click();
  await page.keyboard.type("ship");
  await page.keyboard.press("Enter");
  expect(await board(page)).toEqual({ "To do": ["write"], Done: ["ship"] });
  await expect(editor(page).getByRole("button", { name: "Add a card to Done" })).toBeFocused();

  await column(page, "To do").getByRole("listitem").focus();
  await page.keyboard.press("Shift+ArrowRight");
  expect(await board(page)).toEqual({ "To do": [], Done: ["write", "ship"] });
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n:::kanban{keep=me}\nintro words\n## To do\n\nA paragraph.\n\n\n```\n## not a column\n```\n## Done\n- write\n  - the intro\n- ship\n:::\n");
});

test("a card moved while the member has typed elsewhere, and after someone else's change lands, keeps every word of each", async ({ page }) => {
  const note = await open(page, BOARD);

  await page.keyboard.type("Typed by Ada.");
  await column(page, "Doing").getByRole("listitem").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await board(page)).toEqual({ "To do": ["build", "write", "review"], Doing: [], Done: [] });
  const mine = "# Plan\n\n:::kanban{}\n## To do\n- build\n- write\n- review\n\n## Doing\n\n## Done\n:::\n\nAfter the board.\nTyped by Ada.";
  await expect.poll(() => read(page, note.id)).toBe(mine);

  // Another tab or an agent rewrites the top of the note and adds a card, while the board is drawn from what was there before.
  const { revision } = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, baseRevision: revision, text: mine.replace("# Plan\n", "# Plan\n\nA much longer opening, written elsewhere.\n").replace("## Done\n", "## Done\n- shipped\n") });
  await expect(column(page, "Done").getByRole("listitem")).toHaveText(["shipped"], { timeout: 20_000 });
  await column(page, "Done").getByRole("listitem").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" And more.");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\nA much longer opening, written elsewhere.\n\n:::kanban{}\n## To do\n- build\n- write\n- review\n\n## Doing\n- shipped\n\n## Done\n:::\n\nAfter the board.\nTyped by Ada. And more.");
});

test("a timer's time is kept in the note: it runs on through a reload, pauses, and resets, each as the member's change", async ({ page }) => {
  const note = await open(page, "# Tea\n\nSteep ::timer{5m} then pour.\n");
  const timer = editor(page).getByRole("button", { name: /^Timer/ });
  const reset = editor(page).getByRole("button", { name: "Reset timer" });

  await expect(timer).toHaveText("5:00");
  await expect(reset).toBeDisabled();
  await timer.click();
  await expect(timer).toHaveAttribute("aria-pressed", "true");
  await expect(timer).toBeFocused();
  await expect.poll(() => read(page, note.id)).toMatch(/^# Tea\n\nSteep ::timer\{5m since=20\d\d-\d\d-\d\dT[\d:.]+Z\} then pour\.\n$/);
  await expect(timer).toHaveText(/^4:5[0-8]$/);

  await page.reload();
  await expect(timer).toHaveAttribute("aria-pressed", "true");
  await expect(timer).toHaveText(/^4:[0-5]\d$/);

  await timer.click();
  await expect(timer).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => read(page, note.id)).toMatch(/^# Tea\n\nSteep ::timer\{5m at=\d+s\} then pour\.\n$/);
  const paused = await timer.textContent();
  await reset.click();
  await expect(timer).toHaveText("5:00");
  expect(paused).toMatch(/^4:[0-5]\d$/);
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\nSteep ::timer{5m} then pour.\n");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));
});

test("a timer that has run its length says so, and one that can't be read says how to write it", async ({ page }) => {
  await open(page, "# Tea\n\nDone ::timer{5m since=2020-01-01T00:00:00.000Z} and unread ::timer{soon} and ::timer{}.\n");

  await expect(editor(page).getByRole("button", { name: "Timer, finished" })).toHaveText("0:00");
  await expect(lines(page).nth(2)).toContainText("unread Timer: write it like ::timer{5m} and Timer: write it like ::timer{5m}.");
  await editor(page).getByRole("button", { name: "Timer, finished" }).click();
  await expect(editor(page).getByRole("button", { name: "Timer, 5:00 left" })).toBeVisible();
  await openPlugins(page);
  await expect(page.getByRole("checkbox", { name: "Timer", exact: true })).toBeChecked();
  await expect(page.getByRole("list", { name: "Plugins" }).getByRole("alert")).toHaveCount(0);
});

test("with vim on, / opens the embed menu in insert mode and is vim's search in normal mode", async ({ page }) => {
  const note = await open(page, "# Tea\n\nsteep", { "vim.enabled": true });
  const statusLine = page.locator(".cm-vim-panel");
  await expect(statusLine).toHaveText("--NORMAL--");

  await page.keyboard.press("/");
  await expect(menu(page)).toHaveCount(0);
  await expect(statusLine.locator("input")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.keyboard.press("A");
  await expect(statusLine).toHaveText("--INSERT--");
  await page.keyboard.type(" /");
  await expect(options(page)).toHaveText([/^Timer/, /^Stopwatch/, /^Kanban board/, /^YouTube video/, /^Social post/, /^Link/, /^HTML/]);
  await page.keyboard.type("sto");
  await expect(options(page)).toHaveText([/^Stopwatch/, /^Social post/]);
  await settled(page);
  await page.keyboard.press("Enter");
  await expect(statusLine).toHaveText("--INSERT--");
  await slash(page, " go /");
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(statusLine).toHaveText("--NORMAL--");
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\nsteep ::stopwatch{} go /");
});

test("with vim on, j and k go through a board's cards and never into its hidden lines, and the board is still drawn", async ({ page }) => {
  await open(page, BOARD, { "vim.enabled": true });
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");

  await page.keyboard.press("g");
  await page.keyboard.press("g");
  // Down from the title: the blank line, the board's first column from its top to "Add a card", the blank line past the board, then the words after it.
  for (const key of ["j", "j"]) await page.keyboard.press(key);
  await expect(column(page, "To do").getByRole("listitem").filter({ hasText: "write" })).toBeFocused();
  for (const key of ["j", "j", "j", "j"]) await page.keyboard.press(key);
  await expect(page.locator(".cm-fat-cursor")).toHaveText("A");
  await expect(editor(page)).not.toContainText(":::kanban{}");
  for (const key of ["k", "k"]) await page.keyboard.press(key);
  await expect(editor(page).getByRole("button", { name: "Add a card to To do" })).toBeFocused();
  for (const key of ["k", "k", "k", "k"]) await page.keyboard.press(key);
  await expect(page.locator(".cm-fat-cursor")).toHaveText("#");
  await expect(editor(page)).not.toContainText(":::kanban{}");
  await page.keyboard.press("i");
  await page.keyboard.type("top ");
  await expect(lines(page).nth(0)).toHaveText("top # Plan");
  expect(await board(page)).toEqual({ "To do": ["write", "review"], Doing: ["build"], Done: [] });
});

test("the embed menu lists only the embeds of plugins that are on, and is gone with its own plugin off", async ({ page }) => {
  await open(page, "# Tea\n\n", { "timer.enabled": false });

  await page.keyboard.type("/");
  await expect(options(page)).toHaveText([/^Stopwatch/, /^Kanban board/, /^YouTube video/, /^Social post/, /^Link/, /^HTML/]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.getByRole("combobox", { name: "Commands" }).fill("Disable plugin: Embed menu");
  await page.keyboard.press("Enter");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" /");
  await expect(lines(page).last()).toContainText("/");
  await expect(menu(page)).toHaveCount(0);
});

test("an embed's rewrite does nothing once the note says something else of it, and one that would break out of the embed is refused", async ({ page }) => {
  await page.addInitScript(() => {
    type Handle = { config: string; update(next: { config?: string; body?: string }): void };
    const handles: Handle[] = ((window as unknown as { __INK_HANDLES__: Handle[] }).__INK_HANDLES__ = []);
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Counter fixture",
        activate(host: { embeds: { register(embed: unknown): void } }) {
          host.embeds.register({ name: "count", title: "Counter", render: (el: HTMLElement, embed: Handle) => (handles.push(embed), void (el.textContent = `count ${embed.config}`)) });
        },
      },
    ];
  });
  const update = (which: number, next: { config?: string; body?: string }) =>
    page.evaluate(([at, to]) => {
      try {
        (window as unknown as { __INK_HANDLES__: { update(next: unknown): void }[] }).__INK_HANDLES__.at(at)!.update(to);
        return "done";
      } catch (err) {
        return (err as Error).message;
      }
    }, [which, next] as const);
  const note = await open(page, "# Counts\n\nFirst ::count{1} and second ::count{1}.\n\nwords");
  await expect(lines(page).nth(2)).toHaveText("First count 1 and second count 1.");

  expect(await update(0, { config: "2" })).toBe("done");
  await expect(lines(page).nth(2)).toHaveText("First count 2 and second count 1.");
  // The first drawing was of ::count{1}, which the note no longer says there.
  expect(await update(0, { config: "9" })).toBe("done");
  await page.keyboard.type(" typed");
  await expect.poll(() => read(page, note.id)).toBe("# Counts\n\nFirst ::count{2} and second ::count{1}.\n\nwords typed");

  expect(await update(-1, { config: "3} ::count{4" })).toContain("config");
  expect(await update(-1, { config: "3\n" })).toContain("config");
  expect(await update(-1, { body: "a body" })).toContain("block");
  expect(await update(-1, { config: "3" })).toBe("done");
  await expect.poll(() => read(page, note.id)).toBe("# Counts\n\nFirst ::count{3} and second ::count{1}.\n\nwords typed");
});

test("a completion that throws offers nothing, typing carries on, and the Plugins page says what failed", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Broken fixture",
        activate(host: { completions: { register(completion: unknown): void } }) {
          host.completions.register({
            id: "people",
            trigger: "@",
            items: (typed: string) => {
              if (typed === "x") throw new Error("The people list broke");
              return [{ label: "Ada Lovelace", insert: "@ada" }];
            },
          });
        },
      },
    ];
  });
  const note = await open(page, "# People\n\n");

  await slash(page, "ask @");
  await expect(options(page)).toHaveText(["Ada Lovelace"]);
  await page.keyboard.type("x");
  await expect(menu(page)).toHaveCount(0);
  await slash(page, " ada@example.com and @");
  await expect(options(page)).toHaveText(["Ada Lovelace"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe("# People\n\nask @x ada@example.com and @ada");
  await openPlugins(page);
  await expect(page.getByRole("list", { name: "Plugins" }).getByRole("listitem").filter({ hasText: "Broken fixture" }).getByRole("alert")).toContainText("The people list broke");
});

test("an embed's name typed after / without a pause and then Enter writes the embed", async ({ page }) => {
  const note = await open(page, "# Tea\n\n");

  // A fast typist's keys are some 20 ms apart, so Enter comes 120 ms after the /.
  await page.keyboard.type("/timer\n", { delay: 20 });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" and /kan\n", { delay: 20 });
  await page.keyboard.type("/sto\n", { delay: 20 });
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\n::timer{5m} and \n:::kanban{}\n## To do\n\n## Doing\n\n## Done\n:::\n::stopwatch{}");
});

test("a member who can't change the note sees its embeds without their controls, and nothing they do in the editor changes it", async ({ page }) => {
  // There is no way to be made a viewer of a workspace before #14, so the app is told this member is one. The server would refuse a viewer's write; what is checked here is that the app sends none.
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const me = await response.json();
    await route.fulfill({ response, json: { ...me, workspaces: me.workspaces.map((w: object) => ({ ...w, role: "viewer" })) } });
  });
  const writes: string[] = [];
  page.on("request", (request) => request.url().endsWith("/ops") && /"note\.(write|undo|redo)"/.test(request.postData() ?? "") && writes.push(request.postData()!));
  const written = `# Plan\n\nSteep ::timer{5m} and ::stopwatch{at=5s} and ::timer{9m since=${new Date().toISOString()}}\n\n:::kanban{}\n## To do\n- write\n\n## Done\n:::\n\nwords`;
  await signInAsNewPerson(page, "Vera Viewer");
  const note = await perform(page, { type: "note.create", text: written });
  await page.goto(`/note/${note.id}`);

  await expect(page.getByRole("button", { name: "Vera's workspace Viewer" })).toBeVisible();
  await expect(column(page, "Done")).toBeVisible();
  expect(await board(page)).toEqual({ "To do": ["write"], Done: [] });
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  const clocks = editor(page).getByRole("button", { name: /^(Timer|Stopwatch)/ });
  await expect(clocks).toHaveText(["5:00", "0:05", /^8:\d\d$/]);
  for (const clock of await clocks.all()) await expect(clock).toBeDisabled();
  await expect(editor(page).getByRole("button", { name: /Reset|Start|Add a card|Edit as markdown|Options|Colour/ })).toHaveCount(0);
  const card = column(page, "To do").getByRole("listitem");
  await expect(card).not.toHaveAttribute("draggable");

  await card.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await drag(page, card, column(page, "Done"));
  await lines(page).last().click();
  await page.keyboard.type(" typed /");
  await page.keyboard.press("ControlOrMeta+z");
  await page.evaluate(() => (document.querySelector(".cm-content") as HTMLElement).focus());
  await page.keyboard.type("more");
  await page.keyboard.press("Backspace");
  expect(await board(page)).toEqual({ "To do": ["write"], Done: [] });
  await expect(lines(page).last()).toHaveText("words");
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await settled(page);
  expect(writes).toEqual([]);

  // What someone else writes still reaches the editor. That write, made here, is the only one the page sent.
  await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: written.replace("words", "words from an editor") });
  await expect(lines(page).last()).toHaveText("words from an editor", { timeout: 20_000 });
  expect(writes).toHaveLength(1);
  expect(await authors(page, note.id)).toHaveLength(2);
});

test("completions whose triggers both fit share one list, in the order of their plugins", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
      {
        id: "fixture",
        name: "Snippets fixture",
        activate(host: { completions: { register(completion: unknown): void } }) {
          host.completions.register({ id: "snippets", trigger: "/", items: (typed: string) => ["Signature", "Standup notes", "Thanks"].filter((s) => s.toLowerCase().startsWith(typed.toLowerCase())).map((label) => ({ label, insert: `<${label}>` })) });
        },
      },
    ];
  });
  const note = await open(page, "# Tea\n\n");

  await slash(page, "/");
  await expect(options(page)).toHaveText([/^Timer/, /^Stopwatch/, /^Kanban board/, /^YouTube video/, /^Social post/, /^Link/, /^HTML/, "Signature", "Standup notes", "Thanks"]);
  await page.keyboard.type("st");
  await expect(options(page)).toHaveText([/^Stopwatch/, /^Social post/, "Standup notes"]);
  await settled(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type(" /tim");
  await expect(options(page)).toHaveText([/^Timer/]);
  await settled(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe("# Tea\n\n<Standup notes> ::timer{5m}");
});

/** A fixture embed that writes its config in capitals, rewriting itself as it is drawn, and keeps every handle it was given. */
const shout = () => {
  type Handle = { config: string; update(next: { config?: string }): void };
  const handles: Handle[] = ((window as unknown as { __INK_HANDLES__: Handle[] }).__INK_HANDLES__ = []);
  (window as unknown as { __INK_FIXTURE_PLUGINS__: unknown[] }).__INK_FIXTURE_PLUGINS__ = [
    {
      id: "fixture",
      name: "Shout fixture",
      activate(host: { embeds: { register(embed: unknown): void } }) {
        host.embeds.register({
          name: "shout",
          title: "Shout",
          render(el: HTMLElement, embed: Handle) {
            handles.push(embed);
            el.textContent = `shout ${embed.config}`;
            if (embed.config !== embed.config.toUpperCase()) embed.update({ config: embed.config.toUpperCase() });
          },
        });
      },
    },
  ];
};

test("an embed that rewrites itself while being drawn is rewritten right after", async ({ page }) => {
  await page.addInitScript(shout);
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Loud\n\nthen ::shout{hi} and ::shout{there}\n\nwords" });
  await page.goto(`/note/${note.id}`);

  await expect(lines(page).nth(2)).toHaveText("then shout HI and shout THERE");
  await expect.poll(() => read(page, note.id)).toBe("# Loud\n\nthen ::shout{HI} and ::shout{THERE}\n\nwords");
});

test("a handle kept past its drawing changes nothing, though an embed just like it is written at the start of the note", async ({ page }) => {
  await page.addInitScript(shout);
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "::shout{HI} and ::shout{HI} end\n\nwords" });
  await page.goto(`/note/${note.id}`);
  await expect(lines(page).nth(0)).toHaveText("shout HI and shout HI end");

  // With the cursor on it the second embed is shown as written, so its drawing is gone, and the handle it was given with it.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await expect(lines(page).nth(0)).toHaveText("shout HI and ::shout{HI} end");
  await page.evaluate(() => (window as unknown as { __INK_HANDLES__: { update(next: { config?: string }): void }[] }).__INK_HANDLES__[1]!.update({ config: "GONE" }));
  await expect(lines(page).nth(0)).toHaveText("shout HI and ::shout{HI} end");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" typed");
  await expect.poll(() => read(page, note.id)).toBe("::shout{HI} and ::shout{HI} end\n\nwords typed");
});

test("a card half typed into Add a card is still there, with the cursor, after someone else's change draws the board again", async ({ page }) => {
  const note = await open(page, BOARD);

  await editor(page).getByRole("button", { name: "Add a card to Doing" }).click();
  await page.keyboard.type("half a");
  await perform(page, { type: "note.write", id: note.id, baseRevision: 1, text: BOARD.replace("## Done\n", "## Done\n- shipped\n") });
  await expect(column(page, "Done").getByRole("listitem")).toHaveText(["shipped"], { timeout: 20_000 });
  const adding = editor(page).getByRole("textbox", { name: "New card in Doing" });
  await expect(adding).toHaveValue("half a");
  await expect(adding).toBeFocused();
  await page.keyboard.type(" thought");
  await page.keyboard.press("Enter");
  expect(await board(page)).toEqual({ "To do": ["write", "review"], Doing: ["build", "half a thought"], Done: ["shipped"] });
  await expect(editor(page).getByRole("textbox", { name: "New card in Doing" })).toHaveCount(0);
  await expect.poll(() => read(page, note.id)).toBe(BOARD.replace("- build\n", "- build\n- half a thought\n").replace("## Done\n", "## Done\n- shipped\n"));
});
