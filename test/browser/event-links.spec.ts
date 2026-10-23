import { expect, type Page } from "@playwright/test";
import type { CalendarEvent } from "../../src/core/protocol.ts";
import { anotherPerson, join, perform, signInAsNewPerson, test } from "./helpers.ts";

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
  expect(reference).toMatch(/^\[\[event:[a-z0-9]{12}\]\]$/);
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
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toMatch(/\nSo Then \[\[event:[a-z0-9]{12}\]\]$/);
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

/** A note of Ada's that links the nearest Standup, from the sample calendar, and the event and its reference. */
async function withLink(page: Page) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  const event = (await nearestFirst(page, "Standup"))[0]!;
  const { text: reference } = await perform(page, { type: "record.refer", sourceId: event.sourceId, id: event.id });
  const here = await perform(page, { type: "note.create", text: `# Standup notes\n\nWe met at ${reference} today\n` });
  return { event, reference, here };
}

const linkIn = (page: Page) => editor(page).locator(".ref-chip");
const popover = (page: Page) => page.getByRole("dialog", { name: "Event" });
/** The popover's actions, by what each says, once it has read the notes about the event. */
const actions = async (page: Page) => {
  await expect(popover(page).getByText("Finding notes about it…")).toHaveCount(0);
  return popover(page).locator("[data-action]");
};

/** Opens the note and presses its link. */
async function pressLink(page: Page, noteId: string) {
  await page.goto(`/note/${noteId}`);
  await expect(linkIn(page)).toHaveAttribute("data-state", "live");
  await linkIn(page).click();
  await expect(popover(page)).toBeVisible();
}

test("an event link with no other note about its event says what and when it is, and offers to make one, which asks for a folder and references the event", async ({ page }) => {
  const { event, reference, here } = await withLink(page);
  const day = dayIn(event.when.from as number, await zoneOf(page));
  await pressLink(page, here.id);
  const head = popover(page).locator(".event-link-head");
  await expect(head.locator("strong")).toHaveText("Standup");
  await expect(head).toContainText(longDay(day));
  await expect(head).toContainText("Work");
  await expect(await actions(page)).toHaveText(["New note about this event", "Go to calendar"]);
  await expect(popover(page).getByRole("region", { name: "Notes about this event" })).toHaveCount(0);

  await popover(page).getByRole("button", { name: "New note about this event" }).click();
  await expect(popover(page).getByRole("combobox")).toHaveValue((await perform(page, { type: "note.read", id: here.id })).folderId!);
  await popover(page).getByRole("button", { name: "Make the note" }).click();
  await expect(popover(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(new RegExp(here.id));
  const madeId = /([a-z0-9]{12})$/.exec(new URL(page.url()).pathname)![1]!;
  const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(Date.parse(`${day}T00:00:00Z`));
  expect((await perform(page, { type: "note.read", id: madeId })).text).toBe(`# Standup, ${shortDay}\n\n${reference}\n\n`);
  expect((await perform(page, { type: "record.notes", sourceId: event.sourceId, id: event.id })).notes.map((n) => n.id).toSorted()).toEqual([here.id, madeId].toSorted());

  // Back in the first note, its link now opens the new one, and lists nothing.
  await pressLink(page, here.id);
  await expect(await actions(page)).toHaveText([`Open note about itStandup, ${shortDay}`, "Go to calendar"]);
});

test("an event link with one other note about its event opens it, and lists nothing", async ({ page }) => {
  const { reference, here } = await withLink(page);
  const other = await perform(page, { type: "note.create", text: `# Retro\n\n${reference}\n` });
  await pressLink(page, here.id);
  await expect(await actions(page)).toHaveText(["Open note about itRetro", "Go to calendar"]);
  await expect(popover(page).getByRole("region", { name: "Notes about this event" })).toHaveCount(0);
  await popover(page).getByRole("button", { name: "Open note about it" }).click();
  await expect(page).toHaveURL(new RegExp(`${other.id}$`));
  await expect(popover(page)).toHaveCount(0);
  await expect(editor(page)).toContainText("Retro");
});

test("an event link with several notes about its event opens the one changed last that the member can see, and lists them with who sees each, never one they can't", async ({ page }) => {
  const { reference, here } = await withLink(page);
  const first = await perform(page, { type: "note.create", text: `# First take\n\n${reference}\n` });
  const mine = await perform(page, { type: "note.create", text: `# Ada-private-thoughts\n\n${reference}\n` });
  await perform(page, { type: "note.setPrivate", id: mine.id, private: true });
  // Grace copies Ada's reference into a private note of her own, the latest of all, which Ada can't see.
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  const hers = await perform(grace, { type: "note.create", text: `# Grace-secret-plans\n\n${reference}\n` }, workspaceId);
  await perform(grace, { type: "note.setPrivate", id: hers.id, private: true }, workspaceId);

  await pressLink(page, here.id);
  await expect(await actions(page)).toHaveText(["Open note about itAda-private-thoughts", "Ada-private-thoughtsPrivate", "First takeWorkspace", "Go to calendar"]);
  await expect(popover(page).getByRole("region", { name: "Notes about this event" }).getByRole("button")).toHaveText(["Ada-private-thoughtsPrivate", "First takeWorkspace"]);
  await expect(popover(page)).not.toContainText("Grace");
  await expect(popover(page)).not.toContainText("Standup notes");

  await popover(page).getByRole("button", { name: "Open note about it" }).click();
  await expect(page).toHaveURL(new RegExp(`${mine.id}$`));
  await pressLink(page, here.id);
  await popover(page).getByRole("region", { name: "Notes about this event" }).getByRole("button", { name: /^First take/ }).click();
  await expect(page).toHaveURL(new RegExp(`${first.id}$`));
});

test("Go to calendar opens the Calendar at the event's day with the event open", async ({ page }) => {
  const { event, here } = await withLink(page);
  const day = dayIn(event.when.from as number, await zoneOf(page));
  await pressLink(page, here.id);
  await (await actions(page)).filter({ hasText: "Go to calendar" }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole("dialog", { name: "Event: Standup" })).toContainText(longDay(day));
  await expect(page.getByRole("region", { name: "Calendar", exact: true }).locator(`.cal-col[data-day="${day}"]`)).toBeVisible();
});

test("an event link opens from the keyboard on its first action, the arrows and Tab go through the actions, and Escape gives the keyboard back to the link", async ({ page }) => {
  const { reference, here } = await withLink(page);
  await perform(page, { type: "note.create", text: `# Retro\n\n${reference}\n` });
  await page.goto(`/note/${here.id}`);
  await expect(linkIn(page)).toHaveAttribute("data-state", "live");
  await linkIn(page).focus();
  await page.keyboard.press("Enter");
  const open = popover(page).getByRole("button", { name: "Open note about it" });
  const go = popover(page).getByRole("button", { name: "Go to calendar" });
  await expect(open).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(go).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(open).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(go).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(open).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(linkIn(page)).toBeFocused();
  const line = editor(page).locator(".cm-line").filter({ hasText: "We met at" });
  await expect(line, "nothing was typed into the note").toHaveText("We met at Standup today");

  await page.keyboard.press(" ");
  await expect(open).toBeFocused();
  await expect(line).toHaveText("We met at Standup today");
  await page.keyboard.press("Tab");
  await expect(go).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole("dialog", { name: "Event: Standup" })).toBeVisible();
});

test("Cancel in the new note form gives the keyboard back to New note about this event, and Escape then back to the link", async ({ page }) => {
  const { here } = await withLink(page);
  await page.goto(`/note/${here.id}`);
  await expect(linkIn(page)).toHaveAttribute("data-state", "live");
  await linkIn(page).focus();
  await page.keyboard.press("Enter");
  const start = popover(page).getByRole("button", { name: "New note about this event" });
  await expect(start).toBeFocused();
  await page.keyboard.press("Enter");
  await popover(page).getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Enter");
  await expect(start).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(linkIn(page)).toBeFocused();
});

test("a link to an event shows its title, or its own words after a |, opens the event on a click, a ⌘-click or vim's gd, and is Event to anyone else", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "settings.write", text: JSON.stringify({ "vim.enabled": true }), baseRevision: 0 });
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  const [lunch] = await nearestFirst(page, "Lunch with Sam");
  const { ref } = await perform(page, { type: "record.refer", sourceId: lunch!.sourceId, id: lunch!.id });
  const note = await perform(page, { type: "note.create", text: `# Plans\n\nAt [[event:${ref}]] and again at [[event:${ref}|the lunch]]` });
  await page.goto(`/note/${note.id}`);
  const chips = editor(page).locator(".md-chip-event");
  await expect(chips).toHaveText(["Lunch with Sam", "the lunch"]);
  await expect(chips.nth(1)).toHaveAttribute("title", /Personal/);

  const popover = page.getByRole("dialog", { name: "Event" });
  await chips.first().click();
  await expect(popover).toContainText("Lunch with Sam");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await chips.nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(popover).toContainText("Lunch with Sam");
  await page.keyboard.press("Escape");

  // gd from the word before it, where the cursor lands on the drawn link.
  await editor(page).click();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await page.keyboard.press("2");
  await page.keyboard.press("j");
  await page.keyboard.press("w");
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(popover).toContainText("Lunch with Sam");
  await page.keyboard.press("Escape");

  // Another member reads the note and is told nothing of the event: it is Event, or the words the note gives it.
  const grace = await anotherPerson(page, "Grace Hopper");
  await join(grace, page, "editor");
  await grace.goto(`/note/${note.id}`);
  const theirs = editor(grace).locator(".md-chip-event");
  await expect(theirs).toHaveText(["Event", "the lunch"]);
  await expect(theirs.first()).toHaveAttribute("data-state", "private");
  await theirs.first().click();
  await expect(grace.getByRole("dialog", { name: "Event" })).toHaveCount(0);
  await expect(editor(grace)).toContainText(`[[event:${ref}]]`);
});
