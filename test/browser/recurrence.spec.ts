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
/** The line the cursor is on as the note writes it: each chip's token, without what the chip says over it. */
const cursorLine = (page: Page) =>
  page.evaluate(() => {
    const copy = getSelection()!.anchorNode?.parentElement?.closest(".cm-line")?.cloneNode(true) as HTMLElement | undefined;
    copy?.querySelectorAll(".md-chip-sized > :not(:first-child)").forEach((said) => said.remove());
    // The recurrence chip takes its own width and holds no token: it names the one it stands for.
    copy?.querySelectorAll<HTMLElement>(".md-chip-every").forEach((chip) => chip.replaceWith(chip.dataset.written!));
    return copy?.textContent;
  });
const recurrence = (page: Page) => page.getByRole("dialog", { name: "Recurrence" });
const completions = (page: Page) => page.getByRole("dialog", { name: "Completions" });
const more = (page: Page, text: string | RegExp) => row(page, text).getByRole("button", { name: /^More for / });
const menu = (page: Page) => page.getByRole("menu", { name: /^More for / });
/** Picks from a todo's one menu on the Todos page, which is where everything but its checkbox and its words is. */
const pick = async (page: Page, text: string | RegExp, item: string) => {
  await more(page, text).click();
  await menu(page).getByRole("menuitem", { name: item, exact: true }).click();
};
const modes = (page: Page) => page.getByRole("navigation", { name: "Modes" });

/** Today on the page's own clock, which is the day the app completes a todo on. */
const localDay = (page: Page) =>
  page.evaluate(() => {
    const at = new Date();
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  });
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** How a due date more than a week off is said beside today. */
const dateSaid = (day: string, now: string) => {
  const short = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return day.slice(0, 4) === now.slice(0, 4) ? short : `${short}, ${day.slice(0, 4)}`;
};

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
  await expectShown(line(page, "Water the plants"), "Water the plants Today every week +Home");
  await expect(line(page, "Water the plants").getByRole("button", { name: "Recurs: Every week" })).toBeVisible();

  await line(page, "Water the plants").getByRole("checkbox").click();

  const rolled = `- [ ] Water the plants due:${addDays(today, 7)} every:1w +Home done:${today}x1`;
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled);
  // The editor takes the line the server answered with: open again, due next week, done today once.
  await expect(line(page, "Water the plants").getByRole("checkbox")).not.toBeChecked();
  await expectShown(line(page, "Water the plants"), /^Water the plants .+ every week \+Home ✓ Today ×1$/);
  await expect(line(page, "Water the plants").getByRole("button", { name: "Last done Today, 1 time" })).toBeVisible();
  const daily = await dailyNote(page, today);
  expect(daily.note.text).toBe(`# ${today}\n\n- [x] Water the plants due:${today} +Home [[${note.id}]]\n`);
  expect(daily.folder).toBe("Daily");
  // The folder tree has the folder that was just made, without a reload.
  await expect(page.getByRole("tree", { name: "Folders" }).getByRole("treeitem", { name: /Daily/ })).toBeVisible();

  // A todo that doesn't recur is checked as it always was.
  await line(page, "Plain one").getByRole("checkbox").click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[3]).toBe("- [x] Plain one");
  await expect.poll(async () => (await dailyNote(page, today)).note.text).toBe(daily.note.text);
});

test("checking a recurring todo off on the Todos page leaves its row open, as its note reads, and it can't be completed twice while the first is on its way", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  const note = await perform(page, { type: "note.create", text: `# Home\n\n- [ ] Take out the bins due:${today} every:2w\n- [ ] Plain one\n` });
  await page.goto("/todos");
  const bins = row(page, "Take out the bins");
  await expect(bins.locator(".todo-every")).toHaveText("every 2 weeks");
  await expect(bins.locator(".todo-every")).toHaveAttribute("title", "Recurs: Every 2 weeks");
  await expect(bins.locator(".todo-done")).toHaveCount(0);
  // The chips say it and are nothing to press: the card has its checkbox, its words and its one menu.
  await expect(bins.getByRole("button")).toHaveCount(2);
  await more(page, "Take out the bins").click();
  await expect(menu(page).getByRole("menuitem", { name: "Recurrence…", exact: true })).toBeEnabled();
  await expect(menu(page).getByRole("menuitem", { name: "Completions", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await bins.getByRole("checkbox").dblclick();

  const rolled = `- [ ] Take out the bins due:${addDays(today, 14)} every:2w done:${today}x1`;
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled);
  await expect(bins).toHaveCount(1);
  await expect(bins.getByRole("checkbox")).not.toBeChecked();
  await expect(bins.getByRole("checkbox")).toBeEnabled();
  await expect(bins.locator(".todo-done")).toHaveText("✓ Today ×1");
  await expect(bins.locator(".todo-done")).toHaveAttribute("title", "Last done Today, 1 time");
  await expect(bins.locator(".todo-due")).toHaveText(dateSaid(addDays(today, 14), today));
  await expect.poll(async () => (await perform(page, { type: "todo.list", noteId: note.id })).todos.find((t) => t.line === 2)?.text).toBe(rolled);
  await expect.poll(async () => (await dailyNote(page, today)).note.text).toBe(`# ${today}\n\n- [x] Take out the bins due:${today} [[${note.id}]]\n`);

  // The same history as the editor's chip opens, with the daily note a click away.
  await pick(page, "Take out the bins", "Completions");
  await expect(completions(page).getByRole("listitem")).toHaveText(["TodayAda Lovelace"]);
  await page.keyboard.press("Escape");
  await expect(completions(page)).toHaveCount(0);

  // Its recurrence is set and cleared from the card's menu, with the form the editor's chip opens.
  await pick(page, "Take out the bins", "Recurrence…");
  await expect(recurrence(page).getByRole("button", { name: "Every 2 weeks now", exact: true })).toBeDisabled();
  await recurrence(page).getByRole("button", { name: "Monthly" }).click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled.replace("every:2w", "every:1m"));
  await expect(bins.locator(".todo-every")).toHaveText("every month");
  await expect(bins.locator(".todo-every")).toHaveAttribute("title", "Recurs: Every month");
  // A panel open under the card's button gives way to the next one asked for there.
  await pick(page, "Take out the bins", "Completions");
  await expect(completions(page)).toBeVisible();
  await pick(page, "Take out the bins", "Recurrence…");
  await expect(completions(page)).toHaveCount(0);
  await recurrence(page).getByRole("button", { name: "Stop recurring" }).click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled.replace(" every:2w", ""));
  await expect(bins.locator(".todo-every")).toHaveCount(0);
  await expect(row(page, "Plain one").locator(".todo-every")).toHaveCount(0);
  await pick(page, "Plain one", "Recurrence…");
  await expect(recurrence(page).locator(".rule-now")).toHaveText("Doesn't recur yet");
  // A todo that doesn't recur has nothing to skip and nothing to stop.
  await expect(recurrence(page).getByRole("button")).toHaveText(["Daily", "Every weekday", "Weekly", "Every 2 weeks", "Monthly", "Yearly", "More options…"]);
  await recurrence(page).getByRole("button", { name: "Daily" }).click();
  await expect.poll(async () => (await read(page, note.id)).split("\n")[3]).toBe("- [ ] Plain one every:1d");
});

test("typing x into a recurring todo's brackets completes it as its checkbox does", async ({ page }) => {
  const today = await localDay(page);
  const written = "- [ ] Stretch every:1d";
  const note = await open(page, `# Habits\n\n${written}`);

  await page.keyboard.press("ControlOrMeta+End");
  await expect.poll(() => cursorLine(page)).toBe(written);
  for (let i = 0; i < written.length - "- [".length; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Delete");
  await page.keyboard.type("x");

  const rolled = `- [ ] Stretch every:1d due:${addDays(today, 1)} done:${today}x1`;
  await expect.poll(() => read(page, note.id)).toBe(`# Habits\n\n${rolled}`);
  await expect.poll(() => cursorLine(page)).toBe(rolled);
  await page.keyboard.press("ControlOrMeta+Home");
  await expectShown(line(page, "Stretch"), "Stretch every day Tomorrow ✓ Today ×1");
  await expect.poll(async () => (await dailyNote(page, today)).note.text).toBe(`# ${today}\n\n- [x] Stretch [[${note.id}]]\n`);
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
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]!.length).toBe(`- [ ] Stretch every:1d slowly due:${today} done:${today}x1`.length);
  await expect.poll(() => filedOn(page, today)).toHaveLength(1);
  await expect.poll(async () => (await filedOn(page, today))[0]).toContain("Stretch");
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
  await expect.poll(async () => (await filedOn(page, today))[0]).toContain("Stretch");
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
  await expect.poll(() => filedOn(page, today)).toEqual([`- [x] Stretch [[${note.id}]]`]);
});

/** The second stage of the editor of a rule: the sentence it is built as. */
const sentence = (page: Page) => recurrence(page).locator(".rule-says");
const moreOptions = async (page: Page, chip: Locator) => {
  await chip.click();
  await recurrence(page).getByRole("button", { name: "More options…" }).click();
  await expect(recurrence(page).getByLabel("How many", { exact: true })).toBeFocused();
};

test("the recurrence chip opens the editor of a rule: a pick saves at once, and More options builds any rule as a sentence, by pointer and by keyboard", async ({ page }) => {
  // 1 January 2031 is a Wednesday.
  const note = await open(page, "# Plan\n\n- [ ] Pay rent every:1w due:2031-01-01 #home\nAfter");
  const rent = () => line(page, "Pay rent");
  const lineIn = async () => (await read(page, note.id)).split("\n")[2];
  const chip = (name: string) => rent().getByRole("button", { name, exact: true });
  const save = () => recurrence(page).getByRole("button", { name: "Save" }).click();

  await chip("Recurs: Every week").click();
  await expect(recurrence(page).locator(".rule-now")).toHaveText("Every week on Wednesday");
  await expect(recurrence(page).getByRole("button")).toHaveText(["Daily", "Every weekday", "Weeklynow", "Every 2 weeks", "Monthly", "Yearly", /^Skip this onedue Jan 8, 2031$/, "Stop recurring", "More options…"]);
  await expect(recurrence(page).getByRole("button", { name: "Weekly" })).toBeDisabled();
  await recurrence(page).getByRole("button", { name: "Monthly" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:1m due:2031-01-01 #home");
  await expect(recurrence(page)).toHaveCount(0);
  await expectShown(rent(), "Pay rent every month Jan 1, 2031 #home");

  // Escape closes it, changes nothing and gives the keyboard back to the chip. A press outside closes it too.
  await chip("Recurs: Every month").click();
  await expect(recurrence(page).getByRole("button", { name: "Daily" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(recurrence(page)).toHaveCount(0);
  await expect(chip("Recurs: Every month")).toBeFocused();
  await chip("Recurs: Every month").click();
  await line(page, "Plan").click();
  await expect(recurrence(page)).toHaveCount(0);
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:1m due:2031-01-01 #home");

  // By keyboard alone: down the picks to More options, then the sentence, and Enter saves.
  await chip("Recurs: Every month").focus();
  await page.keyboard.press("Enter");
  await expect(recurrence(page).getByRole("button", { name: "Daily" })).toBeFocused();
  for (const name of ["Every weekday", "Weekly", "Every 2 weeks", "Yearly", "Skip this one", "Stop recurring", "More options…"]) {
    await page.keyboard.press("Tab");
    await expect(recurrence(page).getByRole("button", { name })).toBeFocused();
  }
  await page.keyboard.press("Enter");
  await expect(recurrence(page).getByLabel("How many", { exact: true })).toBeFocused();
  await expect(sentence(page)).toHaveText("Every month on the 1stAfter this one: Feb 1, 2031 · Mar 1, 2031 · Apr 1, 2031");
  await page.keyboard.type("3");
  await recurrence(page).getByLabel("Unit").selectOption("days");
  await recurrence(page).getByLabel("Recur from").selectOption("Completion");
  await expect(sentence(page)).toContainText("3 days after it's done");
  await expect(sentence(page)).toContainText("If done today:");
  await recurrence(page).getByLabel("How many", { exact: true }).press("Enter");
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:3d-after-done due:2031-01-01 #home");
  await expectShown(rent(), "Pay rent 3 days after done Jan 1, 2031 #home");

  // Several days of a month, from its start and from its end.
  await moreOptions(page, chip("Recurs: 3 days after it's done"));
  await expect(recurrence(page).getByLabel("How many", { exact: true })).toHaveValue("3");
  await recurrence(page).getByLabel("How many", { exact: true }).fill("1");
  await recurrence(page).getByLabel("Unit").selectOption("month");
  await recurrence(page).getByLabel("Day of the month").selectOption("day…");
  await recurrence(page).getByLabel("Day 1", { exact: true }).selectOption("2nd-last day");
  await recurrence(page).getByRole("button", { name: "+ Another day" }).click();
  await expect(recurrence(page).getByLabel("Day 2", { exact: true })).toHaveValue("1");
  // A rule that names its days counts from the due date, and says why the other way isn't offered.
  await expect(recurrence(page).getByLabel("Recur from")).toBeDisabled();
  await expect(recurrence(page).locator(".rule-hint")).toHaveText("A rule that names its days counts from the due date.");
  await expect(sentence(page)).toContainText("Every month on the 1st and 2nd-last day");
  await save();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:1st-day,2nd-last-day due:2031-01-01 #home");

  // A row is taken out, and weekdays of the month take the place of days.
  await moreOptions(page, chip("Recurs: Every month on the 1st and 2nd-last day"));
  await recurrence(page).getByRole("button", { name: "Take out row 2" }).click();
  await expect(sentence(page)).toContainText("Every month on the 1st");
  await recurrence(page).getByLabel("Day of the month").selectOption("the…");
  await recurrence(page).getByLabel("Which weekday 1").selectOption("2nd");
  await recurrence(page).getByLabel("Day of the week, weekday 1").selectOption("Tuesday");
  await recurrence(page).getByRole("button", { name: "+ Another weekday" }).click();
  await recurrence(page).getByLabel("Which weekday 2").selectOption("last");
  await expect(sentence(page)).toContainText("Every month on the 2nd and last Tuesday");
  await save();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:2nd-tue,last-tue due:2031-01-01 #home");
  await expectShown(rent(), "Pay rent monthly on the 2nd & last Tue Jan 1, 2031 #home");

  // Every second week on chosen days, with an end after so many times.
  await moreOptions(page, chip("Recurs: Every month on the 2nd and last Tuesday"));
  await recurrence(page).getByLabel("How many", { exact: true }).fill("2");
  await recurrence(page).getByLabel("Unit").selectOption("weeks");
  const days = recurrence(page).getByRole("group", { name: "Days of the week" });
  await days.getByRole("button", { name: "Thursday" }).click();
  await days.getByRole("button", { name: "Monday" }).click();
  await expect(days.getByRole("button", { pressed: true })).toHaveText(["Mon", "Thu"]);
  await recurrence(page).getByLabel("Ends", { exact: true }).selectOption("After");
  await recurrence(page).getByLabel("How many times").fill("5");
  await expect(sentence(page)).toHaveText("Every 2 weeks on Monday and Thursday, 5 more timesAfter this one: Jan 2, 2031 · Jan 13, 2031 · Jan 16, 2031");
  await save();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:2w-mon,thu-times-5 due:2031-01-01 #home");
  await expectShown(rent(), "Pay rent every 2 weeks on Mon, Thu · 5 left Jan 1, 2031 #home");

  // A date every year, until a day. A number out of range is no rule, and can't be saved.
  await moreOptions(page, chip("Recurs: Every 2 weeks on Monday and Thursday, 5 more times"));
  await recurrence(page).getByLabel("How many", { exact: true }).fill("0");
  await expect(sentence(page)).toContainText("That isn't a rule yet");
  await expect(recurrence(page).getByRole("button", { name: "Save" })).toBeDisabled();
  await recurrence(page).getByLabel("How many", { exact: true }).fill("1");
  await recurrence(page).getByLabel("Unit").selectOption("year");
  await expect(recurrence(page).getByLabel("Day of the year")).toContainText("January 1 (from the due date)");
  await recurrence(page).getByLabel("Day of the year").selectOption("a date…");
  await recurrence(page).getByLabel("Month").selectOption("March");
  await recurrence(page).getByLabel("Day", { exact: true }).selectOption("15");
  await recurrence(page).getByLabel("Ends", { exact: true }).selectOption("On");
  await recurrence(page).getByLabel("Ends on").fill("2035-06-30");
  await expect(sentence(page)).toContainText("Every year on March 15, until June 30, 2035");
  await save();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:mar-15-until-2035-06-30 due:2031-01-01 #home");
  await moreOptions(page, chip("Recurs: Every year on March 15, until June 30, 2035"));
  await recurrence(page).getByLabel("Day of the year").selectOption("the… weekday of a month");
  await recurrence(page).getByLabel("Which weekday").selectOption("last");
  await recurrence(page).getByLabel("Day of the week, weekday").selectOption("Friday");
  await recurrence(page).getByLabel("Month").selectOption("November");
  await recurrence(page).getByLabel("Ends", { exact: true }).selectOption("Never");
  await save();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:last-fri-nov due:2031-01-01 #home");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- [ ] Pay rent every:last-fri-nov due:2031-01-01 #home\nAfter");
});

test("the editor of a rule says when a month is too short for its day and offers the last day, skips one occurrence, shows the token to be typed over, and stops the todo recurring", async ({ page }) => {
  const note = await open(page, "# Plan\n\n- [ ] Pay rent every:1m due:2031-01-31 done:2030-12-31x2\n- [ ] Pills every:1d-times-1 due:2031-01-31\nAfter");
  const rent = () => line(page, "Pay rent");
  const lineIn = async () => (await read(page, note.id)).split("\n")[2];

  // The 31st: shorter months use their last day, and the due date then stays there.
  await moreOptions(page, rent().getByRole("button", { name: "Recurs: Every month" }));
  await expect(sentence(page)).toHaveText("Every month on the 31stAfter this one: Feb 28, 2031 · Mar 28, 2031 · Apr 28, 2031");
  const note28 = recurrence(page).locator(".rule-note");
  await expect(note28).toContainText("Months without a 31st use their last day, and the due date then stays on that day of the month.");
  await note28.getByRole("button", { name: "Use the last day of the month instead" }).click();
  await expect(note28).toHaveCount(0);
  await expect(sentence(page)).toHaveText("Every month on the last dayAfter this one: Feb 28, 2031 · Mar 31, 2031 · Apr 30, 2031");
  await recurrence(page).getByLabel("Day 1", { exact: true }).selectOption("30th");
  await expect(note28).toContainText("Months without a 30th use their last day.");
  await recurrence(page).getByLabel("Day 1", { exact: true }).selectOption("last day");
  await recurrence(page).getByRole("button", { name: "Save" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:last-day due:2031-01-31 done:2030-12-31x2");

  // Skipping moves the due date on, with nothing checked off, counted or filed.
  await rent().getByRole("button", { name: "Recurs: Every month on the last day" }).click();
  await recurrence(page).getByRole("button", { name: "Skip this one due Feb 28, 2031" }).click();
  await expect(recurrence(page)).toHaveCount(0);
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:last-day due:2031-02-28 done:2030-12-31x2");
  await expect(rent().getByRole("checkbox")).not.toBeChecked();
  expect((await perform(page, { type: "todo.history", id: note.id, revision: (await perform(page, { type: "note.read", id: note.id })).revision, line: 2, text: (await lineIn())! })).completions).toEqual([]);
  // The last time of a rule that ends has no later one to skip to, so skipping isn't offered.
  await line(page, "Pills").getByRole("button", { name: "Recurs: Every day, this is the last time" }).click();
  await expect(recurrence(page).getByRole("button", { name: /Skip/ })).toHaveCount(0);
  await expect(recurrence(page).getByRole("button", { name: "Stop recurring" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Edit as text puts the cursor on the token, which is then shown as written and typed over.
  await moreOptions(page, rent().getByRole("button", { name: "Recurs: Every month on the last day" }));
  await recurrence(page).getByRole("button", { name: "Edit as text" }).click();
  await expect(recurrence(page)).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expect(rent().locator(".md-todo-token")).toHaveText("every:last-day");
  await page.keyboard.type("-times-3");
  await expect.poll(lineIn).toBe("- [ ] Pay rent every:last-day-times-3 due:2031-02-28 done:2030-12-31x2");
  await line(page, "After").click();
  await expectShown(rent(), "Pay rent monthly on the last day · 3 left Feb 28, 2031 ✓ Dec 31, 2030 ×2");

  await rent().getByRole("button", { name: "Recurs: Every month on the last day, 3 more times" }).click();
  await recurrence(page).getByRole("button", { name: "Stop recurring" }).click();
  await expect.poll(lineIn).toBe("- [ ] Pay rent due:2031-02-28 done:2030-12-31x2");
  await expect(rent().getByRole("button", { name: /^Recurs/ })).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the editor of a rule stays inside a narrow window, in ${scheme}, and on the Todos page sets a rule typed as text, skips and stops`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 420, height: 720 });
    await signInAsNewPerson(page, "Ada Lovelace");
    const note = await perform(page, { type: "note.create", text: "# Home\n\n- [ ] Take out the bins due:2031-01-01 every:1st-day,15th-day,last-day-times-9\n" });
    const lineIn = async () => (await read(page, note.id)).split("\n")[2];
    await page.goto("/todos");
    const bins = row(page, "Take out the bins");
    // The row says the rule in words on a plain chip, and has its checkbox, its words and its one menu to press.
    await expect(bins.locator(".todo-every")).toHaveText("monthly on the 1st, 15th & last day · 9 left");
    await expect(bins.getByRole("button")).toHaveCount(2);

    // It is placed again as it widens, so where it is is asked until it has settled.
    const inside = () =>
      expect(async () => {
        const box = (await recurrence(page).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(420);
        expect(box.y + box.height).toBeLessThanOrEqual(720);
        expect(await recurrence(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }).toPass({ timeout: 5000 });
    await pick(page, "Take out the bins", "Recurrence…");
    await expect(recurrence(page).locator(".rule-now")).toHaveText("Every month on the 1st, 15th and last day, 9 more times");
    await inside();
    await page.screenshot({ path: test.info().outputPath(`picks-${scheme}.png`) });
    await recurrence(page).getByRole("button", { name: "More options…" }).click();
    await expect(recurrence(page).getByLabel("Day 3", { exact: true })).toHaveValue("-1");
    await expect(recurrence(page).getByLabel("How many times")).toHaveValue("9");
    await inside();
    await page.screenshot({ path: test.info().outputPath(`sentence-${scheme}.png`) });
    expect(await recurrence(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await page.evaluate(() => getComputedStyle(document.querySelector(".todo-card")!).backgroundColor));

    // Away from the note there is no token to put the cursor on: the rule is typed in one field.
    await recurrence(page).getByRole("button", { name: "Edit as text" }).click();
    const typed = recurrence(page).getByLabel("The rule as written");
    await expect(typed).toBeFocused();
    await expect(typed).toHaveValue("1st-day,15th-day,last-day-times-9");
    await typed.fill("sometimes");
    await expect(sentence(page)).toContainText("That isn't a rule.");
    await expect(recurrence(page).getByRole("button", { name: "Save" })).toBeDisabled();
    await typed.fill("1st-tue,3rd-tue");
    await expect(sentence(page)).toHaveText("Every month on the 1st and 3rd Tuesday");
    await inside();
    await typed.press("Enter");
    await expect.poll(lineIn).toBe("- [ ] Take out the bins due:2031-01-01 every:1st-tue,3rd-tue");
    await expect(bins.locator(".todo-every")).toHaveText("monthly on the 1st & 3rd Tue");
    await expect(recurrence(page)).toHaveCount(0);

    // 7 January 2031 is the first Tuesday after the due date.
    await pick(page, "Take out the bins", "Recurrence…");
    await recurrence(page).getByRole("button", { name: "Skip this one due Jan 7, 2031" }).click();
    await expect.poll(lineIn).toBe("- [ ] Take out the bins due:2031-01-07 every:1st-tue,3rd-tue");
    await expect(bins.locator(".todo-due")).toHaveText("Jan 7, 2031");
    await expect(bins.locator(".todo-done")).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveCount(0);

    // Escape gives the keyboard back to the card's button.
    await pick(page, "Take out the bins", "Recurrence…");
    await page.keyboard.press("Escape");
    await expect(recurrence(page)).toHaveCount(0);
    await expect(more(page, "Take out the bins")).toBeFocused();
    await pick(page, "Take out the bins", "Recurrence…");
    await recurrence(page).getByRole("button", { name: "Stop recurring" }).click();
    await expect.poll(lineIn).toBe("- [ ] Take out the bins due:2031-01-07");
    await expect(bins.locator(".todo-every")).toHaveCount(0);
  });
}

test("typing every: offers rules, and the one picked is written as a rule", async ({ page }) => {
  const note = await open(page, "# Plan\n\n- [ ] Pay rent");

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" every:");
  const offered = page.getByRole("listbox").getByRole("option");
  await expect(offered.first()).toContainText("Daily");
  await page.keyboard.type("2w");
  await expect(offered).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect.poll(() => read(page, note.id)).toBe("# Plan\n\n- [ ] Pay rent every:2w");
});

test("the last-done chip says the day and the count, and lists each completion with who did it and its daily note", async ({ page }) => {
  const today = await localDay(page);
  const note = await open(page, `# Chores\n\n- [ ] Feed the cat every:1d done:2026-01-05x3\n`);
  const cat = () => line(page, "Feed the cat");
  await expectShown(cat(), "Feed the cat every day ✓ Jan 5 ×3");

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
  await expect(row(page, "Feed the cat").locator(".todo-every")).toHaveAttribute("title", "Recurs: Every day");
  await expect(row(page, "Feed the cat").getByRole("checkbox")).toBeDisabled();
  // The card's menu has no way to set how it recurs, and still lists the completions.
  await more(page, "Feed the cat").click();
  await expect(menu(page).getByRole("menuitem", { name: "Recurrence…", exact: true })).toHaveCount(0);
  await menu(page).getByRole("menuitem", { name: "Completions", exact: true }).click();
  await expect(completions(page)).toContainText("Done 3 times");
  await page.keyboard.press("Escape");
  // A viewer has no daily note, and is told so in the server's words.
  await modes(page).getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("region", { name: "Today" }).getByRole("alert")).not.toBeEmpty();
  await expect.poll(() => read(admin, note.id)).toBe(text);
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
  "- [ ] !! First todo due:2026-10-14 every:2w then done:2026-10-10x12 +Home trailing words",
  "  - [ ] Nested todo every:mon,thu then done:2026-01-02 nested tail",
  "- [ ] A long todo that goes on for many words so that it wraps in a narrow column and its tokens fall near the end of a row every:3d-after-done then done:2025-12-31x104 and then some more words after the tokens to wrap again due:2026-11-11 every:2nd-last-fri +Second",
  "1. [ ] Numbered todo every:last-day then done:2026-09-30x2 numbered tail",
  "",
  "Below words.",
].join("\n");
/**
 * The last-done tokens, where they are in LAYOUT. A word stands between each and the recurrence
 * token before it, so the cursor beside one is never on the other: the recurrence chip takes its own
 * width, and what moves when it is shown as written is measured by the test after this one.
 */
const TOKENS = LAYOUT.split("\n").flatMap((text, i, all) => {
  const start = all.slice(0, i).join("\n").length + (i ? 1 : 0);
  if (!/^\s*(?:[-*+]|\d+[.)]) \[ \] /.test(text)) return [];
  return [/(?<=\s)done:\S+/].flatMap((token) => {
    const found = token.exec(text);
    return found ? [{ text: found[0], from: start + found.index, to: start + found.index + found[0].length }] : [];
  });
}).sort((a, b) => a.from - b.from);
const MEASURED = ["Above words", "First todo", "trailing words", "Nested todo", "nested tail", "A long todo", "and then some more", "wrap again", "Numbered todo", "numbered tail", "Below words"];

/** The column is 720px wide in the first and 314px in the second, where the long todo wraps over several rows. */
for (const width of [1600, 1100]) {
  test(`nothing moves when the cursor comes to a last-done chip, which alone is then shown as written, as wide as its token (${width}px window)`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 2000 });
    await open(page, LAYOUT);
    await expect(editor(page).getByRole("button", { name: /^Last done/ })).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const before = await places(page, MEASURED);

    const chipBoxes = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-content .md-chip-sized")].map((el) => [el.className.replace(/md-chip-sized|md-chip /g, "").trim(), el.firstElementChild!.textContent, Math.round(el.getBoundingClientRect().x), Math.round(el.getBoundingClientRect().width)]));
    const drawn = await chipBoxes();
    // A todo's second every: is words, as its second due: is. The first is a chip in words.
    await expect(page.locator(".cm-content .md-chip-every")).toHaveText(["every 2 weeks", "every Mon, Thu", "3 days after done", "monthly on the last day"]);
    expect(drawn.filter((c) => c[0] === "md-chip-done").map((c) => c[1])).toEqual(["done:2026-10-10x12", "done:2026-01-02", "done:2025-12-31x104", "done:2026-09-30x2"]);
    // What a chip says is never wider than the chip, so nothing of it is cut off.
    const cut = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-content .md-chip-every > .md-todo-chip, .cm-content .md-chip-done > .md-todo-chip")].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    expect(cut).toEqual([]);

    // Down to the first todo's first letter, then right one letter at a time to the last todo's end, looking around each token.
    for (let down = 0; down < 4; down++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    const [first, last] = [LAYOUT.indexOf("- [ ] !! First"), LAYOUT.indexOf("\n\nBelow words.")];
    const looks = new Set(TOKENS.flatMap((t) => [t.from - 1, t.from, t.from + 3, t.to, t.to + 1]));
    const stops = new Set<number>();
    for (let at = first; at <= last; at++) {
      if (at > first) await page.keyboard.press("ArrowRight");
      if (!looks.has(at)) continue;
      const on = TOKENS.filter((t) => t.from <= at && at <= t.to);
      const when = `with the cursor at "${LAYOUT.slice(Math.max(0, at - 4), at)}|${LAYOUT.slice(at, at + 4)}"`.replaceAll("\n", "\u23ce");
      expect(on.length, `the cursor is never on two tokens: ${when}`).toBeLessThanOrEqual(1);
      on.forEach((t) => stops.add(t.from));
      // Only the token the cursor is on is shown as written: every other chip stays drawn, where it was and as wide.
      const rest = TOKENS.filter((t) => !on.includes(t)).map((t) => t.text);
      await expect.poll(async () => (await chipBoxes()).filter((c) => c[0] === "md-chip-done").map((c) => c[1]), `the chips drawn ${when}`).toEqual(rest);
      await expect(page.locator(".cm-content .md-chip-every"), `the recurrence chips drawn ${when}`).toHaveCount(4);
      for (const [kind, text, x, wide] of await chipBoxes()) {
        const was = drawn.find((c) => c[0] === kind && c[1] === text && Math.abs((c[2] as number) - (x as number)) <= 1);
        expect(was, `the chip "${text}" at ${x} ${when} is where it was: ${JSON.stringify(drawn.filter((c) => c[1] === text))}`).toBeDefined();
        expect(Math.abs((was![3] as number) - (wide as number)), `the width of the chip "${text}" ${when}`).toBeLessThanOrEqual(1);
      }
      const now = await places(page, MEASURED);
      for (const [measured, was] of Object.entries(before)) {
        for (const side of ["x", "y", "top", "height"] as const) expect(Math.abs(now[measured]![side] - was[side]), `${side} of "${measured}" ${when}: ${was[side]} -> ${now[measured]![side]}`).toBeLessThanOrEqual(1);
      }
      // The token written is where its chip was, as wide as it was.
      const written = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-content .md-todo-token")].map((t) => [t.textContent, Math.round(t.getBoundingClientRect().x), Math.round(t.getBoundingClientRect().width)]));
      expect(written.map(([text]) => text).filter((text) => /^(every|done):/.test(text as string)), `what is kept in one piece ${when}`).toEqual(on.map((t) => t.text));
      for (const [text, x, wide] of written) {
        const chip = drawn.find((c) => c[1] === text && Math.abs((c[2] as number) - (x as number)) <= 1);
        expect(chip, `"${text}" at ${x} ${when} stands where a chip stood: ${JSON.stringify(drawn.filter((c) => c[1] === text))}`).toBeDefined();
        expect(Math.abs((chip![3] as number) - (wide as number)), `the width of "${text}"`).toBeLessThanOrEqual(1);
      }
    }
    // The walk went over every last-done token there is.
    expect(stops.size).toBe(TOKENS.length);
    await expect.poll(() => cursorLine(page)).toContain("numbered tail");
    await page.keyboard.press("ControlOrMeta+Home");
    await expect.poll(() => chipBoxes()).toEqual(drawn);

    // The form opens over the app and takes no room in the note.
    await line(page, "First todo").getByRole("button", { name: "Recurs: Every 2 weeks" }).click();
    await expect(recurrence(page)).toBeVisible();
    await recurrence(page).getByRole("button", { name: "More options…" }).click();
    await expect(recurrence(page).getByRole("button", { name: "Save" })).toBeVisible();
    await expect.poll(() => places(page, MEASURED)).toEqual(before);
    await page.keyboard.press("Escape");
  });
}

const toast = (page: Page) => page.locator(".toast");
/** Everything a completion writes: the todo's note, the daily note's filed lines, and the todo's history. */
const completionOf = async (page: Page, noteId: string, day: string) => {
  const note = await perform(page, { type: "note.read", id: noteId });
  const index = note.text.split("\n").findIndex((l) => /^- \[.\] /.test(l));
  const { completions: listed } = await perform(page, { type: "todo.history", id: noteId, revision: note.revision, line: index, text: note.text.split("\n")[index]! });
  return { text: note.text, filed: await filedOn(page, day), completions: listed.length };
};

test("checking off a recurring todo on the Todos page says so in the toast, and Undo takes back its due date, its count, the line it filed and its completion as one revert", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  const text = `# Home\n\n- [ ] Take out the bins due:${today} every:2w-times-3 done:2026-01-05x4\n- [ ] Plain one\n`;
  const note = await perform(page, { type: "note.create", text });
  await page.goto("/todos");
  const bins = row(page, "Take out the bins");
  const before = await completionOf(page, note.id, today);
  expect(before).toEqual({ text, filed: [], completions: 0 });

  await bins.getByRole("checkbox").click();
  await expect(toast(page)).toHaveText("Completed Take out the binsUndo");
  await expect(toast(page).getByRole("button")).toHaveText(["Undo", ""]);
  // The todo is open, due next, with one fewer time left.
  await expect.poll(() => completionOf(page, note.id, today)).toEqual({ text: text.replace(`due:${today} every:2w-times-3 done:2026-01-05x4`, `due:${addDays(today, 14)} every:2w-times-2 done:${today}x5`), filed: [`- [x] Take out the bins due:${today} [[${note.id}]]`], completions: 1 });
  await expect(bins.locator(".todo-due")).toHaveText(dateSaid(addDays(today, 14), today));
  await expect(bins.locator(".todo-every")).toHaveText("every 2 weeks · 2 left");

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveCount(0);
  await expect.poll(() => completionOf(page, note.id, today)).toEqual(before);
  await expect(bins.locator(".todo-due")).toHaveText("Today");
  await expect(bins.locator(".todo-every")).toHaveText("every 2 weeks · 3 left");
  await expect(bins.locator(".todo-done")).toHaveText("✓ Jan 5 ×4");
  await expect(bins.getByRole("checkbox")).not.toBeChecked();
  // It is in History as a revert of the completion, like any other.
  const history = await perform(page, { type: "note.history", id: note.id });
  expect(history.map((c) => [c.revision, c.reverts?.how ?? null, c.reverts?.revisions ?? null, c.revertedBy])).toEqual([[1, null, null, null], [2, null, null, 3], [3, "revert", [2], null]]);

  // The last time checks it off for good, and Undo takes that back the same way.
  await perform(page, { type: "note.write", id: note.id, baseRevision: 3, text: text.replace("times-3", "times-1") });
  await expect(bins.locator(".todo-every")).toHaveText("every 2 weeks · 1 left");
  await bins.getByRole("checkbox").check();
  await expect(toast(page)).toHaveText("Completed Take out the binsUndo");
  await expect.poll(async () => (await completionOf(page, note.id, today)).filed).toHaveLength(1);
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(`- [x] Take out the bins due:${today} every:2w-times-1 done:2026-01-05x4`);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => completionOf(page, note.id, today)).toEqual({ text: text.replace("times-3", "times-1"), filed: [], completions: 0 });
});

test("checking off a recurring todo in a note says so in the toast, and Undo takes all of it back as one revert, which the open editor takes", async ({ page }) => {
  const today = await localDay(page);
  const text = `# Habits\n\n- [ ] Stretch due:${today} every:1d-times-9\nAfter\n`;
  const note = await open(page, text);
  const before = await completionOf(page, note.id, today);

  // Words typed just before the click are saved apart from it, so Undo takes back the completion and leaves them.
  await line(page, "After").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" words");
  await line(page, "Stretch").getByRole("checkbox").click();
  await expect(toast(page)).toHaveText("Completed StretchUndo");
  const typed = text.replace("After", "After words");
  await expect.poll(() => completionOf(page, note.id, today)).toEqual({ text: typed.replace(`due:${today} every:1d-times-9`, `due:${addDays(today, 1)} every:1d-times-8 done:${today}x1`), filed: [`- [x] Stretch due:${today} [[${note.id}]]`], completions: 1 });
  await expectShown(line(page, "Stretch"), "Stretch Tomorrow every day · 8 left ✓ Today ×1");

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveCount(0);
  await expect.poll(() => completionOf(page, note.id, today)).toEqual({ ...before, text: typed });
  // The editor has the line back as it was, and goes on being typed in.
  await expectShown(line(page, "Stretch"), "Stretch Today every day · 9 left");
  await expect(line(page, "Stretch").getByRole("checkbox")).not.toBeChecked();
  await line(page, "After").click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect.poll(() => read(page, note.id)).toBe(typed.replace("After words", "After words!"));
  const history = await perform(page, { type: "note.history", id: note.id });
  expect(history.filter((c) => c.reverts).map((c) => [c.reverts!.how, c.reverts!.revisions.length])).toEqual([["revert", 1]]);
});

test("Undo of a recurring todo's completion changes nothing when its line was written another way since: the toast says so", async ({ page }) => {
  const today = await localDay(page);
  const text = `# Habits\n\n- [ ] Stretch due:${today} every:1d\nAfter\n`;
  const note = await open(page, text);

  await line(page, "Stretch").getByRole("checkbox").click();
  await expect(toast(page)).toHaveText("Completed StretchUndo");
  const rolled = `- [ ] Stretch due:${addDays(today, 1)} every:1d done:${today}x1`;
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(rolled);
  // The line is reworded before Undo is pressed, here and on the Todos page alike.
  await line(page, "After").click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" slowly");
  await expect.poll(async () => (await read(page, note.id)).split("\n")[2]).toBe(`${rolled} slowly`);
  const after = await completionOf(page, note.id, today);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveText("That todo was changed since it was checked off, so it was left as it is.");
  await expect(toast(page).getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(await completionOf(page, note.id, today)).toEqual(after);
  expect(after.filed).toHaveLength(1);
  expect((await perform(page, { type: "note.history", id: note.id })).filter((c) => c.reverts)).toEqual([]);

  // A line written below the todo doesn't touch it: Undo still takes the completion back, and keeps that line.
  await page.goto("/todos");
  await row(page, "Stretch").getByRole("checkbox").click();
  await expect(toast(page)).toHaveText("Completed Stretch slowlyUndo");
  await expect.poll(async () => (await completionOf(page, note.id, today)).completions).toBe(2);
  const revision = (await perform(page, { type: "note.read", id: note.id })).revision;
  await perform(page, { type: "note.write", id: note.id, baseRevision: revision, text: `${await read(page, note.id)}Below\n` });
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveCount(0);
  await expect.poll(() => completionOf(page, note.id, today)).toEqual({ text: `${after.text}Below\n`, filed: after.filed, completions: 1 });
});

const WORDS = [
  "# Words",
  "",
  "Above words.",
  "",
  "- [ ] !! First todo due:2026-10-14 every:2w-mon,thu-times-5 first tail and far tail",
  "  - [ ] Nested todo every:1m nested tail",
  "- [ ] A long todo that goes on for many words so that it wraps in a narrow column and its token falls in the middle of it every:1st-tue,3rd-tue and then some more words after the token so that the line wraps again",
  "1. [ ] Numbered todo every:mar-1 numbered tail",
  "",
  "Below words.",
].join("\n");
const SAID = ["every 2 weeks on Mon, Thu · 5 left", "every month", "monthly on the 1st & 3rd Tue", "yearly on Mar 1"];
/** Each recurrence token in WORDS, with the words measured before it and after it on its line. */
const RECURRING = [
  { text: "every:2w-mon,thu-times-5", before: ["First todo"], after: ["first tail", "far tail"] },
  { text: "every:1m", before: ["Nested todo"], after: ["nested tail"] },
  { text: "every:1st-tue,3rd-tue", before: ["A long todo", "falls in the middle"], after: ["and then some more", "wraps again"] },
  { text: "every:mar-1", before: ["Numbered todo"], after: ["numbered tail"] },
].map((token) => ({ ...token, from: WORDS.indexOf(token.text), to: WORDS.indexOf(token.text) + token.text.length }));
const ALL_WORDS = ["Above words", ...RECURRING.flatMap((t) => [...t.before, ...t.after]), "Below words"];

/**
 * The column is 720px wide in the first and 314px in the second, where every todo but the nested and the numbered one wraps with the Mac's
 * letters. With wider letters more of them wrap, so which rows a chip and its token are on is measured and never taken from here: each
 * window is walked a second time with the letters spread, which wraps the first todo in the wide column as the letters CI draws with do.
 */
for (const [width, spread] of [[1600, 0], [1100, 0], [1600, 0.8], [1100, 0.8]] as const) {
  test(`a recurrence chip takes its own width: shown as written, the words before it stay, the words after it on its row move by the difference, and nothing else moves unless its row wraps (${width}px window${spread ? ", letters spread" : ""})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 2000 });
    await open(page, WORDS);
    if (spread) await page.addStyleTag({ content: `.cm-content { letter-spacing: ${spread}px }` });
    await expect(page.locator(".cm-content .md-chip-every")).toHaveText(SAID);
    await page.evaluate(() => document.fonts.ready);
    const before = await places(page, ALL_WORDS);
    const boxes = (selector: string) => page.evaluate((s) => [...document.querySelectorAll<HTMLElement>(s)].map((el) => {
      const [at, line] = [el.getBoundingClientRect(), el.closest<HTMLElement>(".cm-line")!];
      return { text: el.textContent, x: at.x, top: at.top, bottom: at.bottom, width: at.width, rowEnd: line.getBoundingClientRect().right - parseFloat(getComputedStyle(line).paddingRight) };
    }), selector);
    const chips = await boxes(".cm-content .md-chip-every");
    // Each chip is one piece on one row, no taller than the row it is on.
    const rowHigh = before["Above words"]!.height;
    for (const chip of chips) expect(chip.bottom - chip.top, `the height of "${chip.text}"`).toBeLessThan(rowHigh);
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    const moved: string[] = [];
    const wraps = new Set<string>();
    const middle = (box: { top: number; bottom: number }) => (box.top + box.bottom) / 2;

    for (let down = 0; down < 4; down++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    const [first, last] = [WORDS.indexOf("- [ ] !! First"), WORDS.indexOf("\n\nBelow words.")];
    const looks = new Set(RECURRING.flatMap((t) => [t.from - 1, t.from, t.from + 3, t.to, t.to + 1]));
    let looked = 0;
    for (let at = first; at <= last; at++) {
      if (at > first) await page.keyboard.press("ArrowRight");
      if (!looks.has(at)) continue;
      looked++;
      const on = RECURRING.findIndex((t) => t.from <= at && at <= t.to);
      const when = `with the cursor at "${WORDS.slice(Math.max(0, at - 4), at)}|${WORDS.slice(at, at + 4)}"`;
      await expect(page.locator(".cm-content .md-chip-every"), `the chips drawn ${when}`).toHaveText(SAID.filter((_, i) => i !== on));
      const now = await places(page, ALL_WORDS);
      if (on < 0) {
        // Off every token, the note is to the pixel as it was before the cursor came.
        for (const [word, was] of Object.entries(before)) for (const side of ["x", "y", "top", "height"] as const) expect(near(now[word]![side], was[side]), `${side} of "${word}" ${when}: ${was[side]} -> ${now[word]![side]}`).toBe(true);
        expect((await boxes(".cm-content .md-chip-every")).map((c) => [Math.round(c.x), Math.round(c.width)]), `where the chips are ${when}`).toEqual(chips.map((c) => [Math.round(c.x), Math.round(c.width)]));
        continue;
      }
      const token = RECURRING[on]!;
      const chip = chips[on]!;
      const [written] = (await boxes(".cm-content .md-todo-token")).filter((t) => t.text === token.text);
      expect(written, `"${token.text}" is shown as written ${when}`).toBeDefined();
      // The token starts where its chip did, on the row it was on, in one piece. The two are not the same width, so the wider one may not fit
      // the room left on that row: then it starts the next row, and the narrower one is a row above it, where the wider one had no room.
      const stayed = Math.abs(middle(written!) - middle(chip)) < rowHigh / 2;
      if (stayed) expect(near(written!.x, chip.x), `the left edge of "${token.text}": ${chip.x} -> ${written!.x}`).toBe(true);
      else {
        const [upper, lower] = middle(written!) < middle(chip) ? [written!, chip] : [chip, written!];
        const said = `"${token.text}" ${when}: its chip ${JSON.stringify(chip)}, as written ${JSON.stringify(written)}`;
        expect(Math.round((middle(lower) - middle(upper)) / rowHigh), `one row apart: ${said}`).toBe(1);
        expect(lower.x, `the lower one starts its row: ${said}`).toBeLessThan(upper.x);
        expect(lower.width, `the lower one had no room on the row above: ${said}`).toBeGreaterThan(upper.rowEnd - upper.x);
      }
      expect(written!.bottom - written!.top, `"${token.text}" is on one row`).toBeLessThan(rowHigh * 1.5);
      const by = written!.width - chip.width;
      const line = before[token.before[0]!]!;
      const grew = now[token.before[0]!]!.height - line.height;
      if (!stayed || line.height > rowHigh * 1.5 || Math.abs(grew) >= 1) wraps.add(token.text);
      for (const [word, was] of Object.entries(before)) {
        const is = now[word]!;
        const said = `"${word}" ${when}: ${JSON.stringify(was)} -> ${JSON.stringify(is)}`;
        if (token.before.includes(word)) {
          // Before the chip on its line: exactly where it was.
          expect(near(is.x, was.x) && near(is.y, was.y) && near(is.top, was.top), said).toBe(true);
        } else if (token.after.includes(word)) {
          const sameRow = stayed && was.y < chip.bottom && was.y + rowHigh > chip.bottom;
          // After it on its row: over by the difference between the token and the chip, and by nothing else. On a later row of a todo that wraps, or after a token that is on another row than its chip was, it may be taken up or down a row.
          if (sameRow && near(is.y, was.y)) expect(near(is.x - was.x, by), `by ${by}: ${said}`).toBe(true);
          else if (!near(is.x, was.x) || !near(is.y, was.y)) moved.push(`${token.text}: "${word}" went from ${Math.round(was.x)},${Math.round(was.y)} to ${Math.round(is.x)},${Math.round(is.y)}`);
        } else {
          // Every other line: where it was, or lower or higher by what the todo's own line grew or shrank when its row wrapped another way.
          const below = was.top > line.top;
          expect(near(is.x, was.x) && near(is.height, was.height) && near(is.top - was.top, below ? grew : 0), `the line grew by ${grew}: ${said}`).toBe(true);
        }
      }
      expect(near(now[token.before[0]!]!.top, line.top), `the top of the line of "${token.text}"`).toBe(true);
      expect(Math.abs(grew) < 1 || near(Math.abs(grew), rowHigh), `the line of "${token.text}" is as high as it was or one row off: ${grew}`).toBe(true);
      if (at === token.from) console.log(`CHIP-MOVES ${width}px ${JSON.stringify({ token: token.text, chip: Math.round(chip.width * 10) / 10, written: Math.round(written!.width * 10) / 10, by: Math.round(by * 10) / 10, lineGrew: Math.round(grew), rewrapped: [...new Set(moved)].filter((m) => m.startsWith(token.text)) })}`);
    }
    expect(looked).toBe(looks.size);
    // With the cursor gone again, the note is as it was.
    await page.keyboard.press("ControlOrMeta+Home");
    await expect.poll(async () => JSON.stringify(await places(page, ALL_WORDS))).toBe(JSON.stringify(before));
    await expect(page.locator(".cm-content .md-chip-every")).toHaveText(SAID);
    expect(moved.filter((m) => ![...wraps].some((token) => m.startsWith(`${token}: `))), "only a todo that wraps has words taken up or down a row").toEqual([]);
    if (width === 1600) expect(wraps.has("every:1m") || wraps.has("every:mar-1"), "the two short todos are one row each in the wide column").toBe(false);
    if (width === 1600 && spread) expect(wraps.has("every:2w-mon,thu-times-5"), "with the letters spread, the first todo wraps in the wide column").toBe(true);
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
  await expect.poll(async () => (await perform(page, { type: "note.list" })).filter((n) => n.title === today)).toHaveLength(1);
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

test("going to Today leaves the editor of a note open beside it as it was: the same one, not one made again", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const today = await localDay(page);
  const note = await perform(page, { type: "note.create", text: "# Alpha\n\nSome words.\n" });
  await perform(page, { type: "note.create", text: "# Beta\n\nOther words.\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Some words.");
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("combobox", { name: "Go to note" }).fill("Beta");
  await expect(page.getByRole("dialog", { name: "Go to note" }).getByRole("option").first()).toContainText("Beta");
  await page.keyboard.press("Enter");
  await expect(editor(page)).toContainText("Other words.");
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox", { name: "Commands" }).fill("Split editor right");
  await page.keyboard.press("Enter");
  const [left, right] = [page.getByRole("region", { name: "Editor group 1" }), page.getByRole("region", { name: "Editor group 2" })];
  await expect(right.getByRole("textbox", { name: "Note text" })).toContainText("Other words.");
  await expect(left.getByRole("textbox", { name: "Note text" })).toContainText("Some words.");
  const alpha = left.locator(".cm-editor");
  await alpha.evaluate((el) => ((el as HTMLElement & { wasThere?: boolean }).wasThere = true));

  await modes(page).getByRole("link", { name: "Today" }).click();

  await expect(right.getByRole("textbox", { name: "Note text" })).toContainText(today);
  await expect(page).toHaveURL(/\/note\//);
  await expect(page.getByRole("tab", { name: "Today", exact: true })).toHaveCount(0);
  await expect(alpha).toContainText("Some words.");
  await expect.poll(() => alpha.evaluate((el) => (el as HTMLElement & { wasThere?: boolean }).wasThere)).toBe(true);
});

test("reverting a completion from History takes its line off the daily note open beside it, and what is typed there next is kept", async ({ page }) => {
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
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.getByRole("combobox", { name: "Commands" }).fill("Split editor right");
  await page.keyboard.press("Enter");
  const [left, right] = [page.getByRole("region", { name: "Editor group 1" }).getByRole("textbox", { name: "Note text" }), page.getByRole("region", { name: "Editor group 2" }).getByRole("textbox", { name: "Note text" })];
  await expect(right).toContainText("Morning.");
  await left.locator(".cm-line").filter({ hasText: "Sweep" }).getByRole("checkbox").click();
  await expect(right).toContainText("Sweep");
  await expect.poll(() => read(page, daily.note.id)).toContain(`Morning.\n- [x] Sweep [[${note.id}]]`);

  // The todo's note is in front on the left, and its History tab reverts the change that completed the todo.
  await left.click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await inspector.getByRole("tab", { name: "History" }).click();
  const changes = inspector.getByRole("listbox", { name: "Changes" }).getByRole("option");
  await expect(changes.first()).toBeVisible();
  await inspector.getByRole("button", { name: "Revert…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Revert/ });
  await dialog.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(right).not.toContainText("Sweep");
  await expect(right).toContainText("Morning.");
  await right.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Evening.");
  await expect.poll(() => read(page, daily.note.id)).toContain("Evening.");
  await expect.poll(() => read(page, daily.note.id)).not.toContain("Sweep");
});
