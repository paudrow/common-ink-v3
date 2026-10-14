import { expect, test, type Locator, type Page } from "@playwright/test";
import { todosIn } from "../../src/core/todos.ts";
import { asViewerOfNote, connectAgent, perform, pinPanel, signInAsNewPerson } from "./helpers.ts";

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
const popover = (page: Page) => page.locator(".chip-popover");
/** Picks one of what the open chip's popover offers. */
const choose = (page: Page, name: string) => popover(page).getByRole("button", { name, exact: true }).click();
/** The bar a query is typed in, and the builder Advanced opens under it. */
const bar = (page: Page) => todosPage(page).getByRole("searchbox", { name: "Filter todos" });
const advanced = (page: Page) => todosPage(page).getByRole("button", { name: "Advanced" });
const builder = (page: Page) => todosPage(page).getByRole("group", { name: "Advanced filter" });
const condition = (page: Page, n: number) => builder(page).getByRole("group", { name: `Condition ${n}` });
const problem = (page: Page) => todosPage(page).getByRole("status");
const words = (page: Page) => rows(page).locator(".todo-words");
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
  await expect(editor(page).getByRole("button", { name: /^Importance: / })).toHaveCount(2);
  await expect(editor(page).getByRole("button", { name: /^Due date: / })).toHaveCount(1);
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

  await bank().getByRole("button", { name: /^Importance: / }).click();
  await choose(page, "!!!");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-10-14 +Home about the card");
  await bank().getByRole("button", { name: /^Due date: / }).click();
  await popover(page).getByLabel("Due on").fill("2031-12-25");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-12-25 +Home about the card");
  await expectShown(bank(), "!!! Call the bank Dec 25, 2031 +Home about the card");
  await bank().getByRole("checkbox").click();
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Home about the card");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  // Taking an option away takes its token and the space before it, and undo puts both back.
  await bank().getByRole("button", { name: /^Importance: / }).click();
  await choose(page, "Normal");
  await expect.poll(lineIn).toBe("- [x] Call the bank due:2031-12-25 +Home about the card");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Home about the card");
  await bank().getByRole("button", { name: /^Importance: / }).click();
  await choose(page, "Normal");
  await bank().getByRole("button", { name: /^Due date: / }).click();
  await choose(page, "Clear");
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
  for (const control of [editor(page).getByRole("checkbox").first(), editor(page).getByRole("button", { name: /^Importance: / }).first(), editor(page).getByRole("button", { name: /^Due date: / })]) await expect(control).toBeDisabled();
  await editor(page).getByRole("button", { name: /^Due date: / }).click({ force: true });
  await expect(popover(page)).toHaveCount(0);

  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Call the bank +Home about the card", "Deep one +Garden", "Plain one"]);
  for (const control of await rows(page).getByRole("checkbox").all()) await expect(control).toBeDisabled();
  for (const control of await rows(page).getByRole("button", { name: /^(Importance|Due date): / }).all()) await expect(control).toBeDisabled();
  // What isn't set isn't offered to someone who can't set it.
  await expect(rows(page).locator(".todo-chip[data-unset]")).toHaveCount(0);
  await expect(row(page, "Plain one").locator(".todo-words")).not.toHaveAttribute("role", "button");
  // It has no fields to list, from its buttons or a right-click, and still goes to its note.
  await expect(row(page, "Plain one").getByRole("button", { name: /^Fields of / })).toHaveCount(0);
  await row(page, "Plain one").locator(".todo-words").click({ button: "right" });
  await expect(popover(page)).toHaveCount(0);
  await expect(row(page, "Plain one").getByRole("button", { name: /^Go to / })).toHaveCount(1);
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
    await expect(editor(page).getByRole("button", { name: /^Due date: / })).toHaveCount(4);
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

const fieldsOf = (page: Page, text: string) => row(page, text).getByRole("button", { name: /^Fields of / });
/** One of what a row's fields button lists, by its name. */
const field = (page: Page, name: string) => popover(page).getByRole("button", { name: new RegExp(`^${name}: `) });
const chipOf = (page: Page, text: string, kind: "Importance" | "Due date") => row(page, text).getByRole("button", { name: new RegExp(`^${kind}: `) });
const toast = (page: Page) => page.locator(".toast-card");
/** Where everything on the page that isn't the toast is: each thing's box, to the pixel. */
const laidOut = (page: Page, within: string) =>
  page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((el) => [el.className || el.tagName, ...(["x", "y", "width", "height"] as const).map((side) => Math.round(el.getBoundingClientRect()[side] * 10) / 10)].join(" ")), within);

test("the Todos page lists open todos from every note, and its builder narrows by folder, tag, due date and importance, and to completed ones too", async ({ page }) => {
  const { home, work } = await twoNotes(page);

  await expect(todosPage(page).getByRole("heading", { level: 1 })).toHaveText("Todos");
  // A +Name is words of the todo: nothing is made of it.
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
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
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);
  await expect(row(page, "Book flights").getByRole("checkbox")).toBeChecked();
  await condition(page, 2).getByRole("button", { name: "Remove condition 2" }).click();
  await condition(page, 1).getByRole("button", { name: "Remove condition 1" }).click();
  await expect(bar(page)).toHaveValue("");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);

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
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
  await folder.selectOption({ label: "House / Garden" });
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
  await folder.selectOption({ label: "Office" });
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await condition(page, 1).getByRole("combobox", { name: "Is or is not" }).selectOption("is not");
  await expect(bar(page)).toHaveValue("-folder:Office");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
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
  await expect(words(page)).toHaveText(["Water plants", "Write notes"]);
  await builder(page).getByRole("combobox", { name: "Sort" }).selectOption("title-desc");
  await expect(bar(page)).toHaveValue("no:due sort:title-desc");
  await expect(words(page)).toHaveText(["Write notes", "Water plants"]);

  // The page opens the way it was left.
  await page.reload();
  await expect(bar(page)).toHaveValue("no:due sort:title-desc");
  await expect(words(page)).toHaveText(["Write notes", "Water plants"]);

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
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await expect(problem(page)).toHaveCount(0);
  await expect(todosPage(page).getByRole("alert")).toHaveCount(0);
});

test("the Todos page's bar takes the query language as typed: words of a todo's line, filters, OR and NOT, with what can't be read said under it", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const asked = async (query: string, found: string[]) => {
    await bar(page).fill(query);
    await expect(words(page), query).toHaveText(found);
  };
  await asked("bank", ["Call the bank +Home"]);
  await asked("notes OR plants", ["Water plants", "Write notes"]);
  await asked("-ship -notes", ["Call the bank +Home", "Water plants"]);
  // Words are the todo's own, and with in:title its note's.
  await asked("work in:title", ["Ship it", "Write notes"]);
  await asked("is:done", ["Book flights"]);
  await asked("importance:>=2", ["Ship it", "Call the bank +Home"]);
  await asked("importance:1..2 sort:importance-desc", ["Call the bank +Home", "Water plants"]);
  await asked("has:due sort:due-desc", ["Call the bank +Home", "Ship it"]);
  await asked("#office no:due", ["Write notes"]);
  await asked("editor:@me -tag:office", ["Call the bank +Home", "Water plants"]);
  await asked("due:<2026-10-13 OR no:due", ["Ship it", "Water plants", "Write notes"]);

  // A query that can't be read is said so, with where, and the list stays as it was. One for notes alone says so.
  await bar(page).fill("importance:9");
  await expect(problem(page)).toContainText('importance: takes a number from 0 to 3, and "9" isn\'t one');
  await expect(problem(page).locator("mark")).toHaveText("9");
  await expect(bar(page)).toHaveAttribute("aria-invalid", "true");
  await expect(words(page)).toHaveText(["Ship it", "Water plants", "Write notes"]);
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
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await page.evaluate(async () => {
    const me = (await (await fetch("/api/me")).json()) as { person: { id: string }; workspaces: { id: string }[] };
    const key = (name: string) => `ink.plugin.todos.${me.workspaces[0]!.id}.${me.person.id}.${name}`;
    localStorage.removeItem(key("query"));
    localStorage.setItem(key("filters"), JSON.stringify({ folder: "", tag: "outside", due: "any", importance: "", completed: true, archived: false }));
  });
  await page.reload();
  await expect(bar(page)).toHaveValue("tag:outside (is:open OR is:done)");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants", "Book flights"]);
  await expect(todosPage(page).getByRole("alert")).toHaveCount(0);
  // A link to the page can name its query, which is then what the page is left at.
  await page.goto("/todos?q=is%3Adone+-tag%3Aoffice");
  await expect(bar(page)).toHaveValue("is:done -tag:office");
  await expect(words(page)).toHaveText(["Book flights"]);
  await page.goto("/todos");
  await expect(bar(page)).toHaveValue("is:done -tag:office");
  // Once the bar is changed from a link's query, a reload opens what was left, not the link's.
  await page.goto("/todos?q=is%3Adone");
  await expect(words(page)).toHaveText(["Book flights"]);
  await bar(page).fill("bank");
  await expect(words(page)).toHaveText(["Call the bank +Home"]);
  await expect(page).toHaveURL(/\/todos$/);
  await page.reload();
  await expect(bar(page)).toHaveValue("bank");
});

test("a todo has the tags on its own line and its note's: its own are drawn as chips after its words, and one listed for its note's tag says so beside the note's name", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);

  // A tag written at the end of its words is a chip after them, and no row says a tag its line doesn't write.
  await expect(row(page, "Water plants").locator(".todo-text .todo-tag")).toHaveText(["#outside"]);
  await expect(rows(page).locator(".todo-tag")).toHaveText(["#outside"]);

  // Under the tag of its own line: both todos of the note are tagged with it, and only the other one is told why. The builder offers the tags todos have.
  await advanced(page).click();
  await builder(page).getByRole("button", { name: "Add a condition" }).click();
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Tag" });
  await expect.poll(() => condition(page, 1).locator("datalist option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).toEqual(["office", "outside"]);
  await condition(page, 1).getByRole("combobox", { name: "Value" }).fill("outside");
  await expect(bar(page)).toHaveValue("tag:outside");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
  await expect(row(page, "Call the bank").locator(".todo-where .todo-tag")).toHaveText(["#outside"]);
  await expect(row(page, "Water plants").locator(".todo-where .todo-tag")).toHaveCount(0);

  // Under a tag only the note's title writes: every todo of the note, each with the tag beside the note's name.
  await bar(page).fill("#office");
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" })).toHaveValue("office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await expect(rows(page).locator(".todo-where .todo-tag")).toHaveText(["#office", "#office"]);
});

test("a tag's chip narrows the list through the query: it adds #tag to the bar, pressed again takes it off, and the rest of the query stays; a tag inside the words stays in them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Home\n\n- [ ] Water plants #outside #garden\n" });
  await perform(page, { type: "note.create", text: "# Fence\n\n- [ ] Ask #bob about the fence\n" });
  await perform(page, { type: "note.create", text: "# Work\n\n- [ ] Write notes\n- [ ] #someday\n- [ ] Twice #twice #twice\n" });
  const warned: string[] = [];
  page.on("console", (m) => m.type() === "error" && warned.push(m.text()));
  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Ask #bob about the fence", "Water plants", "Write notes", "#someday", "Twice"]);
  await expect(row(page, "Water plants").locator(".todo-text button.todo-tag")).toHaveText(["#outside", "#garden"]);
  await expect(row(page, "Twice").locator("button.todo-tag")).toHaveText(["#twice", "#twice"]);
  await expect(row(page, "Ask").locator("button.todo-tag")).toHaveCount(0);
  await expect(row(page, "#someday").locator("button.todo-tag")).toHaveCount(0);

  const garden = () => row(page, "Water plants").getByRole("button", { name: "#garden", exact: true });
  await expect(garden()).toHaveAttribute("aria-pressed", "false");
  await garden().click();
  await expect(bar(page)).toHaveValue("#garden");
  await expect(words(page)).toHaveText(["Water plants"]);
  await expect(garden()).toHaveAttribute("aria-pressed", "true");
  await garden().click();
  await expect(bar(page)).toHaveValue("");
  await expect(words(page)).toHaveText(["Ask #bob about the fence", "Water plants", "Write notes", "#someday", "Twice"]);

  // With a query in the bar, the tag is added to it and taken off it, and the rest is left as typed.
  await bar(page).fill("water OR twice");
  await expect(words(page)).toHaveText(["Water plants", "Twice"]);
  await row(page, "Twice").getByRole("button", { name: "#twice", exact: true }).first().click();
  await expect(bar(page)).toHaveValue("(water OR twice) tag:twice");
  await expect(words(page)).toHaveText(["Twice"]);
  await expect(row(page, "Twice").locator("button.todo-tag[aria-pressed=true]")).toHaveCount(2);
  await row(page, "Twice").getByRole("button", { name: "#twice", exact: true }).first().click();
  await expect(bar(page)).toHaveValue("(water OR twice)");
  await expect(words(page)).toHaveText(["Water plants", "Twice"]);
  // A tag the bar names with tag: is the same tag: its chip reads pressed and takes it off.
  await bar(page).fill("tag:Outside plants");
  await expect(row(page, "Water plants").getByRole("button", { name: "#outside", exact: true })).toHaveAttribute("aria-pressed", "true");
  await row(page, "Water plants").getByRole("button", { name: "#outside", exact: true }).click();
  await expect(bar(page)).toHaveValue("plants");
  // The page opens the way the chip left it.
  await garden().click();
  await expect(bar(page)).toHaveValue("plants #garden");
  await page.reload();
  await expect(bar(page)).toHaveValue("plants #garden");
  await expect(words(page)).toHaveText(["Water plants"]);
  expect(warned).toEqual([]);
});

test("the list is v1's: one panel of rows, each its checkbox, its words, a chip for each thing a todo can have, set or not, its note's name at the right, and v1's three buttons", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const look = await page.evaluate(() => {
    const list = getComputedStyle(document.querySelector(".todo-list")!);
    const row = getComputedStyle(document.querySelector(".todo-row")!);
    const chip = getComputedStyle(document.querySelector(".todo-chip")!);
    return { list: [list.borderRadius, list.borderTopWidth], row: [row.fontSize, row.paddingTop, row.borderRadius], chip: [chip.height, chip.fontSize, chip.paddingLeft, chip.borderRadius] };
  });
  expect(look).toEqual({ list: ["14px", "1px"], row: ["14.5px", "4px", "7px"], chip: ["20px", "11.5px", "7px", "999px"] });
  // Rows of todos with and without chips are one height, as v1's: 32px.
  const heights = await rows(page).evaluateAll((all) => all.map((el) => el.getBoundingClientRect().height));
  expect(new Set(heights)).toEqual(new Set([32]));

  // About 660px wide, in a window with room for far more.
  await page.setViewportSize({ width: 1800, height: 900 });
  expect((await todosPage(page).getByRole("list", { name: "Todos" }).boundingBox())!.width).toBeLessThanOrEqual(662);

  // Every row has every chip: what is set says what it is, and what isn't is a quiet one to set it with.
  const water = row(page, "Water plants");
  await expect(water.getByRole("button")).toHaveText(["Water plants", "!", "Add date", "Repeat", "#outside", "Home", "", "", ""]);
  await expect(row(page, "Write notes").locator(".todo-chip")).toHaveText(["Importance", "Add date", "Repeat", "# Add tag"]);
  await expect(row(page, "Write notes").locator(".todo-chip[data-unset]")).toHaveCount(4);
  await expect(row(page, "Ship it").locator(".todo-chip")).toHaveText(["!!!", /\S/, "Repeat", "# Add tag"]);
  await expect(water.getByRole("checkbox")).toHaveCount(1);
  // Its chips follow its words on their row, as near as a pill's margin.
  const end = await water.locator(".todo-words").evaluate((el) => el.getBoundingClientRect().right);
  const first = (await water.locator(".todo-chip").first().boundingBox())!;
  expect(first.x - end).toBeGreaterThanOrEqual(0);
  expect(first.x - end).toBeLessThanOrEqual(8);
  // The note's name is at the row's right end, before the three buttons.
  const where = (await water.locator(".todo-note").boundingBox())!;
  const fields = (await water.locator(".todo-act").first().boundingBox())!;
  const split = (await water.locator(".todo-act").last().boundingBox())!;
  const box = (await water.boundingBox())!;
  expect(box.x + box.width - (split.x + split.width)).toBeLessThan(12);
  expect(fields.x - (where.x + where.width)).toBeLessThan(16);
});

test("the fields list, from its button, a right-click and the keyboard, says what each chip sets; each chip, set or not, opens its own popover, and each pick rewrites the line in its note as the member's change", async ({ page }) => {
  // The bank is due on a day that is never today, whenever this runs, and "Today" is picked below.
  const due = await localDay(page, 10);
  const homeText = HOME.replace("due:2026-10-14", `due:${due}`);
  const { home } = await twoNotes(page, homeText);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  const today = await localDay(page);

  // The fields button lists each thing the chips set, with what it is now.
  await fieldsOf(page, "Call the bank").click();
  await expect(popover(page)).toHaveAccessibleName("Fields of Call the bank +Home");
  await expect(popover(page).getByRole("button")).toHaveText(["Importance!!", /^Due date\S/, "RepeatAdd", "TagsAdd"]);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);

  // Importance from its chip: the one it has is marked, and a pick saves at once.
  await chipOf(page, "Call the bank", "Importance").click();
  await expect(popover(page)).toHaveAccessibleName("Importance of Call the bank +Home");
  await expect(popover(page).getByRole("button")).toHaveText(["!!!", "!!now", "!", "Normal"]);
  await expect(popover(page).getByRole("button", { name: "!!", exact: true })).toHaveAttribute("aria-current", "true");
  await choose(page, "!");
  await expect.poll(lineIn).toBe(`- [ ] ! Call the bank due:${due} +Home`);
  await expect(popover(page)).toHaveCount(0);
  await expect(chipOf(page, "Call the bank", "Importance")).toBeFocused();

  // The date from its chip.
  await chipOf(page, "Call the bank", "Due date").click();
  await expect(popover(page).getByRole("button")).toHaveText(["Today", "Tomorrow", /^Next week· /, "Clear"]);
  await choose(page, "Today");
  await expect.poll(lineIn).toBe(`- [ ] ! Call the bank due:${today} +Home`);
  await expect(row(page, "Call the bank").locator(".todo-due")).toHaveText("Today");

  // Two picks one after the other, the second before the list has been read again: it is made to the line the first leaves.
  await chipOf(page, "Call the bank", "Due date").click();
  await choose(page, "Clear");
  await expect(row(page, "Call the bank").locator(".todo-due")).toHaveText("Add date");
  // The chip it came from says there is no date now, and still has the keyboard.
  await expect(chipOf(page, "Call the bank", "Due date")).toBeFocused();
  await chipOf(page, "Call the bank", "Importance").click();
  await choose(page, "!!!");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank +Home");

  // The same list, from a right-click anywhere on the row or Shift+F10, for a todo with nothing set.
  await row(page, "Write notes").locator(".todo-note").click({ button: "right" });
  await expect(popover(page)).toHaveAccessibleName("Fields of Write notes");
  await expect(popover(page).getByRole("button")).toHaveText(["ImportanceAdd", "Due dateAdd", "RepeatAdd", "TagsAdd"]);
  await page.keyboard.press("Escape");
  await row(page, "Write notes").getByRole("checkbox").focus();
  await page.keyboard.press("Shift+F10");
  await expect(popover(page).getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  // A date for a todo with none, from its Add date chip, under it.
  const add = chipOf(page, "Write notes", "Due date");
  await expect(add).toHaveAccessibleName("Due date: none");
  await add.click();
  expect(await hangsUnder(page, add)).toEqual({ gap: 4, left: 0, inside: true });
  // A day of the member's choosing from the date field.
  await popover(page).getByLabel("Due on").fill("2026-10-01");
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank +Home", "Water plants"]);

  await row(page, "Call the bank").getByRole("button", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(new RegExp(`${home.id}$`));
  expect(new Set(await authors(page, home.id))).toEqual(new Set(["member Ada Lovelace"]));
  await expect.poll(async () => (await read(page, home.id)).replace("- [ ] !!! Call the bank +Home", `- [ ] !! Call the bank due:${due} +Home`)).toBe(homeText);
});

test("a menu opens at the pointer when there is room, and is moved wholly inside the window when there isn't", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "folder.create", name: "Errands" });
  await page.goto("/todos");
  const tab = page.getByRole("tab", { name: /Todos/ });
  const menu = page.getByRole("menu");
  const inside = async (window: { width: number; height: number }) => {
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(window.width - 8);
    expect(box.y + box.height).toBeLessThanOrEqual(window.height - 8);
    // It is still the menu, with the keyboard in it.
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    return box;
  };

  // With room, at the pointer.
  const at = (await tab.boundingBox())!;
  const press = { x: Math.round(at.x + at.width - 6), y: Math.round(at.y + 12) };
  await page.mouse.click(press.x, press.y, { button: "right" });
  const roomy = (await menu.boundingBox())!;
  expect([Math.round(roomy.x), Math.round(roomy.y)]).toEqual([press.x, press.y]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  // A window too narrow for it right of the pointer: moved left.
  const narrow = { width: press.x + Math.ceil(roomy.width / 2), height: 600 };
  await page.setViewportSize(narrow);
  const there = (await tab.boundingBox())!;
  await page.mouse.click(there.x + there.width - 6, there.y + 12, { button: "right" });
  expect(there.x + there.width - 6 + roomy.width, "it would have run off the right").toBeGreaterThan(narrow.width);
  await inside(narrow);
  await page.keyboard.press("Escape");

  // A window too short for it under the pointer: moved up.
  await page.setViewportSize({ width: 720, height: 600 });
  const errands = page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: "Errands", exact: true });
  const row = (await errands.boundingBox())!;
  const short = { width: 720, height: Math.ceil(row.y + row.height + 20) };
  await page.setViewportSize(short);
  await page.mouse.click(row.x + 20, row.y + row.height / 2, { button: "right" });
  const moved = await inside(short);
  expect(row.y + row.height / 2 + moved.height, "it would have run off the foot").toBeGreaterThan(short.height);
});

test("checking a todo off on the Todos page says so in a toast, and Undo opens it again as a change of its own; opening one says nothing", async ({ page }) => {
  const { home } = await twoNotes(page);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  await bar(page).fill("is:open OR is:done");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);
  await page.evaluate(() => document.fonts.ready);
  const frame = ".todos-page h1, .query-bar, .query-line, .query-line > *, .todo-list";
  const before = await laidOut(page, frame);

  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect.poll(lineIn).toBe("- [x] !! Call the bank due:2026-10-14 +Home");
  // It says just that a task was completed, not which: the member has just pressed it.
  await expect(toast(page)).toHaveText("Task completedUndo");
  await expect(toast(page)).toHaveAttribute("role", "status");
  await expect(toast(page).getByRole("button")).toHaveText(["Undo"]);
  // It is laid over the page: nothing that was there has moved for it, and nothing moves when it goes.
  expect(await toast(page).evaluate((el) => getComputedStyle(el.parentElement!).position)).toBe("fixed");
  expect(await laidOut(page, frame)).toEqual(before);
  await expect(words(page)).toHaveText(["Ship it", "Water plants", "Write notes", "Call the bank +Home", "Book flights"]);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(lineIn).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);
  // The tick and its undo are two changes in History, the member's like any other.
  await expect.poll(() => authors(page, home.id)).toEqual(["member Ada Lovelace", "member Ada Lovelace", "member Ada Lovelace"]);
  await expect.poll(() => read(page, home.id)).toBe(HOME);

  // A newer completion takes the toast's place, and a press on it takes it away with nothing else moving.
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toHaveText("Task completedUndo");
  await row(page, "Write notes").getByRole("checkbox").check();
  await expect(toast(page)).toHaveCount(1);
  await expect(words(page)).toHaveText(["Ship it", "Water plants", "Call the bank +Home", "Book flights", "Write notes"]);
  const withToast = await laidOut(page, ".todos-page *");
  await toast(page).locator(".toast-text").click();
  await expect(toast(page)).toHaveCount(0);
  expect(await laidOut(page, ".todos-page *")).toEqual(withToast);
  expect(await laidOut(page, frame)).toEqual(before);

  // Opening a todo again says nothing.
  await row(page, "Write notes").getByRole("checkbox").uncheck();
  await expect.poll(async () => (await perform(page, { type: "todo.list" })).todos.map((t) => t.words)).toContain("Write notes");
  await expect(toast(page)).toHaveCount(0);

  // Left alone, it goes away by itself after ten seconds, as v1's did.
  await row(page, "Ship it").getByRole("checkbox").check();
  await expect(toast(page)).toHaveText("Task completedUndo");
  const shown = Date.now();
  await expect(toast(page)).toHaveCount(0, { timeout: 14_000 });
  expect(Date.now() - shown).toBeGreaterThan(9000);
});

test("Undo changes nothing when the todo was written another way since: the toast says so", async ({ page }) => {
  const { home } = await twoNotes(page);
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toContainText("Task completed");
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
  await expect(toast(page)).toHaveText("Task completedUndo");
  await expect(toast(page)).toHaveAttribute("role", "status");
  expect(await toast(page).evaluate((el) => getComputedStyle(el.parentElement!).position)).toBe("fixed");
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
  await expect(toast(page)).toHaveText("Task completedUndo");
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
  await toast(page).locator(".toast-text").click();
  await expect(toast(page)).toHaveCount(0);
  expect(await places(page, every)).toEqual(shown);
});

test("Undo opens a todo again after more was changed on it from the page, and after lines were written above it in a note that was left", async ({ page }) => {
  const { home } = await twoNotes(page);
  await bar(page).fill("is:open OR is:done");
  await expect(row(page, "Book flights")).toHaveCount(1);
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toContainText("Task completed");
  await chipOf(page, "Call the bank", "Importance").click();
  await choose(page, "!");
  await expect.poll(async () => (await read(page, home.id)).split("\n")[2]).toBe("- [x] ! Call the bank due:2026-10-14 +Home");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await read(page, home.id)).split("\n")[2]).toBe("- [ ] ! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);

  // Checked off in the note, the note left, and a line written above the todo by someone else before Undo.
  await page.goto(`/note/${home.id}`);
  await line(page, "Call the bank").getByRole("checkbox").click();
  await expect(toast(page)).toContainText("Task completed");
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
  await expect(toast(page)).toContainText("Task completed");
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();
  await expect(words(page)).toHaveText(["Water plants"]);

  await toast(page).getByRole("button", { name: "Undo" }).click();

  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
});

test("the note's name at a row's right opens its note with the cursor on the todo's line, and the editor has what the Todos page changed", async ({ page }) => {
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
  await row(page, "Call the bank").getByRole("button", { name: "Home", exact: true }).click();

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
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const changed = HOME.replace("- [ ] !! Call the bank due:2026-10-14 +Home", "- [ ] Email the landlord\n- [ ] !! Call the credit union due:2026-10-14 +Home");
  await perform(page, { type: "note.write", id: home.id, baseRevision: 1, text: changed });

  await row(page, "Call the bank").getByRole("checkbox").check();

  await expect(todosPage(page).getByRole("alert")).toHaveText("This todo was changed since it was listed. List the todos again.");
  await expect(words(page)).toHaveText(["Ship it", "Call the credit union +Home", "Water plants", "Email the landlord", "Write notes"]);
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
  await expect(words(page)).toHaveText(["Ship it", "Water plants", "Write notes"], { timeout: 20_000 });
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

/** Where a popover is beside the chip it was opened from, and whether it is wholly in the window. */
async function hangsUnder(page: Page, chip: Locator) {
  const at = (await chip.boundingBox())!;
  const panel = (await popover(page).boundingBox())!;
  const view = page.viewportSize()!;
  return {
    gap: Math.round(panel.y - (at.y + at.height)),
    left: Math.round(panel.x - at.x),
    inside: panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= view.width && panel.y + panel.height <= view.height,
  };
}

test("each chip opens its own popover directly under it and inside the window, one at a time, with its card marked and nothing in the list moved", async ({ page }) => {
  const { home } = await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  const cards = () => page.evaluate(() => [...document.querySelectorAll(".todo-row")].map((el) => JSON.stringify(el.getBoundingClientRect())));
  const shown = await cards();

  // The second is opened over the first, which closes; the others after Escape, since an open popover lies over the cards under its own.
  for (const [text, kind, after] of [["Call the bank", "Due date", ""], ["Call the bank", "Importance", "Escape"], ["Ship it", "Due date", "Escape"], ["Water plants", "Importance", ""]] as const) {
    const chip = chipOf(page, text, kind);
    await chip.click();
    await expect(popover(page)).toHaveCount(1);
    await expect(popover(page)).toHaveAccessibleName(new RegExp(`^${kind} of ${text}`));
    expect(await hangsUnder(page, chip), `${kind} of ${text}`).toEqual({ gap: 4, left: 0, inside: true });
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    // The card being changed is marked, and only it.
    await expect(rows(page).and(page.locator("[data-picking]"))).toHaveText([new RegExp(`^${text}`)]);
    expect(await cards(), "nothing in the list moves").toEqual(shown);
    if (after) await page.keyboard.press(after);
  }
  // Pressed again, its chip closes it; a press outside closes it too.
  await chipOf(page, "Water plants", "Importance").click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator(".todo-row[data-picking]")).toHaveCount(0);
  await chipOf(page, "Ship it", "Importance").click();
  await todosPage(page).getByRole("heading", { level: 1 }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator(".todo-row[data-picking]")).toHaveCount(0);
  await expect(chipOf(page, "Ship it", "Importance")).toHaveAttribute("aria-expanded", "false");

  // Near the foot of a short window it opens above its chip, still wholly inside.
  await page.setViewportSize({ width: 900, height: 420 });
  const low = chipOf(page, "Water plants", "Importance");
  await low.scrollIntoViewIfNeeded();
  await low.click();
  const placed = await hangsUnder(page, low);
  expect(placed.inside).toBe(true);
  await page.keyboard.press("Escape");
  // Where it fits neither below nor above, it is on the side with more room, wholly inside, and never over its chip.
  await page.setViewportSize({ width: 700, height: 300 });
  const tight = chipOf(page, "Call the bank", "Due date");
  await tight.scrollIntoViewIfNeeded();
  await tight.click();
  expect((await hangsUnder(page, tight)).inside).toBe(true);
  const [chipBox, panelBox] = [(await tight.boundingBox())!, (await popover(page).boundingBox())!];
  expect(panelBox.y >= chipBox.y + chipBox.height || panelBox.y + panelBox.height <= chipBox.y, "the popover is not over its chip").toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(lineIn).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
});

test("a popover open on a card closes when the list is read again with another todo on that line, so a pick never lands on the one that came", async ({ page }) => {
  test.setTimeout(90_000);
  const { home } = await twoNotes(page);
  await chipOf(page, "Call the bank", "Due date").click();
  await expect(popover(page)).toHaveAccessibleName("Due date of Call the bank +Home");
  // Someone else writes a todo above it: the card that held the bank's line now holds the new one.
  const { revision, text } = await perform(page, { type: "note.read", id: home.id });
  await perform(page, { type: "note.write", id: home.id, baseRevision: revision, text: text.replace("- [ ] !! Call", "- [ ] Inserted above due:2026-10-02\n- [ ] !! Call") });
  await expect(row(page, "Inserted above")).toHaveCount(1, { timeout: 45_000 });
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator(".todo-row[data-picking]")).toHaveCount(0);
  await expect.poll(async () => (await read(page, home.id)).split("\n").slice(2, 4)).toEqual(["- [ ] Inserted above due:2026-10-02", "- [ ] !! Call the bank due:2026-10-14 +Home"]);
});

test("the keyboard reaches every chip: Enter opens its popover on what it says now, arrows go through the choices, Enter picks, and Escape goes back to the chip changing nothing", async ({ page }) => {
  const { home } = await twoNotes(page);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  const chip = chipOf(page, "Call the bank", "Importance");

  await row(page, "Call the bank").getByRole("checkbox").focus();
  await page.keyboard.press("Tab");
  await expect(row(page, "Call the bank").locator(".todo-words")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popover(page).getByRole("button", { name: "!!", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).getByRole("button", { name: "!", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(popover(page).getByRole("button", { name: "!!!", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(popover(page).getByRole("button", { name: "Normal", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(chip).toBeFocused();
  expect(await lineIn()).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");

  await page.keyboard.press(" ");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2026-10-14 +Home");
  await expect(chip).toBeFocused();

  // On to the date's chip; a date typed into the field is saved on Enter, not on the way there.
  await page.keyboard.press("Tab");
  await expect(chipOf(page, "Call the bank", "Due date")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popover(page).getByRole("button", { name: "Today", exact: true })).toBeFocused();
  await popover(page).getByLabel("Due on").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("2031");
  await expect(popover(page)).toHaveCount(1);
  expect(await lineIn()).toBe("- [ ] !!! Call the bank due:2026-10-14 +Home");
  await page.keyboard.press("Enter");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-10-14 +Home");
  await expect(popover(page)).toHaveCount(0);
});

test("in a note, a todo's chip opens the same popover under it without moving the cursor, a pick is the member's edit undone like typing, and the keyboard goes back to the note", async ({ page }) => {
  const note = await open(page, CHORES);
  const lineIn = async () => (await read(page, note.id)).split("\n")[2];
  const due = line(page, "Call the bank").getByRole("button", { name: /^Due date: / });
  const importance = line(page, "Call the bank").getByRole("button", { name: /^Importance: / });

  await due.click();
  await expect(popover(page)).toHaveAccessibleName("Due date");
  expect(await hangsUnder(page, due)).toEqual({ gap: 4, left: 0, inside: true });
  await expect(popover(page).getByRole("button")).toHaveText(["Today", "Tomorrow", /^Next week· /, "Clear"]);
  // Another chip's popover takes its place: one at a time.
  await importance.click();
  await expect(popover(page)).toHaveCount(1);
  await expect(popover(page)).toHaveAccessibleName("Importance");
  expect(await hangsUnder(page, importance)).toEqual({ gap: 4, left: 0, inside: true });
  // The cursor stayed on the title, so the line is drawn as it was.
  expect(await cursorLine(page)).toContain("Chores");
  await expectShown(line(page, "Call the bank"), "!! Call the bank Oct 14, 2031 +Home about the card");

  await choose(page, "!!!");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-10-14 +Home about the card");
  await expect(popover(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lineIn).toBe("- [ ] !! Call the bank due:2031-10-14 +Home about the card");

  // Escape closes it and gives the note the keyboard back, changing nothing.
  await due.click();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  expect(await lineIn()).toBe("- [ ] !! Call the bank due:2031-10-14 +Home about the card");
});

test("a chip of what isn't set opens the same popover as a set one: Importance and Add date set it, and Add tag writes a tag in use, or a new one typed, after the words", async ({ page }) => {
  const { work } = await twoNotes(page);
  const lineIn = async (n: number) => (await read(page, work.id)).split("\n")[n];
  const notes = row(page, "Write notes");

  await chipOf(page, "Write notes", "Importance").click();
  await expect(popover(page)).toHaveAccessibleName("Importance of Write notes");
  await expect(popover(page).getByRole("button", { name: "Normal", exact: true })).toHaveAttribute("aria-current", "true");
  await choose(page, "!!");
  await expect.poll(() => lineIn(3)).toBe("- [ ] !! Write notes");
  await expect(chipOf(page, "Write notes", "Importance")).toHaveText("!!");
  await expect(chipOf(page, "Write notes", "Importance")).not.toHaveAttribute("data-unset");

  // The tags in use, narrowed as one is typed; a pick is written after the words.
  await notes.getByRole("button", { name: "Add tag" }).click();
  await expect(popover(page)).toHaveAccessibleName("Tag of Write notes");
  await expect(popover(page).getByLabel("Tag")).toBeFocused();
  await expect(popover(page).getByRole("button")).toHaveText(["#office", "#outside"]);
  await page.keyboard.type("off");
  await expect(popover(page).getByRole("button")).toHaveText(["#office", "Add #off"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => lineIn(3)).toBe("- [ ] !! Write notes #office");
  await expect(notes.locator(".todo-text button.todo-tag")).toHaveText(["#office"]);
  await expect(notes.getByRole("button", { name: "Add tag" })).toHaveCount(0);
  await expect(fieldsOf(page, "Write notes")).toBeFocused();

  // A new tag typed whole is written on Enter, and the rest of the line stays as it was.
  await row(page, "Ship it").getByRole("button", { name: "Add tag" }).click();
  await page.keyboard.type("#Launch");
  await expect(popover(page).getByRole("button")).toHaveText(["Add #Launch"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => lineIn(2)).toBe("- [ ] !!! Ship it #Launch due:2026-10-12");
  // Something that can't be a tag is not offered and Enter writes nothing.
  await row(page, "Call the bank").getByRole("button", { name: "Add tag" }).click();
  await page.keyboard.type("two words");
  await expect(popover(page).getByRole("button")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(popover(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  expect(new Set(await authors(page, work.id))).toEqual(new Set(["member Ada Lovelace"]));
});

test("pressing a todo's words edits them right there, with its chips where they were: Enter or leaving saves through the op, Escape puts them back, and a held key opens the note", async ({ page }) => {
  const { home } = await twoNotes(page);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  // The second row, by where it is: while it is edited its words are a field's value, not its text.
  const bank = rows(page).nth(1);
  await expect(bank).toContainText("Call the bank");
  const field = bank.getByRole("textbox");
  const chips = () => bank.locator(".todo-chip").evaluateAll((all) => all.map((el) => [el.textContent, Math.round(el.getBoundingClientRect().y)]));
  const before = { chips: await chips(), rows: await rows(page).evaluateAll((all) => all.map((el) => JSON.stringify(el.getBoundingClientRect()))) };

  await bank.locator(".todo-words").click();
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Call the bank +Home");
  // A one-line field in v1's look, laid where the words were: the chips stay on the row after it, and no row moves.
  expect(await field.evaluate((el) => [getComputedStyle(el).borderRadius, getComputedStyle(el).height, getComputedStyle(el).boxShadow.includes("3px")])).toEqual(["6px", "26px", true]);
  expect(await chips()).toEqual(before.chips);
  expect(await rows(page).evaluateAll((all) => all.map((el) => JSON.stringify(el.getBoundingClientRect())))).toEqual(before.rows);

  // Escape puts the words back and writes nothing.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Something else");
  await page.keyboard.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(bank.locator(".todo-words")).toHaveText("Call the bank +Home");
  await expect(bank.locator(".todo-words")).toBeFocused();
  expect(await lineIn()).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");

  // Enter saves: the words change, the importance and the date stay.
  await page.keyboard.press("Enter");
  await expect(field).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Call the credit union");
  await page.keyboard.press("Enter");
  await expect(row(page, "Call the credit union").locator(".todo-words")).toHaveText("Call the credit union");
  await expect.poll(lineIn).toBe("- [ ] !! Call the credit union due:2026-10-14");
  await expect(chipOf(page, "Call the credit union", "Importance")).toHaveText("!!");

  // Leaving the field saves too; the tags written after the words stay theirs.
  const water = rows(page).nth(2);
  await expect(water).toContainText("Water plants");
  await water.locator(".todo-words").click();
  await expect(water.getByRole("textbox")).toHaveValue("Water plants");
  await page.keyboard.press("End");
  await page.keyboard.type(" and the hedge");
  await todosPage(page).getByRole("heading", { level: 1 }).click();
  await expect.poll(async () => (await read(page, home.id)).split("\n")[4]).toBe("- [ ] ! Water plants and the hedge #outside");
  await expect(row(page, "Water plants and the hedge").locator(".todo-text button.todo-tag")).toHaveText(["#outside"]);
  // Emptied, nothing is written.
  await row(page, "Write notes").locator(".todo-words").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await expect(row(page, "Write notes").locator(".todo-words")).toHaveText("Write notes");
  expect(new Set(await authors(page, home.id))).toEqual(new Set(["member Ada Lovelace"]));
  expect((await perform(page, { type: "note.history", id: home.id })).length).toBe(3);

  // With Ctrl or Cmd held, the words open the note at the todo's line.
  await row(page, "Call the credit union").locator(".todo-words").click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(new RegExp(`${home.id}$`));
  await expect.poll(() => cursorLine(page)).toContain("Call the credit union");
});

test("the toast is v1's: in the bottom right corner in the app's colours, Task completed and Undo; it waits while pointed at, and the row stays a moment struck through before it leaves the list", async ({ page }) => {
  test.setTimeout(60_000);
  await twoNotes(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await row(page, "Water plants").getByRole("checkbox").check();
  const ticked = Date.now();
  // The row stays, ticked and struck through, then leaves an open list.
  await expect(row(page, "Water plants")).toHaveAttribute("data-done", "true");
  await expect(row(page, "Water plants").locator(".todo-words")).toHaveCSS("text-decoration-line", "line-through");
  await expect(row(page, "Water plants")).toHaveCount(0, { timeout: 5000 });

  const box = (await toast(page).boundingBox())!;
  expect([Math.round(1280 - box.x - box.width), Math.round(800 - box.y - box.height)]).toEqual([18, 44]);
  expect(box.width).toBeGreaterThanOrEqual(240);
  expect(box.width).toBeLessThanOrEqual(340);
  const looks = await page.evaluate(() => {
    const card = getComputedStyle(document.querySelector(".toast-card")!);
    const root = getComputedStyle(document.documentElement);
    const probe = document.body.appendChild(document.createElement("i"));
    probe.style.color = root.getPropertyValue("--bg-elev");
    const elev = getComputedStyle(probe).color;
    probe.remove();
    return { background: card.backgroundColor === elev, radius: card.borderRadius, icon: getComputedStyle(document.querySelector(".toast-icon")!).width };
  });
  expect(looks).toEqual({ background: true, radius: "12px", icon: "26px" });

  // Pointed at near its end, it stays past its ten seconds, and is given two more once the pointer leaves.
  await page.waitForTimeout(8500 - (Date.now() - ticked));
  await toast(page).hover();
  await page.waitForTimeout(3000);
  await expect(toast(page)).toHaveCount(1);
  await page.mouse.move(10, 10);
  const left = Date.now();
  await expect(toast(page)).toHaveCount(0, { timeout: 5000 });
  expect(Date.now() - left).toBeGreaterThan(1500);
});

test("the inspector is about the notes the listed todos are in: Info counts them and History is theirs", async ({ page }) => {
  await twoNotes(page);
  await perform(page, { type: "note.create", text: "# No todos\n\nJust words." });
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await pinPanel(page, "Info");
  const panel = page.getByRole("complementary", { name: "Inspector" });
  await expect(panel.getByRole("term")).toHaveText(["Showing", "Notes", "Last changed"]);
  await expect(panel.getByRole("definition").first()).toHaveText("Todos");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("2 notes");
  // Narrowed, it follows the list.
  await bar(page).fill("#office");
  await expect(panel.getByRole("definition").nth(1)).toHaveText("1 note");
  await page.getByRole("navigation", { name: "Inspector bar" }).getByRole("button", { name: "History" }).click();
  await expect(panel.getByRole("tree", { name: "Notes that changed" }).locator('[aria-level="1"]')).toHaveText([/Work/]);
});

test("a todo's words being edited are left alone when the list is read again with another todo on that line, and a tag typed again is written once", async ({ page }) => {
  test.setTimeout(90_000);
  const { home } = await twoNotes(page);
  const bank = rows(page).nth(1);
  await expect(bank).toContainText("Call the bank");
  await bank.locator(".todo-words").click();
  await expect(bank.getByRole("textbox")).toBeFocused();
  // Someone else writes a todo above it: the row that held the bank's line now holds the new one, and the field closes.
  const { revision, text } = await perform(page, { type: "note.read", id: home.id });
  await perform(page, { type: "note.write", id: home.id, baseRevision: revision, text: text.replace("- [ ] !! Call", "- [ ] Inserted above\n- [ ] !! Call") });
  await expect(row(page, "Inserted above")).toHaveCount(1, { timeout: 45_000 });
  await expect(rows(page).getByRole("textbox")).toHaveCount(0);
  await page.keyboard.type("Typed after");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await read(page, home.id)).split("\n").slice(2, 4)).toEqual(["- [ ] Inserted above", "- [ ] !! Call the bank due:2026-10-14 +Home"]);

  // A tag after the words, typed again in the field, is written once.
  const water = rows(page).filter({ hasText: "Water plants" });
  await water.locator(".todo-words").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" #outside");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await read(page, home.id)).split("\n")[5]).toBe("- [ ] ! Water plants #outside");

  // A row just checked off can be unticked while it stays, and its box says so at once.
  await row(page, "Water plants").getByRole("checkbox").check();
  await row(page, "Water plants").getByRole("checkbox").uncheck();
  await expect(row(page, "Water plants").getByRole("checkbox")).not.toBeChecked();
  await expect.poll(async () => (await read(page, home.id)).split("\n")[5]).toBe("- [ ] ! Water plants #outside");
});

test("each row has v1's three buttons, out of sight until it is pointed at or has the keyboard and keeping their room: its fields, whose every line opens that chip's popover, go to the note, and open it in a split, each at the todo's line", async ({ page }) => {
  const { work } = await twoNotes(page);
  const bank = row(page, "Call the bank");
  const acts = bank.locator(".todo-act");
  await expect(acts).toHaveCount(3);
  await page.mouse.move(1, 1);
  expect(await acts.evaluateAll((all) => all.map((b) => `${getComputedStyle(b).opacity} ${b.getBoundingClientRect().width}`))).toEqual(["0 24", "0 24", "0 24"]);
  const shape = ".todo-row, .todo-words, .todo-chip, .todo-note";
  const before = await laidOut(page, shape);
  await bank.hover();
  await expect(acts.first()).toHaveCSS("opacity", "1");
  await expect(acts.last()).toHaveCSS("opacity", "1");
  expect(await laidOut(page, shape)).toEqual(before);
  await expect(bank.getByRole("button", { name: "Fields of Call the bank +Home" })).toHaveAttribute("title", "Importance, due date, repeat, tags…");
  await expect(bank.getByRole("button", { name: "Go to Home" })).toHaveAttribute("title", "Go to note");
  await expect(bank.getByRole("button", { name: "Open Home in split view" })).toHaveAttribute("title", "Open in split view");

  // Tab reaches them, and they show while the keyboard is in the row.
  await page.mouse.move(1, 1);
  await row(page, "Write notes").locator(".todo-note").focus();
  await page.keyboard.press("Tab");
  await expect(fieldsOf(page, "Write notes")).toBeFocused();
  await expect(row(page, "Write notes").locator(".todo-act").last()).toHaveCSS("opacity", "1");
  // Enter lists the fields; a field opens its chip's popover in the list's place, under the button, and a pick saves.
  await page.keyboard.press("Enter");
  await expect(popover(page)).toHaveAccessibleName("Fields of Write notes");
  await expect(row(page, "Write notes")).toHaveAttribute("data-picking", "fields");
  await page.keyboard.press("ArrowDown");
  await expect(field(page, "Due date")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toHaveAccessibleName("Due date of Write notes");
  await expect(row(page, "Write notes")).toHaveAttribute("data-picking", "due");
  expect(await hangsUnder(page, fieldsOf(page, "Write notes"))).toEqual({ gap: 4, left: 0, inside: true });
  // Pressed again while that popover hangs from it, it closes it, and the row is marked as nothing open.
  await fieldsOf(page, "Write notes").click();
  await expect(popover(page)).toHaveCount(0);
  await expect(row(page, "Write notes")).not.toHaveAttribute("data-picking");
  await expect(fieldsOf(page, "Write notes")).toHaveAttribute("aria-expanded", "false");
  await fieldsOf(page, "Write notes").click();
  await expect(popover(page)).toHaveAccessibleName("Fields of Write notes");
  await expect(fieldsOf(page, "Write notes")).toHaveAttribute("aria-expanded", "true");
  await field(page, "Due date").click();
  await choose(page, "Tomorrow");
  const tomorrow = await localDay(page, 1);
  await expect.poll(async () => (await read(page, work.id)).split("\n")[3]).toBe(`- [ ] Write notes due:${tomorrow}`);
  await expect(fieldsOf(page, "Write notes")).toBeFocused();
  // Read again, with a date it comes before the todo with none.
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Write notes", "Water plants"]);
  await fieldsOf(page, "Write notes").click();
  await field(page, "Tags").click();
  await expect(popover(page)).toHaveAccessibleName("Tag of Write notes");
  await page.keyboard.type("desk");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await read(page, work.id)).split("\n")[3]).toBe(`- [ ] Write notes #desk due:${tomorrow}`);

  // Go to note: the note in front, the cursor on the todo's line.
  await row(page, "Ship it").hover();
  await row(page, "Ship it").getByRole("button", { name: /^Go to Work/ }).click();
  await expect(page).toHaveURL(new RegExp(`${work.id}$`));
  await expect.poll(() => cursorLine(page)).toContain("Ship it");

  // Open in split view: the note beside the Todos page, the cursor on the todo's line.
  await page.goto("/todos");
  await row(page, "Water plants").hover();
  await row(page, "Water plants").getByRole("button", { name: "Open Home in split view" }).click();
  await expect(editor(page)).toContainText("Water plants");
  await expect(todosPage(page)).toBeVisible();
  await expect.poll(() => cursorLine(page)).toContain("Water plants");
});

test("a link in a todo's words shows what the note shows: its note's title or its own words, and the field it is edited in has it as written", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const groceries = await perform(page, { type: "note.create", text: "# Groceries\n\nMilk." });
  const text = `# Errands\n\n- [ ] Buy what [[${groceries.id}]] lists\n- [ ] Ask about [[zzzzzzzzzzzz]]\n- [ ] Type \`[[${groceries.id}]]\` to link\n- [x] Done from [[${groceries.id}|the list]]\n`;
  // A link to no note there is, kept as it is written.
  await perform(page, { type: "note.create", text, linkTitles: "keep" });
  await page.goto("/todos");
  await bar(page).fill("is:open OR is:done");
  await expect(words(page)).toHaveText(["Buy what Groceries lists", "Ask about Unavailable note", `Type \`[[${groceries.id}]]\` to link`, "Done from the list"]);
  await expect(row(page, "Buy what").locator(".todo-link")).toHaveText("Groceries");
  // What the row is called by says the link as it is shown.
  await expect(fieldsOf(page, "Buy what")).toHaveAccessibleName("Fields of Buy what Groceries lists");
  await row(page, "Buy what").locator(".todo-words").click();
  await expect(rows(page).getByRole("textbox")).toHaveValue(`Buy what [[${groceries.id}]] lists`);
  await page.keyboard.press("Escape");
});

test("in a narrow window with both sidebars open, a row's words keep the room and its note's name and buttons go under them", async ({ page }) => {
  await twoNotes(page);
  await page.setViewportSize({ width: 420, height: 720 });
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
  for (const each of await rows(page).all()) {
    const shape = await each.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const text = el.querySelector(".todo-text")!.getBoundingClientRect();
      const end = el.querySelector(".todo-end")!.getBoundingClientRect();
        const name = el.querySelector(".todo-note")!;
      return { room: Math.round(box.right - text.left - text.width), under: end.top >= text.bottom - 1, name: name.scrollWidth <= name.clientWidth || name.clientWidth >= 80 };
    });
    // The words run to the row's end, less its padding, and nothing beside them.
    expect(shape.room).toBeLessThanOrEqual(8);
    expect(shape.under).toBe(true);
    // The note's name is not squeezed to a letter: the buttons go under it first.
    expect(shape.name).toBe(true);
  }
  // No word is broken across lines.
  await expect(row(page, "Ship it").locator(".todo-words")).toHaveText("Ship it");
  expect(await row(page, "Ship it").locator(".todo-words").evaluate((el) => el.getClientRects().length)).toBe(1);
});

test("a row that leaves the list after its moment gives the keyboard to the row in its place, or the one before it when it was last", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await row(page, "Call the bank").getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await expect(row(page, "Call the bank")).toHaveCount(0, { timeout: 5000 });
  await expect(row(page, "Water plants").getByRole("checkbox")).toBeFocused();
  await row(page, "Write notes").getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await expect(row(page, "Write notes")).toHaveCount(0, { timeout: 5000 });
  await expect(row(page, "Water plants").getByRole("checkbox")).toBeFocused();

  // Shift+F10 while the words are being edited leaves the field alone: nothing opens and nothing is saved.
  await row(page, "Water plants").locator(".todo-words").click();
  await page.keyboard.type(" later");
  await page.keyboard.press("Shift+F10");
  await expect(rows(page).getByRole("textbox")).toBeFocused();
  await expect(popover(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(row(page, "Water plants").locator(".todo-words")).toBeFocused();
  await expect(row(page, "Water plants").locator(".todo-words")).toHaveText("Water plants");

  // Rows listed above it since the keyboard came to it: still the row in its place.
  await row(page, "Ship it").getByRole("checkbox").focus();
  await perform(page, { type: "note.create", text: "# Early\n\n- [ ] !!! First due:2020-01-01\n- [ ] !!! Second due:2020-01-02\n" });
  await expect(words(page)).toHaveText(["First", "Second", "Ship it", "Water plants"], { timeout: 20_000 });
  await expect(row(page, "Ship it").getByRole("checkbox")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(row(page, "Ship it")).toHaveCount(0, { timeout: 5000 });
  await expect(row(page, "Water plants").getByRole("checkbox")).toBeFocused();
});

test("a read of the list or of the notes that fails, as one can under load, is asked again: an outside change still shows, and nothing is thrown", async ({ page }) => {
  const { home } = await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const failing = new Set(["todo.list", "note.list", "folder.list"]);
  await page.route("**/ops", async (route) => {
    const op = route.request().postDataJSON() as { type?: string; updatedSince?: number } | null;
    const once = op?.type === "note.list" && op.updatedSince !== undefined ? null : op?.type;
    if (once && failing.delete(once)) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "Internal Server Error" }) });
    await route.fallback();
  });
  // The notes and folders are listed again when the window has the focus back, and fail once each.
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await expect.poll(() => [...failing]).not.toContain("folder.list");
  const { revision, text } = await perform(page, { type: "note.read", id: home.id });
  await perform(page, { type: "note.write", id: home.id, baseRevision: revision, text: text.replace("- [ ] !! Call", "- [ ] Inserted above\n- [ ] !! Call") });
  await expect.poll(() => [...failing]).toEqual([]);
  await expect(row(page, "Inserted above")).toHaveCount(1, { timeout: 20_000 });
  await expect(todosPage(page).getByRole("alert")).toHaveCount(0);
});
