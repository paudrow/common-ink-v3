import { expect, test, type Locator, type Page } from "@playwright/test";
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
const filter = (page: Page, name: string) => todosPage(page).getByRole("group", { name: "Filters" }).getByLabel(name);
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

test("a todo's importance, due date and project are drawn as chips, on the lines the server takes for todos and no others", async ({ page }) => {
  const note = await open(page, CHORES);

  await expect(editor(page).getByRole("checkbox")).toHaveCount(4);
  await expect(editor(page).getByRole("combobox", { name: "Importance" })).toHaveCount(2);
  await expect(editor(page).getByLabel("Due date")).toHaveCount(1);
  await expect(editor(page).getByRole("combobox", { name: "Project" })).toHaveCount(3);
  await expectShown(line(page, "Call the bank"), "!! Call the bank Oct 14, 2031 +Home about the card");
  await expectShown(line(page, "in code"), "[ ] !!! in code due:2031-10-14 +Never");
  // Indented as far as a code block is, and a todo all the same: the editor draws what the server lists.
  await expectShown(line(page, "Deep one"), "! Deep one +Garden");
  const listed = (await perform(page, { type: "todo.list", noteId: note.id, includeCompleted: true })).todos.map((t) => t.words);
  expect(listed.sort()).toEqual(["Book flights", "Call the bank about the card", "Deep one", "Plain one"]);

  // On the cursor's line the note shows what it writes.
  // At the end of the line, past its last word: the middle of the line is a chip at some widths, and a click there opens the chip.
  const bank = (await line(page, "Call the bank").boundingBox())!;
  await page.mouse.click(bank.x + bank.width - 3, bank.y + bank.height - 6);
  await expectShown(line(page, "Call the bank"), "[ ] !! Call the bank due:2031-10-14 +Home about the card");
  await expect(editor(page).getByLabel("Due date")).toHaveCount(0);
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
  // The project chip offers the projects there are, from every note.
  await expect(bank().getByRole("combobox", { name: "Project" }).getByRole("option")).toHaveText(["Home", "Garden", "Trip", "No project", "Rename…"]);
  await bank().getByRole("combobox", { name: "Project" }).selectOption("Trip");
  await expect.poll(lineIn).toBe("- [ ] !!! Call the bank due:2031-12-25 +Trip about the card");
  await bank().getByRole("checkbox").click();
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Trip about the card");
  expect(new Set(await authors(page, note.id))).toEqual(new Set(["member Ada Lovelace"]));

  // Taking an option away takes its token and the space before it, and undo puts both back.
  await bank().getByRole("combobox", { name: "Importance" }).selectOption("Normal");
  await expect.poll(lineIn).toBe("- [x] Call the bank due:2031-12-25 +Trip about the card");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(lineIn).toBe("- [x] !!! Call the bank due:2031-12-25 +Trip about the card");
  await bank().getByRole("combobox", { name: "Importance" }).selectOption("Normal");
  await bank().getByLabel("Due date").fill("");
  await bank().getByRole("combobox", { name: "Project" }).selectOption("No project");
  await expect.poll(lineIn).toBe("- [x] Call the bank about the card");
  expect((await read(page, note.id)).replace("- [x] Call the bank about the card", "- [ ] !! Call the bank due:2031-10-14 +Home about the card")).toBe(CHORES);

  // Rename puts the cursor in the token, which shows the line as written.
  await line(page, "Deep one").getByRole("combobox", { name: "Project" }).selectOption("Rename…");
  await page.keyboard.type("ing");
  await expect.poll(async () => (await read(page, note.id)).split("\n")[9]).toBe("      - [ ] ! Deep one +Gardening");
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
  for (const control of [editor(page).getByRole("checkbox").first(), editor(page).getByRole("combobox", { name: "Importance" }).first(), editor(page).getByLabel("Due date"), editor(page).getByRole("combobox", { name: "Project" }).first()]) await expect(control).toBeDisabled();

  await page.goto("/todos");
  await expect(words(page)).toHaveText(["Call the bank about the card", "Deep one", "Plain one"]);
  for (const control of await rows(page).locator("input, select").all()) await expect(control).toBeDisabled();
  await expect(rows(page).getByLabel("Add to a project")).toHaveCount(0);
  expect(await read(admin, note.id)).toBe(CHORES);
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
  "- [ ] !! First todo due:2026-10-14 +Home trailing words",
  "  - [x] ! Nested todo +Trip-planning due:2026-01-02 nested tail",
  "    - [ ] Deeper todo +a",
  "- [ ] !!! A long todo that goes on for many words so that it wraps in a narrow column and its tokens fall near the end of a row due:2026-10-14 +Long-project-name and then some more words after the tokens to wrap again due:2026-11-11 +Second",
  "1. [ ] ! Numbered todo due:2027-03-04 numbered tail",
  "",
  "Below words.",
].join("\n");
const MEASURED = ["Above words", "First todo", "trailing words", "Nested todo", "nested tail", "Deeper todo", "A long todo", "and then some more", "wrap again", "Numbered todo", "numbered tail", "Below words"];

/** The column is 720px wide in the first and 314px in the second, where the long todo wraps over several rows. */
for (const width of [1600, 1100]) {
  test(`nothing on a todo's line moves when the cursor comes and its chips are shown as written, and a chip is as wide as its token (${width}px window)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 2000 });
    await open(page, LAYOUT);
    await expect(editor(page).getByLabel("Due date")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const before = await places(page, MEASURED);

    // Each chip stands exactly where its token is written: same left edge, same width.
    const chipBoxes = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-content .md-chip-sized")].map((el) => [el.className.replace(/md-chip-sized|md-chip /g, "").trim(), el.firstElementChild!.textContent, Math.round(el.getBoundingClientRect().x), Math.round(el.getBoundingClientRect().width)]));
    const drawn = await chipBoxes();
    // Five checkboxes, four importances, four due dates (a todo's second due: is words), and five projects.
    expect(drawn.length).toBe(5 + 4 + 4 + 5);

    for (const word of ["First todo", "Nested todo", "Deeper todo", "A long todo", "Numbered todo"]) {
      const at = await page.evaluate((w) => {
        const el = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((l) => l.textContent!.includes(w))!;
        const box = el.getBoundingClientRect();
        return { x: box.right - 4, y: box.bottom - 6 };
      }, word);
      await page.mouse.click(at.x, at.y);
      expect(await cursorLine(page), `the cursor is on "${word}"`).toContain(word);
      // As written: the line's own chips are gone and its tokens are text.
      await expect(line(page, word).locator(".md-chip-sized")).toHaveCount(0);
      const now = await places(page, MEASURED);
      for (const [measured, was] of Object.entries(before)) {
        for (const side of ["x", "y", "top", "height"] as const) expect(Math.abs(now[measured]![side] - was[side]), `${side} of "${measured}" with the cursor on "${word}": ${was[side]} -> ${now[measured]![side]}`).toBeLessThanOrEqual(1);
      }
      // And each token written is where its chip was, as wide as it was.
      const written = await page.evaluate((w) => {
        const el = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((l) => l.textContent!.includes(w))!;
        return [...el.querySelectorAll<HTMLElement>(".md-todo-token")].map((t) => [t.textContent, Math.round(t.getBoundingClientRect().x), Math.round(t.getBoundingClientRect().width)]);
      }, word);
      for (const [text, x, wide] of written) {
        const chip = drawn.find((c) => c[1] === text && Math.abs((c[2] as number) - (x as number)) <= 1);
        expect(chip, `"${text}" at ${x} on "${word}" stands where a chip stood: ${JSON.stringify(drawn.filter((c) => c[1] === text))}`).toBeDefined();
        expect(Math.abs((chip![3] as number) - (wide as number)), `the width of "${text}"`).toBeLessThanOrEqual(1);
      }
    }
    await page.keyboard.press("ControlOrMeta+Home");
    expect(await chipBoxes()).toEqual(drawn);
  });
}

const HOME = "# Home\n\n- [ ] !! Call the bank due:2026-10-14 +Home\n- [x] Book flights +Trip\n- [ ] ! Water plants +Garden #outside\n";
const WORK = "# Work #office\n\n- [ ] !!! Ship it due:2026-10-12 +Launch\n- [ ] Write notes\n";

async function twoNotes(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  const home = await perform(page, { type: "note.create", text: HOME });
  const work = await perform(page, { type: "note.create", text: WORK });
  await page.goto("/todos");
  return { home, work };
}

test("the Todos page lists open todos from every note, and narrows by project, tag, due date and importance, and to completed ones too", async ({ page }) => {
  await twoNotes(page);

  await expect(todosPage(page).getByRole("heading", { level: 1 })).toHaveText("Todos");
  await expect(words(page)).toHaveText(["Ship it", "Call the bank", "Water plants #outside", "Write notes"]);
  await expect(row(page, "Ship it").locator(".todo-note")).toHaveText("Work #office");

  await filter(page, "Include completed").check();
  await expect(words(page)).toHaveText(["Ship it", "Call the bank", "Water plants #outside", "Write notes", "Book flights"]);
  await expect(row(page, "Book flights").getByRole("checkbox")).toBeChecked();
  await filter(page, "Project").selectOption("Trip");
  await expect(words(page)).toHaveText(["Book flights"]);
  await filter(page, "Include completed").uncheck();
  await expect(todosPage(page)).toContainText("No todos match.");

  await expect(filter(page, "Project").getByRole("option")).toHaveText(["All projects", "Garden", "Home", "Launch", "Trip"]);
  await filter(page, "Project").selectOption("Home");
  await expect(words(page)).toHaveText(["Call the bank"]);
  await filter(page, "Project").selectOption("All projects");
  await expect(filter(page, "Tag").getByRole("option")).toHaveText(["All tags", "#office", "#outside"]);
  await filter(page, "Tag").selectOption("#office");
  await expect(words(page)).toHaveText(["Ship it", "Write notes"]);
  await filter(page, "Tag").selectOption("All tags");
  await filter(page, "Importance").selectOption("!!");
  await expect(words(page)).toHaveText(["Call the bank"]);
  await filter(page, "Importance").selectOption("Normal");
  await expect(words(page)).toHaveText(["Write notes"]);
  await filter(page, "Importance").selectOption("Any");
  await filter(page, "Due").selectOption("No date");
  await expect(words(page)).toHaveText(["Water plants #outside", "Write notes"]);

  // The page opens the way it was left.
  await page.reload();
  await expect(filter(page, "Due")).toHaveValue("none");
  await expect(words(page)).toHaveText(["Water plants #outside", "Write notes"]);
});

test("checking a todo off and changing its chips on the Todos page rewrites its line in its note, as the member's change", async ({ page }) => {
  const { home } = await twoNotes(page);
  const lineIn = async () => (await read(page, home.id)).split("\n")[2];

  await row(page, "Call the bank").getByLabel("Importance").selectOption("!");
  await expect.poll(lineIn).toBe("- [ ] ! Call the bank due:2026-10-14 +Home");
  await row(page, "Call the bank").getByLabel("Due date").fill("2026-11-02");
  await expect.poll(lineIn).toBe("- [ ] ! Call the bank due:2026-11-02 +Home");
  // Two changes one after the other, the second before the list has been read again: it is made to the line the first leaves.
  await row(page, "Call the bank").getByLabel("Project Home").selectOption("Garden");
  await row(page, "Call the bank").getByLabel("Add to a project").selectOption("Launch");
  await expect.poll(lineIn).toBe("- [ ] ! Call the bank due:2026-11-02 +Garden +Launch");
  await row(page, "Write notes").getByLabel("Due date").fill("2026-10-01");
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Call the bank", "Water plants #outside"]);

  await row(page, "Call the bank").getByRole("checkbox").check();
  await expect.poll(lineIn).toBe("- [x] ! Call the bank due:2026-11-02 +Garden +Launch");
  await expect(words(page)).toHaveText(["Write notes", "Ship it", "Water plants #outside"]);
  expect((await read(page, home.id)).replace("- [x] ! Call the bank due:2026-11-02 +Garden +Launch", "- [ ] !! Call the bank due:2026-10-14 +Home")).toBe(HOME);
  expect(new Set(await authors(page, home.id))).toEqual(new Set(["member Ada Lovelace"]));
  // The note list's count of open todos follows.
  await expect.poll(async () => (await perform(page, { type: "note.list" })).find((n) => n.id === home.id)!.openTodos).toBe(1);
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
  await row(page, "Call the bank").getByRole("button", { name: /Call the bank/ }).click();

  await expect(page).toHaveURL(new RegExp(`${home.id}$`));
  await expect.poll(() => cursorLine(page)).toBe("- [ ] !! Call the bank due:2026-10-14 +Home");
  await expect(line(page, "Water plants").getByRole("checkbox")).toBeChecked();
  await expect(editor(page)).toContainText("Typed last.");
  await page.keyboard.type(" now");
  await expect.poll(() => read(page, home.id)).toBe(`${HOME.replace("- [ ] ! Water", "- [x] ! Water").replace("+Home", "+Home now")}Typed last.`);
});

test("a todo that changed since it was listed is not rewritten: the page says so and lists what is there now", async ({ page }) => {
  const { home } = await twoNotes(page);
  await expect(words(page)).toHaveText(["Ship it", "Call the bank", "Water plants #outside", "Write notes"]);
  const changed = HOME.replace("- [ ] !! Call the bank due:2026-10-14 +Home", "- [ ] Email the landlord\n- [ ] !! Call the credit union due:2026-10-14 +Home");
  await perform(page, { type: "note.write", id: home.id, baseRevision: 1, text: changed });

  await row(page, "Call the bank").getByRole("checkbox").check();

  await expect(todosPage(page).getByRole("alert")).toHaveText("This todo was changed since it was listed. List the todos again.");
  await expect(words(page)).toHaveText(["Ship it", "Call the credit union", "Water plants #outside", "Email the landlord", "Write notes"]);
  expect(await read(page, home.id)).toBe(changed);
});

test("an agent lists todos and checks one off, and the Todos page and the note follow", async ({ page }) => {
  const { home } = await twoNotes(page);
  const agent = await connectAgent(page, "Claude");

  const listed = await agent.tool<{ todos: { noteId: string; revision: number; line: number; text: string; words: string }[] }>("list_todos", { project: "home" });
  expect(listed.todos.map((t) => t.words)).toEqual(["Call the bank"]);
  const { noteId, revision, line: at, text } = listed.todos[0]!;
  await agent.tool("set_todo", { id: noteId, revision, line: at, text, done: true, due: "2026-10-20" });
  // The same call again, as after an answer that never arrived, changes nothing more.
  await agent.tool("set_todo", { id: noteId, revision, line: at, text, done: true, due: "2026-10-20" });

  expect((await read(page, home.id)).split("\n")[2]).toBe("- [x] !! Call the bank due:2026-10-20 +Home");
  expect(await authors(page, home.id)).toEqual(["member Ada Lovelace", "agent Claude"]);
  await expect(words(page)).toHaveText(["Ship it", "Water plants #outside", "Write notes"], { timeout: 20_000 });
});

test.describe("where the member's day is not the day in UTC", () => {
  // Five in the morning on the 10th in UTC is nine in the evening on the 9th in Los Angeles.
  test.use({ timezoneId: "America/Los_Angeles" });

  test("due today is today where the member is, in the note and on the Todos page", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-03-10T05:00:00Z"));
    const note = await open(page, "# Days\n\n- [ ] The eighth due:2026-03-08\n- [ ] The ninth due:2026-03-09\n- [ ] The tenth due:2026-03-10\n- [ ] The twentieth due:2026-03-20\n- [ ] Undated\n");
    expect(await localDay(page)).toBe("2026-03-09");

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
    expect(await read(page, note.id)).toContain("due:2026-03-09");
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
