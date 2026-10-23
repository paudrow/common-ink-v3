import { expect, type Page } from "@playwright/test";
import { anotherPerson, join, perform, signInAsNewPerson, test, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const options = (page: Page) => page.getByRole("listbox").getByRole("option");
const preview = (page: Page) => page.locator(".cm-completionInfo");
const dates = (page: Page) => editor(page).locator(".md-chip-date");
const text = async (page: Page, id: string) => (await perform(page, { type: "note.read", id })).text;
/** The list's groups as the member sees them: each heading, and how many items are under it. */
const groups = (page: Page) =>
  page.getByRole("listbox").evaluate((box) => {
    const found: [string, number][] = [];
    for (const row of box.querySelectorAll("completion-section, [role=option]")) {
      if (row.localName === "completion-section") found.push([row.textContent ?? "", 0]);
      else if (found.length) found.at(-1)![1]++;
    }
    return found;
  });

/** The day it is in the browser, which is the member's today, and the days from it, as a note writes them. */
async function daysHere(page: Page) {
  const today = await page.evaluate(() => {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  });
  const day = (ahead: number) => new Date(today + ahead * 86_400_000).toISOString().slice(0, 10);
  const nextMonday = 7 - ((new Date(today).getUTCDay() + 6) % 7);
  return { today: day(0), tomorrow: day(1), nextFriday: day(nextMonday + 4) };
}

/** How a chip reads a day, worked out here from the date alone. */
const reads = (day: string, time = "") => {
  const words = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", ...(day.slice(0, 4) !== String(new Date().getFullYear()) && { year: "numeric" }) });
  return time ? `${words}, ${time}` : words;
};

async function inNote(page: Page, body = "") {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: `# Plan\n\n${body}` });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return { note, ...(await daysHere(page)) };
}

test("@ alone offers Today and Tomorrow under Dates, after the people and before the notes, uploads and events, and narrows as I type", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-contacts", back: "/contacts" });
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  await perform(page, { type: "note.create", text: "# Budget\n\nNumbers." });
  await page.evaluate(async () => {
    const id = (await (await fetch("/api/me")).json()).workspaces[0].id;
    const res = await fetch(`/api/workspaces/${id}/uploads`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "minutes.txt" })) }, body: "We met." });
    if (!res.ok) throw new Error(await res.text());
  });
  const note = await perform(page, { type: "note.create", text: "# Plan\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  const { today, tomorrow } = await daysHere(page);

  const read = ["contact.list", "upload.list", "event.list"].map((type) => page.waitForResponse((response) => response.request().postDataJSON()?.type === type));
  await page.keyboard.type("Started @");
  await Promise.all(read);
  await expect.poll(() => groups(page)).toEqual([
    ["People", 3],
    ["Dates", 2],
    ["Notes", 1],
    ["Uploads", 1],
    ["Events", 2],
  ]);
  await expect(options(page).nth(3)).toHaveText(/^Today\w+day, \w+ \d{1,2}, \d{4}$/);
  await expect(options(page).nth(4)).toHaveText(/^Tomorrow\w+day, \w+ \d{1,2}, \d{4}$/);
  await expect(options(page).filter({ hasText: "Pick a date…" })).toHaveCount(0);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");

  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(preview(page).locator("dd").nth(1)).toHaveText("Tomorrow");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted [[${tomorrow}]]`);

  await page.keyboard.type(" and @budg");
  await expect(options(page)).toHaveText(["BudgetUnsorted", "Create note “budg”New note in Unsorted", "Create folder “budg”New folder at the top", "Create tag #budgNew tag"]);
  await page.keyboard.press("Escape");
  await page.keyboard.type(" @tod");
  await expect(options(page)).toHaveText([/^Today/, "Pick a date…Any day, from a calendar", "Create note “tod”New note in Unsorted", "Create folder “tod”New folder at the top", "Create tag #todNew tag"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted [[${tomorrow}]] and @budg [[${today}]]`);
});

test("@tod offers Today, under Dates with the full date and how far it is, and writes today's date, drawn as it reads", async ({ page }) => {
  const { note, today } = await inNote(page);
  await page.keyboard.type("Started @tod");
  await expect(options(page)).toHaveText([/^Today\w+day, \w+ \d{1,2}, \d{4}$/, "Pick a date…Any day, from a calendar", "Create note “tod”New note in Unsorted", "Create folder “tod”New folder at the top", "Create tag #todNew tag"]);
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(preview(page).locator("dt")).toHaveText(["Weekday", "From today"]);
  await expect(preview(page).locator("dd").nth(1)).toHaveText("Today");
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted [[${today}]]`);
  await expect(dates(page)).toHaveText([reads(today)]);

  // The cursor inside it shows it as written, and out of it again draws it.
  await page.keyboard.press("ArrowLeft");
  await expect(dates(page)).toHaveCount(0);
  await expect(editor(page)).toContainText(`Started [[${today}]]`);
  await page.keyboard.press("End");
  await page.keyboard.type(" then.");
  await expect(dates(page)).toHaveText([reads(today)]);
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nStarted [[${today}]] then.`);
});

test("@tomorrow 3pm writes the day and the time, and @next fri the Friday of next week", async ({ page }) => {
  const { note, tomorrow, nextFriday } = await inNote(page);
  await page.keyboard.type("Call @tomorrow 3pm");
  await expect(options(page).first()).toHaveText(/^Tomorrow, 3:00 PM\w+day, \w+ \d{1,2}, \d{4} at 3:00 PM$/);
  await page.keyboard.press("Enter");
  await page.keyboard.type(" and review @next fri");
  await expect(options(page).first()).toHaveText(/^Next Friday/);
  await page.keyboard.press("Enter");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nCall [[${tomorrow} 15:00]] and review [[${nextFriday}]]`);
  await expect(dates(page)).toHaveText([reads(tomorrow, "3:00 PM"), reads(nextFriday)]);
});

test("Pick a date… opens a date field at the cursor and writes the day picked there, or nothing when it is closed", async ({ page }) => {
  const { note, today } = await inNote(page);
  await page.keyboard.type("Due @pick");
  await expect(options(page)).toHaveText(["Pick a date…Any day, from a calendar", "Create note “pick”New note in Unsorted", "Create folder “pick”New folder at the top", "Create tag #pickNew tag"]);
  await page.keyboard.press("Enter");
  const field = page.getByRole("dialog", { name: "Pick a date" }).getByLabel("Date");
  await expect(field).toBeFocused();
  await field.fill("2027-03-04");
  await expect(page.getByRole("dialog", { name: "Pick a date" })).toHaveCount(0);
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nDue [[2027-03-04]]");
  await expect(dates(page)).toHaveText(["Thu, Mar 4, 2027"]);
  await page.keyboard.type(" or @date");
  await expect(options(page)).toHaveText(["Pick a date…Any day, from a calendar", "Create note “date”New note in Unsorted", "Create folder “date”New folder at the top", "Create tag #dateNew tag"]);
  await page.keyboard.press("Enter");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeFocused();
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nDue [[2027-03-04]] or @date");

  // It starts empty, so today is a pick too, and a time typed before it is kept.
  await page.keyboard.type(" or @tomorrow 3pm");
  const pick = options(page).filter({ hasText: "Pick a date…" });
  await expect(pick).toHaveText("Pick a date…Any day at 3:00 PM, from a calendar");
  await pick.click();
  await expect(field).toHaveValue("");
  await field.fill(today);
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nDue [[2027-03-04]] or @date or [[${today} 15:00]]`);
});

test("a link to a day is drawn as the day reads, in a heading too; a bare date, a due date, code and a daily note's own title are words; and ⌘-click opens the day's daily note", async ({ page }) => {
  const { today } = await inNote(page);
  const linkDates = page.waitForRequest((r) => r.url().endsWith("/ops") && r.postDataJSON()?.type === "note.linkDates");
  await page.reload();
  await linkDates;
  await expect(editor(page)).toContainText("Plan");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(`## Week of [[${today}]]`);
  await page.keyboard.press("Enter");
  await page.keyboard.type(`- [ ] Pay rent due:2026-11-01 before [[2026-11-01 09:00]]`);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Not `[[2026-11-02]]` or 2026-11-03, written bare, or [[2026-11-04|the launch]].");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(dates(page)).toHaveText([reads(today), reads("2026-11-01", "9:00 AM"), "the launch"]);
  await expect(editor(page).locator(".md-chip-due")).toHaveCount(1);
  await expect(editor(page)).toContainText("2026-11-03, written bare");

  await dates(page).first().click({ modifiers: ["ControlOrMeta"] });
  await expect.poll(async () => (await perform(page, { type: "daily.find", on: today })).note?.id ?? null).not.toBeNull();
  const daily = (await perform(page, { type: "daily.find", on: today })).note!;
  await expect(page).toHaveURL(new RegExp(`${daily.id}$`));
  // A daily note's title is its date as words, not a link.
  await expect(editor(page).locator(".cm-line").first()).toContainText(`# ${today}`);
  await expect(dates(page)).toHaveCount(0);
});


const picker = (page: Page) => page.getByRole("dialog", { name: "Change date" });
const card = (page: Page) => page.getByRole("tooltip");

test("a click on a date opens the picker a due date opens, under it; a day picked is written in place of the date's, its time kept, and the text stays a date as written", async ({ page }) => {
  const { note, tomorrow } = await inNote(page, "Call [[2027-03-04 15:00]] then");
  await expect(dates(page)).toHaveText([reads("2027-03-04", "3:00 PM")]);
  await dates(page).click();
  await expect(picker(page).getByRole("button")).toHaveText([/^Today/, /^Tomorrow/, /^Next week/, "Remove time", "Open daily note"]);
  await expect(picker(page).getByLabel("Time")).toHaveValue("15:00");
  await expect(picker(page).getByLabel("Date")).toHaveValue("2027-03-04");
  await picker(page).getByRole("button", { name: /^Tomorrow/ }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nCall [[${tomorrow} 15:00]] then`);
  expect(page.url()).toContain(note.id);

  await dates(page).click();
  await picker(page).getByLabel("Date").fill("2027-05-06");
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nCall [[2027-05-06 15:00]] then");
  await expect(dates(page)).toHaveText([reads("2027-05-06", "3:00 PM")]);
  // A pick is the member's edit, undone as typing is.
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nCall [[${tomorrow} 15:00]] then`);
});

test("resting on a date shows its card: the whole date and how far it is, Change date, and Create daily note for a day with none, which makes it and opens it", async ({ page }) => {
  const { note } = await inNote(page, "Due [[2027-03-04]] and [[2027-03-05]]");
  await dates(page).first().hover();
  await expect(card(page)).toContainText("Thursday, March 4, 2027 · in ");
  await expect(card(page).getByRole("button")).toHaveText(["Change date", "Create daily note"]);
  await card(page).getByRole("button", { name: "Change date" }).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByLabel("Date").fill("2027-03-10");
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nDue [[2027-03-10]] and [[2027-03-05]]");

  await dates(page).last().hover();
  await expect(card(page)).toContainText("Friday, March 5, 2027");
  await card(page).getByRole("button", { name: "Create daily note" }).click();
  await expect.poll(async () => (await perform(page, { type: "daily.find", on: "2027-03-05" })).note?.id ?? null).not.toBeNull();
  const daily = (await perform(page, { type: "daily.find", on: "2027-03-05" })).note!;
  await expect(page).toHaveURL(new RegExp(`${daily.id}$`));

  // With the note made, the card opens it.
  const other = await perform(page, { type: "note.create", text: "# Later\n\nOn [[2027-03-05]]" });
  await page.goto(`/note/${other.id}`);
  await dates(page).hover();
  await expect(card(page).getByRole("button")).toHaveText(["Change date", "Open daily note"]);
});

test("Alt+Shift+D with the cursor in a date opens the picker there, from the keyboard, and keyboard help lists it", async ({ page }) => {
  const { note, today } = await inNote(page, "Due [[2027-03-04]]");
  await page.keyboard.press("ArrowLeft");
  await expect(dates(page)).toHaveCount(0);
  await page.keyboard.press("Alt+Shift+KeyD");
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole("button", { name: /^Today/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nDue [[${today}]]`);
  await expect(editor(page)).toBeFocused();

  await editor(page).blur();
  await page.keyboard.press("Shift+Slash");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByRole("row", { name: /Change the date at the cursor/ })).toContainText(/Alt\+Shift\+D|⇧⌥D/);
});

test("a viewer, and a link's page, read a date as it reads and can't change it: a click opens no picker, and its card has no Change date", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const note = await perform(page, { type: "note.create", text: "# Plan\n\nDue [[2027-03-04]]" });
  const vera = await anotherPerson(page, "Vera Viewer");
  const { workspaceId } = await join(vera, page, "viewer");
  await vera.goto(`/note/${note.id}`);
  await expect(dates(vera)).toHaveText([reads("2027-03-04")]);
  await expect(dates(vera)).not.toHaveAttribute("role", "button");
  await dates(vera).hover();
  await expect(card(vera)).toContainText("Thursday, March 4, 2027");
  await expect(card(vera).getByRole("button")).toHaveText(["Create daily note"]);
  // A click is for opening the day: there is nothing to change.
  await dates(vera).click();
  await expect(picker(vera)).toHaveCount(0);
  await expect(vera.getByRole("group", { name: "Notice" })).toContainText("No note for 2027-03-04");
  expect((await perform(vera, { type: "note.read", id: note.id }, workspaceId)).text).toBe("# Plan\n\nDue [[2027-03-04]]");

  // A link's page draws the date as it reads too, with nothing to change and no daily note to open.
  const link = await perform(page, { type: "grant.link", noteId: note.id, link: "public" });
  const reader = await visitor(page);
  await reader.goto(`/s/${link!.to.kind === "link" ? link!.to.token : ""}`);
  await expect(dates(reader)).toHaveText([reads("2027-03-04")]);
  await dates(reader).click();
  await expect(picker(reader)).toHaveCount(0);
  await dates(reader).hover();
  await expect(card(reader)).toContainText("Thursday, March 4, 2027");
  await expect(card(reader).getByRole("button")).toHaveCount(0);
});

test("the picker has a time: Add time is a field, written as the date's time when the picker closes by Enter or a press away and not by Escape, and Remove time takes it off; a day picked keeps it", async ({ page }) => {
  const { note, tomorrow } = await inNote(page, "Call [[2027-03-04]] then");
  await dates(page).click();
  await expect(picker(page).getByRole("button", { name: "Remove time" })).toHaveCount(0);
  await picker(page).getByRole("button", { name: "Add time" }).click();
  await expect(picker(page).getByLabel("Time")).toBeFocused();
  await picker(page).getByLabel("Time").fill("08:15");
  // Escape is a cancel.
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await text(page, note.id)).toBe("# Plan\n\nCall [[2027-03-04]] then");

  await dates(page).click();
  await picker(page).getByRole("button", { name: "Add time" }).click();
  await picker(page).getByLabel("Time").fill("09:30");
  // Nothing is written while the picker is open, so it stays under its date.
  expect(await text(page, note.id)).toBe("# Plan\n\nCall [[2027-03-04]] then");
  await picker(page).getByLabel("Time").press("Enter");
  await expect(picker(page)).toHaveCount(0);
  await expect.poll(() => text(page, note.id)).toBe("# Plan\n\nCall [[2027-03-04 09:30]] then");
  await expect(dates(page)).toHaveText([reads("2027-03-04", "9:30 AM")]);

  await dates(page).click();
  await picker(page).getByRole("button", { name: /^Tomorrow/ }).click();
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nCall [[${tomorrow} 09:30]] then`);

  await dates(page).click();
  await picker(page).getByRole("button", { name: "Remove time" }).click();
  await expect(picker(page).getByRole("button", { name: "Add time" })).toBeVisible();
  await editor(page).locator(".cm-line").first().click();
  await expect.poll(() => text(page, note.id)).toBe(`# Plan\n\nCall [[${tomorrow}]] then`);
});

test("a date's card stays away while its picker is open, however the pointer comes back to the date", async ({ page }) => {
  await inNote(page, "Due [[2027-03-04]]");
  await dates(page).hover();
  await expect(card(page)).toBeVisible();
  await dates(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await page.mouse.move(5, 5);
  await dates(page).hover();
  await page.waitForTimeout(700);
  await expect(card(page)).toHaveCount(0);
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await dates(page).hover();
  await expect(card(page)).toBeVisible();
});

test("in vim, gd on a date opens its daily note, as on a link it opens the link's note", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  const { today } = await daysHere(page);
  const note = await perform(page, { type: "note.create", text: `# Plan\n\nDue [[${today}]] and later` });
  await page.goto(`/note/${note.id}`);
  await expect(page.locator(".cm-vim-panel")).toHaveText("--NORMAL--");
  await editor(page).click();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  for (let i = 0; i < 5; i++) await page.keyboard.press("l");
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect.poll(async () => (await perform(page, { type: "daily.find", on: today })).note?.id ?? null).not.toBeNull();
  const daily = (await perform(page, { type: "daily.find", on: today })).note!;
  await expect(page).toHaveURL(new RegExp(`${daily.id}$`));
});

