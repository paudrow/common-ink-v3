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
const popover = (page: Page) => page.locator(".chip-popover");
/** Picks one of what the open chip's popover offers. */
const choose = (page: Page, name: string) => popover(page).getByRole("button", { name, exact: true }).click();
const filter = (page: Page, name: string) => todosPage(page).getByRole("group", { name: "Filters" }).getByLabel(name);
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

const more = (page: Page, text: string) => row(page, text).getByRole("button", { name: /^More for / });
const menu = (page: Page) => page.getByRole("menu", { name: /^More for / });
const pick = (page: Page, item: string) => menu(page).getByRole("menuitem", { name: item, exact: true }).click();
const chipOf = (page: Page, text: string, kind: "Importance" | "Due date") => row(page, text).getByRole("button", { name: new RegExp(`^${kind}: `) });
const toast = (page: Page) => page.locator(".toast");
/** Where everything on the page that isn't the toast is: each thing's box, to the pixel. */
const laidOut = (page: Page, within: string) =>
  page.evaluate((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((el) => [el.className || el.tagName, ...(["x", "y", "width", "height"] as const).map((side) => Math.round(el.getBoundingClientRect()[side] * 10) / 10)].join(" ")), within);

test("the Todos page lists open todos from every note, and narrows by folder, tag, due date and importance, and to completed ones too", async ({ page }) => {
  const { home, work } = await twoNotes(page);

  await expect(todosPage(page).getByRole("heading", { level: 1 })).toHaveText("Todos");
  // A +Name is words of the todo: nothing is made of it.
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await expect(row(page, "Ship it").locator(".todo-note")).toHaveText("Work #office");
  await expect(filter(page, "Project")).toHaveCount(0);

  await filter(page, "Include completed").check();
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);
  await expect(row(page, "Book flights").getByRole("checkbox")).toBeChecked();
  await filter(page, "Include completed").uncheck();

  // A folder lists its notes' todos and those of the folders under it.
  const house = await perform(page, { type: "folder.create", name: "House" });
  const garden = await perform(page, { type: "folder.create", name: "Garden", parentId: house.id });
  const office = await perform(page, { type: "folder.create", name: "Office" });
  await perform(page, { type: "note.move", id: home.id, folderId: garden.id });
  await perform(page, { type: "note.move", id: work.id, folderId: office.id });
  await page.reload();
  await expect(filter(page, "Folder").getByRole("option")).toHaveText(["All folders", "Unsorted", "House", "House / Garden", "Office"]);
  await filter(page, "Folder").selectOption("House");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
  await filter(page, "Folder").selectOption("House / Garden");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
  await filter(page, "Folder").selectOption("Office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await filter(page, "Folder").selectOption("Unsorted");
  await expect(todosPage(page)).toContainText("No todos match.");
  await filter(page, "Folder").selectOption("All folders");

  await expect(filter(page, "Tag").getByRole("option")).toHaveText(["All tags", "#office", "#outside"]);
  await filter(page, "Importance").selectOption("!!");
  await expect(words(page)).toHaveText(["Call the bank +Home"]);
  await filter(page, "Importance").selectOption("Normal");
  await expect(words(page)).toHaveText(["Write notes"]);
  await filter(page, "Importance").selectOption("Any");
  await filter(page, "Due").selectOption("No date");
  await expect(words(page)).toHaveText(["Water plants", "Write notes"]);

  // The page opens the way it was left.
  await page.reload();
  await expect(filter(page, "Due")).toHaveValue("none");
  await expect(words(page)).toHaveText(["Water plants", "Write notes"]);

  // A folder the list was left narrowed to and that is gone since narrows nothing.
  await filter(page, "Due").selectOption("Any date");
  await filter(page, "Folder").selectOption("Office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await perform(page, { type: "note.move", id: work.id, folderId: house.id });
  await perform(page, { type: "folder.delete", id: office.id });
  await page.reload();
  await expect(filter(page, "Folder")).toHaveValue("");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  await expect(todosPage(page).getByRole("alert")).toHaveCount(0);
});

test("a todo has the tags on its own line and its note's: its own are drawn as chips after its words, and one listed for its note's tag says so beside the note's name", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);

  // A tag written at the end of its words is a chip after them, and no row says a tag its line doesn't write.
  await expect(row(page, "Water plants").locator(".todo-text .todo-tag")).toHaveText(["#outside"]);
  await expect(rows(page).locator(".todo-tag")).toHaveText(["#outside"]);

  // Under the tag of its own line: both todos of the note are tagged with it, and only the other one is told why.
  await filter(page, "Tag").selectOption("#outside");
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
  await expect(row(page, "Call the bank").locator(".todo-where .todo-tag")).toHaveText(["#outside"]);
  await expect(row(page, "Water plants").locator(".todo-where .todo-tag")).toHaveCount(0);

  // Under a tag only the note's title writes: every todo of the note, each with the tag beside the note's name.
  await filter(page, "Tag").selectOption("#office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await expect(rows(page).locator(".todo-where .todo-tag")).toHaveText(["#office", "#office"]);
});

test("a tag's chip narrows the list to that tag, and pressed again takes that off; a tag inside the words stays in them", async ({ page }) => {
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

  await row(page, "Water plants").getByRole("button", { name: "#garden", exact: true }).click();
  await expect(filter(page, "Tag")).toHaveValue("garden");
  await expect(words(page)).toHaveText(["Water plants"]);
  await expect(row(page, "Water plants").getByRole("button", { name: "#garden", exact: true })).toHaveAttribute("aria-pressed", "true");
  await row(page, "Water plants").getByRole("button", { name: "#garden", exact: true }).click();
  await expect(filter(page, "Tag")).toHaveValue("");
  await expect(words(page)).toHaveText(["Ask #bob about the fence", "Water plants", "Write notes", "#someday", "Twice"]);
  expect(warned).toEqual([]);
});

test("a todo's card looks like a plugin's card, no wider than v1's list, with its chips straight after its words; its controls are its checkbox, its words, a chip for each thing set on it, and one menu", async ({ page }) => {
  await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes"]);
  const look = (selector: string) =>
    page.evaluate((s) => {
      const card = getComputedStyle(document.querySelector(`${s}:not(:hover)`)!);
      const list = getComputedStyle(document.querySelector(s)!.parentElement!);
      return { radius: card.borderRadius, border: `${card.borderTopWidth} ${card.borderTopStyle} ${card.borderTopColor}`, padding: card.padding, background: card.backgroundColor, gap: list.rowGap };
    }, selector);
  const todo = await look(".todo-card");

  // About 690px of words and chips inside the card, in a window with room for far more.
  await page.setViewportSize({ width: 1800, height: 900 });
  const text = await row(page, "Ship it").locator(".todo-text").boundingBox();
  const card = (await row(page, "Ship it").boundingBox())!;
  expect(card.width).toBeLessThanOrEqual(720);
  expect(text!.width).toBeLessThan(card.width);

  // Its chips follow its words on their row, as near as a pill's margin.
  const water = row(page, "Water plants");
  await water.getByRole("button", { name: "More for Water plants #outside" }).click();
  await pick(page, "Due date…");
  await choose(page, "Tomorrow");
  await expect(water.locator(".todo-due")).toHaveText("Tomorrow");
  await expect(water.locator(".todo-importance")).toHaveText("!");
  const end = await water.locator(".todo-words").evaluate((el) => {
    const rects = el.getClientRects();
    return rects[rects.length - 1]!.right;
  });
  const first = (await water.locator(".todo-chip").first().boundingBox())!;
  expect(first.x - end).toBeGreaterThanOrEqual(0);
  expect(first.x - end).toBeLessThanOrEqual(8);
  await expect(water.getByRole("checkbox")).toHaveCount(1);
  await expect(water.getByRole("link")).toHaveText(["Water plants"]);
  await expect(water.getByRole("button")).toHaveText(["!", "Tomorrow", "#outside", ""]);
  // A todo with no date and no importance says neither.
  await expect(row(page, "Write notes").locator(".todo-chip")).toHaveCount(0);
  await expect(rows(page).filter({ hasText: "No date" })).toHaveCount(0);

  await page.goto("/plugins");
  await expect(page.locator(".plugin-card").first()).toBeVisible();
  expect(todo).toEqual(await look(".plugin-card"));
});

test("what has no chip is in one short menu, from its button, a right-click and the keyboard; each chip opens its own popover, and each pick rewrites the line in its note as the member's change", async ({ page }) => {
  // The bank is due on a day that is never today, whenever this runs, and "Today" is picked below.
  const due = await localDay(page, 10);
  const homeText = HOME.replace("due:2026-10-14", `due:${due}`);
  const { home } = await twoNotes(page, homeText);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  const today = await localDay(page);

  // A todo with importance and a date: the menu only opens it.
  await more(page, "Call the bank").click();
  await expect(menu(page)).toHaveAccessibleName("More for Call the bank +Home");
  await expect(menu(page).getByRole("menuitem").filter({ hasNotText: /^Open / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

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
  await expect(row(page, "Call the bank").locator(".todo-due")).toHaveCount(0);
  // The chip it came from is gone: the keyboard is on the card's "…".
  await expect(more(page, "Call the bank")).toBeFocused();
  await chipOf(page, "Call the bank", "Importance").click();
  await choose(page, "!!!");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank +Home");

  // What has no chip is in the menu, from a right-click anywhere on the card or Shift+F10, and opens the same popover under the "…".
  await row(page, "Write notes").locator(".todo-note").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem").filter({ hasNotText: /^Open / })).toHaveText(["Importance…", "Due date…"]);
  await page.keyboard.press("Escape");
  await row(page, "Write notes").getByRole("checkbox").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  await pick(page, "Due date…");
  const under = (await more(page, "Write notes").boundingBox())!;
  const panel = (await popover(page).boundingBox())!;
  expect(Math.round(panel.y - (under.y + under.height))).toBe(4);
  // A day of the member's choosing from the date field.
  await popover(page).getByLabel("Due on").fill("2026-10-01");
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank +Home", "Water plants"]);

  await more(page, "Call the bank").click();
  await pick(page, "Open the note");
  await expect(page).toHaveURL(new RegExp(`${home.id}$`));
  expect(new Set(await authors(page, home.id))).toEqual(new Set(["member Ada Lovelace"]));
  await expect.poll(async () => (await read(page, home.id)).replace("- [ ] !!! Call the bank +Home", `- [ ] !! Call the bank due:${due} +Home`)).toBe(homeText);
});

test("a todo's menu opens at the pointer when there is room, and is moved wholly inside the window when there isn't", async ({ page }) => {
  await twoNotes(page);
  const card = (await row(page, "Write notes").boundingBox())!;
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
  await row(page, "Write notes").scrollIntoViewIfNeeded();
  const tight = (await row(page, "Write notes").boundingBox())!;
  // The menu of a todo with neither importance nor a date, which has the most in it. The press is on what of the card is in sight.
  const press = { x: tight.x + tight.width - 50, y: Math.min(tight.y + tight.height - 6, window.height - 40) };
  await page.mouse.click(press.x, press.y, { button: "right" });
  const moved = (await menu(page).boundingBox())!;
  expect(press.x + moved.width, "it would have run off the right").toBeGreaterThan(window.width);
  expect(press.y + moved.height, "it would have run off the foot").toBeGreaterThan(window.height);
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
  await filter(page, "Include completed").check();
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);
  await page.evaluate(() => document.fonts.ready);
  const frame = ".todos-page h1, .todo-filters, .todo-filters label, .todos-page .cards";
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
  await expect(words(page)).toHaveText(["Ship it", "Water plants", "Write notes", "Call the bank +Home", "Book flights"]);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(lineIn).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank +Home", "Water plants", "Write notes", "Book flights"]);
  // The tick and its undo are two changes in History, the member's like any other.
  await expect.poll(() => authors(page, home.id)).toEqual(["member Ada Lovelace", "member Ada Lovelace", "member Ada Lovelace"]);
  await expect.poll(() => read(page, home.id)).toBe(HOME);

  // A newer completion takes the toast's place, and Dismiss takes it away with nothing else moving.
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toContainText("Completed Call the bank +Home");
  await row(page, "Write notes").getByRole("checkbox").check();
  await expect(toast(page)).toHaveText("Completed Write notesUndo");
  await expect(toast(page)).toHaveCount(1);
  await expect(words(page)).toHaveText(["Ship it", "Water plants", "Call the bank +Home", "Book flights", "Write notes"]);
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
  await filter(page, "Include completed").check();
  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect(toast(page)).toContainText("Completed Call the bank +Home");
  await chipOf(page, "Call the bank", "Importance").click();
  await choose(page, "!");
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
  await expect(words(page)).toHaveText(["Water plants"]);

  await toast(page).getByRole("button", { name: "Undo" }).click();

  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(toast(page)).toHaveCount(0);
  await expect(words(page)).toHaveText(["Call the bank +Home", "Water plants"]);
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
    await filter(page, "Due").selectOption("Today");
    await expect(words(page)).toHaveText(["The ninth"]);
    await filter(page, "Due").selectOption("Overdue");
    await expect(words(page)).toHaveText(["The eighth"]);
    await filter(page, "Due").selectOption("Next 7 days");
    await expect(words(page)).toHaveText(["The ninth", "The tenth"]);
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
  const cards = () => page.evaluate(() => [...document.querySelectorAll(".todo-card")].map((el) => JSON.stringify(el.getBoundingClientRect())));
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
  await expect(page.locator(".todo-card[data-picking]")).toHaveCount(0);
  await chipOf(page, "Ship it", "Importance").click();
  await todosPage(page).getByRole("heading", { level: 1 }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page.locator(".todo-card[data-picking]")).toHaveCount(0);
  await expect(chipOf(page, "Ship it", "Importance")).toHaveAttribute("aria-expanded", "false");

  // Near the foot of a short window it opens above its chip, still wholly inside.
  await page.setViewportSize({ width: 900, height: 420 });
  const low = chipOf(page, "Water plants", "Importance");
  await low.scrollIntoViewIfNeeded();
  await low.click();
  const placed = await hangsUnder(page, low);
  expect(placed.inside).toBe(true);
  await page.keyboard.press("Escape");
  // Where it fits neither below nor above, it is as low as it fits, and still wholly inside.
  await page.setViewportSize({ width: 700, height: 300 });
  const tight = chipOf(page, "Call the bank", "Due date");
  await tight.scrollIntoViewIfNeeded();
  await tight.click();
  expect((await hangsUnder(page, tight)).inside).toBe(true);
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
  await expect(page.locator(".todo-card[data-picking]")).toHaveCount(0);
  await expect.poll(async () => (await read(page, home.id)).split("\n").slice(2, 4)).toEqual(["- [ ] Inserted above due:2026-10-02", "- [ ] !! Call the bank due:2026-10-14 +Home"]);
});

test("the keyboard reaches every chip: Enter opens its popover on what it says now, arrows go through the choices, Enter picks, and Escape goes back to the chip changing nothing", async ({ page }) => {
  const { home } = await twoNotes(page);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];
  const chip = chipOf(page, "Call the bank", "Importance");

  await row(page, "Call the bank").getByRole("checkbox").focus();
  await page.keyboard.press("Tab");
  await expect(row(page, "Call the bank").getByRole("link")).toBeFocused();
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
