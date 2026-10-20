import { expect, test, type Locator, type Page } from "@playwright/test";
import { todosIn } from "../../src/core/todos.ts";
import { anotherPerson, asViewerOfNote, connectAgent, join, me, perform, pinPanel, signInAs, signInAsNewPerson } from "./helpers.ts";
import { closeSettings, group } from "./settings-helpers.ts";

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
const problem = (page: Page) => todosPage(page).locator(".query-error");
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

test("a todo's priority and due date are drawn as chips, on the lines the server takes for todos and no others, and a +Name is words", async ({ page }) => {
  const note = await open(page, CHORES);

  await expect(editor(page).getByRole("checkbox")).toHaveCount(4);
  await expect(editor(page).getByRole("button", { name: /^Priority: / })).toHaveCount(2);
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

  await bank().getByRole("button", { name: /^Priority: / }).click();
  await choose(page, "High");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-10-14 +Home about the card");
  await bank().getByRole("button", { name: /^Due date: / }).click();
  await popover(page).getByLabel("Due on").fill("2031-12-25");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-12-25 +Home about the card");
  await expectShown(bank(), "!!! Call the bank Dec 25, 2031 +Home about the card");
  await bank().getByRole("checkbox").click();
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Home about the card");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  // Taking an option away takes its token and the space before it, and undo puts both back.
  await bank().getByRole("button", { name: /^Priority: / }).click();
  await choose(page, "None");
  await expect.poll(lineIn).toBe("- [x] Call the bank due:2031-12-25 +Home about the card");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Home about the card");
  await bank().getByRole("button", { name: /^Priority: / }).click();
  await choose(page, "None");
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
  for (const control of [editor(page).getByRole("checkbox").first(), editor(page).getByRole("button", { name: /^Priority: / }).first(), editor(page).getByRole("button", { name: /^Due date: / })]) await expect(control).toBeDisabled();
  await editor(page).getByRole("button", { name: /^Due date: / }).click({ force: true });
  await expect(popover(page)).toHaveCount(0);

  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Call the bank +Home about the card", "Deep one +Garden", "Plain one"]);
  for (const control of await rows(page).getByRole("checkbox").all()) await expect(control).toBeDisabled();
  for (const control of await rows(page).getByRole("button", { name: /^(Priority|Due date): / }).all()) await expect(control).toBeDisabled();
  // What isn't set isn't offered to someone who can't set it.
  await expect(rows(page).locator(".todo-chip[data-unset]")).toHaveCount(0);
  await expect(row(page, "Plain one").locator(".todo-words")).not.toHaveAttribute("role", "button");
  // Its menu, from a right-click, has nothing to set and still goes to its note.
  await row(page, "Plain one").locator(".todo-words").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open note", "Open to the side"]);
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(row(page, "Plain one").locator(".todo-note")).toHaveText("Chores");
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

const menu = (page: Page) => page.getByRole("menu");
/** Opens a row's menu with a right-click on its words. */
const menuOf = async (page: Page, text: string) => {
  await row(page, text).locator(".todo-words").click({ button: "right" });
  await expect(menu(page)).toBeVisible();
};
/** Where each part of a row is, by its first class: its box, to the pixel. */
const partsOf = (of: Locator) =>
  of.evaluate((li) =>
    [...li.querySelectorAll<HTMLElement>(".todo-box, .todo-words, .todo-edit, .todo-chip, .todo-note")].map((el) => {
      const box = el.getBoundingClientRect();
      return { part: el.classList[0]!, text: el.textContent ?? "", left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width };
    }),
  );
const chipOf = (page: Page, text: string, kind: "Priority" | "Due date") => row(page, text).getByRole("button", { name: new RegExp(`^${kind}: `) });
const toast = (page: Page) => page.locator(".toast-card");
/** The bar at the top of the list that says the order has changed, with Refresh. */
const orderBar = (page: Page) => todosPage(page).locator(".todo-order");
/** Waits for the order bar to have opened to its height, and answers how far it moved the rows down: its height and its gap. */
const barOpened = async (page: Page) => {
  await expect(orderBar(page)).toBeVisible();
  await page.waitForFunction(() => document.querySelector(".todo-order")!.getAnimations().length === 0);
  return orderBar(page).evaluate((el) => el.getBoundingClientRect().height + parseFloat(getComputedStyle(el).marginBottom));
};
/** Where everything on the page that isn't the toast is: each thing's box, to the pixel. */
const laidOut = (page: Page, within: string) =>
  page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((el) => [el.className || el.tagName, ...(["x", "y", "width", "height"] as const).map((side) => Math.round(el.getBoundingClientRect()[side] * 10) / 10)].join(" ")), within);

test("the Todos page lists open todos from every note, and its builder narrows by folder, tag, due date and priority, and to completed ones too", async ({ page }) => {
  const { home, work } = await twoNotes(page);

  await expect(todosPage(page).getByRole("heading", { level: 1 })).toHaveText("Todos");
  // A +Name is words of the todo: nothing is made of it.
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await expect(row(page, "Ship it").locator(".todo-note")).toHaveText("Work");
  // At rest there is the bar and Advanced, and no filter of the page's own.
  await expect(bar(page)).toHaveValue("");
  await expect(todosPage(page).getByRole("combobox")).toHaveCount(1);
  await expect(todosPage(page).getByRole("combobox", { name: "Sort" })).toBeVisible();
  await expect(todosPage(page).getByRole("group", { name: "Filters" })).toHaveCount(0);

  // Done todos too: any of open or done, which the builder writes in the bar.
  await advanced(page).click();
  // The first condition is there, ready to fill in. Shared and Private are who can see a todo's note, apart from its state.
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Visibility" });
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" }).getByRole("option")).toHaveText(["Choose…", "shared", "private"]);
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "State" });
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" }).getByRole("option")).toHaveText(["Choose…", "open", "done", "archived", "trashed"]);
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
  // With the last condition gone, an empty one is left to fill in.
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(1);
  await expect(condition(page, 1).getByRole("textbox", { name: "Value" })).toHaveValue("");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);

  // A folder lists its notes' todos and those of the folders under it.
  const house = await perform(page, { type: "folder.create", name: "House" });
  const garden = await perform(page, { type: "folder.create", name: "Garden", parentId: house.id });
  const office = await perform(page, { type: "folder.create", name: "Office" });
  await perform(page, { type: "note.move", id: home.id, folderId: garden.id });
  await perform(page, { type: "note.move", id: work.id, folderId: office.id });
  await page.reload();
  await advanced(page).click();
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

  // Priority and due take a comparison, and a row is no part of the query until it says something.
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Priority" });
  await expect(bar(page)).toHaveValue("");
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" }).getByRole("option")).toHaveText(["Choose…", "High", "Medium", "Low", "None"]);
  await condition(page, 1).getByRole("combobox", { name: "Value" }).selectOption({ label: "Medium" });
  await expect(bar(page)).toHaveValue("priority:medium");
  await expect(words(page)).toHaveText(["Call the bank +Home"]);
  await condition(page, 1).getByRole("combobox", { name: "Comparison" }).selectOption("at least");
  await expect(bar(page)).toHaveValue("priority:>=medium");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home"]);
  await condition(page, 1).getByRole("combobox", { name: "Comparison" }).selectOption("exactly");
  await condition(page, 1).getByRole("combobox", { name: "Value" }).selectOption({ label: "None" });
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
  await asked("priority:>=medium", ["Ship it", "Call the bank +Home"]);
  await asked("priority:low..medium sort:priority-desc", ["Call the bank +Home", "Water plants"]);
  // importance: is another name for priority:, and 0 to 3 read as none to high.
  await asked("importance:>=2", ["Ship it", "Call the bank +Home"]);
  await asked("importance:1..2 sort:importance-desc", ["Call the bank +Home", "Water plants"]);
  await asked("has:due sort:due-desc", ["Call the bank +Home", "Ship it"]);
  await asked("#office no:due", ["Write notes"]);
  await asked("editor:@me -tag:office", ["Call the bank +Home", "Water plants"]);
  await asked("due:<2026-10-13 OR no:due", ["Ship it", "Water plants", "Write notes"]);

  // A query that can't be read is said so, with where, and the list stays as it was. One for notes alone says so.
  await bar(page).fill("priority:urgent");
  await expect(problem(page)).toContainText('priority: takes high, medium, low or none, and "urgent" isn\'t one');
  await expect(problem(page).locator("mark")).toHaveText("urgent");
  await expect(bar(page)).toHaveAttribute("aria-invalid", "true");
  await expect(words(page)).toHaveText(["Ship it", "Water plants", "Write notes"]);
  await bar(page).fill("has:todo");
  await expect(problem(page)).toContainText("has:todo is for notes, and this is a search of todos");
  await bar(page).fill("priority:high");
  await expect(problem(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Ship it"]);

  // One the server refuses is said so too, and the list of the query before is not left under it.
  await bar(page).fill("folder:Nowhere");
  await expect(problem(page)).toHaveText('No folder named "Nowhere"');
  await expect(rows(page)).toHaveCount(0);
  await bar(page).fill("priority:high");
  await expect(problem(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Ship it"]);

  // The filters of todos are offered as they are typed, and Tab takes one.
  await bar(page).fill("");
  await bar(page).pressSequentially("du");
  await expect(todosPage(page).getByRole("listbox").getByRole("option")).toHaveText([/^due:/]);
  await page.keyboard.press("Tab");
  await expect(bar(page)).toHaveValue("due:");
  await expect(todosPage(page).getByRole("listbox").getByRole("option")).toHaveText(["today", "yesterday", "tomorrow", "7d", "+7d"]);
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
  const help = page.getByRole("dialog", { name: "Query syntax" });
  await expect(help.getByRole("table", { name: "State" }).getByRole("rowheader")).toHaveText(["is:open", "is:done", "is:archived", "is:trashed"]);
  await expect(help.getByRole("table", { name: "Visibility" }).getByRole("rowheader")).toHaveText(["is:shared", "is:private"]);
  const box = (await help.boundingBox())!;
  expect(box.x >= 0 && box.x + box.width <= 380 && box.y >= 0 && box.y + box.height <= 800).toBe(true);
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(builder(page).getByRole("group", { name: /^Condition / })).toHaveCount(3);
  await builder(page).getByRole("combobox", { name: "Sort" }).selectOption("due-desc");
  // The builder writes the query back with priority:, the name importance: is another for.
  await expect(bar(page)).toHaveValue("due:2026-10-01..2026-10-31 OR priority:>=medium OR -tag:office sort:due-desc");
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

test("a todo has the tags on its own line and its note's: its own are drawn as chips after its words, and its note's name is said alone, narrowed to a tag or not", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const names = () => rows(page).locator(".todo-note");
  // Nothing follows the note's name, not even a tag its title ends in.
  await expect(names()).toHaveText(["Work", "Home", "Home", "Work"]);
  await expect(row(page, "Ship it").locator(".todo-note")).toHaveAttribute("title", "Open Work");

  // A tag written at the end of its words is a chip under them, and no row says a tag its line doesn't write.
  await expect(row(page, "Water plants").locator(".todo-chips .todo-tag")).toHaveText(["#outside"]);
  await expect(rows(page).locator(".todo-tag")).toHaveText(["#outside"]);

  // Under the tag of one todo's line: both todos of the note are tagged with it, and only the one whose line writes it has its chip. The builder offers the tags todos have.
  await advanced(page).click();
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Tag" });
  await expect.poll(() => condition(page, 1).locator("datalist option").evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).toEqual(["office", "outside"]);
  await condition(page, 1).getByRole("combobox", { name: "Value" }).fill("outside");
  await expect(bar(page)).toHaveValue("tag:outside");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
  await expect(rows(page).locator(".todo-tag")).toHaveText(["#outside"]);
  await expect(names()).toHaveText(["Home", "Home"]);
  await expect(row(page, "Call the bank").locator(".todo-note")).toHaveAttribute("title", "Open Home");

  // Under a tag only the note's title writes: every todo of the note, and still only the note's name.
  await bar(page).fill("#office");
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" })).toHaveValue("office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await expect(names()).toHaveText(["Work", "Work"]);
  await expect(rows(page).locator(".todo-tag")).toHaveCount(0);

  await bar(page).fill("");
  await expect(names()).toHaveText(["Work", "Home", "Home", "Work"]);
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
  await expect(row(page, "Water plants").locator(".todo-chips button.todo-tag")).toHaveText(["#outside", "#garden"]);
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

test("a row is two lines: the first only its checkbox, its words and its note's name at the right, the second its chips under the words, each in its one place whether set or not", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const look = await page.evaluate(() => {
    const list = getComputedStyle(document.querySelector(".todo-card")!);
    const row = getComputedStyle(document.querySelector(".todo-row")!);
    const chip = getComputedStyle(document.querySelector(".todo-chip:not([data-unset])")!);
    const unset = getComputedStyle(document.querySelector(".todo-chip[data-unset]")!);
    return {
      list: [list.borderRadius, list.borderTopWidth],
      row: [row.fontSize, row.paddingTop, row.borderRadius],
      chip: [chip.height, chip.fontSize, chip.paddingLeft, chip.borderRadius],
      unset: [unset.height, unset.backgroundColor, unset.borderTopStyle, unset.borderTopColor],
    };
  });
  // What isn't set is quiet: no pill, and its dashed edge is drawn only while the row is pointed at or has the keyboard.
  expect(look).toEqual({ list: ["14px", "1px"], row: ["14.5px", "4px", "7px"], chip: ["18px", "11.5px", "7px", "999px"], unset: ["18px", "rgba(0, 0, 0, 0)", "dashed", "rgba(0, 0, 0, 0)"] });
  // Every row is the same height, whatever is set on it, in either scheme: its words' line and its chips' line, close under it.
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const heights = await rows(page).evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights), colorScheme).toEqual(new Set([46]));
  }
  await page.emulateMedia({ colorScheme: "light" });

  // About 660px wide, in a window with room for far more.
  await page.setViewportSize({ width: 1800, height: 900 });
  expect((await todosPage(page).getByRole("list", { name: "Todos" }).boundingBox())!.width).toBeLessThanOrEqual(662);

  // One order for every row, set or not: the date, the repeat, the priority, the tags, then Add tag; no other buttons.
  const water = row(page, "Water plants");
  // The tag's cross, named "Remove #outside", has no words of its own.
  await expect(water.getByRole("button")).toHaveText(["Water plants", "Add date", "Repeat", "Low", "#outside", "", "Add tag", "Home"]);
  await expect(row(page, "Write notes").locator(".todo-chip")).toHaveText(["Add date", "Repeat", "Priority", "Add tag"]);
  await expect(row(page, "Write notes").locator(".todo-chip[data-unset]")).toHaveCount(4);
  await expect(row(page, "Ship it").locator(".todo-chip")).toHaveText([/\S/, "Repeat", "High", "Add tag"]);
  await expect(row(page, "Ship it").locator(".todo-chip[data-unset]")).toHaveText(["Repeat", "Add tag"]);
  await expect(water.getByRole("checkbox")).toHaveCount(1);

  for (const each of await rows(page).all()) {
    const parts = await partsOf(each);
    const box = (await each.boundingBox())!;
    const said = parts.find((p) => p.part === "todo-words")!;
    const firstLine = await each.locator(".todo-words").evaluate((el) => el.getClientRects()[0]!.bottom);
    // Line 1 holds the checkbox, the words and the note's name, and nothing else.
    expect(parts.filter((p) => p.top < firstLine).map((p) => p.part)).toEqual(["todo-box", "todo-words", "todo-note"]);
    // Line 2 holds every chip, on one line, starting where the words start.
    const chips = parts.filter((p) => p.part === "todo-chip");
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) expect(Math.round(chip.top)).toBe(Math.round(chips[0]!.top));
    expect(Math.abs(chips[0]!.left - said.left)).toBeLessThanOrEqual(0.5);
    expect(chips[0]!.top).toBeGreaterThanOrEqual(said.bottom);
    // The note's name is at the right end of line 1, the row's padding from its edge.
    const note = parts.find((p) => p.part === "todo-note")!;
    expect(Math.round(box.x + box.width - note.right)).toBeLessThanOrEqual(6);
    expect(note.bottom).toBeLessThanOrEqual(chips[0]!.top);
  }
});

test("at 1280px with both sidebars open, no row wraps raggedly: chips stay on one line and long words wrap under their first word", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  await perform(page, {
    type: "note.create",
    text: `# Try in this PR\n\n- [ ] Renew the passport due:${await localDay(page, -5)}\n- [ ] !! Call the bank about the card due:${today} #money\n- [ ] ! Water the plants every:1w due:${today} done:${today}x2 #outside #garden\n- [ ] Order seeds #outside #shopping\n- [ ] Sweep the porch +Home\n- [ ] ! A long todo that runs past the end of the line, so that its second row can be seen to start under its first word and not under the checkbox, with its date near the end due:${await localDay(page, 2)} #outside\n- [ ] An open todo\n`,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/todos");
  await pinPanel(page, "Info");
  await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
  await expect(rows(page)).toHaveCount(7);
  for (const each of await rows(page).all()) {
    const parts = await partsOf(each);
    const chips = parts.filter((p) => p.part === "todo-chip");
    const said = parts.find((p) => p.part === "todo-words")!;
    expect(new Set(chips.map((c) => Math.round(c.top))), `the chips of "${said.text}"`).toEqual(new Set([Math.round(chips[0]!.top)]));
    const lines = await each.locator(".todo-words").evaluate((el) => [...el.getClientRects()].map((r) => Math.round(r.left)));
    expect(new Set(lines), `where each line of "${said.text}" starts`).toEqual(new Set([Math.round(said.left)]));
    if (lines.length === 1) expect(Math.round((await each.boundingBox())!.height), said.text).toBe(46);
  }
  expect(await row(page, "A long todo").locator(".todo-words").evaluate((el) => el.getClientRects().length)).toBeGreaterThan(1);
});

test("the row's menu, from a right-click and the keyboard, only opens the note; each chip, set or not, opens its own popover, and each pick rewrites the line in its note as the member's change, the list keeping its order", async ({ page }) => {
  // The bank is due on a day that is never today, whenever this runs, and "Today" is picked below.
  const due = await localDay(page, 10);
  const homeText = HOME.replace("due:2026-10-14", `due:${due}`);
  const { home } = await twoNotes(page, homeText);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  const today = await localDay(page);

  // A right-click anywhere on the row: the note, or the note beside the list, and nothing the chips set.
  for (const on of [".todo-note", ".todo-words", ".todo-chips"]) {
    await row(page, "Call the bank").locator(on).click({ button: "right", position: { x: 2, y: 2 } });
    await expect(menu(page)).toHaveAccessibleName("More for Call the bank +Home");
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Open note", "Open to the side"]);
    await expect(row(page, "Call the bank")).toHaveAttribute("data-picking", "menu");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
  }

  // Priority from its chip: the one it has is marked, and a pick saves at once.
  await chipOf(page, "Call the bank", "Priority").click();
  await expect(popover(page)).toHaveAccessibleName("Priority of Call the bank +Home");
  await expect(popover(page).getByRole("button")).toHaveText(["High", "Mediumnow", "Low", "None"]);
  await expect(popover(page).getByRole("button", { name: "Medium", exact: true })).toHaveAttribute("aria-current", "true");
  await choose(page, "Low");
  await expect.poll(lineIn).toBe(`- [ ] ! Call the bank due:${due} +Home`);
  await expect(popover(page)).toHaveCount(0);
  await expect(chipOf(page, "Call the bank", "Priority")).toBeFocused();

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
  // The chip it came from says there is no date now, in its same place, and still has the keyboard.
  await expect(chipOf(page, "Call the bank", "Due date")).toBeFocused();
  await chipOf(page, "Call the bank", "Priority").click();
  await choose(page, "High");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank +Home");

  // From the keyboard, Shift+F10 on what has it: the menu opens under it with its first item, Down goes on, and Escape gives the keyboard back.
  await row(page, "Write notes").getByRole("checkbox").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page).getByRole("menuitem", { name: "Open note" })).toBeFocused();
  const box = (await row(page, "Write notes").getByRole("checkbox").boundingBox())!;
  const at = (await menu(page).boundingBox())!;
  expect([Math.round(at.x - box.x), Math.round(at.y - (box.y + box.height))]).toEqual([0, 2]);
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitem", { name: "Open to the side" })).toBeFocused();
  await expect(menu(page).getByRole("menuitem")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(row(page, "Write notes").getByRole("checkbox")).toBeFocused();
  // The menu key opens it too.
  await page.keyboard.press("ContextMenu");
  await expect(menu(page).getByRole("menuitem", { name: "Open note" })).toBeFocused();
  await page.keyboard.press("Escape");
  // A date for a todo with none, from its Add date chip, under it.
  const add = chipOf(page, "Write notes", "Due date");
  await add.click();
  await expect(add).toHaveAccessibleName("Due date: none");
  await expect(popover(page)).toHaveAccessibleName("Due date of Write notes");
  expect(await hangsUnder(page, add)).toEqual({ gap: 4, left: 0, inside: true });
  // A day of the member's choosing from the date field: it would sort first, and the list keeps its order until it is refreshed.
  await popover(page).getByLabel("Due on").fill("2026-10-01");
  await expect(row(page, "Write notes").locator(".todo-due")).toHaveText(/Oct 1/);
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await orderBar(page).getByRole("button", { name: "Refresh" }).click();
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank +Home", "Water plants"]);
  await expect(orderBar(page)).toHaveCount(0);

  // Open note: the note in front, the cursor on the todo's line.
  await menuOf(page, "Call the bank");
  await menu(page).getByRole("menuitem", { name: "Open note" }).click();
  await expect(page).toHaveURL(new RegExp(`${home.id}$`));
  await expect.poll(() => cursorLine(page)).toContain("Call the bank");
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
  // It waits ten seconds at its end for the toast to go by itself, which leaves little of 30 s on a slow server.
  test.setTimeout(60_000);
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
  // It is said to a screen reader: the stack it arrives in is a live region.
  await expect(toast(page).locator("xpath=..")).toHaveAttribute("aria-live", "polite");
  await expect(toast(page).getByRole("button")).toHaveText(["Undo"]);
  // It is laid over the page: nothing that was there has moved for it, and nothing moves when it goes.
  expect(await toast(page).evaluate((el) => getComputedStyle(el.parentElement!).position)).toBe("fixed");
  expect(await laidOut(page, frame)).toEqual(before);
  // Listed with the completed ones, it stays where it was, ticked, until the list is refreshed.
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);

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
  // The newer card comes when the server answers, so it is waited for by the first card going.
  await toast(page).evaluate((el) => el.setAttribute("data-first", ""));
  await row(page, "Write notes").getByRole("checkbox").check();
  await expect(page.locator(".toast-card[data-first]")).toHaveCount(0);
  await expect(toast(page)).toHaveCount(1);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);
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
  // It is said to a screen reader: the stack it arrives in is a live region.
  await expect(toast(page).locator("xpath=..")).toHaveAttribute("aria-live", "polite");
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
  await chipOf(page, "Call the bank", "Priority").click();
  await choose(page, "Low");
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
  expect(await agent.tool("todo_filters", {})).toEqual({ tags: ["office", "outside"], assignees: [] });
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
  for (const [text, kind, after] of [["Call the bank", "Due date", ""], ["Call the bank", "Priority", "Escape"], ["Ship it", "Due date", "Escape"], ["Water plants", "Priority", ""]] as const) {
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
  await chipOf(page, "Water plants", "Priority").click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator(".todo-row[data-picking]")).toHaveCount(0);
  await chipOf(page, "Ship it", "Priority").click();
  await todosPage(page).getByRole("heading", { level: 1 }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator(".todo-row[data-picking]")).toHaveCount(0);
  await expect(chipOf(page, "Ship it", "Priority")).toHaveAttribute("aria-expanded", "false");

  // Near the foot of a short window it opens above its chip, still wholly inside.
  await page.setViewportSize({ width: 900, height: 420 });
  const low = chipOf(page, "Water plants", "Priority");
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
  const chip = chipOf(page, "Call the bank", "Priority");

  await row(page, "Call the bank").getByRole("checkbox").focus();
  await page.keyboard.press("Tab");
  await expect(row(page, "Call the bank").locator(".todo-words")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(chipOf(page, "Call the bank", "Due date")).toBeFocused();
  // The chips in their places, set or not: the date, the repeat, the priority.
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName("Repeat: none");
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popover(page).getByRole("button", { name: "Medium", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).getByRole("button", { name: "Low", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(popover(page).getByRole("button", { name: "High", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(popover(page).getByRole("button", { name: "None", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(chip).toBeFocused();
  expect(await lineIn()).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");

  await page.keyboard.press(" ");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2026-10-14 +Home");
  await expect(chip).toBeFocused();

  // Back to the date's chip; a date typed into the field is saved on Enter, not on the way there.
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
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
  const importance = line(page, "Call the bank").getByRole("button", { name: /^Priority: / });

  await due.click();
  await expect(popover(page)).toHaveAccessibleName("Due date");
  expect(await hangsUnder(page, due)).toEqual({ gap: 4, left: 0, inside: true });
  await expect(popover(page).getByRole("button")).toHaveText(["Today", "Tomorrow", /^Next week· /, "Clear"]);
  // Another chip's popover takes its place: one at a time.
  await importance.click();
  await expect(popover(page)).toHaveCount(1);
  await expect(popover(page)).toHaveAccessibleName("Priority");
  expect(await hangsUnder(page, importance)).toEqual({ gap: 4, left: 0, inside: true });
  // The cursor stayed on the title, so the line is drawn as it was.
  expect(await cursorLine(page)).toContain("Chores");
  await expectShown(line(page, "Call the bank"), "!! Call the bank Oct 14, 2031 +Home about the card");

  await choose(page, "High");
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

test("a chip of what isn't set opens the same popover as a set one: Priority and Add date set it, and Add tag, which always follows the tags, writes a tag in use, or a new one typed, after them", async ({ page }) => {
  const { work } = await twoNotes(page);
  const lineIn = async (n: number) => (await read(page, work.id)).split("\n")[n];
  const notes = row(page, "Write notes");

  await chipOf(page, "Write notes", "Priority").click();
  await expect(popover(page)).toHaveAccessibleName("Priority of Write notes");
  await expect(popover(page).getByRole("button", { name: "None", exact: true })).toHaveAttribute("aria-current", "true");
  await choose(page, "Medium");
  await expect.poll(() => lineIn(3)).toBe("- [ ] !! Write notes");
  await expect(chipOf(page, "Write notes", "Priority")).toHaveText("Medium");
  await expect(chipOf(page, "Write notes", "Priority")).not.toHaveAttribute("data-unset");

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
  await expect(notes.locator(".todo-chips button.todo-tag")).toHaveText(["#office"]);
  // Add tag follows the tag, and keeps the keyboard, so another is added the same way, after it.
  await expect(notes.locator(".todo-chip").last()).toHaveAccessibleName("Add tag");
  await expect(notes.getByRole("button", { name: "Add tag" })).toBeFocused();
  await page.keyboard.press("Enter");
  // The tags it has are not offered again.
  await expect(popover(page).getByRole("button")).toHaveText(["#outside"]);
  await page.keyboard.type("desk");
  await page.keyboard.press("Enter");
  await expect.poll(() => lineIn(3)).toBe("- [ ] !! Write notes #office #desk");
  await expect(notes.locator(".todo-chip")).toHaveText(["Add date", "Repeat", "Medium", "#office", "#desk", "Add tag"]);
  // Each tag's chip still narrows the list, to the todos of the notes with that tag.
  await notes.getByRole("button", { name: "#desk", exact: true }).click();
  await expect(bar(page)).toHaveValue("#desk");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await expect(notes.getByRole("button", { name: "#desk", exact: true })).toHaveAttribute("aria-pressed", "true");
  await notes.getByRole("button", { name: "#desk", exact: true }).click();
  await expect(bar(page)).toHaveValue("");

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
  expect(await field.evaluate((el) => [getComputedStyle(el).borderRadius, getComputedStyle(el).height, getComputedStyle(el).boxShadow.includes("3px")])).toEqual(["6px", "24px", true]);
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

  // Enter saves: the words change, the priority and the date stay.
  await page.keyboard.press("Enter");
  await expect(field).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Call the credit union");
  await page.keyboard.press("Enter");
  await expect(row(page, "Call the credit union").locator(".todo-words")).toHaveText("Call the credit union");
  await expect.poll(lineIn).toBe("- [ ] !! Call the credit union due:2026-10-14");
  await expect(chipOf(page, "Call the credit union", "Priority")).toHaveText("Medium");

  // Leaving the field saves too; the tags written after the words stay theirs.
  const water = rows(page).nth(2);
  await expect(water).toContainText("Water plants");
  await water.locator(".todo-words").click();
  await expect(water.getByRole("textbox")).toHaveValue("Water plants");
  await page.keyboard.press("End");
  await page.keyboard.type(" and the hedge");
  await todosPage(page).getByRole("heading", { level: 1 }).click();
  await expect.poll(async () => (await read(page, home.id)).split("\n")[4]).toBe("- [ ] ! Water plants and the hedge #outside");
  await expect(row(page, "Water plants and the hedge").locator(".todo-chips button.todo-tag")).toHaveText(["#outside"]);
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

test("the toast is v1's: at the foot of the pane in the app's colours, Task completed and Undo; it waits while pointed at, and the row stays a moment struck through before it leaves the list", async ({ page }) => {
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
  const pane = (await page.locator(".group[data-front]").boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (pane.x + pane.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.round(pane.y + pane.height - box.y - box.height)).toBe(12);
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

test("the todos of a note in Trash are listed as one the member can only view: no box to check, no words to edit, nothing to set", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Old\n\n- [ ] Shred it #paper\n" });
  await perform(page, { type: "note.trash", id: note.id });
  await page.goto("/todos?q=is%3Atrashed");
  await expect(words(page)).toHaveText(["Shred it"]);
  await expect(row(page, "Shred it").getByRole("checkbox")).toBeDisabled();
  await expect(row(page, "Shred it").getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(row(page, "Shred it").locator(".todo-chip[data-unset]")).toHaveCount(0);
  await menuOf(page, "Shred it");
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Open note", "Open to the side"]);
  await page.keyboard.press("Escape");
  await expect(row(page, "Shred it").getByRole("button", { name: "#paper", exact: true })).toBeVisible();
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

test("a row has nothing at its right but its note's name: pointing at it moves nothing, Tab goes words, chips, name, each chip opens its popover under itself, and the menu opens the note, in front or beside the list", async ({ page }) => {
  const { home, work } = await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const notes = row(page, "Write notes");
  const shape = ".todo-row, .todo-words, .todo-chip, .todo-note";
  await page.mouse.move(1, 1);
  const before = await laidOut(page, shape);
  // Pointed at, what isn't set shows its edge, and nothing moves.
  await notes.hover();
  await expect(notes.locator(".todo-chip[data-unset]").first()).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  expect(await laidOut(page, shape)).toEqual(before);
  await expect(notes.getByRole("button")).toHaveText(["Write notes", "Add date", "Repeat", "Priority", "Add tag", "Work"]);

  // The keyboard: the box, the words, the chips in the order they are shown, the note's name, and on to the next row.
  await page.mouse.move(1, 1);
  await row(page, "Ship it").getByRole("checkbox").focus();
  for (const name of ["Edit Ship it", /^Due date: /, "Repeat: none", "Priority: High", "Add tag", "Work", "Not done"]) {
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveAccessibleName(name);
  }
  await expect(row(page, "Call the bank").getByRole("checkbox")).toBeFocused();

  // The menu has only the note; each chip opens its own popover under itself, set or not, and a pick saves.
  await menuOf(page, "Write notes");
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Open note", "Open to the side"]);
  await page.keyboard.press("Escape");
  for (const [chip, label] of [
    ["todo-due", "Due date of Write notes"],
    ["todo-every", "Repeat of Write notes"],
    ["todo-importance", "Priority of Write notes"],
    ["todo-add-tag", "Tag of Write notes"],
  ] as const) {
    await notes.locator(`.${chip}`).click();
    await expect(popover(page)).toHaveAccessibleName(label);
    await expect(notes.locator(`.${chip}`)).toHaveAttribute("aria-expanded", "true");
    expect(await hangsUnder(page, notes.locator(`.${chip}`)), chip).toEqual({ gap: 4, left: 0, inside: true });
    await page.keyboard.press("Escape");
  }
  await notes.locator(".todo-due").click();
  await choose(page, "Tomorrow");
  const tomorrow = await localDay(page, 1);
  await expect.poll(async () => (await read(page, work.id)).split("\n")[3]).toBe(`- [ ] Write notes due:${tomorrow}`);
  // With a date it would come before the todo with none; it stays where it is until the list is refreshed.
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  // Add tag on a todo that has a tag follows its tag.
  await row(page, "Water plants").getByRole("button", { name: "Add tag" }).click();
  await expect(popover(page)).toHaveAccessibleName("Tag of Water plants #outside");
  expect(await hangsUnder(page, row(page, "Water plants").getByRole("button", { name: "Add tag" }))).toEqual({ gap: 4, left: 0, inside: true });
  await page.keyboard.type("desk");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await read(page, home.id)).split("\n")[4]).toBe("- [ ] ! Water plants #outside #desk");

  // Open note from the name: the note in front, the cursor on the todo's line.
  await row(page, "Ship it").locator(".todo-note").click();
  await expect(page).toHaveURL(new RegExp(`${work.id}$`));
  await expect.poll(() => cursorLine(page)).toContain("Ship it");

  // Open to the side: the note beside the Todos page, the cursor on the todo's line.
  await page.goto("/todos");
  await menuOf(page, "Water plants");
  await menu(page).getByRole("menuitem", { name: "Open to the side" }).click();
  await expect(editor(page)).toContainText("Water plants");
  await expect(todosPage(page)).toBeVisible();
  await expect.poll(() => cursorLine(page)).toContain("Water plants");
});

test("words that wrap keep their room while they are edited in their one-line field: no row moves", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Long\n\n- [ ] ! A long todo that runs past the end of the line, so that its second row can be seen to start under its first word and not under the checkbox #outside\n- [ ] After it\n" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/todos");
  const long = row(page, "A long todo");
  expect(await long.locator(".todo-words").evaluate((el) => el.getClientRects().length)).toBeGreaterThan(1);
  const boxes = () => rows(page).evaluateAll((all) => all.map((el) => JSON.stringify(el.getBoundingClientRect())));
  const before = await boxes();
  await long.locator(".todo-words").click();
  await expect(rows(page).getByRole("textbox")).toBeFocused();
  expect(await boxes()).toEqual(before);
  await page.keyboard.press("Escape");
  expect(await boxes()).toEqual(before);
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
  await expect(row(page, "Buy what").locator(".todo-words")).toHaveAccessibleName("Edit Buy what Groceries lists");
  await menuOf(page, "Buy what");
  await expect(menu(page)).toHaveAccessibleName("More for Buy what Groceries lists");
  await page.keyboard.press("Escape");
  await row(page, "Buy what").locator(".todo-words").click();
  await expect(rows(page).getByRole("textbox")).toHaveValue(`Buy what [[${groceries.id}]] lists`);
  await page.keyboard.press("Escape");
});

test("in a narrow list with both sidebars open, a row's words have the whole first line, its chips go under them as icons, on one line at 700px, and its note's name goes under them", async ({ page }) => {
  await twoNotes(page);
  for (const width of [420, 700]) {
    await page.setViewportSize({ width, height: 720 });
    if (width === 700) await pinPanel(page, "Info");
    await expect(page.getByRole("tree", { name: "Folders" })).toBeVisible();
    for (const each of await rows(page).all()) {
      const parts = await partsOf(each);
      const box = (await each.boundingBox())!;
      const said = parts.find((p) => p.part === "todo-words")!;
      const text = (await each.locator(".todo-text").boundingBox())!;
      const chips = parts.filter((p) => p.part === "todo-chip");
      const note = parts.find((p) => p.part === "todo-note")!;
      // The words run to the row's end, less its padding, and nothing beside them.
      expect(Math.round(box.x + box.width - (text.x + text.width)), `${width}: ${said.text}`).toBeLessThanOrEqual(6);
      // The chips are under the words, from where the words start: one line at 700px; at 420px, where the list is a few words wide,
      // every line of them starts there. What isn't set is its icon alone.
      const lines = [...new Set(chips.map((c) => Math.round(c.top)))];
      if (width === 700) expect(lines, `${width}: ${said.text}`).toHaveLength(1);
      for (const top of lines) expect(Math.min(...chips.filter((c) => Math.round(c.top) === top).map((c) => c.left)) - said.left, `${width}: ${said.text}`).toBeCloseTo(0, 0);
      for (const chip of chips.filter((c) => /^(Add date|Repeat|Priority|Add tag)$/.test(c.text))) expect(Math.round(chip.width)).toBe(22);
      // The note's name is under the chips, where the words start, and whole (its press area reaches 1px above its words and 4px before them).
      expect(note.top + 1).toBeGreaterThanOrEqual(Math.max(...chips.map((c) => c.bottom)));
      expect(Math.abs(note.left + 4 - said.left)).toBeLessThanOrEqual(0.5);
      expect(await each.locator(".todo-note-title").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    // No word is broken across lines.
    await expect(row(page, "Ship it").locator(".todo-words")).toHaveText("Ship it");
    expect(await row(page, "Ship it").locator(".todo-words").evaluate((el) => el.getClientRects().length)).toBe(1);
  }
  // Named all the same, for the pointer and the keyboard.
  await expect(row(page, "Write notes").locator(".todo-due")).toHaveAttribute("title", "Add date");
  await expect(row(page, "Write notes").locator(".todo-due")).toHaveAccessibleName("Due date: none");
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
  await expect(page.getByRole("menu")).toHaveCount(0);
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

test("a row's chips keep their places, set or not: setting or clearing one moves neither it nor any chip before it, and Add tag always follows the tags", async ({ page }) => {
  await twoNotes(page);
  const notes = row(page, "Write notes");
  const lefts = () => notes.locator(".todo-chip").evaluateAll((all) => all.map((el) => [el.classList[1]!, Math.round(el.getBoundingClientRect().left * 10) / 10] as const));
  await expect(notes.locator(".todo-chip")).toHaveText(["Add date", "Repeat", "Priority", "Add tag"]);
  /** Does `act`, then finds the chip it set, and every chip before it, where they were. */
  const stays = async (kind: string, act: () => Promise<void>, says: string) => {
    const was = await lefts();
    await act();
    await expect(notes.locator(`.${kind}`)).toHaveText(says);
    const now = await lefts();
    const upTo = was.findIndex(([c]) => c === kind);
    expect(now.slice(0, upTo + 1), `${kind} set to ${says}`).toEqual(was.slice(0, upTo + 1));
  };
  await stays("todo-importance", () => chipOf(page, "Write notes", "Priority").click().then(() => choose(page, "High")), "High");
  await stays("todo-due", () => notes.locator(".todo-due").click().then(() => choose(page, "Tomorrow")), "Tomorrow");
  await stays(
    "todo-every",
    async () => {
      await notes.locator(".todo-every").click();
      await page.getByRole("radio", { name: "Daily" }).click();
      await page.getByRole("button", { name: "Done" }).click();
    },
    "every day",
  );
  // A tag is written where Add tag was, and Add tag follows it; nothing before it moves.
  const untagged = await lefts();
  await notes.locator(".todo-add-tag").click();
  await page.keyboard.type("desk");
  await page.keyboard.press("Enter");
  await expect(notes.locator(".todo-tag")).toHaveText(["#desk"]);
  const tagged = await lefts();
  expect(tagged.map(([c]) => c)).toEqual(["todo-due", "todo-every", "todo-importance", "todo-tag", "todo-add-tag"]);
  expect(tagged.slice(0, 3)).toEqual(untagged.slice(0, 3));
  expect(tagged[3]![1]).toBe(untagged[3]![1]);
  // Cleared, a chip is quiet again in the same place.
  await stays("todo-importance", () => chipOf(page, "Write notes", "Priority").click().then(() => choose(page, "None")), "Priority");
  await stays("todo-due", () => notes.locator(".todo-due").click().then(() => choose(page, "Clear")), "Add date");
  await expect(notes.locator(".todo-chip")).toHaveText(["Add date", "every day", "Priority", "#desk", "Add tag"]);
});

test("the list keeps its order while its todos are changed: a row that would sort elsewhere stays, one that no longer matches stays dimmed, the notice offers Refresh, and coming back to the page shows it sorted", async ({ page }) => {
  const { home } = await twoNotes(page, HOME.replace("- [ ] ! Water plants", "- [ ] !! Water plants"));
  const order = ["Ship it", "Call the bank +Home", "Water plants", "Write notes"];
  await expect(words(page)).toHaveText(order);
  const tops = () => rows(page).evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().top)));
  const placed = await tops();

  // A date before every other: the row would sort first, and stays where it is, with nothing else moving.
  await chipOf(page, "Write notes", "Due date").click();
  await popover(page).getByLabel("Due on").fill("2026-10-01");
  await expect(row(page, "Write notes").locator(".todo-due")).toHaveText(/Oct 1/);
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await expect(todosPage(page).getByRole("status").filter({ has: page.locator(".todo-order") })).toHaveText("The order has changed.Refresh");
  // The bar above the first row moves every row down by its own height, and nothing else moves.
  const opened = await barOpened(page);
  expect((await tops()).map((top, i) => Math.abs(top - placed[i]! - opened) <= 1)).toEqual(placed.map(() => true));
  await expect(words(page)).toHaveText(order);
  // Another change while it is out of order keeps it so, and the notice stays up.
  await chipOf(page, "Call the bank", "Priority").click();
  await choose(page, "Low");
  await expect.poll(async () => (await read(page, home.id)).split("\n")[2]).toBe("- [ ] ! Call the bank due:2026-10-14 +Home");
  await expect(words(page)).toHaveText(order);
  await expect(orderBar(page)).toHaveCount(1);

  // Refresh sorts it.
  await orderBar(page).getByRole("button", { name: "Refresh" }).click();
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank +Home", "Water plants"]);
  await expect(orderBar(page)).toHaveCount(0);

  // Narrowed to a priority, a row changed out of it stays where it was, dimmed, until the list is refreshed.
  await bar(page).fill("priority:medium");
  await expect(words(page)).toHaveText(["Water plants"]);
  await bar(page).fill("priority:low");
  await expect(words(page)).toHaveText(["Call the bank +Home"]);
  await chipOf(page, "Call the bank", "Priority").click();
  await choose(page, "High");
  await expect.poll(async () => (await read(page, home.id)).split("\n")[2]).toBe("- [ ] !!! Call the bank due:2026-10-14 +Home");
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await expect(words(page)).toHaveText(["Call the bank +Home"]);
  await expect(row(page, "Call the bank")).toHaveAttribute("data-gone", "true");
  await expect(row(page, "Call the bank").locator(".todo-text")).toHaveCSS("opacity", "0.5");
  await expect(chipOf(page, "Call the bank", "Priority")).toHaveText("High");
  await orderBar(page).getByRole("button", { name: "Refresh" }).click();
  await expect(todosPage(page)).toContainText("No todos match.");
  await bar(page).fill("");

  // A change left out of order, then the page left and come back to: sorted, and no notice.
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank +Home", "Water plants"]);
  await chipOf(page, "Water plants", "Priority").click();
  await choose(page, "High");
  await chipOf(page, "Water plants", "Due date").click();
  await popover(page).getByLabel("Due on").fill("2026-09-01");
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank +Home", "Water plants"]);
  await row(page, "Ship it").locator(".todo-note").click();
  await expect(editor(page)).toBeVisible();
  await expect(orderBar(page)).toHaveCount(0);
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();
  await expect(words(page)).toHaveText(["Water plants", "Write notes", "Ship it", "Call the bank +Home"]);
  await expect(orderBar(page)).toHaveCount(0);
});

test("priority is said in words on the Todos page, High, Medium, Low and None, and never as Importance or as bare marks; a note keeps its marks and names them in words", async ({ page }) => {
  const { home } = await twoNotes(page);
  /** What the page shows or names: its text, and every aria-label, title and placeholder. */
  const said = () =>
    page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll("[aria-label], [title], [placeholder]")].flatMap((el) => ["aria-label", "title", "placeholder"].map((name) => el.getAttribute(name) ?? ""))].join("\n"));
  const plainly = async () => {
    const all = await said();
    expect(all).not.toMatch(/importan/i);
    expect(all).not.toMatch(/(^|[\s:])!{1,3}(\s|$)/m);
  };
  await expect(rows(page).locator(".todo-importance")).toHaveText(["High", "Medium", "Low", "Priority"]);
  await expect(chipOf(page, "Ship it", "Priority")).toHaveAccessibleName("Priority: High");
  await expect(chipOf(page, "Write notes", "Priority")).toHaveAccessibleName("Priority: none");
  await advanced(page).click();
  await condition(page, 1).getByRole("combobox", { name: "Field" }).selectOption({ label: "Priority" });
  await expect(condition(page, 1).getByRole("combobox", { name: "Value" }).getByRole("option")).toHaveText(["Choose…", "High", "Medium", "Low", "None"]);
  await advanced(page).click();
  await plainly();
  await chipOf(page, "Call the bank", "Priority").click();
  await expect(popover(page)).toHaveAccessibleName("Priority of Call the bank +Home");
  await expect(popover(page).getByRole("button")).toHaveText(["High", "Mediumnow", "Low", "None"]);
  await plainly();
  await page.keyboard.press("Escape");

  // In the note the marks are written, and named in words.
  await page.goto(`/note/${home.id}`);
  const chip = line(page, "Call the bank").locator(".md-chip-importance .md-todo-chip");
  await expect(chip).toHaveText("!!");
  await expect(chip).toHaveAccessibleName("Priority: Medium");
  await expect(chip).toHaveAttribute("title", "Priority: Medium");
  await chip.click();
  await expect(popover(page).getByRole("button")).toHaveText(["High", "Mediumnow", "Low", "None"]);
});

test("a line written above the todos in their note keeps the list as it is shown: each row stays with its todo, held or not", async ({ page }) => {
  test.setTimeout(90_000);
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n- [ ] ccc due:2031-10-30\n- [ ] aaa due:2031-10-15\n- [ ] bbb due:2031-10-20\n- [ ] ddd due:2031-10-17\n" });
  await page.goto("/todos");
  await expect(words(page)).toHaveText(["aaa", "ddd", "bbb", "ccc"]);
  // A date that would sort ccc first: it stays last, held.
  await chipOf(page, "ccc", "Due date").click();
  await popover(page).getByLabel("Due on").fill("2031-10-01");
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await expect(words(page)).toHaveText(["aaa", "ddd", "bbb", "ccc"]);
  const rowsAt = () => rows(page).evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.row));
  const keys = await rowsAt();
  // Someone writes a line above them all: every todo is a line further down now.
  const { revision, text } = await perform(page, { type: "note.read", id: note.id });
  await perform(page, { type: "note.write", id: note.id, baseRevision: revision, text: text.replace("# Plan\n", "# Plan\nA line above\n") });
  await expect.poll(rowsAt, { timeout: 45_000 }).not.toEqual(keys);
  await expect(words(page)).toHaveText(["aaa", "ddd", "bbb", "ccc"]);
  await expect(row(page, "ccc").locator(".todo-due")).toHaveText(/Oct 1/);
  await expect(rows(page).and(page.locator("[data-gone]"))).toHaveCount(0);
  await orderBar(page).getByRole("button", { name: "Refresh" }).click();
  await expect(words(page)).toHaveText(["ccc", "aaa", "ddd", "bbb"]);
});

test("a tag's chip shows a cross on hover that takes the tag off the todo's line, as Delete and Backspace on the chip do, each with Undo", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Home\n\n- [ ] Water plants #outside #garden #desk\n" });
  await page.goto("/todos");
  const tagsOf = () => row(page, "Water plants").locator("button.todo-tag");
  const lineOf = async () => (await read(page, note.id)).split("\n")[2];
  await expect(tagsOf()).toHaveText(["#outside", "#garden", "#desk"]);
  const cross = row(page, "Water plants").getByRole("button", { name: "Remove #garden" });
  await expect(cross).toHaveCSS("opacity", "0");
  await expect(cross).toHaveAttribute("tabindex", "-1");
  await tagsOf().nth(1).hover();
  await expect(cross).toHaveCSS("opacity", "1");
  // It sits on the chip's top right corner, laid over it: the chip and every chip after it stay where they were.
  const chip = (await tagsOf().nth(1).boundingBox())!;
  const x = (await cross.boundingBox())!;
  expect(Math.abs(x.x + x.width / 2 - (chip.x + chip.width))).toBeLessThanOrEqual(2);
  expect(Math.abs(x.y + x.height / 2 - chip.y)).toBeLessThanOrEqual(2);
  await cross.click();
  await expect.poll(lineOf).toBe("- [ ] Water plants #outside #desk");
  await expect(tagsOf()).toHaveText(["#outside", "#desk"]);
  await expect(toast(page)).toHaveText("Removed #gardenUndo");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(lineOf).toBe("- [ ] Water plants #outside #garden #desk");
  await expect(tagsOf()).toHaveText(["#outside", "#garden", "#desk"]);

  // From the keyboard: Delete on a tag's chip takes it off, and the chip in its place has the keyboard.
  await tagsOf().first().focus();
  await expect(tagsOf().first()).toHaveAttribute("aria-keyshortcuts", "Delete");
  await page.keyboard.press("Delete");
  await expect.poll(lineOf).toBe("- [ ] Water plants #garden #desk");
  await expect(tagsOf().first()).toBeFocused();
  await expect(tagsOf().first()).toHaveText("#garden");
  await page.keyboard.press("Backspace");
  await expect.poll(lineOf).toBe("- [ ] Water plants #desk");
  await expect(tagsOf()).toHaveText(["#desk"]);
  // Notices stack, so the one for #outside may still be up: this one is for the tag taken off last.
  const removed = toast(page).filter({ hasText: "Removed #garden" });
  await expect(removed).toHaveText("Removed #gardenUndo");
  await removed.getByRole("button", { name: "Undo" }).click();
  await expect.poll(lineOf).toBe("- [ ] Water plants #garden #desk");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));
});

test('a row shows its first three tags and then "+N", which lists the rest in a popover where each can be pressed or taken off, and Add tag; the row\'s Add tag stays after it', async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Trip\n\n- [ ] Plan the trip #maps #tickets #hotel #bags #visa #money\n" });
  await page.goto("/todos");
  const trip = row(page, "Plan the trip");
  const lineOf = async () => (await read(page, note.id)).split("\n")[2];
  await expect(trip.locator("button.todo-tag")).toHaveText(["#maps", "#tickets", "#hotel"]);
  const more = trip.locator(".todo-more-tags");
  await expect(more).toHaveText("+3");
  await expect(more).toHaveAccessibleName("3 more tags");
  await expect(more).toHaveAttribute("title", "#bags #visa #money");
  expect(await trip.locator(".todo-chips > *").evaluateAll((all) => all.map((el) => el.classList[0] === "todo-tag-chip" ? "tag" : el.classList[1]))).toEqual(["todo-due", "todo-every", "todo-importance", "tag", "tag", "tag", "todo-more-tags", "todo-add-tag"]);
  // One line of chips: no long run of tags wrapping.
  expect(new Set(await trip.locator(".todo-chip").evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().top))))).toHaveProperty("size", 1);

  await more.click();
  await expect(popover(page)).toHaveAccessibleName("Tags of Plan the trip #maps #tickets #hotel #bags #visa #money");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  expect(await hangsUnder(page, more)).toEqual({ gap: 4, left: 0, inside: true });
  const lines = popover(page).locator(".tag-line .chip-choice");
  await expect(lines).toHaveText(["bags", "visa", "money"]);
  await popover(page).getByRole("button", { name: "Remove #visa" }).click();
  await expect.poll(lineOf).toBe("- [ ] Plan the trip #maps #tickets #hotel #bags #money");
  await expect(lines).toHaveText(["bags", "money"]);
  await expect(more).toHaveText("+2");
  // Delete on a tag in the list takes it off too, and the keyboard goes to the line after it.
  await lines.first().focus();
  await page.keyboard.press("Delete");
  await expect.poll(lineOf).toBe("- [ ] Plan the trip #maps #tickets #hotel #money");
  await expect(lines).toHaveText(["money"]);
  await expect(lines.first()).toBeFocused();
  await expect(more).toHaveText("+1");
  // Add tag there opens the field for a tag in its place.
  await popover(page).getByRole("button", { name: "Add tag" }).click();
  await expect(popover(page).getByLabel("Tag")).toBeFocused();
  await page.keyboard.type("passport");
  await page.keyboard.press("Enter");
  await expect.poll(lineOf).toBe("- [ ] Plan the trip #maps #tickets #hotel #money #passport");
  await expect(more).toHaveText("+2");
  // A tag pressed there narrows the list to it.
  await more.click();
  await popover(page).getByRole("button", { name: "passport", exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(bar(page)).toHaveValue("#passport");
  await expect(trip.locator(".todo-add-tag")).toBeVisible();
  await bar(page).fill("");
  // Taking off the last tag past three takes "+N" away too, and the keyboard goes to Add tag in its place.
  await more.click();
  await lines.first().focus();
  await page.keyboard.press("Delete");
  await expect(lines).toHaveText(["passport"]);
  await expect(lines.first()).toBeFocused();
  await page.keyboard.press("Delete");
  await expect.poll(lineOf).toBe("- [ ] Plan the trip #maps #tickets #hotel");
  await expect(more).toHaveCount(0);
  await expect(trip.locator(".todo-add-tag")).toBeFocused();
});

/** Where each of a row's chips is, and where its note's name is. */
const chipsBeside = (of: Locator) =>
  of.evaluate((li) => {
    const box = (el: Element) => el.getBoundingClientRect();
    const note = box(li.querySelector(".todo-note")!);
    const card = box(li.closest(".todo-card")!);
    return {
      note: { left: note.left, bottom: note.bottom },
      card: { right: card.right },
      chips: [...li.querySelectorAll(".todo-chip")].map((el) => ({ text: el.textContent!, left: box(el).left, right: box(el).right, top: box(el).top, width: box(el).width })),
      cut: [...li.querySelectorAll<HTMLElement>(".todo-tag-name")].map((el) => el.scrollWidth > el.clientWidth),
    };
  });

for (const width of [1280, 700]) {
  test(`a long tag is cut short with an ellipsis inside its chip, named whole, and a row's chips never reach its note's name (${width}px window)`, async ({ page }) => {
    await signInAsNewPerson(page, "Ada Lovelace");
    const long = `${"verylongtagname".repeat(7)}end`.slice(0, 100);
    await perform(page, { type: "note.create", text: `# A rather long name for a note about the house\n\n- [ ] !! Fix the gate due:2031-10-14 every:1w #${long} #${long}2 #short\n` });
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/todos");
    await pinPanel(page, "Info");
    const gate = row(page, "Fix the gate");
    const tag = gate.locator("button.todo-tag").first();
    await expect(tag).toHaveAccessibleName(`#${long}`);
    await expect(tag).toHaveAttribute("title", `Todos tagged #${long}`);
    const seen = await chipsBeside(gate);
    expect(seen.cut).toEqual([true, true, false]);
    const fontSize = await tag.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    for (const chip of seen.chips) {
      expect(chip.width, chip.text).toBeLessThanOrEqual(14 * fontSize + 0.5);
      expect(chip.right, chip.text).toBeLessThanOrEqual(seen.card.right);
      // On the wide list the note's name is at the right of the first line, and no chip comes under or beside it.
      if (width === 1280) expect(chip.right, chip.text).toBeLessThan(seen.note.left);
      else expect(chip.top, chip.text).toBeLessThan(seen.note.bottom);
    }
  });
}

test("a row a change takes out of the list stays, greyed, with a line under it saying what changed and why it will leave, for its date, its priority and its tag; a setting turns the line off", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  // In notes of their own: a tag anywhere in a todo's note is the todo's tag too.
  await perform(page, { type: "note.create", text: `# Gym\n\n- [ ] !!! Gym due:${today} #health\n` });
  await perform(page, { type: "note.create", text: `# Stretch\n\n- [ ] !!! Stretch due:${today} #health\n` });
  // One the query leaves out, so a list read for it shows it has been.
  await perform(page, { type: "note.create", text: "# Books\n\n- [ ] Read a book\n" });
  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Gym", "Stretch", "Read a book"]);
  const why = (text: string) => row(page, text).locator(".todo-why");
  // The query's own terms for a date, a priority and a tag are said as the filters they are.
  await bar(page).fill("due:today");
  await expect(words(page)).toHaveText(["Gym", "Stretch"]);
  await expect(rows(page).locator(".todo-why")).toHaveCount(0);

  await chipOf(page, "Gym", "Due date").click();
  await choose(page, "Tomorrow");
  await expect(why("Gym")).toHaveText("Moved to tomorrow, so it no longer shows under Today. It leaves when you refresh.");
  await expect(row(page, "Gym")).toHaveAttribute("data-gone", "true");
  await expect(row(page, "Gym").locator(".todo-text")).toHaveCSS("opacity", "0.5");
  await expect(row(page, "Gym").locator(".todo-chips")).toHaveCSS("opacity", "0.5");
  await expect(why("Gym")).toHaveCSS("opacity", "1");
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await orderBar(page).getByRole("button", { name: "Refresh" }).click();
  await expect(words(page)).toHaveText(["Stretch"]);

  await bar(page).fill("priority:high");
  await expect(words(page)).toHaveText(["Stretch", "Gym"]);
  await chipOf(page, "Stretch", "Priority").click();
  await choose(page, "Low");
  await expect(why("Stretch")).toHaveText("Set to Low, so it no longer shows under Priority: High. It leaves when you refresh.");
  await orderBar(page).getByRole("button", { name: "Refresh" }).click();
  await expect(words(page)).toHaveText(["Gym"]);

  await bar(page).fill("#health");
  await expect(words(page)).toHaveText(["Stretch", "Gym"]);
  await row(page, "Gym").locator("button.todo-tag").focus();
  await page.keyboard.press("Delete");
  await expect(why("Gym")).toHaveText("#health was taken off, so it no longer shows under #health. It leaves when you refresh.");
  await expect(why("Stretch")).toHaveCount(0);

  // Off, the row is only greyed.
  await page.goto("/settings/plugins/todos");
  await group(page, "Todos").getByRole("checkbox", { name: "Say why a changed todo will leave the list" }).uncheck();
  await closeSettings(page);
  await page.getByRole("navigation", { name: "Modes" }).getByRole("link", { name: "Todos" }).click();
  await expect(words(page)).toHaveText(["Stretch"]);
  await row(page, "Stretch").locator("button.todo-tag").focus();
  await page.keyboard.press("Delete");
  await expect(row(page, "Stretch")).toHaveAttribute("data-gone", "true");
  await expect(row(page, "Stretch").locator(".todo-text")).toHaveCSS("opacity", "0.5");
  await expect(rows(page).locator(".todo-why")).toHaveCount(0);
});

test("the order changing is said in a bar at the top of the list, which moves the rows down by its own height and nothing more, stays in sight as the list scrolls, can be sent away, and Refresh sorts the list", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const many = Array.from({ length: 30 }, (_, i) => `- [ ] Chore ${String(i + 1).padStart(2, "0")} due:2031-11-${String(i + 1).padStart(2, "0")}`).join("\n");
  await perform(page, { type: "note.create", text: `# Chores\n\n${many}\n` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/todos");
  await expect(rows(page)).toHaveCount(30);
  const tops = () => rows(page).evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().top * 10) / 10));
  const before = await tops();

  await chipOf(page, "Chore 03", "Due date").click();
  await popover(page).getByLabel("Due on").fill("2031-10-01");
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  // Inside the list's card, above its first row, and the rows moved down by the bar's height and its gap, every one alike.
  const height = await barOpened(page);
  const placed = await page.evaluate(() => {
    const bar = document.querySelector(".todo-order")!.getBoundingClientRect();
    const card = document.querySelector(".todo-card")!.getBoundingClientRect();
    const first = document.querySelector(".todo-row")!.getBoundingClientRect();
    return { inCard: bar.top >= card.top && bar.right <= card.right && bar.left >= card.left, above: bar.bottom <= first.top };
  });
  expect(placed).toEqual({ inCard: true, above: true });
  expect(height).toBeGreaterThan(20);
  const after = await tops();
  expect(after.map((top, i) => Math.abs(top - before[i]! - height) <= 0.5)).toEqual(before.map(() => true));
  await expect(words(page).first()).toHaveText("Chore 01");

  // Scrolled to the end of the list, the bar is still at the top of the page.
  await page.locator(".todos-page").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const stuck = await page.evaluate(() => {
    const scroller = document.querySelector(".todos-page")!;
    return [document.querySelector(".todo-order")!.getBoundingClientRect().top, scroller.getBoundingClientRect().top];
  });
  expect(Math.abs(stuck[0]! - stuck[1]!)).toBeLessThan(1);
  await page.locator(".todos-page").evaluate((el) => el.scrollTo(0, 0));

  // Sent away, from the keys, the rows go back up and the first row has the keyboard; another change brings it back.
  await orderBar(page).getByRole("button", { name: "Dismiss" }).focus();
  await page.keyboard.press("Enter");
  await expect(orderBar(page)).toHaveCount(0);
  await expect(rows(page).first().locator(".todo-box")).toBeFocused();
  await expect.poll(tops).toEqual(before);
  await chipOf(page, "Chore 05", "Priority").click();
  await choose(page, "High");
  await expect(orderBar(page)).toHaveText("The order has changed.Refresh");
  await orderBar(page).getByRole("button", { name: "Refresh" }).focus();
  await page.keyboard.press("Enter");
  await expect(words(page).first()).toHaveText("Chore 03");
  await expect(rows(page).first().locator(".todo-box")).toBeFocused();
  await expect(orderBar(page)).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);
});

test("the Sort menu orders the list by due date, priority, recently changed, note or A–Z; a change of sort sorts at once, and it is remembered", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const zoo = await perform(page, { type: "note.create", text: "# Zoo\n\n- [ ] ! feed the cats due:2031-03-01\n- [ ] !!! Buy hay\n" });
  await perform(page, { type: "note.create", text: "# attic\n\n- [ ] zebra tickets due:2031-02-01\n- [ ] !! apples due:2031-05-01\n" });
  await page.goto("/todos");
  const sort = todosPage(page).getByLabel("Sort", { exact: true });
  await expect(sort).toHaveValue("due");
  await expect(sort.getByRole("option")).toHaveText(["Due date", "Priority", "Recently changed", "Note", "A–Z"]);
  await expect(words(page)).toHaveText(["zebra tickets", "feed the cats", "apples", "Buy hay"]);
  await sort.selectOption("Priority");
  await expect(words(page)).toHaveText(["Buy hay", "apples", "feed the cats", "zebra tickets"]);
  await sort.selectOption("Note");
  await expect(words(page)).toHaveText(["zebra tickets", "apples", "feed the cats", "Buy hay"]);
  await sort.selectOption("A–Z");
  await expect(words(page)).toHaveText(["apples", "Buy hay", "feed the cats", "zebra tickets"]);
  // Zoo is written after attic: its todos come first.
  const { revision, text } = await perform(page, { type: "note.read", id: zoo.id });
  await perform(page, { type: "note.write", id: zoo.id, baseRevision: revision, text: `${text}\nA line.` });
  await sort.selectOption("Recently changed");
  await expect(words(page)).toHaveText(["feed the cats", "Buy hay", "zebra tickets", "apples"]);

  // A change the order would move is held until Refresh, and a change of sort is a refresh.
  await sort.selectOption("Priority");
  await expect(words(page)).toHaveText(["Buy hay", "apples", "feed the cats", "zebra tickets"]);
  await chipOf(page, "zebra tickets", "Priority").click();
  await choose(page, "High");
  await expect(orderBar(page)).toBeVisible();
  await expect(words(page)).toHaveText(["Buy hay", "apples", "feed the cats", "zebra tickets"]);
  await sort.selectOption("A–Z");
  await expect(words(page)).toHaveText(["apples", "Buy hay", "feed the cats", "zebra tickets"]);
  await expect(orderBar(page)).toHaveCount(0);

  await page.reload();
  await expect(sort).toHaveValue("text");
  await expect(words(page)).toHaveText(["apples", "Buy hay", "feed the cats", "zebra tickets"]);

  // The menu and the query's sort: are one choice: a pick writes its word in the bar, and a word typed there shows in the menu.
  await expect(bar(page)).toHaveValue("sort:text-asc");
  await bar(page).fill("#nothing");
  await sort.selectOption("Priority");
  await expect(bar(page)).toHaveValue("#nothing sort:priority-desc");
  await expect.poll(() => keptSort(page), "a pick is kept with the account").toBe("priority");
  await bar(page).fill("sort:updated-desc");
  await expect(sort).toHaveValue("changed");
  await expect.poll(() => keptSort(page), "and so is a sort: run from the bar").toBe("changed");
  // attic's note changed last, when zebra tickets was set to High.
  await expect(words(page)).toHaveText(["zebra tickets", "apples", "feed the cats", "Buy hay"]);
  await bar(page).fill("sort:due-desc");
  await expect(sort).toHaveValue("due-desc");
  await expect(words(page)).toHaveText(["apples", "feed the cats", "zebra tickets", "Buy hay"]);
  expect(await keptSort(page), "a sort: the menu has no name for leaves the account's as it was").toBe("changed");
  await sort.selectOption("Due date");
  await expect(bar(page)).toHaveValue("");
  await expect(words(page)).toHaveText(["zebra tickets", "feed the cats", "apples", "Buy hay"]);
  await expect.poll(() => keptSort(page), "Due date is the setting's default, so nothing is kept").toBeUndefined();
});

/** The member's Sort as their settings on the server hold it, in their first workspace unless one is named. */
const keptSort = async (page: Page, workspaceId?: string) => JSON.parse((await perform(page, { type: "settings.read" }, workspaceId)).text)["todos.sort"] as string | undefined;
/** Where a browser kept the Sort before it was kept with the account. */
const browserSortKey = async (page: Page) => {
  const { person, workspaces } = await me(page);
  return `ink.plugin.todos.${workspaces[0]!.id}.${person.id}.sort`;
};
const SORT_NOTES = ["# Zoo\n\n- [ ] ! feed the cats due:2031-03-01\n- [ ] !!! Buy hay\n", "# attic\n\n- [ ] zebra tickets due:2031-02-01\n- [ ] !! apples due:2031-05-01\n"];

test("the Sort is kept with the account: another browser signed in as the same member opens the Todos page in that order, and another member's Sort is their own", async ({ page, browser, baseURL }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (const text of SORT_NOTES) await perform(page, { type: "note.create", text });
  await page.goto("/todos");
  const sort = todosPage(page).getByLabel("Sort", { exact: true });
  await sort.selectOption("Priority");
  await expect(words(page)).toHaveText(["Buy hay", "apples", "feed the cats", "zebra tickets"]);
  await expect.poll(() => keptSort(page)).toBe("priority");

  const { person, workspaces } = await me(page);
  const elsewhere = await (await browser.newContext({ baseURL })).newPage();
  await signInAs(elsewhere, person.email, person.name, "/todos");
  const sortThere = todosPage(elsewhere).getByLabel("Sort", { exact: true });
  await expect(sortThere, "the same member in a browser that never chose").toHaveValue("priority");
  await expect(words(elsewhere)).toHaveText(["Buy hay", "apples", "feed the cats", "zebra tickets"]);
  await sortThere.selectOption("A–Z");
  await expect.poll(() => keptSort(elsewhere)).toBe("text");
  await page.reload();
  await expect(sort, "and the first browser follows the account").toHaveValue("text");
  await expect(bar(page), "its bar too, though it had kept sort:priority-desc").toHaveValue("sort:text-asc");
  await expect(words(page)).toHaveText(["apples", "Buy hay", "feed the cats", "zebra tickets"]);
  await elsewhere.context().close();

  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  const zoo = (await perform(page, { type: "note.list" })).notes.find((n) => n.title === "Zoo")!;
  await grace.goto(`/note/${zoo.id}`);
  await expect(grace.locator(".workspace-button")).toContainText("Ada");
  await grace.goto("/todos");
  const graceSort = todosPage(grace).getByLabel("Sort", { exact: true });
  await expect(graceSort, "another member of the workspace starts from their own").toHaveValue("due");
  await expect(words(grace)).toHaveText(["zebra tickets", "feed the cats", "apples", "Buy hay"]);
  await graceSort.selectOption("Note");
  await expect.poll(() => keptSort(grace, workspaces[0]!.id)).toBe("note");
  expect(await keptSort(page), "Ada's is still hers").toBe("text");
  await page.reload();
  await expect(sort).toHaveValue("text");
  await grace.context().close();
});

test("a Sort this browser kept before moves to the account once, even when the settings are slow to come, and after that the account's wins", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (const text of SORT_NOTES) await perform(page, { type: "note.create", text });
  const key = await browserSortKey(page);
  const inBrowser = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown, key);
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify("priority")), key);
  await page.route("**/ops", async (route) => {
    if (route.request().postData()?.includes('"settings.read"')) await new Promise((done) => setTimeout(done, 2500));
    await route.fallback();
  });
  await page.goto("/todos");
  const sort = todosPage(page).getByLabel("Sort", { exact: true });
  await expect(sort).toHaveValue("priority");
  await expect(words(page)).toHaveText(["Buy hay", "apples", "feed the cats", "zebra tickets"]);
  await expect.poll(() => keptSort(page)).toBe("priority");
  expect(await inBrowser(), "moved once, and not again").toBeNull();
  await page.unroute("**/ops");

  // A browser left holding an older choice: the account's is the one shown, and the old one is let go.
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify("note")), key);
  await page.reload();
  await expect(sort).toHaveValue("priority");
  await expect.poll(inBrowser).toBeNull();
  expect(await keptSort(page)).toBe("priority");
});

test("a link that names its order opens in it and leaves the account's as it was; a link that names none opens in the account's", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  for (const text of SORT_NOTES) await perform(page, { type: "note.create", text });
  await page.goto("/todos");
  const sort = todosPage(page).getByLabel("Sort", { exact: true });
  await sort.selectOption("Priority");
  await expect.poll(() => keptSort(page)).toBe("priority");

  // The member's settings come after the page has opened the link, as they can on a slow connection.
  await page.route("**/ops", async (route) => {
    if (route.request().postData()?.includes('"settings.read"')) await new Promise((done) => setTimeout(done, 1500));
    await route.fallback();
  });
  const settingsRead = () => page.waitForResponse((r) => r.url().endsWith("/ops") && (r.request().postData()?.includes('"settings.read"') ?? false));
  let read = settingsRead();
  await page.goto(`/todos?q=${encodeURIComponent("sort:text-asc")}`);
  await read;
  await page.waitForTimeout(500);
  await expect(bar(page)).toHaveValue("sort:text-asc");
  await expect(sort).toHaveValue("text");
  await expect(words(page)).toHaveText(["apples", "Buy hay", "feed the cats", "zebra tickets"]);
  expect(await keptSort(page)).toBe("priority");

  read = settingsRead();
  await page.goto(`/todos?q=${encodeURIComponent("has:due")}`);
  await read;
  await expect(bar(page), "the account's order, once it is read").toHaveValue("has:due sort:priority-desc");
  await expect(sort).toHaveValue("priority");
  await expect(words(page)).toHaveText(["apples", "feed the cats", "zebra tickets"]);
});

test("what isn't set on a todo shows only while its row is pointed at or has the keyboard, and nothing moves when it shows", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "note.create", text: "# Home\n\n- [ ] !! Call the bank due:2031-10-14 #money\n- [ ] Nothing set\n- [ ] Sweep\n" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/todos");
  await page.mouse.move(0, 0);
  const shown = (text: string) => row(page, text).locator(".todo-chip").evaluateAll((all) => all.map((el) => `${el.textContent} ${getComputedStyle(el).opacity}`));
  await expect.poll(() => shown("Call the bank")).toEqual(["Oct 14, 2031 1", "Repeat 0", "Medium 1", "#money 1", "Add tag 0"]);
  await expect.poll(() => shown("Nothing set")).toEqual(["Add date 0", "Repeat 0", "Priority 0", "Add tag 0"]);
  // A row with nothing set keeps its second line, empty: every row is as tall.
  expect(new Set(await rows(page).evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().height))))).toEqual(new Set([46]));
  const boxes = () => laidOut(page, ".todo-row, .todo-row *");
  const resting = await boxes();

  await row(page, "Nothing set").hover();
  await expect.poll(() => shown("Nothing set")).toEqual(["Add date 1", "Repeat 1", "Priority 1", "Add tag 1"]);
  await expect.poll(() => shown("Sweep")).toEqual(["Add date 0", "Repeat 0", "Priority 0", "Add tag 0"]);
  expect(await boxes()).toEqual(resting);

  // From the keyboard: a row with the keyboard shows them, and Tab reaches each.
  await page.mouse.move(0, 0);
  await row(page, "Sweep").locator(".todo-box").focus();
  await expect.poll(() => shown("Sweep")).toEqual(["Add date 1", "Repeat 1", "Priority 1", "Add tag 1"]);
  await expect.poll(() => shown("Nothing set")).toEqual(["Add date 0", "Repeat 0", "Priority 0", "Add tag 0"]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(row(page, "Sweep").getByRole("button", { name: "Due date: none" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toHaveAccessibleName("Due date of Sweep");
  expect(await boxes()).toEqual(resting);
});
