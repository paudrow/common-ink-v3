import { expect, test, type Page } from "@playwright/test";
import type { CalendarEvent } from "../../src/core/protocol.ts";
import { anotherPerson, perform, signInAsNewPerson } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const DAY_MS = 86_400_000;
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const offered = (page: Page) => page.getByRole("listbox").getByRole("option");
const zoneOf = (page: Page) => page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
const dayIn = (time: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
/** "Thu, Oct 15, 2026", as an event's day is listed. */
const longDay = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(Date.parse(`${day}T00:00:00Z`));
/** "oct 20", as a member types a day. */
const typedDay = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(Date.parse(`${day}T00:00:00Z`)).toLowerCase();
const timeIn = (time: number, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(time).replace(/ /g, " ");

/** The sample calendar's events from a month back to three months ahead, as the server lists them to the member, the nearest to now first. */
async function nearestFirst(page: Page, title: string): Promise<CalendarEvent[]> {
  const now = Date.now();
  const { events } = await perform(page, { type: "event.list", from: now - 30 * DAY_MS, to: now + 90 * DAY_MS, timeZone: await zoneOf(page) });
  const start = (e: CalendarEvent) => (e.when.allDay ? Date.parse(`${e.when.from}T12:00:00Z`) : e.when.from);
  return events.filter((e) => e.title === title).sort((a, b) => Math.abs(start(a) - now) - Math.abs(start(b) - now) || start(a) - start(b));
}

async function withSampleNote(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  const note = await perform(page, { type: "note.create", text: "# Standup notes\n\n" });
  await page.goto(`/note/${note.id}`);
  await expect(editor(page)).toContainText("Standup notes");
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  return note;
}

test("[[ finds a repeating event's occurrences after the notes, nearest first, each with its day, time and calendar, and writes the reference the event lists the note by", async ({ page }) => {
  const note = await withSampleNote(page);
  const zone = await zoneOf(page);
  const standups = await nearestFirst(page, "Standup");
  expect(standups.length).toBeGreaterThan(40);

  // `[[` alone starts reading the events.
  const reading = page.waitForResponse((r) => r.url().endsWith("/ops") && (r.request().postData() ?? "").includes('"event.list"'));
  await page.keyboard.type("Before [[");
  await reading;
  await page.keyboard.type("standup");
  // The note titled Standup notes first, then each Standup on its own, the nearest first, at most eight.
  await expect(offered(page).first()).toContainText("Standup notes");
  const events = offered(page).filter({ hasText: " · Work" });
  await expect(events).toHaveCount(8);
  await expect(events).toHaveText(standups.slice(0, 8).map((e) => `Standup${longDay(dayIn(e.when.from as number, zone))} · ${timeIn(e.when.from as number, zone)} · Work`));

  // Typing a day narrows to that day's.
  const later = standups.find((e) => (e.when.from as number) > Date.now() + 5 * DAY_MS)!;
  const day = dayIn(later.when.from as number, zone);
  await page.keyboard.type(` ${typedDay(day)}`);
  await expect(offered(page)).toHaveCount(1);
  await expect(offered(page)).toHaveText(`Standup${longDay(day)} · ${timeIn(later.when.from as number, zone)} · Work`);
  await page.keyboard.press("Enter");
  const { text: reference } = await perform(page, { type: "record.refer", sourceId: later.sourceId, id: later.id });
  expect(reference).toMatch(/^::event\{[a-z0-9]{12} Standup\}$/);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(`# Standup notes\n\nBefore ${reference}`);
  // The cursor is after it, so typing goes on, and off its edge it is drawn as the event.
  await page.keyboard.type(" after");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(`# Standup notes\n\nBefore ${reference} after`);
  await expect(editor(page).locator(".ref-chip")).toHaveText("Standup");

  // Typing before it while its reference is made moves it, and the reference still takes its place.
  await page.route("**/ops", async (route) => {
    if ((route.request().postData() ?? "").includes('"record.refer"')) await new Promise((done) => setTimeout(done, 800));
    await route.fallback();
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Then [[planning");
  await expect(offered(page).first()).toHaveText(/^Planning/);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.type("So ");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toMatch(/\nSo Then ::event\{[a-z0-9]{12} Planning\}$/);
  await page.unroute("**/ops");

  // The occurrence lists the note; another occurrence of the same event doesn't.
  expect((await perform(page, { type: "record.notes", sourceId: later.sourceId, id: later.id })).notes.map((n) => n.id)).toEqual([note.id]);
  expect((await perform(page, { type: "record.notes", sourceId: standups[0]!.sourceId, id: standups[0]!.id })).notes).toEqual([]);
});

test("[[ offers a member only their own calendars' events: one with none connected is offered notes alone", async ({ page }) => {
  await withSampleNote(page);
  await page.keyboard.type("[[planning");
  await expect(offered(page).first()).toHaveText(/^Planning/);
  const grace = await anotherPerson(page, "Grace Hopper");
  await perform(grace, { type: "note.create", text: "# Planning ahead\n\n" });
  const note = await perform(grace, { type: "note.create", text: "# Grace's\n\n" });
  await grace.goto(`/note/${note.id}`);
  await expect(editor(grace)).toContainText("Grace's");
  await editor(grace).focus();
  await grace.keyboard.press("ControlOrMeta+End");
  // The list waits for every completion's answer, the events' too, so this is all of it.
  await grace.keyboard.type("[[planning");
  await expect(offered(grace)).toHaveText(["Planning aheadUnsorted"]);
});

test("quick open finds events by title and day after the notes, and opens one on the Calendar at its day", async ({ page }) => {
  await withSampleNote(page);
  const zone = await zoneOf(page);
  const planning = (await nearestFirst(page, "Planning")).find((e) => (e.when.from as number) > Date.now() + 8 * DAY_MS)!;
  const day = dayIn(planning.when.from as number, zone);

  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Go to note" });
  await palette.getByRole("combobox").fill(`planning ${typedDay(day)}`);
  await expect(palette.getByRole("option")).toHaveText([`Planning${`Event · ${longDay(day)} · ${timeIn(planning.when.from as number, zone)} · Work`}`]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/calendar$/);
  const opened = page.getByRole("dialog", { name: "Event: Planning" });
  await expect(opened).toContainText(longDay(day));
  await expect(page.getByRole("region", { name: "Calendar", exact: true }).locator(`.cal-col[data-day="${day}"]`)).toBeVisible();

  // Words that start a note's title list the note first, the events after it.
  await opened.getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("ControlOrMeta+p");
  await palette.getByRole("combobox").fill("standup");
  await expect(palette.getByRole("option").first()).toHaveText(/^Standup notes/);
  await expect(palette.getByRole("option").nth(1)).toHaveText(/^StandupEvent · /);
});
