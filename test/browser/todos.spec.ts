import { expect, test, type Locator, type Page } from "@playwright/test";
import { todosIn } from "../../src/core/todos.ts";
import { asViewerOfNote, connectAgent, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string | RegExp) => page.locator(".cm-line").filter({ hasText: text }).first();
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const authors = async (page: Page, id: string) => (await perform(page, { type: "note.history", id })).map((c) => `${c.author.kind} ${c.author.name}`);
const todosPage = (page: Page) => page.getByRole("region", { name: "Todos" });
const rows = (page: Page) => todosPage(page).getByRole("list", { name: "Todos" }).getByRole("listitem");
const row = (page: Page, text: string | RegExp) => rows(page).filter({ hasText: text });
/** The bar a query is typed in, and the builder Advanced opens under it. */
const bar = (page: Page) => todosPage(page).getByRole("searchbox", { name: "Filter todos" });
const advanced = (page: Page) => todosPage(page).getByRole("button", { name: "Advanced" });
const builder = (page: Page) => todosPage(page).getByRole("group", { name: "Advanced filter" });
const condition = (page: Page, n: number) => builder(page).getByRole("group", { name: `Condition ${n}` });
const problem = (page: Page) => todosPage(page).getByRole("status");
const words = (page: Page) => rows(page).locator(".todo-words > :first-child");
const cursorLine = (page: Page) => page.evaluate(() => getSelection()!.anchorNode?.parentElement?.closest(".cm-line")?.textContent);
const localDay = (page: Page, days = 0) =>
  page.evaluate((d) => {
    const at = new Date(Date.now() + d * 86_400_000);
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  }, days);

/** What a line shows: its text without the marks that are there but not painted. */
const shownIn = (el: Element) => {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let painted = true;
    for (let up = node.parentElement; up && up !== el.parentElement; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.opacity === "0" || style.visibility === "hidden") painted = false;
    }
    if (painted && !node.parentElement!.closest("select")) text += node.textContent;
  }
  return text;
};
/** What a todo's line shows after its list mark, which is drawn its own way by the outline. */
const expectShown = (of: Locator, text: string) => expect.poll(async () => (await of.evaluate(shownIn)).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")).toBe(text);

/** Signs in and opens a note with this text, with the cursor on its title. */
async function open(page: Page, text: string) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText(text.split("\n")[0]!.replace(/^# /, ""));
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+Home");
  return note;
}

const CHORES = "# Chores\n\n- [ ] !! Call the bank due:2031-10-14 +Home about the card\n- [x] Book flights +Trip\n- [ ] Plain one\n\n```\n- [ ] !!! in code due:2031-10-14 +Never\n```\n      - [ ] ! Deep one +Garden\n";

test("a todo's importance and due date are drawn as chips, on the lines the server takes for todos and no others, and a +Name is words", async ({ page }) => {
  const note = await open(page, CHORES);

  await expect(editor(page).getByRole("checkbox")).toHaveCount(4);
  await expect(editor(page).getByRole("combobox", { name: "Importance" })).toHaveCount(2);
  await expect(editor(page).getByLabel("Due date")).toHaveCount(1);
  await expect(editor(page).locator(".md-chip-sized")).toHaveCount(4 + 2 + 1);
  await expectShown(line(page, "Call the bank"), "!! Call the bank Oct 14, 2031 +Home about the card");
  await expectShown(line(page, "in code"), "[ ] !!! in code due:2031-10-14 +Never");
  // Indented as far as a code block is, and a todo all the same: the editor draws what the server lists.
  await expectShown(line(page, "Deep one"), "! Deep one +Garden");
  const listed = (await perform(page, { type: "todo.list", noteId: note.id, includeCompleted: true })).todos.map((t) => t.words);
  expect(listed.sort()).toEqual(["Book flights +Trip", "Call the bank +Home about the card", "Deep one +Garden", "Plain one"]);

  // The cursor on the todo's row, past its last word and on none of its tokens, changes nothing: every chip stays drawn.
  const bank = (await line(page, "Call the bank").boundingBox())!;
  await page.mouse.click(bank.x + bank.width - 3, bank.y + bank.height - 6);
  await expect.poll(() => cursorLine(page)).toContain("about the card");
  await page.keyboard.type("!");
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe("- [ ] !! Call the bank due:2031-10-14 +Home about the card!");
  await expectShown(line(page, "Call the bank"), "!! Call the bank Oct 14, 2031 +Home about the card!");
  await expect(editor(page).getByRole("checkbox")).toHaveCount(4);
});

test("changing a chip rewrites its token and nothing else, as the member's change, undone like typing", async ({ page }) => {
  const note = await open(page, CHORES);
  const bank = () => line(page, "Call the bank");
  const lineIn = async () => (await read(page, note.id)).split("\n")[2];

  await bank().getByRole("combobox", { name: "Importance" }).selectOption("!!!");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-10-14 +Home about the card");
  await bank().getByLabel("Due date").fill("2031-12-25");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-12-25 +Home about the card");
  await expectShown(bank(), "!!! Call the bank Dec 25, 2031 +Home about the card");
  await bank().getByRole("checkbox").click();
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Home about the card");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  // Taking an option away takes its token and the space before it, and undo puts both back.
  await bank().getByRole("combobox", { name: "Importance" }).selectOption("Normal");
  await expect.poll(lineIn).toBe("- [x] Call the bank due:2031-12-25 +Home about the card");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Home about the card");
  await bank().getByRole("combobox", { name: "Importance" }).selectOption("Normal");
  await bank().getByLabel("Due date").fill("");
  await expect.poll(lineIn).toBe("- [x] Call the bank +Home about the card");
  await expect.poll(async () => (await read(page, note.id)).replace("- [x] Call the bank +Home about the card", "- [ ] !! Call the bank due:2031-10-14 +Home about the card")).toBe(CHORES);
});

test("typing due: offers days, and the one picked is written as a date", async ({ page }) => {
  const note = await open(page, "# Plan\n\n- [ ] Pay rent");
  const tomorrow = await localDay(page, 1);

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" due:");
  const offered = page.getByRole("listbox").getByRole("option");
  await expect(offered.first()).toContainText("Today");
  await page.keyboard.type("tom");
  await expect(offered).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe(`# Plan\n\n- [ ] Pay rent due:${tomorrow}`);
  await page.keyboard.press("ControlOrMeta+Home");
  await expectShown(line(page, "Pay rent"), "Pay rent Tomorrow");
});

test("a viewer sees the chips and can change nothing through them, in the note or on the Todos page", async ({ page }) => {
  const { note, admin } = await asViewerOfNote(page, CHORES);
  await page.goto(`/note/${note.id}`);

  await expectShown(line(page, "Call the bank"), "!! Call the bank Oct 14, 2031 +Home about the card");
  for (const control of [editor(page).getByRole("checkbox").first(), editor(page).getByRole("combobox", { name: "Importance" }).first(), editor(page).getByLabel("Due date")]) await expect(control).toBeDisabled();

  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Call the bank +Home about the card", "Deep one +Garden", "Plain one"]);
  for (const control of await rows(page).getByRole("checkbox").all()) await expect(control).toBeDisabled();
  // Its menu opens the note and offers no change.
  await row(page, "Plain one").getByRole("button", { name: "More for Plain one" }).click();
  await expect(page.getByRole("menu", { name: "More for Plain one" }).getByRole("menuitem").first()).toHaveText("Open the note");
  await expect(page.getByRole("menu", { name: "More for Plain one" }).getByRole("menuitem").filter({ hasNotText: /^Open / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect.poll(() => read(admin, note.id)).toBe(CHORES);
});

/** Where the first letter of each of these words is, and the top and height of the line it is on. */
const places = (page: Page, all: readonly string[]) =>
  page.evaluate((list) => {
    const found: Record<string, { x: number; y: number; top: number; height: number }> = {};
    for (const word of list) {
      const box = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((el) => el.textContent!.includes(word));
      if (!box) throw new Error(`No line says "${word}"`);
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
      const at = range.getBoundingClientRect();
      const of = box.getBoundingClientRect();
      found[word] = { x: at.x, y: at.y, top: of.top, height: of.height };
    }
    return found;
  }, all);

const LAYOUT = [
  "# Layout",
  "",
  "Above words.",
  "",
  "- [ ] !! First todo due:2026-10-14 #home trailing words",
  "  - [x] ! Nested todo #trip due:2026-01-02 nested tail",
  "    - [ ] Deeper todo",
  "- [ ] !!! A long todo that goes on for many words so that it wraps in a narrow column and its tokens fall near the end of a row due:2026-10-14 #long-tag-name and then some more words after the tokens to wrap again due:2026-11-11 #second",
  "1. [ ] ! Numbered todo due:2027-03-04 numbered tail",
  "",
  "Below words.",
].join("\n");
const MEASURED = ["Above words", "First todo", "#home", "trailing words", "Nested todo", "#trip", "nested tail", "Deeper todo", "A long todo", "#long-tag-name", "and then some more", "wrap again", "Numbered todo", "numbered tail", "Below words"];

/** Every token of LAYOUT's todos that is drawn as a chip, in the order they are written: a box, importance, and the first due date. */
const TOKENS = todosIn(LAYOUT)
  .flatMap((todo) => [
    { kind: "task", ...todo.box },
    ...(todo.importanceAt ? [{ kind: "importance", ...todo.importanceAt }] : []),
    ...(todo.due ? [{ kind: "due", from: todo.due.from, to: todo.due.to }] : []),
  ])
  .map((token) => ({ ...token, text: LAYOUT.slice(token.from, token.to) }));

/** Each chip drawn in the note, in order: its kind, the token it stands for, and where it is. And each token shown as written and kept in one piece. */
const drawnIn = (page: Page) =>
  page.evaluate(() => {
    const boxed = (el: Element, text: string | null) => ({ text, x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width });
    return {
      chips: [...document.querySelectorAll<HTMLElement>(".cm-content .md-chip-sized")].map((el) => ({ kind: el.className.replace(/md-chip-sized|md-chip-|md-chip /g, "").trim(), ...boxed(el, el.firstElementChild!.textContent) })),
      written: [...document.querySelectorAll<HTMLElement>(".cm-content .md-todo-token")].map((el) => boxed(el, el.textContent)),
    };
  });

/** The column is 720px wide in the first and 314px in the second, where the long todo wraps over several rows. */
for (const width of [1600, 1100]) {
  test(`walking the cursor along every todo's line shows as written only the one token it is on, each chip is exactly where and as wide as its token, and nothing else moves (${width}px window)`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 2000 });
    await open(page, LAYOUT);
    await expect(editor(page).getByLabel("Due date")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const before = await places(page, MEASURED);
    const drawn = await drawnIn(page);
    // Five checkboxes, four importances, and four due dates: a todo's second due: is words.
    expect(drawn.chips.map((c) => [c.kind, c.text])).toEqual(TOKENS.map((t) => [t.kind, t.text]));

    // Down to the first todo's first letter, then right one letter at a time to the last todo's end.
    for (let down = 0; down < 4; down++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    const [first, last] = [LAYOUT.indexOf("- [ ] !! First"), LAYOUT.indexOf("\n\nBelow words.")];
    const stops = new Set<string>();
    for (let at = first; at <= last; at++) {
      if (at > first) await page.keyboard.press("ArrowRight");
      const on = TOKENS.filter((t) => t.from <= at && at <= t.to);
      const when = `with the cursor at "${LAYOUT.slice(Math.max(0, at - 4), at)}|${LAYOUT.slice(at, at + 4)}"`.replaceAll("\n", "\u23ce");
      expect(on.length, `the cursor is never on two tokens: ${when}`).toBeLessThanOrEqual(1);
      on.forEach((t) => stops.add(`${t.kind} ${t.from}`));
      const rest = TOKENS.filter((t) => !on.includes(t));
      await expect.poll(async () => (await drawnIn(page)).chips.map((c) => [c.kind, c.text]), `the chips drawn ${when}`).toEqual(rest.map((t) => [t.kind, t.text]));
      const now = await drawnIn(page);

      // Every chip still drawn is where it was, and the token shown as written is where its chip was, as wide as it was.
      for (const chip of now.chips) {
        const was = drawn.chips[TOKENS.indexOf(rest[now.chips.indexOf(chip)]!)]!;
        expect(Math.abs(chip.x - was.x) + Math.abs(chip.width - was.width), `the ${chip.kind} chip "${chip.text}" ${when}`).toBeLessThanOrEqual(1);
      }
      const token = on.find((t) => t.kind !== "task");
      expect(now.written.map((w) => w.text), `what is kept in one piece ${when}`).toEqual(token ? [token.text] : []);
      if (token) {
        const was = drawn.chips[TOKENS.indexOf(token)]!;
        expect(Math.abs(now.written[0]!.x - was.x), `where "${token.text}" is written ${when}`).toBeLessThanOrEqual(1);
        expect(Math.abs(now.written[0]!.width - was.width), `how wide "${token.text}" is written ${when}`).toBeLessThanOrEqual(1);
      }
      const placed = await places(page, MEASURED);
      for (const [measured, was] of Object.entries(before)) {
        for (const side of ["x", "y", "top", "height"] as const) expect(Math.abs(placed[measured]![side] - was[side]), `${side} of "${measured}" ${when}: ${was[side]} -> ${placed[measured]![side]}`).toBeLessThanOrEqual(1);
      }
    }
    // The walk went over every token there is, and ended on the last todo's line.
    expect(stops.size).toBe(TOKENS.length);
    await expect.poll(() => cursorLine(page)).toContain("numbered tail");

    await page.keyboard.press("ControlOrMeta+Home");
    await expect.poll(async () => (await drawnIn(page)).chips).toEqual(drawn.chips);
  });
}

const HOME = "# Home\n\n- [ ] !! Call the bank due:2026-10-14 +Home\n- [x] Book flights\n- [ ] ! Water plants #outside\n";
const WORK = "# Work #office\n\n- [ ] !!! Ship it due:2026-10-12\n- [ ] Write notes\n";

async function twoNotes(page: Page, homeText = HOME) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const home = await perform(page, { type: "note.create", text: homeText });
  const work = await perform(page, { type: "note.create", text: WORK });
  await page.goto("/todos");
  return { home, work };
}

const more = (page: Page, text: string) => row(page, text).getByRole("button", { name: /^More for / });
const menu = (page: Page) => page.getByRole("menu", { name: /^More for / });
const pick = (page: Page, item: string) => menu(page).getByRole("menuitem", { name: item, exact: true }).click();
const toast = (page: Page) => page.locator(".toast");
/** Where everything on the page that isn't the toast is: each thing's box, to the pixel. */
const laidOut = (page: Page, within: string) =>
  page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((el) => [el.className || el.tagName, ...(["x", "y", "width", "height"] as const).map((side) => Math.round(el.getBoundingClientRect()[side] * 10) / 10)].join(" ")), within);

test("the Todos page lists open todos from every note, and its builder narrows by folder, tag, due date and importance, and to completed ones too", async ({ page }) => {
  const { home, work } = await twoNotes(page);

  await expect(todosPage(page).getByRole("heading", { level: 1 })).toHaveText("Todos");
  // A +Name is words of the todo: nothing is made of it.
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);
  await expect(row(page, "Ship it").locator(".todo-note")).toHaveText("Work #office");
  // At rest there is the bar and Advanced, and no filter of the page's own.
  await expect(bar(page)).toHaveValue("");
  await expect(todosPage(page).getByRole("combobox")).toHaveCount(0);
  await expect(todosPage(page).getByRole("group", { name: "Filters" })).toHaveCount(0);

  // Done todos too: any of open or done, which the builder writes in the bar.
  await advanced(page).click();
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "State" });
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" }).getByRole("option")).toHaveText(["Choose…", "open", "done", "archived", "trashed", "shared", "private"]);
  await condition(page, 1).getByRole("combobox", { name: "Value" }).selectOption("open");
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await condition(page, 2).getByRole("combobox", { name: "Field" }).selectOption({ label: "State" });
  await condition(page, 2).getByRole("combobox", { name: "Value" }).selectOption("done");
  await expect(bar(page)).toHaveValue("is:open is:done");
  await expect(todosPage(page)).toContainText("No todos match.");
  await builder(page).getByRole("radio", { name: "Match any" }).check();
  await expect(bar(page)).toHaveValue("is:open OR is:done");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes", "Book flights"]);
  await expect(row(page, "Book flights").getByRole("checkbox")).toBeChecked();
  await condition(page, 2).getByRole("button", { name: "Remove condition 2" }).click();
  await condition(page, 1).getByRole("button", { name: "Remove condition 1" }).click();
  await expect(bar(page)).toHaveValue("");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);

  // A folder lists its notes' todos and those of the folders under it.
  const house = await perform(page, { type: "folder.create", name: "House" });
  const garden = await perform(page, { type: "folder.create", name: "Garden", parentId: house.id });
  const office = await perform(page, { type: "folder.create", name: "Office" });
  await perform(page, { type: "note.move", id: home.id, folderId: garden.id });
  await perform(page, { type: "note.move", id: work.id, folderId: office.id });
  await page.reload();
  await advanced(page).click();
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Folder" });
  const folder = condition(page, 1).getByRole("combobox", { name: "Value" });
  await expect(folder.getByRole("option")).toHaveText(["Choose…", "House", "House / Garden", "Office", "Unsorted"]);
  await folder.selectOption({ label: "House" });
  await expect(bar(page)).toHaveValue("folder:House");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants #outside"]);
  await folder.selectOption({ label: "House / Garden" });
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants #outside"]);
  await folder.selectOption({ label: "Office" });
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await condition(page, 1).getByRole("combobox", { name: "Is or is not" }).selectOption("is not");
  await expect(bar(page)).toHaveValue("-folder:Office");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants #outside"]);
  await condition(page, 1).getByRole("combobox", { name: "Is or is not" }).selectOption("is");
  await folder.selectOption({ label: "Unsorted" });
  await expect(todosPage(page)).toContainText("No todos match.");

  // Importance and due take a comparison, and a row is no part of the query until it says something.
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Importance" });
  await expect(bar(page)).toHaveValue("");
  await condition(page, 1).getByRole("combobox", { name: "Value" }).selectOption("2");
  await expect(bar(page)).toHaveValue("importance:2");
  await expect(words(page)).toHaveText(["Call the bank +Home"]);
  await condition(page, 1).getByRole("combobox", { name: "Comparison" }).selectOption("on or after");
  await expect(bar(page)).toHaveValue("importance:>=2");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home"]);
  await condition(page, 1).getByRole("combobox", { name: "Comparison" }).selectOption("on");
  await condition(page, 1).getByRole("combobox", { name: "Value" }).selectOption("0");
  await expect(words(page)).toHaveText(["Write notes"]);
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Due" });
  await condition(page, 1).getByRole("combobox", { name: "Comparison" }).selectOption("between");
  await condition(page, 1).getByRole("combobox", { name: "Value" }).fill("2026-10-13");
  await expect(bar(page)).toHaveValue("");
  await condition(page, 1).getByRole("combobox", { name: "To" }).fill("2026-10-31");
  await expect(bar(page)).toHaveValue("due:2026-10-13..2026-10-31");
  await expect(words(page)).toHaveText(["Call the bank +Home"]);
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Has" });
  await condition(page, 1).getByRole("combobox", { name: "Value" }).selectOption("due");
  await condition(page, 1).getByRole("combobox", { name: "Is or is not" }).selectOption("is not");
  await expect(bar(page)).toHaveValue("no:due");
  await expect(words(page)).toHaveText(["Water plants #outside", "Write notes"]);
  await builder(page).getByRole("combobox", { name: "Sort" }).selectOption("title-desc");
  await expect(bar(page)).toHaveValue("no:due sort:title-desc");
  await expect(words(page)).toHaveText(["Write notes", "Water plants #outside"]);

  // The page opens the way it was left.
  await page.reload();
  await expect(bar(page)).toHaveValue("no:due sort:title-desc");
  await expect(words(page)).toHaveText(["Write notes", "Water plants #outside"]);

  // A folder the list was left narrowed to and that is gone since is said to be no folder, and taking it out of the bar lists everything again.
  await bar(page).fill("folder:Office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await perform(page, { type: "note.move", id: work.id, folderId: house.id });
  await perform(page, { type: "folder.delete", id: office.id });
  await page.reload();
  await expect(bar(page)).toHaveValue("folder:Office");
  await expect(problem(page)).toHaveText('No folder named "Office"');
  await expect(rows(page)).toHaveCount(0);
  await bar(page).fill("");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);
  await expect(problem(page)).toHaveCount(0);
  await expect(todosPage(page).getByRole("alert")).toHaveCount(0);
});

test("the Todos page's bar takes the query language as typed: words of a todo's line, filters, OR and NOT, with what can't be read said under it", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);
  const asked = async (query: string, found: string[]) => {
    await bar(page).fill(query);
    await expect(words(page), query).toHaveText(found);
  };
  await asked("bank", ["Call the bank +Home"]);
  await asked("notes OR plants", ["Water plants #outside", "Write notes"]);
  await asked("-ship -notes", ["Call the bank +Home", "Water plants #outside"]);
  // Words are the todo's own, and with in:title its note's.
  await asked("work in:title", ["Ship it", "Write notes"]);
  await asked("is:done", ["Book flights"]);
  await asked("importance:>=2", ["Ship it", "Call the bank +Home"]);
  await asked("importance:1..2 sort:importance-desc", ["Call the bank +Home", "Water plants #outside"]);
  await asked("has:due sort:due-desc", ["Call the bank +Home", "Ship it"]);
  await asked("#office no:due", ["Write notes"]);
  await asked("editor:@me -tag:office", ["Call the bank +Home", "Water plants #outside"]);
  await asked("due:<2026-10-13 OR no:due", ["Ship it", "Water plants #outside", "Write notes"]);

  // A query that can't be read is said so, with where, and the list stays as it was. One for notes alone says so.
  await bar(page).fill("importance:9");
  await expect(problem(page)).toContainText('importance: takes a number from 0 to 3, and "9" isn\'t one');
  await expect(problem(page).locator("mark")).toHaveText("9");
  await expect(bar(page)).toHaveAttribute("aria-invalid", "true");
  await expect(words(page)).toHaveText(["Ship it", "Water plants #outside", "Write notes"]);
  await bar(page).fill("has:todo");
  await expect(problem(page)).toContainText("has:todo is for notes, and this is a search of todos");
  await bar(page).fill("importance:3");
  await expect(problem(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Ship it"]);

  // One the server refuses is said so too, and the list of the query before is not left under it.
  await bar(page).fill("folder:Nowhere");
  await expect(problem(page)).toHaveText('No folder named "Nowhere"');
  await expect(rows(page)).toHaveCount(0);
  await bar(page).fill("importance:3");
  await expect(problem(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Ship it"]);

  // The filters of todos are offered as they are typed, and Tab takes one.
  await bar(page).fill("");
  await bar(page).pressSequentially("du");
  await expect(todosPage(page).getByRole("option")).toHaveText([/^due:/]);
  await page.keyboard.press("Tab");
  await expect(bar(page)).toHaveValue("due:");
  await expect(todosPage(page).getByRole("option")).toHaveText(["today", "yesterday", "tomorrow", "7d", "+7d"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(bar(page)).toHaveValue("due:tomorrow ");
  // Tomorrow is the day after the member's own today, whenever this runs.
  const tomorrow = await perform(page, { type: "todo.list", query: `due:${await localDay(page, 1)}` });
  await expect(words(page)).toHaveText(tomorrow.todos.map((todo) => todo.words));
});

test("the Todos page's bar and builder fit a window 380 wide, and nothing in them runs off its side", async ({ page }) => {
  await twoNotes(page);
  await page.setViewportSize({ width: 380, height: 800 });
  // Focus, so the page has the whole window, as a member with a window this narrow would have it.
  await bar(page).focus();
  await page.keyboard.press("ControlOrMeta+.");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
  await bar(page).fill("due:2026-10-01..2026-10-31 OR importance:>=2 OR -tag:office");
  await advanced(page).click();
  await builder(page).getByRole("button", { name: "Query syntax" }).click();
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(3);
  await builder(page).getByRole("combobox", { name: "Sort" }).selectOption("due-desc");
  await expect(bar(page)).toHaveValue("due:2026-10-01..2026-10-31 OR importance:>=2 OR -tag:office sort:due-desc");
  const over = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".query-bar, .query-bar *")].filter((el) => el.getClientRects().length && (el.getBoundingClientRect().right > innerWidth + 0.5 || el.getBoundingClientRect().left < -0.5)).map((el) => `${el.tagName}.${el.className}`));
  expect(over).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("what a browser kept of the Todos page's old filters opens as the query that says the same", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);
  await page.evaluate(async () => {
    const me = (await (await fetch("/api/me")).json()) as { person: { id: string }; workspaces: { id: string }[] };
    const key = (name: string) => `ink.plugin.todos.${me.workspaces[0]!.id}.${me.person.id}.${name}`;
    localStorage.removeItem(key("query"));
    localStorage.setItem(key("filters"), JSON.stringify({ folder: "", tag: "outside", due: "any", importance: "", completed: true, archived: false }));
  });
  await page.reload();
  await expect(bar(page)).toHaveValue("tag:outside (is:open OR is:done)");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants #outside", "Book flights"]);
  await expect(todosPage(page).getByRole("alert")).toHaveCount(0);
  // A link to the page can name its query, which is then what the page is left at.
  await page.goto("/todos?q=is%3Adone+-tag%3Aoffice");
  await expect(bar(page)).toHaveValue("is:done -tag:office");
  await expect(words(page)).toHaveText(["Book flights"]);
  await page.goto("/todos");
  await expect(bar(page)).toHaveValue("is:done -tag:office");
});

test("a todo has the tags on its own line and its note's: its own are drawn in its words, and one listed for its note's tag says so beside the note's name", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);

  // Its own tag is a tag where it is written, and no row says a tag its line doesn't write.
  await expect(row(page, "Water plants").locator(".todo-words > :first-child .todo-tag")).toHaveText(["#outside"]);
  await expect(rows(page).locator(".todo-tag")).toHaveText(["#outside"]);

  // Under the tag of its own line: both todos of the note are tagged with it, and only the other one is told why. The builder offers the tags todos have.
  await advanced(page).click();
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Tag" });
  await expect.poll(() => condition(page, 1).locator("datalist option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).toEqual(["office", "outside"]);
  await condition(page, 1).getByRole("combobox", { name: "Value" }).fill("outside");
  await expect(bar(page)).toHaveValue("tag:outside");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants #outside"]);
  await expect(row(page, "Call the bank").locator(".todo-meta .todo-tag")).toHaveText(["#outside"]);
  await expect(row(page, "Water plants").locator(".todo-meta .todo-tag")).toHaveCount(0);

  // Under a tag only the note's title writes: every todo of the note, each with the tag beside the note's name.
  await bar(page).fill("#office");
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" })).toHaveValue("office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await expect(rows(page).locator(".todo-meta .todo-tag")).toHaveText(["#office", "#office"]);
});

test("a todo's card looks like a plugin's card and has three things to press: its checkbox, its words, and one menu for everything else", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);
  const look = (selector: string) =>
    page.evaluate((s) => {
      const card = getComputedStyle(document.querySelector(`${s}:not(:hover)`)!);
      const list = getComputedStyle(document.querySelector(s)!.parentElement!);
      return { radius: card.borderRadius, border: `${card.borderTopWidth} ${card.borderTopStyle} ${card.borderTopColor}`, padding: card.padding, background: card.backgroundColor, gap: list.rowGap };
    }, selector);
  const todo = await look(".todo-card");

  // One tag, importance and a date: three controls, and importance and the date are said, not pressed.
  const water = row(page, "Water plants");
  await more(page, "Water plants").click();
  await pick(page, "Due tomorrow");
  await expect(water.locator(".todo-due")).toHaveText("Tomorrow");
  await expect(water.locator(".todo-importance")).toHaveText("!");
  await expect(water.locator("button, input, select, a, [tabindex]")).toHaveCount(3);
  await expect(water.getByRole("checkbox")).toHaveCount(1);
  await expect(water.getByRole("button")).toHaveText([/^Water plants #outside/, ""]);
  // A todo with no date and no importance says neither.
  await expect(row(page, "Write notes").locator(".todo-chip")).toHaveCount(0);
  await expect(rows(page).filter({ hasText: "No date" })).toHaveCount(0);

  await page.goto("/plugins");
  await expect(page.locator(".plugin-card").first()).toBeVisible();
  expect(todo).toEqual(await look(".plugin-card"));
});

test("everything else a todo can do is in one menu, from its button, a right-click and the keyboard, and each change rewrites its line in its note as the member's change", async ({ page }) => {
  // The bank is due on a day that is never today, whenever this runs: what a todo already is can't be chosen again, and "Due today" is chosen below.
  const due = await localDay(page, 10);
  const homeText = HOME.replace("due:2026-10-14", `due:${due}`);
  const { home } = await twoNotes(page, homeText);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  const today = await localDay(page);

  await more(page, "Call the bank").click();
  await expect(menu(page)).toHaveAccessibleName("More for Call the bank +Home");
  const offered = ["Importance: !!!", "Importance: !!", "Importance: !", "Importance: Normal", "Due today", "Due tomorrow", "Pick a due date…", "No due date", "Recurrence…"];
  await expect(menu(page).getByRole("menuitem").filter({ hasNotText: /^Open / })).toHaveText(offered);
  // What it already is can't be chosen again.
  await expect(menu(page).getByRole("menuitem", { name: "Importance: !!", exact: true })).toBeDisabled();
  await pick(page, "Importance: !");
  await expect.poll(lineIn).toBe(`- [ ] ! Call the bank due:${due} +Home`);
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page, "Call the bank")).toBeFocused();

  // A right-click anywhere on the card opens the same menu.
  await row(page, "Call the bank").locator(".todo-note").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem").filter({ hasNotText: /^Open / })).toHaveText(offered);
  await pick(page, "Due today");
  await expect.poll(lineIn).toBe(`- [ ] ! Call the bank due:${today} +Home`);
  await expect(row(page, "Call the bank").locator(".todo-due")).toHaveText("Today");

  // So does Shift+F10 with the keyboard in the card, and Escape closes it without a change.
  await row(page, "Call the bank").getByRole("checkbox").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await more(page, "Call the bank").focus();
  await page.keyboard.press("ContextMenu");
  // Two changes one after the other, the second before the list has been read again: it is made to the line the first leaves.
  await pick(page, "No due date");
  await more(page, "Call the bank").click();
  await pick(page, "Importance: !!!");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank +Home");
  await expect(row(page, "Call the bank").locator(".todo-due")).toHaveCount(0);

  // A day of the member's choosing is typed or picked in a date field that is there only while it is asked for.
  await more(page, "Write notes").click();
  await pick(page, "Pick a due date…");
  await row(page, "Write notes").getByLabel("Due date for Write notes").fill("2026-10-01");
  await todosPage(page).getByRole("heading", { level: 1 }).click();
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank +Home", "Water plants #outside"]);
  await expect(rows(page).locator("input[type=date]")).toHaveCount(0);

  await more(page, "Call the bank").click();
  await pick(page, "Open the note");
  await expect(page).toHaveURL(new RegExp(`${home.id}$`));
  expect(new Set(await authors(page, home.id))).toEqual(new Set(["member Ada Lovelace"]));
  await expect.poll(async () => (await read(page, home.id)).replace("- [ ] !!! Call the bank +Home", `- [ ] !! Call the bank due:${due} +Home`)).toBe(homeText);
});

test("a todo's menu opens at the pointer when there is room, and is moved wholly inside the window when there isn't", async ({ page }) => {
  await twoNotes(page);
  const card = (await row(page, "Call the bank").boundingBox())!;
  const at = { x: Math.round(card.x + 60), y: Math.round(card.y + 6) };
  await page.mouse.click(at.x, at.y, { button: "right" });
  const roomy = (await menu(page).boundingBox())!;
  expect([Math.round(roomy.x), Math.round(roomy.y)]).toEqual([at.x, at.y]);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  // A window barely taller than the menu with the inspector closed, and a press near the card's right end: the menu fits nowhere below and right of the pointer.
  const window = { width: 720, height: Math.ceil(roomy.height) + 40 };
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toHaveCount(0);
  await page.setViewportSize(window);
  await row(page, "Call the bank").scrollIntoViewIfNeeded();
  const tight = (await row(page, "Call the bank").boundingBox())!;
  await page.mouse.click(tight.x + tight.width - 50, tight.y + tight.height - 6, { button: "right" });
  const moved = (await menu(page).boundingBox())!;
  expect(tight.x + tight.width - 50 + moved.width, "it would have run off the right").toBeGreaterThan(window.width);
  expect(tight.y + tight.height - 6 + moved.height, "it would have run off the foot").toBeGreaterThan(window.height);
  expect(moved.x).toBeGreaterThanOrEqual(8);
  expect(moved.y).toBeGreaterThanOrEqual(8);
  expect(moved.x + moved.width).toBeLessThanOrEqual(window.width - 8);
  expect(moved.y + moved.height).toBeLessThanOrEqual(window.height - 8);
  // It is still the menu, with the keyboard in it.
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
});

test("checking a todo off on the Todos page says so in a toast, and Undo opens it again as a change of its own; opening one says nothing", async ({ page }) => {
  const { home } = await twoNotes(page);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  await bar(page).fill("is:open OR is:done");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes", "Book flights"]);
  await page.evaluate(() => document.fonts.ready);
  const frame = ".todos-page h1, .query-bar, .query-line, .query-line > *, .todos-page .cards";
  const before = await laidOut(page, frame);

  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect.poll(lineIn).toBe("- [x] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveText("Completed Call the bank +HomeUndo");
  await expect(toast(page)).toHaveAttribute("role", "status");
  await expect(toast(page).getByRole("button")).toHaveText(["Undo", ""]);
  await expect(toast(page).getByRole("button", { name: "Dismiss" })).toBeVisible();
  // It is laid over the page: nothing that was there has moved for it, and nothing moves when it goes.
  expect(await toast(page).evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  expect(await laidOut(page, frame)).toEqual(before);
  await expect(words(page)).toHaveText(["Ship it", "Water plants #outside", "Write notes", "Call the bank +Home", "Book flights"]);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(lineIn).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes", "Book flights"]);
  // The tick and its undo are two changes in History, the member's like any other.
  await expect.poll(() => authors(page, home.id)).toEqual(["member Ada Lovelace", "member Ada Lovelace", "member Ada Lovelace"]);
  await expect.poll(() => read(page, home.id)).toBe(HOME);

  // A newer completion takes the toast's place, and Dismiss takes it away with nothing else moving.
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toContainText("Completed Call the bank +Home");
  await row(page, "Write notes").getByRole("checkbox").check();
  await expect(toast(page)).toHaveText("Completed Write notesUndo");
  await expect(toast(page)).toHaveCount(1);
  await expect(words(page)).toHaveText(["Ship it", "Water plants #outside", "Call the bank +Home", "Book flights", "Write notes"]);
  const withToast = await laidOut(page, ".todos-page *");
  await toast(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(toast(page)).toHaveCount(0);
  expect(await laidOut(page, ".todos-page *")).toEqual(withToast);
  expect(await laidOut(page, frame)).toEqual(before);

  // Opening a todo again says nothing.
  await row(page, "Write notes").getByRole("checkbox").uncheck();
  await expect.poll(async () => (await perform(page, { type: "todo.list" })).todos.map((t) => t.words)).toContain("Write notes");
  await expect(toast(page)).toHaveCount(0);

  // Left alone, it goes away by itself after about eight seconds.
  await row(page, "Ship it").getByRole("checkbox").check();
  await expect(toast(page)).toHaveText("Completed Ship itUndo");
  const shown = Date.now();
  await expect(toast(page)).toHaveCount(0, { timeout: 12_000 });
  expect(Date.now() - shown).toBeGreaterThan(6000);
});

test("Undo changes nothing when the todo was written another way since: the toast says so", async ({ page }) => {
  const { home } = await twoNotes(page);
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toContainText("Completed Call the bank +Home");
  // The line is written another way before Undo is pressed.
  const changed = HOME.replace("- [ ] !! Call the bank due:2026-10-14 +Home", "- [x] !! Call the credit union due:2026-10-14 +Home");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: home.id })).revision).toBe(2);
  await perform(page, { type: "note.write", id: home.id, baseRevision: 2, text: changed });

  await toast(page).getByRole("button", { name: "Undo" }).click();

  await expect(toast(page)).toHaveText("That todo was changed since it was checked off, so it was left as it is.");
  await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect.poll(() => read(page, home.id)).toBe(changed);
  expect((await perform(page, { type: "note.read", id: home.id })).revision).toBe(3);
  await expect(todosPage(page).getByRole("alert")).toHaveCount(0);
});

test("checking a todo off in a note says so in the same toast, and Undo opens it again as the member's edit, which Ctrl+Z takes back", async ({ page }) => {
  const note = await open(page, HOME);
  const lineIn = async (n = 2) => (await read(page, note.id)).split("\n")[n];
  await page.evaluate(() => document.fonts.ready);
  // The ticked line's own words stand after its box, which is written one letter another way, so the lines measured are the others.
  const measured = ["Home", "Book flights", "Water plants"];
  const before = await places(page, measured);

  await line(page, "Call the bank").getByRole("checkbox").click();
  await expect.poll(lineIn).toBe("- [x] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveText("Completed Call the bank +HomeUndo");
  await expect(toast(page)).toHaveAttribute("role", "status");
  expect(await toast(page).evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  expect(await places(page, measured)).toEqual(before);
  // The keyboard is still in the note.
  await expect(editor(page)).toBeFocused();

  // The note is written above the todo before Undo is pressed: the todo is followed to where it is now.
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("A line above.");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => lineIn(3)).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await expect(line(page, "Call the bank").getByRole("checkbox")).not.toBeChecked();
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  // It was an edit like any other: the editor's own undo checks the todo off again.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => lineIn(3)).toBe("- [x] !! Call the bank due:2026-10-14 +Home");

  // Unticking it says nothing, and a line written another way since it was ticked is left alone.
  await line(page, "Call the bank").getByRole("checkbox").click();
  await expect.poll(() => lineIn(3)).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await line(page, "Water plants").getByRole("checkbox").click();
  await expect(toast(page)).toHaveText("Completed Water plants #outsideUndo");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" today");
  await expect.poll(() => lineIn(5)).toBe("- [x] ! Water plants #outside today");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveText("That todo was changed since it was checked off, so it was left as it is.");
  await expect.poll(() => lineIn(5)).toBe("- [x] ! Water plants #outside today");
  // And nothing in the note moves when the toast goes.
  const every = ["Home", "A line above", "Call the bank", "Book flights", "Water plants"];
  const shown = await places(page, every);
  await toast(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(toast(page)).toHaveCount(0);
  expect(await places(page, every)).toEqual(shown);
});

test("Undo opens a todo again after more was changed on it from the page, and after lines were written above it in a note that was left", async ({ page }) => {
  const { home } = await twoNotes(page);
  await bar(page).fill("is:open OR is:done");
  await expect(row(page, "Book flights")).toHaveCount(1);
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toContainText("Completed Call the bank +Home");
  await more(page, "Call the bank").click();
  await pick(page, "Importance: !");
  await expect.poll(async () => (await read(page, home.id)).split("\n")[2]).toBe("- [x] ! Call the bank due:2026-10-14 +Home");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await read(page, home.id)).split("\n")[2]).toBe("- [ ] ! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);

  // Checked off in the note, the note left, and a line written above the todo by someone else before Undo.
  await page.goto(`/note/${home.id}`);
  await line(page, "Call the bank").getByRole("checkbox").click();
  await expect(toast(page)).toContainText("Completed Call the bank +Home");
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();
  await expect(rows(page).first()).toBeVisible();
  const ticked = await perform(page, { type: "note.read", id: home.id });
  expect(ticked.text.split("\n")[2]).toBe("- [x] ! Call the bank due:2026-10-14 +Home");
  await perform(page, { type: "note.write", id: home.id, baseRevision: ticked.revision, text: ticked.text.replace("# Home\n", "# Home\n\nA line above\n") });
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await read(page, home.id)).split("\n")[4]).toBe("- [ ] ! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
});

test("Undo still opens a todo checked off in a note after the note is left for the Todos page", async ({ page }) => {
  const note = await open(page, HOME);
  await line(page, "Call the bank").getByRole("checkbox").click();
  await expect(toast(page)).toContainText("Completed Call the bank +Home");
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();
  await expect(words(page)).toHaveText(["Water plants #outside"]);

  await toast(page).getByRole("button", { name: "Undo" }).click();

  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants #outside"]);
});

test("clicking a todo opens its note with the cursor on its line, and the editor has what the Todos page changed", async ({ page }) => {
  const { home } = await twoNotes(page);
  // The note is open in a tab, with typing the server doesn't have yet, when the page changes it.
  await page.goto(`/note/${home.id}`);
  await expect(editor(page)).toContainText("Call the bank");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Typed last.");
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();

  await row(page, "Water plants").getByRole("checkbox").check();
  await expect.poll(() => read(page, home.id)).toBe(`${HOME.replace("- [ ] ! Water", "- [x] ! Water")}Typed last.`);
  await row(page, "Call the bank").locator(".todo-words").click();

  await expect(page).toHaveURL(new RegExp(`${home.id}$`));
  // The cursor is at the end of its line, on none of its tokens, so the line stays drawn.
  await expect.poll(() => cursorLine(page)).toContain("Call the bank");
  await expect(line(page, "Call the bank").locator(".md-chip-task, .md-chip-importance, .md-chip-due")).toHaveCount(3);
  await expect(line(page, "Water plants").getByRole("checkbox")).toBeChecked();
  await expect(editor(page)).toContainText("Typed last.");
  await page.keyboard.type(" now");
  await expect.poll(() => read(page, home.id)).toBe(`${HOME.replace("- [ ] ! Water", "- [x] ! Water").replace("+Home", "+Home now")}Typed last.`);
});

test("a todo that changed since it was listed is not rewritten: the page says so and lists what is there now", async ({ page }) => {
  const { home } = await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants #outside", "Write notes"]);
  const changed = HOME.replace("- [ ] !! Call the bank due:2026-10-14 +Home", "- [ ] Email the landlord\n- [ ] !! Call the credit union due:2026-10-14 +Home");
  await perform(page, { type: "note.write", id: home.id, baseRevision: 1, text: changed });

  await row(page, "Call the bank").getByRole("checkbox").check();

  await expect(todosPage(page).getByRole("alert")).toHaveText("This todo was changed since it was listed. List the todos again.");
  await expect(words(page)).toHaveText(["Ship it", "Call the credit union +Home", "Water plants #outside", "Email the landlord", "Write notes"]);
  await expect.poll(() => read(page, home.id)).toBe(changed);
  // Nothing was checked off, so nothing says it was.
  await expect(toast(page)).toHaveCount(0);
});

test("an agent lists todos by folder and by tag and checks one off, and the Todos page and the note follow", async ({ page }) => {
  const { home, work } = await twoNotes(page);
  const house = await perform(page, { type: "folder.create", name: "House" });
  await perform(page, { type: "note.move", id: home.id, folderId: house.id });
  const agent = await connectAgent(page, "Claude");
  type Listed = { todos: { noteId: string; revision: number; line: number; text: string; words: string; tags: string[] }[] };

  expect((await agent.tool<Listed>("list_todos", { tag: "OFFICE" })).todos.map((t) => [t.noteId, t.words, t.tags])).toEqual([[work.id, "Ship it", ["office"]], [work.id, "Write notes", ["office"]]]);
  const listed = await agent.tool<Listed>("list_todos", { folderId: house.id, importance: [2] });
  expect(listed.todos.map((t) => t.words)).toEqual(["Call the bank +Home"]);
  expect(listed.todos[0]).not.toHaveProperty("projects");
  expect(await agent.tool("todo_filters", {})).toEqual({ tags: ["office", "outside"] });
  const { noteId, revision, line: at, text } = listed.todos[0]!;
  await agent.tool("set_todo", { id: noteId, revision, line: at, text, done: true, due: "2026-10-20" });
  // The same call again, as after an answer that never arrived, changes nothing more.
  await agent.tool("set_todo", { id: noteId, revision, line: at, text, done: true, due: "2026-10-20" });

  await expect.poll(async () => (await read(page, home.id)).split("\n")[2]).toBe("- [x] !! Call the bank due:2026-10-20 +Home");
  await expect.poll(() => authors(page, home.id)).toEqual(["member Ada Lovelace", "agent Claude"]);
  await expect(words(page)).toHaveText(["Ship it", "Water plants #outside", "Write notes"], { timeout: 20_000 });
  // An agent's completion is not the member's to undo from a toast.
  await expect(toast(page)).toHaveCount(0);
});

test.describe("where the member's day is not the day in UTC", () => {
  // Five in the morning on the 10th in UTC is nine in the evening on the 9th in Los Angeles.
  test.use({ timezoneId: "America/Los_Angeles" });

  test("due today is today where the member is, in the note and on the Todos page", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-03-10T05:00:00Z"));
    const note = await open(page, "# Days\n\n- [ ] The eighth due:2026-03-08\n- [ ] The ninth due:2026-03-09\n- [ ] The tenth due:2026-03-10\n- [ ] The twentieth due:2026-03-20\n- [ ] Undated\n");
    await expect.poll(() => localDay(page)).toBe("2026-03-09");

    await expectShown(line(page, "The eighth"), "The eighth Yesterday");
    await expectShown(line(page, "The ninth"), "The ninth Today");
    await expectShown(line(page, "The tenth"), "The tenth Tomorrow");
    await expect(line(page, "The ninth").locator(".md-todo-chip")).toHaveAttribute("data-due", "today");
    await expect(line(page, "The eighth").locator(".md-todo-chip")).toHaveAttribute("data-due", "overdue");

    await page.goto("/todos");
    await expect(row(page, "The ninth").locator(".todo-due")).toHaveText("Today");
    await expect(row(page, "The tenth").locator(".todo-due")).toHaveText("Tomorrow");
    // The days a query counts from today are counted from the member's own day, which the page says with every ask.
    await bar(page).fill("due:today");
    await expect(words(page)).toHaveText(["The ninth"]);
    await bar(page).fill("due:<today");
    await expect(words(page)).toHaveText(["The eighth"]);
    await bar(page).fill("due:today..+6d");
    await expect(words(page)).toHaveText(["The ninth", "The tenth"]);
    await bar(page).fill("due:tomorrow OR due:yesterday");
    await expect(words(page)).toHaveText(["The eighth", "The tenth"]);
    await expect.poll(() => read(page, note.id)).toContain("due:2026-03-09");
  });
});

test("in vim, motions and operators go over a todo's tokens as the text they are", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const note = await perform(page, { type: "note.create", text: "# Vim\n\n- [ ] !! Call due:2026-10-14 +Home\nAfter" });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  const press = async (...all: string[]) => {
    for (const key of all) await page.keyboard.press(key);
  };

  // Down from the title onto the todo: the line is as written, and w steps token by token.
  await press("g", "g", "j", "j", "0", "f", "!", "x");
  await expect.poll(() => read(page, note.id)).toBe("# Vim\n\n- [ ] ! Call due:2026-10-14 +Home\nAfter");
  await press("$", "d", "a", "W");
  await expect.poll(() => read(page, note.id)).toBe("# Vim\n\n- [ ] ! Call due:2026-10-14\nAfter");
  await press("F", "d", "c", "t", ":");
  await page.keyboard.type("was");
  await press("Escape", "j");
  await expect.poll(() => read(page, note.id)).toBe("# Vim\n\n- [ ] ! Call was:2026-10-14\nAfter");
  await expectShown(line(page, "Call"), "! Call was:2026-10-14");
});
