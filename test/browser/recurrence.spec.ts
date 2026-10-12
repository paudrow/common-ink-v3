import { expect, test, type Locator, type Page } from "@playwright/test";
import { anotherPerson, asViewerOfNote, join, listedNote, openAllNotes, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const line = (page: Page, text: string | RegExp) => page.locator(".cm-line").filter({ hasText: text }).first();
const read = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
const todosPage = (page: Page) => page.getByRole("region", { name: "Todos" });
const rows = (page: Page) => todosPage(page).getByRole("list", { name: "Todos" }).getByRole("listitem");
const row = (page: Page, text: string | RegExp) => rows(page).filter({ hasText: text });
const cursorLine = (page: Page) => page.evaluate(() => getSelection()!.anchorNode?.parentElement?.closest(".cm-line")?.textContent);
const recurrence = (page: Page) => page.getByRole("dialog", { name: "Recurrence" });
const completions = (page: Page) => page.getByRole("dialog", { name: "Completions" });
const modes = (page: Page) => page.getByRole("navigation", { name: "Modes" });

/** Today on the page's own clock, which is the day the app completes a todo on. */
const localDay = (page: Page) =>
  page.evaluate(() => {
    const at = new Date();
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  });
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
const expectShown = (of: Locator, text: string | RegExp) => {
  const shown = expect.poll(async () => (await of.evaluate(shownIn)).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
  return typeof text === "string" ? shown.toBe(text) : shown.toMatch(text);
};

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

/** The member's daily note for `day`, and the name of the folder it is in. */
async function dailyNote(page: Page, day: string, workspaceId?: string) {
  const note = await perform(page, { type: "daily.open", on: day }, workspaceId);
  const { folders } = await perform(page, { type: "folder.list" }, workspaceId);
  return { note, folder: folders.find((f) => f.id === note.folderId)?.name };
}

test("checking a recurring todo's box in the editor keeps the line open with its next due date and a last-done chip, and files the checked line on today's daily note", async ({ page }) => {
  const today = await localDay(page);
  const note = await open(page, `# Chores\n\n- [ ] Water the plants due:${today} every:1w +Home\n- [ ] Plain one\n`);
  await expectShown(line(page, "Water the plants"), "Water the plants Today ↻ 1w +Home");
  await expect(line(page, "Water the plants").getByRole("button", { name: "Recurs: Every week" })).toBeVisible();

  await line(page, "Water the plants").getByRole("checkbox").click();

  const rolled = `- [ ] Water the plants due:${addDays(today, 7)} every:1w +Home done:${today}x1`;
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled);
  // The editor takes the line the server answered with: open again, due next week, done today once.
  await expect(line(page, "Water the plants").getByRole("checkbox")).not.toBeChecked();
  await expectShown(line(page, "Water the plants"), /^Water the plants .+ ↻ 1w \+Home ✓ Today ×1$/);
  await expect(line(page, "Water the plants").getByRole("button", { name: "Last done Today, 1 time" })).toBeVisible();
  const daily = await dailyNote(page, today);
  expect(daily.note.text).toBe(`# ${today}\n\n- [x] Water the plants due:${today} +Home [[${note.id}]]\n`);
  expect(daily.folder).toBe("Daily");
  // The folder tree has the folder that was just made, without a reload.
  await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: /Daily/ })).toBeVisible();

  // A todo that doesn't recur is checked as it always was.
  await line(page, "Plain one").getByRole("checkbox").click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[3]).toBe("- [x] Plain one");
  expect((await dailyNote(page, today)).note.text).toBe(daily.note.text);
});

test("checking a recurring todo off on the Todos page leaves its row open, as its note reads, and it can't be completed twice while the first is on its way", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  const note = await perform(page, { type: "note.create", text: `# Home\n\n- [ ] Take out the bins due:${today} every:2w\n- [ ] Plain one\n` });
  await page.goto("/todos");
  const bins = row(page, "Take out the bins");
  await expect(bins.locator(".todo-every")).toHaveText("↻ 2w");
  await expect(bins.locator(".todo-done")).toHaveCount(0);

  await bins.getByRole("checkbox").dblclick();

  const rolled = `- [ ] Take out the bins due:${addDays(today, 14)} every:2w done:${today}x1`;
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled);
  await expect(bins).toHaveCount(1);
  await expect(bins.getByRole("checkbox")).not.toBeChecked();
  await expect(bins.getByRole("checkbox")).toBeEnabled();
  await expect(bins.locator(".todo-done")).toHaveText("✓ Today ×1");
  await expect(bins.getByLabel("Due date")).toHaveValue(addDays(today, 14));
  await expect.poll(async () => (await perform(page, { type: "todo.list", noteId: note.id })).todos.find((t) => t.line === 2)?.text).toBe(rolled);
  expect((await dailyNote(page, today)).note.text).toBe(`# ${today}\n\n- [x] Take out the bins due:${today} [[${note.id}]]\n`);

  // The same history as the editor's chip opens, with the daily note a click away.
  await bins.getByRole("button", { name: "Last done Today, 1 time" }).click();
  await expect(completions(page).getByRole("listitem")).toHaveText(["TodayAda Lovelace"]);
  await page.keyboard.press("Escape");
  await expect(completions(page)).toHaveCount(0);

  // Its recurrence is set and cleared from the row, with the form the editor's chip opens.
  await bins.getByRole("button", { name: "Recurs: Every 2 weeks" }).click();
  await recurrence(page).getByRole("button", { name: "Every month" }).click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled.replace("every:2w", "every:1m"));
  await expect(bins.locator(".todo-every")).toHaveText("↻ 1m");
  await bins.getByRole("button", { name: "Recurs: Every month" }).click();
  await recurrence(page).getByRole("button", { name: "Doesn't recur" }).click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled.replace(" every:2w", ""));
  await row(page, "Plain one").getByRole("button", { name: "Doesn't recur" }).click();
  await recurrence(page).getByRole("button", { name: "Every day" }).click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[3]).toBe("- [ ] Plain one every:1d");
});

test("typing x into a recurring todo's brackets completes it as its checkbox does", async ({ page }) => {
  const today = await localDay(page);
  const written = "- [ ] Stretch every:1d";
  const note = await open(page, `# Habits\n\n${written}`);

  await page.keyboard.press("ControlOrMeta+End");
  expect(await cursorLine(page)).toBe(written);
  for (let i = 0; i < written.length - "- [".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Delete");
  await page.keyboard.type("x");

  const rolled = `- [ ] Stretch every:1d due:${addDays(today, 1)} done:${today}x1`;
  await expect.poll(() => read(page, note.id)).toBe(`# Habits\n\n${rolled}`);
  await expect.poll(() => cursorLine(page)).toBe(rolled);
  await page.keyboard.press("ControlOrMeta+Home");
  await expectShown(line(page, "Stretch"), "Stretch ↻ 1d Tomorrow ✓ Today ×1");
  expect((await dailyNote(page, today)).note.text).toBe(`# ${today}\n\n- [x] Stretch [[${note.id}]]\n`);
});

/** The lines filed on the member's daily note for `day`. */
const filedOn = async (page: Page, day: string) => (await dailyNote(page, day)).note.text.split("\n").filter((l) => l.startsWith("- [x]"));

test("a word typed on a recurring todo's line right after its box is clicked is kept, and the todo is completed once", async ({ page }) => {
  const today = await localDay(page);
  const note = await open(page, "# Habits\n\n- [ ] Stretch every:1d");

  await line(page, "Stretch").getByRole("checkbox").click();
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" slowly");

  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toMatch(new RegExp(`^- \\[ \\] Stretch every:1d(?=.* slowly)(?=.* due:${addDays(today, 1)})(?=.* done:${today}x1)`));
  expect((await read(page, note.id)).split("\n")[2]!.length).toBe(`- [ ] Stretch every:1d slowly due:${today} done:${today}x1`.length);
  await expect.poll(() => filedOn(page, today)).toHaveLength(1);
  expect((await filedOn(page, today))[0]).toContain("Stretch");
  await page.keyboard.press("ControlOrMeta+Home");
  await expect(line(page, "Stretch").getByRole("button", { name: "Last done Today, 1 time" })).toBeVisible();
});

test("typing x into a recurring todo's brackets and going on typing on the line completes it once, with what was typed", async ({ page }) => {
  const today = await localDay(page);
  const written = "- [ ] Stretch every:1d";
  const note = await open(page, `# Habits\n\n${written}`);

  await page.keyboard.press("ControlOrMeta+End");
  for (let i = 0; i < written.length - "- [".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Delete");
  await page.keyboard.type("x");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" slowly");

  await expect.poll(() => read(page, note.id)).toBe(`# Habits\n\n- [ ] Stretch every:1d slowly due:${addDays(today, 1)} done:${today}x1`);
  await expect.poll(() => filedOn(page, today)).toHaveLength(1);
  expect((await filedOn(page, today))[0]).toContain("Stretch");
  await expect.poll(() => cursorLine(page)).toContain(`done:${today}x1`);
});

test("undoing a completion puts the todo's line back and takes the filed line off the daily note, and redoing or completing again files it once", async ({ page }) => {
  const today = await localDay(page);
  const text = "# Habits\n\n- [ ] Stretch every:1d\n";
  const rolled = `# Habits\n\n- [ ] Stretch every:1d due:${addDays(today, 1)} done:${today}x1\n`;
  const note = await open(page, text);
  const complete = async () => {
    await line(page, "Stretch").getByRole("checkbox").click();
    await expect.poll(() => read(page, note.id)).toBe(rolled);
    await expect.poll(() => filedOn(page, today)).toHaveLength(1);
  };
  const press = async (keys: string) => {
    await editor(page).focus();
    await page.keyboard.press(keys);
  };

  await complete();
  await press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toBe(text);
  await expect.poll(() => filedOn(page, today)).toEqual([]);
  await expect(line(page, "Stretch").getByRole("button", { name: /^Last done/ })).toHaveCount(0);

  await press("ControlOrMeta+Shift+z");
  await expect.poll(() => read(page, note.id)).toBe(rolled);
  await expect.poll(() => filedOn(page, today)).toHaveLength(1);

  await press("ControlOrMeta+z");
  await expect.poll(() => read(page, note.id)).toBe(text);
  await expect.poll(() => filedOn(page, today)).toEqual([]);
  await complete();
  expect(await filedOn(page, today)).toEqual([`- [x] Stretch [[${note.id}]]`]);
});

test("the recurrence chip sets a simple rule, each advanced kind, and days of the week, and takes the rule away", async ({ page }) => {
  const note = await open(page, "# Plan\n\n- [ ] Pay rent every:1w due:2031-01-01 +Home\nAfter");
  const rent = () => line(page, "Pay rent");
  const lineIn = async () => (await read(page, note.id)).split("\n")[2];
  const chip = (name: string) => rent().getByRole("button", { name });

  await chip("Recurs: Every week").click();
  await expect(recurrence(page).getByRole("button", { name: "Every week", exact: true })).toHaveAttribute("aria-pressed", "true");
  await recurrence(page).getByRole("button", { name: "Every month" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:1m due:2031-01-01 +Home");
  await expect(recurrence(page)).toHaveCount(0);
  await expectShown(rent(), "Pay rent ↻ 1m Jan 1, 2031 +Home");

  // Escape and a press outside close it and change nothing.
  await chip("Recurs: Every month").click();
  await expect(recurrence(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(recurrence(page)).toHaveCount(0);
  await chip("Recurs: Every month").click();
  await line(page, "Plan").click();
  await expect(recurrence(page)).toHaveCount(0);
  expect(await lineIn()).toBe("- [ ] Pay rent every:1m due:2031-01-01 +Home");

  // By keyboard: the form takes focus, and Enter in a field sets the rule.
  await chip("Recurs: Every month").click();
  await expect(recurrence(page).getByRole("button", { name: "Every day" })).toBeFocused();
  await recurrence(page).getByRole("button", { name: "Advanced" }).click();
  await recurrence(page).getByLabel("How many").fill("3");
  await recurrence(page).getByLabel("Unit").selectOption("days");
  await recurrence(page).getByLabel("Counted", { exact: true }).selectOption("from the day it was done");
  await expect(recurrence(page).locator(".rule-says")).toHaveText("3 days after done");
  await recurrence(page).getByLabel("How many").press("Enter");
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:3d-after-done due:2031-01-01 +Home");

  await chip("Recurs: 3 days after done").click();
  // A rule the simple choices don't have opens with Advanced showing it.
  await expect(recurrence(page).getByLabel("How many")).toHaveValue("3");
  await recurrence(page).getByLabel("Day of the month", { exact: true }).fill("2");
  await recurrence(page).getByLabel("Day counted", { exact: true }).selectOption("from the end");
  await recurrence(page).getByRole("button", { name: "Set" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:2nd-last-day due:2031-01-01 +Home");

  await chip("Recurs: 2nd-last day of the month").click();
  await recurrence(page).getByLabel("Which one").selectOption("2nd");
  await recurrence(page).getByLabel("Weekday", { exact: true }).selectOption("Tue");
  await recurrence(page).getByRole("button", { name: "Set" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:2nd-tue due:2031-01-01 +Home");

  await chip("Recurs: 2nd Tue of the month").click();
  const days = recurrence(page).getByRole("group", { name: "Days of the week" });
  await days.getByRole("button", { name: "Thu" }).click();
  await days.getByRole("button", { name: "Mon" }).click();
  await recurrence(page).getByRole("button", { name: "Set" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:mon,thu due:2031-01-01 +Home");

  await chip("Recurs: Mon, Thu").click();
  await recurrence(page).getByRole("button", { name: "Doesn't recur" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent due:2031-01-01 +Home");
  await expect(rent().getByRole("button")).toHaveCount(0);
  expect(await read(page, note.id)).toBe("# Plan\n\n- [ ] Pay rent due:2031-01-01 +Home\nAfter");
});

test("typing every: offers rules, and the one picked is written as a rule", async ({ page }) => {
  const note = await open(page, "# Plan\n\n- [ ] Pay rent");

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" every:");
  const offered = page.getByRole("listbox").getByRole("option");
  await expect(offered.first()).toContainText("Every day");
  await page.keyboard.type("2w");
  await expect(offered).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- [ ] Pay rent every:2w");
});

test("the last-done chip says the day and the count, and lists each completion with who did it and its daily note", async ({ page }) => {
  const today = await localDay(page);
  const note = await open(page, `# Chores\n\n- [ ] Feed the cat every:1d done:2026-01-05x3\n`);
  const cat = () => line(page, "Feed the cat");
  await expectShown(cat(), "Feed the cat ↻ 1d ✓ Jan 5 ×3");

  // Three are counted on the line and none were followed here.
  await cat().getByRole("button", { name: "Last done Jan 5, 3 times" }).click();
  await expect(completions(page)).toContainText("Done 3 times");
  await expect(completions(page)).toContainText("None of them are listed here. A completion made before the line was cut and pasted is not followed.");
  await expect(completions(page).getByRole("listitem")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await cat().getByRole("checkbox").click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(`- [ ] Feed the cat every:1d done:${today}x4 due:${addDays(today, 1)}`);
  await cat().getByRole("button", { name: "Last done Today, 4 times" }).click();
  await expect(completions(page).getByRole("listitem")).toHaveText(["TodayAda Lovelace"]);
  await expect(completions(page)).toContainText("3 earlier ones aren't listed here.");

  // Asked for with typing the server doesn't have yet, which moved the line: it is found once that is saved.
  await page.keyboard.press("Escape");
  await line(page, "Chores").click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type("First line\n");
  await cat().getByRole("button", { name: "Last done Today, 4 times" }).click();
  await expect(completions(page).getByRole("listitem")).toHaveText(["TodayAda Lovelace"]);

  await completions(page).getByRole("listitem").getByRole("button").click();
  const daily = await dailyNote(page, today);
  await expect(page).toHaveURL(new RegExp(`${daily.note.id}$`));
  await expect(editor(page)).toContainText("Feed the cat");
});

test("a viewer sees the recurrence and last-done chips, can list the completions, and can change nothing", async ({ page }) => {
  const text = "# Chores\n\n- [ ] Feed the cat every:1d done:2026-01-05x3\n";
  const { note, admin } = await asViewerOfNote(page, text);
  await page.goto(`/note/${note.id}`);

  await expect(line(page, "Feed the cat").getByRole("button", { name: "Recurs: Every day" })).toBeDisabled();
  await line(page, "Feed the cat").getByRole("button", { name: "Last done Jan 5, 3 times" }).click();
  await expect(completions(page)).toContainText("Done 3 times");
  await page.keyboard.press("Escape");

  await page.goto("/todos");
  await expect(row(page, "Feed the cat").getByRole("button", { name: "Recurs: Every day" })).toBeDisabled();
  await expect(row(page, "Feed the cat").getByRole("checkbox")).toBeDisabled();
  // A viewer has no daily note, and is told so in the server's words.
  await modes(page).getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("region", { name: "Today" }).getByRole("alert")).not.toBeEmpty();
  expect(await read(admin, note.id)).toBe(text);
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
  "- [ ] !! First todo due:2026-10-14 every:2w done:2026-10-10x12 +Home trailing words",
  "  - [ ] Nested todo every:mon,thu done:2026-01-02 nested tail",
  "- [ ] A long todo that goes on for many words so that it wraps in a narrow column and its tokens fall near the end of a row every:3d-after-done done:2025-12-31x104 and then some more words after the tokens to wrap again due:2026-11-11 every:2nd-last-fri +Second",
  "1. [ ] Numbered todo every:last-day done:2026-09-30x2 numbered tail",
  "",
  "Below words.",
].join("\n");
const MEASURED = ["Above words", "First todo", "trailing words", "Nested todo", "nested tail", "A long todo", "and then some more", "wrap again", "Numbered todo", "numbered tail", "Below words"];

/** The column is 720px wide in the first and 314px in the second, where the long todo wraps over several rows. */
for (const width of [1600, 1100]) {
  test(`nothing moves when the cursor comes to a line with a recurrence and a last-done chip, each as wide as its token (${width}px window)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 2000 });
    await open(page, LAYOUT);
    await expect(editor(page).getByRole("button", { name: /^Last done/ })).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const before = await places(page, MEASURED);

    const chipBoxes = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-content .md-chip-sized")].map((el) => [el.className.replace(/md-chip-sized|md-chip /g, "").trim(), el.firstElementChild!.textContent, Math.round(el.getBoundingClientRect().x), Math.round(el.getBoundingClientRect().width)]));
    const drawn = await chipBoxes();
    // A todo's second every: is words, as its second due: is.
    expect(drawn.filter((c) => c[0] === "md-chip-every").map((c) => c[1])).toEqual(["every:2w", "every:mon,thu", "every:3d-after-done", "every:last-day"]);
    expect(drawn.filter((c) => c[0] === "md-chip-done").map((c) => c[1])).toEqual(["done:2026-10-10x12", "done:2026-01-02", "done:2025-12-31x104", "done:2026-09-30x2"]);
    // What a chip says is never wider than the chip, so nothing of it is cut off.
    const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-content .md-chip-every > .md-todo-chip, .cm-content .md-chip-done > .md-todo-chip")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    expect(cut).toEqual([]);

    for (const word of ["First todo", "Nested todo", "A long todo", "Numbered todo"]) {
      const at = await page.evaluate((w) => {
        const el = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((l) => l.textContent!.includes(w))!;
        const box = el.getBoundingClientRect();
        return { x: box.right - 4, y: box.bottom - 6 };
      }, word);
      await page.mouse.click(at.x, at.y);
      expect(await cursorLine(page), `the cursor is on "${word}"`).toContain(word);
      await expect(line(page, word).locator(".md-chip-sized")).toHaveCount(0);
      const now = await places(page, MEASURED);
      for (const [measured, was] of Object.entries(before)) {
        for (const side of ["x", "y", "top", "height"] as const) expect(Math.abs(now[measured]![side] - was[side]), `${side} of "${measured}" with the cursor on "${word}": ${was[side]} -> ${now[measured]![side]}`).toBeLessThanOrEqual(1);
      }
      // Each token written is where its chip was, as wide as it was.
      const written = await page.evaluate((w) => {
        const el = [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")].find((l) => l.textContent!.includes(w))!;
        return [...el.querySelectorAll<HTMLElement>(".md-todo-token")].map((t) => [t.textContent, Math.round(t.getBoundingClientRect().x), Math.round(t.getBoundingClientRect().width)]);
      }, word);
      expect(written.filter(([text]) => /^(every|done):/.test(text as string)).length, `the tokens of "${word}"`).toBe(2);
      for (const [text, x, wide] of written) {
        const chip = drawn.find((c) => c[1] === text && Math.abs((c[2] as number) - (x as number)) <= 1);
        expect(chip, `"${text}" at ${x} on "${word}" stands where a chip stood: ${JSON.stringify(drawn.filter((c) => c[1] === text))}`).toBeDefined();
        expect(Math.abs((chip![3] as number) - (wide as number)), `the width of "${text}"`).toBeLessThanOrEqual(1);
      }
    }
    await page.keyboard.press("ControlOrMeta+Home");
    expect(await chipBoxes()).toEqual(drawn);

    // The form opens over the app and takes no room in the note.
    await line(page, "First todo").getByRole("button", { name: "Recurs: Every 2 weeks" }).click();
    await expect(recurrence(page)).toBeVisible();
    await recurrence(page).getByRole("button", { name: "Advanced" }).click();
    expect(await places(page, MEASURED)).toEqual(before);
    await page.keyboard.press("Escape");
  });
}

test("the sidebar's Today and the command both open today's daily note, headed by today's date, in the Daily folder, and Back goes where the member was", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  await page.goto("/todos");
  await expect(todosPage(page)).toBeVisible();

  await modes(page).getByRole("link", { name: "Today" }).click();

  await expect(editor(page)).toContainText(today);
  const daily = await dailyNote(page, today);
  await expect(page).toHaveURL(new RegExp(`${daily.note.id}$`));
  expect(daily.note.text).toBe(`# ${today}\n\n`);
  expect(daily.folder).toBe("Daily");
  expect(daily.note.private).toBe(true);
  // The folder tree and the note list have what was just made.
  await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: /Daily/ })).toBeVisible();
  await openAllNotes(page);
  await expect(listedNote(page, today)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${daily.note.id}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);

  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox", { name: "Commands" }).fill("Open today's daily note");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${daily.note.id}$`));
  await expect(editor(page)).toContainText(today);
  expect((await perform(page, { type: "note.list" })).filter((n) => n.title === today)).toHaveLength(1);
  await page.goBack();
  await expect(page).toHaveURL(/\/todos$/);
});

test("changing the daily folder leaves a daily note already made where it is, and the next one is made in the new folder", async ({ page }) => {
  const today = await localDay(page);
  const note = await open(page, "# Chores\n\n- [ ] Sweep every:1d\n- [ ] Mop every:1d\n");
  await line(page, "Sweep").getByRole("checkbox").click();
  await expect.poll(() => read(page, note.id)).toContain(`done:${today}x1`);
  const first = await dailyNote(page, today);
  expect([first.note.text, first.folder]).toEqual([`# ${today}\n\n- [x] Sweep [[${note.id}]]\n`, "Daily"]);

  // The settings are the daily plugin's, under the keys the server reads.
  await page.goto("/settings/plugins/daily");
  await expect(page.getByText("Daily notes folder")).toBeVisible();
  await expect(page.getByText("Private daily notes")).toBeVisible();
  await expect(page.getByText("Time zone for agents")).toBeVisible();
  await perform(page, { type: "settings.write", text: JSON.stringify({ "daily.folder": "Journal", "daily.private": false }), baseRevision: 0 });

  // Today's note is found where it was made, and a completion is filed on it there.
  await page.goto(`/note/${note.id}`);
  await line(page, "Mop").getByRole("checkbox").click();
  await expect.poll(async () => (await dailyNote(page, today)).note.text).toBe(`# ${today}\n\n- [x] Sweep [[${note.id}]]\n- [x] Mop [[${note.id}]]\n`);
  const still = await dailyNote(page, today);
  expect([still.note.id, still.folder]).toEqual([first.note.id, "Daily"]);
  // Another day's is made by the setting as it is now.
  const next = await dailyNote(page, addDays(today, 1));
  expect([next.folder, next.note.private]).toEqual(["Journal", false]);

  // A member who never had a daily note here gets theirs in the folder their own settings name.
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  await perform(grace, { type: "settings.write", text: JSON.stringify({ "daily.folder": "Log" }), baseRevision: 0 }, workspaceId);
  const theirs = await dailyNote(grace, today, workspaceId);
  expect([theirs.folder, theirs.note.private, theirs.note.id === first.note.id]).toEqual(["Log", true, false]);
});

test("a daily note open in another editor group takes the line filed on it, and goes on being written", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  const note = await perform(page, { type: "note.create", text: "# Chores\n\n- [ ] Sweep every:1d\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Sweep");
  await modes(page).getByRole("link", { name: "Today" }).click();
  await expect(editor(page)).toContainText(today);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Morning.");
  const daily = await dailyNote(page, today);
  await expect.poll(() => read(page, daily.note.id)).toBe(`# ${today}\n\nMorning.`);

  // The daily note goes to a group of its own, beside the todo's note.
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox", { name: "Commands" }).fill("Split editor right");
  await page.keyboard.press("Enter");
  const [left, right] = [page.getByRole("region", { name: "Editor group 1" }).getByRole("textbox", { name: "Note text" }), page.getByRole("region", { name: "Editor group 2" }).getByRole("textbox", { name: "Note text" })];
  await expect(right).toContainText("Morning.");

  await left.locator(".cm-line").filter({ hasText: "Sweep" }).getByRole("checkbox").click();

  await expect(right).toContainText("Sweep");
  await expect(left.locator(".cm-line").filter({ hasText: "Sweep" }).getByRole("button", { name: "Last done Today, 1 time" })).toBeVisible();
  await right.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Evening.");
  await expect.poll(() => read(page, daily.note.id)).toBe(`# ${today}\n\nMorning.\n- [x] Sweep [[${note.id}]]\nEvening.`);
});
