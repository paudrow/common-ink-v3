import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CalendarEvent, Me, OpInput } from "../../src/core/protocol.ts";
import { anotherPerson, join, perform, signInAsNewPerson, visitor } from "./helpers.ts";

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const DAY_MS = 86_400_000;

const calendar = (page: Page) => page.getByRole("region", { name: "Calendar", exact: true });
const contacts = (page: Page) => page.getByRole("region", { name: "Contacts", exact: true });
const sources = (page: Page) => page.getByRole("region", { name: "Data sources" });
const source = (page: Page, name: string) => sources(page).getByRole("listitem", { name });
const grid = (page: Page) => calendar(page).getByRole("grid");
const cell = (page: Page, day: string) => grid(page).locator(`[data-day="${day}"]`);
const eventIn = (within: Locator, title: string) => within.getByRole("button", { name: new RegExp(`${title}$`) });
const details = (page: Page) => page.getByRole("dialog", { name: /^Event:/ });
const form = (page: Page) => details(page).getByRole("form", { name: "Change event" });
const contact = (page: Page, name: string) => contacts(page).getByRole("list", { name: "Contacts" }).getByRole("listitem", { name });
const editor = (page: Page) => page.getByRole("textbox", { name: "Note text" });
const chips = (page: Page) => editor(page).locator(".ref-chip");

/** What the server answers `op` with, refusal or not, asked the way another tab would. */
const answer = (page: Page, op: OpInput, workspaceId?: string) =>
  page.evaluate(
    async ({ body, workspaceId }) => {
      const id = workspaceId ?? ((await (await fetch("/api/me")).json()) as Me).workspaces[0]!.id;
      const res = await fetch(`/api/workspaces/${id}/ops`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { error?: string; message?: string } };
    },
    { body: op, workspaceId },
  );

const zoneOf = (page: Page) => page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
const dayIn = (time: number, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
const timeIn = (time: number, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(time).replace(/ /g, " ");
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

/** The dates of the week it is where the browser is, Sunday first, which is the week the Calendar opens on. */
async function weekOn(page: Page) {
  const today = dayIn(Date.now(), await zoneOf(page));
  const sunday = shift(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
  return Array.from({ length: 7 }, (_, i) => shift(sunday, i));
}

/** This week's events as the server lists them for the signed-in person. */
async function listed(page: Page, workspaceId?: string): Promise<CalendarEvent[]> {
  const week = await weekOn(page);
  const { events } = await perform(page, { type: "event.list", from: Date.parse(`${week[0]}T00:00:00Z`) - DAY_MS, to: Date.parse(`${week[6]}T00:00:00Z`) + 2 * DAY_MS, timeZone: "UTC" }, workspaceId);
  return events.filter((event) => week.some((day) => event.id.endsWith(`.${day}`)));
}

const eventNamed = async (page: Page, title: string) => (await listed(page)).find((event) => event.title === title)!;

async function connectSample(page: Page) {
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
}

async function openCalendar(page: Page) {
  await page.goto("/calendar");
  await expect(eventIn(grid(page), "Standup").first()).toBeVisible();
  await expect(grid(page)).not.toHaveAttribute("aria-busy", "true");
}

/** Writes `text` at the end of the open note, then a line after it so the cursor is off what was written. */
async function writeAtEnd(page: Page, text: string) {
  await editor(page).focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await page.keyboard.type("after");
}

async function openNote(page: Page, id: string, says: string) {
  await page.goto(`/note/${id}`);
  await expect(editor(page)).toContainText(says);
}

/** Whether the element is in the gray the app keeps for what is said quietly. */
const isMuted = (chip: Locator) =>
  chip.evaluate((el) => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--muted)";
    const muted = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(el).color === muted;
  });

test("a calendar that isn't connected says so, and connecting it shows the week's events", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/calendar");

  await expect(source(page, "Sample calendar")).toContainText("Not connected. Connect it to see your events here.");
  await expect(grid(page)).toHaveCount(0);
  await expect(calendar(page)).not.toContainText("Standup");
  const offered = (await perform(page, { type: "source.list" })).sources;
  // Whether there is a Google account to connect is the server's to say: on a Preview there is none.
  await expect(sources(page).getByText("This sign-in has no Google account behind it, so there is no Google Calendar to connect.")).toHaveCount(offered.some((s) => s.provider === "Google") ? 0 : 1);

  await source(page, "Sample calendar").getByRole("button", { name: "Connect Sample calendar" }).click();

  await expect(source(page, "Sample calendar")).toContainText("Connected to Sample data");
  const week = await weekOn(page);
  await expect(calendar(page).getByRole("heading", { level: 2 }).first()).toHaveText(/ – /);
  await expect(grid(page).getByRole("gridcell")).toHaveCount(7);
  for (const title of ["Standup", "Planning", "Lunch with Sam", "Offsite", "Call with Tokyo", "Company holiday"]) await expect(eventIn(grid(page), title).first(), title).toBeVisible();
  await expect(eventIn(cell(page, week[3]!).getByRole("list", { name: "All day" }), "Offsite")).toHaveCount(1);
  await expect(eventIn(cell(page, week[1]!), "Planning")).toHaveCount(1);

  await calendar(page).getByRole("button", { name: "Next" }).click();
  await expect(cell(page, shift(week[0]!, 7))).toBeVisible();
  await expect(eventIn(cell(page, shift(week[1]!, 7)), "Planning")).toHaveCount(1);
  await calendar(page).getByRole("button", { name: "Today" }).click();
  await expect(cell(page, week[0]!)).toBeVisible();

  await calendar(page).getByRole("button", { name: "Month", exact: true }).click();
  await expect(grid(page).getByRole("columnheader")).toHaveText(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  await expect(eventIn(cell(page, week[1]!), "Planning")).toHaveCount(1);
  await expect.poll(() => grid(page).getByRole("gridcell").count()).toBeGreaterThanOrEqual(28);

  await calendar(page).getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(calendar(page).getByRole("region").filter({ has: page.getByRole("heading", { level: 3 }) }).first()).toBeVisible();
  await expect(eventIn(calendar(page), "Standup").first()).toBeVisible();

  await page.reload();
  await expect(calendar(page).getByRole("button", { name: "Agenda", exact: true }), "the view is the one that was left").toHaveAttribute("aria-pressed", "true");
});

test("contacts connect the same way, are searched as typed, and disconnecting takes the calendar with them", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await page.goto("/contacts");

  await expect(source(page, "Sample contacts")).toContainText("Not connected. Connect it to see your contacts here.");
  await expect(contacts(page)).not.toContainText("Grace Hopper");
  await source(page, "Sample contacts").getByRole("button", { name: "Connect Sample contacts" }).click();

  const rows = contacts(page).getByRole("list", { name: "Contacts" }).getByRole("listitem");
  await expect(rows).toHaveText([/^Ada Lovelace/, /^Grace Hopper/, /^Lin Wei/, /^Sam Okafor/, /^Zoë Álvarez/]);
  await expect(contacts(page).getByRole("status").first()).toHaveText("5 contacts");
  await expect(contact(page, "Grace Hopper")).toContainText("Navy");
  await expect(contact(page, "Grace Hopper").getByRole("link", { name: "hopper@navy.example" })).toHaveAttribute("href", "mailto:hopper@navy.example");
  await expect(contact(page, "Sam Okafor")).toContainText("+1 555 0142");
  await expect(contacts(page).getByRole("button", { name: /Edit|Save/ }), "contacts are read here and not changed").toHaveCount(0);

  await contacts(page).getByRole("searchbox", { name: "Search contacts" }).fill("zoe");
  await expect(rows).toHaveText([/^Zoë Álvarez/]);
  await contacts(page).getByRole("searchbox", { name: "Search contacts" }).fill("harbor");
  await expect(rows).toHaveText([/^Lin Wei/]);
  await expect(contacts(page).getByRole("status").first()).toHaveText("1 of 5 contacts");

  // One account stands behind both, so the calendar is connected too.
  await openCalendar(page);
  await source(page, "Sample calendar").getByRole("button", { name: "Disconnect Sample data…" }).click();
  const asking = sources(page).getByRole("group", { name: "Disconnect Sample data" });
  await expect(asking).toContainText("Disconnecting Sample data disconnects Sample calendar and Sample contacts together");
  await asking.getByRole("button", { name: "Disconnect Sample data" }).click();

  await expect(source(page, "Sample calendar")).toContainText("Not connected");
  await expect(grid(page)).toHaveCount(0);
  await expect(calendar(page)).not.toContainText("Standup");
  await page.goto("/contacts");
  await expect(source(page, "Sample contacts")).toContainText("Not connected");
  await expect(contacts(page)).not.toContainText("Grace Hopper");
  expect((await perform(page, { type: "source.list" })).sources.filter((s) => s.provider === "Sample data").map((s) => s.state)).toEqual(["not_connected", "not_connected"]);
});

test("a member's events and contacts are shown to them and to no other member of the workspace", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "admin");
  await connectSample(page);
  await openCalendar(page);

  await grace.goto("/calendar");
  await grace.getByRole("button", { name: /workspace/ }).first().waitFor();
  await expect(source(grace, "Sample calendar")).toContainText("Not connected");
  await expect(grid(grace)).toHaveCount(0);
  for (const title of ["Standup", "Offsite", "Call with Tokyo"]) await expect(grace.locator("body")).not.toContainText(title);
  await grace.goto("/contacts");
  await expect(source(grace, "Sample contacts")).toContainText("Not connected");
  await expect(grace.locator("body")).not.toContainText("Okafor");

  // Asked in Ada's workspace, where Grace is an admin, the server still answers for Grace alone.
  expect((await listed(grace, workspaceId)).length).toBe(0);
  expect((await perform(grace, { type: "contact.list" }, workspaceId)).contacts).toEqual([]);
  expect((await perform(grace, { type: "source.list" }, workspaceId)).sources.every((s) => s.state === "not_connected" && s.account === null)).toBe(true);
  const lunch = await eventNamed(page, "Lunch with Sam");
  expect((await answer(grace, { type: "event.update", sourceId: lunch.sourceId, id: lunch.id, etag: lunch.etag, title: "Grace was here" }, workspaceId)).status).toBe(409);
  expect((await eventNamed(page, "Lunch with Sam")).etag).toBe(lunch.etag);
});

for (const timezoneId of ["Pacific/Kiritimati", "America/Los_Angeles"]) {
  test.describe(`in ${timezoneId}`, () => {
    test.use({ timezoneId });

    test("events are on the member's own days at the member's own times, and an all-day event stays on its dates", async ({ page }) => {
      await signInAsNewPerson(page, "Ada Lovelace");
      await connectSample(page);
      await openCalendar(page);
      expect(await zoneOf(page)).toBe(timezoneId);
      await expect(calendar(page)).toContainText(`Times are in your time zone, ${timezoneId.replace(/_/g, " ")}.`);
      const week = await weekOn(page);
      // The sample call is at 23:30 UTC on the Thursday, so the day it is on depends on where it is read.
      const call = Date.parse(`${week[4]}T23:30:00Z`);
      const [callDay, callTime] = [dayIn(call, timezoneId), timeIn(call, timezoneId)];
      expect(callDay, "this zone reads the call on another day than Kiritimati or Los Angeles would").toBe(timezoneId === "Pacific/Kiritimati" ? week[5] : week[4]);
      const standup = timeIn(Date.parse(`${week[1]}T14:00:00Z`), timezoneId);

      for (const view of ["Week", "Month"]) {
        await calendar(page).getByRole("button", { name: view, exact: true }).click();
        await expect(calendar(page).getByRole("button", { name: view, exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(eventIn(cell(page, callDay), "Call with Tokyo"), `${view}: the call's day`).toHaveText(`${callTime}Call with Tokyo`);
        for (const day of week.filter((d) => d !== callDay)) await expect(eventIn(cell(page, day), "Call with Tokyo"), `${view}: ${day}`).toHaveCount(0);

        for (const day of [week[3]!, week[4]!]) await expect(eventIn(cell(page, day).getByRole("list", { name: "All day" }), "Offsite"), `${view}: Offsite on ${day}`).toHaveCount(1);
        for (const day of [week[2]!, week[5]!]) await expect(eventIn(cell(page, day), "Offsite"), `${view}: no Offsite on ${day}`).toHaveCount(0);
        await expect(eventIn(cell(page, week[5]!).getByRole("list", { name: "All day" }), "Company holiday"), `${view}: the holiday is on Friday`).toHaveCount(1);
        await expect(eventIn(cell(page, dayIn(Date.parse(`${week[1]}T14:00:00Z`), timezoneId)), "Standup").first()).toHaveText(`${standup}Standup`);
      }

      await eventIn(cell(page, callDay), "Call with Tokyo").click();
      await expect(details(page)).toContainText(`${callTime} – ${timeIn(call + 3_600_000, timezoneId)}`);
      const [fromDay, fromTime] = [form(page).getByLabel("Starts"), form(page).getByLabel("Start time")];
      await expect(fromDay).toHaveValue(callDay);
      await expect(fromTime).toHaveValue(new Intl.DateTimeFormat("en-GB", { timeZone: timezoneId, hour: "2-digit", minute: "2-digit" }).format(call));

      // An hour later on the member's clock is an hour later everywhere.
      const [hour, minute] = (await fromTime.inputValue()).split(":").map(Number) as [number, number];
      await fromTime.fill(`${String(hour + 1).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
      await form(page).getByRole("button", { name: "Save" }).click();
      await expect(details(page).getByRole("status").last()).toHaveText("Saved to Work.");
      await expect.poll(async () => (await eventNamed(page, "Call with Tokyo")).when).toEqual({ allDay: false, from: call + 3_600_000, to: call + 3_600_000 });
    });
  });
}

test("an event the member may change is changed where it is kept, and a read-only one is refused by the server too", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectSample(page);
  await openCalendar(page);
  const before = await eventNamed(page, "Lunch with Sam");

  await eventIn(grid(page), "Lunch with Sam").click();
  await expect(details(page)).toContainText("Personal");
  await expect(form(page).getByLabel("Location")).toHaveValue("Cafe Lula");
  await form(page).getByLabel("Title").fill("Lunch with Samira");
  await form(page).getByLabel("Description").fill("Bring the plans.");
  await form(page).getByRole("button", { name: "Save" }).click();

  await expect(details(page).getByRole("status").last()).toHaveText("Saved to Personal.");
  await expect(eventIn(grid(page), "Lunch with Samira")).toHaveCount(1);
  await page.reload();
  await expect(eventIn(grid(page), "Lunch with Samira")).toHaveCount(1);
  await expect(eventIn(grid(page), "Lunch with Sam")).toHaveCount(0);
  const after = (await listed(page)).find((event) => event.id === before.id)!;
  expect({ title: after.title, description: after.description, location: after.location, when: after.when }, "only what was changed is changed").toEqual({ title: "Lunch with Samira", description: "Bring the plans.", location: "Cafe Lula", when: before.when });

  await eventIn(grid(page), "Company holiday").click();
  await expect(details(page)).toContainText("You can only read the calendar Holidays.");
  await expect(form(page)).toHaveCount(0);
  await expect(details(page).getByRole("textbox")).toHaveCount(0);
  await expect(details(page).getByRole("button", { name: "Save" })).toHaveCount(0);
  const holiday = await eventNamed(page, "Company holiday");
  const refused = await answer(page, { type: "event.update", sourceId: holiday.sourceId, id: holiday.id, etag: holiday.etag, title: "Work day" });
  expect([refused.status, refused.body.error]).toEqual([403, "forbidden"]);
  expect((await eventNamed(page, "Company holiday")).etag).toBe(holiday.etag);
});

test("a change made from a stale reading is refused, says so, and overwrites nothing", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectSample(page);
  await openCalendar(page);
  await eventIn(grid(page), "Planning").click();
  await expect(form(page).getByLabel("Location")).toHaveValue("Room 4");

  // Changed somewhere else after this form was filled.
  const read = await eventNamed(page, "Planning");
  await perform(page, { type: "event.update", sourceId: read.sourceId, id: read.id, etag: read.etag, title: "Planning, moved" });
  await form(page).getByLabel("Location").fill("Room 9");
  await form(page).getByLabel("Title").fill("My planning");
  await form(page).getByRole("button", { name: "Save" }).click();

  await expect(details(page).getByRole("alert")).toHaveText("It was changed since you opened it. Open it again, then make your change.");
  // The form starts again from the event as it is now, so saving once more can't put the old title back.
  await expect(form(page).getByLabel("Title")).toHaveValue("Planning, moved");
  await expect(form(page).getByLabel("Location")).toHaveValue("Room 4");
  const now = (await listed(page)).find((event) => event.id === read.id)!;
  expect([now.title, now.location]).toEqual(["Planning, moved", "Room 4"]);

  await form(page).getByLabel("Location").fill("Room 9");
  await form(page).getByRole("button", { name: "Save" }).click();
  await expect(details(page).getByRole("status").last()).toHaveText("Saved to Work.");
  const saved = (await listed(page)).find((event) => event.id === read.id)!;
  expect([saved.title, saved.location]).toEqual(["Planning, moved", "Room 9"]);
});

test("a reference to an event shows its owner the event as it is now, and every other member the label alone", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  await connectSample(page);
  const note = await perform(page, { type: "note.create", text: "# Plan\n\nWe meet at " });
  await openCalendar(page);

  await eventIn(grid(page), "Lunch with Sam").click();
  await details(page).getByRole("button", { name: "Copy reference" }).click();
  await expect(details(page).getByRole("status")).toContainText("Paste it into a note.");
  const written = await page.evaluate(() => navigator.clipboard.readText());
  expect(written).toMatch(/^::event\{[a-z0-9]{12} Lunch with Sam\}$/);

  await openNote(page, note.id, "We meet at");
  await writeAtEnd(page, written);
  await expect(chips(page)).toHaveText(["Lunch with Sam"]);
  await expect(chips(page)).toHaveAttribute("data-state", "live");
  await expect(chips(page)).toHaveAttribute("title", /Personal · Cafe Lula$/);
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(`# Plan\n\nWe meet at ${written}\nafter`);

  await openCalendar(page);
  await eventIn(grid(page), "Lunch with Sam").click();
  await form(page).getByLabel("Title").fill("Dinner with Samira");
  await form(page).getByRole("button", { name: "Save" }).click();
  await expect(details(page).getByRole("status").last()).toHaveText("Saved to Personal.");

  await openNote(page, note.id, "We meet at");
  await expect(chips(page)).toHaveText(["Dinner with Samira"]);
  await chips(page).click();
  await expect(page.getByRole("dialog", { name: "Event" })).toContainText("Cafe Lula");
  await page.keyboard.press("Escape");
  const kept = (await perform(page, { type: "note.read", id: note.id })).text;
  expect(kept, "the note holds the reference and its label, and nothing else of the event").toBe(`# Plan\n\nWe meet at ${written}\nafter`);
  expect(kept).not.toContain("Samira");

  await openNote(grace, note.id, "We meet at");
  await expect(chips(grace)).toHaveText(["Lunch with Sam"]);
  await expect(chips(grace)).toHaveAttribute("data-state", "private");
  await expect(chips(grace)).toHaveAttribute("title", "Only the member who referenced this event sees its details");
  expect(await isMuted(chips(grace))).toBe(true);
  expect(await isMuted(chips(page))).toBe(false);
  await expect(grace.locator("body")).not.toContainText("Samira");
  await expect(grace.locator("body")).not.toContainText("Cafe Lula");
  const ref = /\{([a-z0-9]{12}) /.exec(written)![1]!;
  const refused = await answer(grace, { type: "record.read", ref }, workspaceId);
  expect([refused.status, refused.body.error]).toEqual([404, "not_found"]);

  // Disconnected, the owner is left with the label too, and told what brings the rest back.
  await perform(page, { type: "source.disconnect", id: "sample-calendar" });
  await openNote(page, note.id, "We meet at");
  await expect(chips(page)).toHaveText(["Lunch with Sam"]);
  await expect(chips(page)).toHaveAttribute("title", "Reconnect Sample calendar first to see this event as it is now");
});

test("a reference to a contact shows its owner the contact, and every other member the name alone", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsNewPerson(page, "Ada Lovelace");
  const grace = await anotherPerson(page, "Grace Hopper");
  const { workspaceId } = await join(grace, page, "editor");
  await connectSample(page);
  const note = await perform(page, { type: "note.create", text: "# Plumbing\n\nCall " });
  await page.goto("/contacts");

  await contact(page, "Sam Okafor").getByRole("button", { name: "Copy reference" }).click();
  await expect(contact(page, "Sam Okafor").getByRole("status")).toContainText("Paste it into a note.");
  const written = await page.evaluate(() => navigator.clipboard.readText());
  expect(written).toMatch(/^::contact\{[a-z0-9]{12} Sam Okafor\}$/);

  await openNote(page, note.id, "Call");
  await writeAtEnd(page, written);
  await expect(chips(page)).toHaveText(["Sam Okafor"]);
  await expect(chips(page)).toHaveAttribute("data-state", "live");
  await expect(chips(page)).toHaveAttribute("title", "Okafor Plumbing · +1 555 0142");
  await chips(page).click();
  await expect(page.getByRole("dialog", { name: "Contact" })).toContainText("+1 555 0142");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await perform(page, { type: "note.read", id: note.id })).text).toBe(`# Plumbing\n\nCall ${written}\nafter`);

  await openNote(grace, note.id, "Call");
  await expect(chips(grace)).toHaveText(["Sam Okafor"]);
  await expect(chips(grace)).toHaveAttribute("data-state", "private");
  await expect(chips(grace)).toHaveAttribute("title", "Only the member who referenced this contact sees its details");
  expect(await isMuted(chips(grace))).toBe(true);
  await expect(grace.locator("body")).not.toContainText("555 0142");
  await expect(grace.locator("body")).not.toContainText("Okafor Plumbing");
  const ref = /\{([a-z0-9]{12}) /.exec(written)![1]!;
  expect((await answer(grace, { type: "record.read", ref }, workspaceId)).status).toBe(404);
});

interface Place {
  x: number;
  top: number;
  height: number;
}

/** Where each of these words is: the left edge of its first letter, and the top and height of the line it is on. */
test("whoever opens a link to a note sees a reference as its label, in gray, and their page asks nothing about it", async ({ page }) => {
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectSample(page);
  const lunch = await perform(page, { type: "record.refer", ...(({ sourceId, id }) => ({ sourceId, id }))(await eventNamed(page, "Lunch with Sam")) });
  const sam = await perform(page, { type: "record.refer", sourceId: "sample-contacts", id: "sam" });
  const note = await perform(page, { type: "note.create", text: `# Shared plan\n\nWe meet at ${lunch.text} with ${sam.text} there.\n` });
  const link = await perform(page, { type: "grant.link", noteId: note.id, link: "public" });
  if (link?.to.kind !== "link") throw new Error("no link was made");

  const anyone = await visitor(page);
  const asked: string[] = [];
  anyone.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) asked.push(new URL(request.url()).pathname);
  });
  await anyone.goto(`/s/${link.to.token}`);
  await expect(chips(anyone)).toHaveText(["Lunch with Sam", "Sam Okafor"]);
  await expect(editor(anyone)).not.toContainText("::event");
  await expect(editor(anyone)).not.toContainText(lunch.ref);
  for (const chip of await chips(anyone).all()) {
    await expect(chip).toHaveAttribute("data-state", "private");
    expect(await isMuted(chip)).toBe(true);
    await expect(chip).not.toHaveAttribute("role", "button");
  }
  expect(asked.filter((path) => !path.startsWith("/api/shared/"))).toEqual([]);
});

const places = (page: Page, words: readonly string[]) =>
  page.evaluate((all) => {
    const found: Record<string, Place> = {};
    for (const word of all) {
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
      const line = box.getBoundingClientRect();
      found[word] = { x: range.getBoundingClientRect().x, top: line.top, height: line.height };
    }
    return found;
  }, words);

function expectUnmoved(now: Record<string, Place>, before: Record<string, Place>, when: string) {
  for (const [word, was] of Object.entries(before)) {
    for (const side of ["x", "top", "height"] as const) expect(Math.abs(now[word]![side] - was[side]), `${side} of "${word}" ${when}: ${was[side]} -> ${now[word]![side]}`).toBeLessThanOrEqual(0.5);
  }
}

test("a reference's line is as tall drawn as written, and nothing around it moves when its details arrive or the cursor comes and goes", async ({ page }) => {
  // Wide enough that a line still fits on one row with its reference shown as written, which is longer than the chip.
  await page.setViewportSize({ width: 1700, height: 900 });
  await signInAsNewPerson(page, "Ada Lovelace");
  await connectSample(page);
  const lunch = await perform(page, { type: "record.refer", ...(({ sourceId, id }) => ({ sourceId, id }))(await eventNamed(page, "Lunch with Sam")) });
  const sam = await perform(page, { type: "record.refer", sourceId: "sample-contacts", id: "sam" });
  const note = await perform(page, { type: "note.create", text: `# Refs\n\nplain line above\n\nBefore ${lunch.text} trailing\n\nSecond ${sam.text} and ${lunch.text}\n\nnext line\n\nlast line` });

  // The server's answers about the references are held back, so the note is first seen with their labels alone.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  await page.route("**/api/workspaces/*/ops", async (route) => {
    if ((route.request().postDataJSON() as { type?: string } | null)?.type !== "record.read") return route.continue();
    reads += 1;
    await held;
    await route.continue();
  });

  await openNote(page, note.id, "plain line above");
  await page.evaluate(() => document.fonts.ready);
  await expect(chips(page)).toHaveText(["Lunch with Sam", "Sam Okafor", "Lunch with Sam"]);
  await expect(chips(page).first()).toHaveAttribute("data-state", "reading");
  const fixed = ["plain line above", "Before", "Second", "next line", "last line"];
  const reading = await places(page, fixed);
  expect(reading["Before"]!.height, "a line with references in it is as tall as one without").toBe(reading["plain line above"]!.height);

  release();
  await expect(chips(page)).toHaveText(["Lunch with Sam", "Sam Okafor", "Lunch with Sam"]);
  expectUnmoved(await places(page, fixed), reading, "once the details arrived");
  expect(reads, "a reference written twice is read once").toBe(2);
  const drawn = await places(page, [...fixed, "trailing"]);

  // The cursor on the line, and not on a reference: both stay drawn.
  await editor(page).getByText("Before").click({ position: { x: 2, y: 5 } });
  await expect(editor(page)).toBeFocused();
  await expect(chips(page)).toHaveCount(3);
  expectUnmoved(await places(page, [...fixed, "trailing"]), drawn, "with the cursor on the line");

  // The cursor on the first reference: it is shown as written, and the line keeps its place and height.
  await page.keyboard.press("Home");
  for (let i = 0; i < "Before ".length; i++) await page.keyboard.press("ArrowRight");
  await expect(editor(page).locator(".cm-line").filter({ hasText: "Before" })).toContainText(lunch.text);
  await expect(chips(page)).toHaveCount(2);
  expectUnmoved(await places(page, fixed), reading, "with the first reference shown as written");

  await page.keyboard.press("ControlOrMeta+End");
  await expect(chips(page)).toHaveText(["Lunch with Sam", "Sam Okafor", "Lunch with Sam"]);
  expectUnmoved(await places(page, [...fixed, "trailing"]), drawn, "with the cursor gone again");
  expect(reads, "drawing a reference again asks nothing").toBe(2);

  // Narrow enough that the references wrap: they break as words do, and the line is whole rows of the height of any other.
  await page.setViewportSize({ width: 1000, height: 900 });
  const row = reading["plain line above"]!.height;
  await expect.poll(async () => (await places(page, ["plain line above", "Before"]))["Before"]!.height / row).toBeGreaterThan(1.5);
  const narrow = await places(page, ["plain line above", "Before"]);
  const rows = narrow["Before"]!.height / row;
  expect(Math.abs(rows - Math.round(rows)), `a wrapped line of ${narrow["Before"]!.height}px is whole rows of ${row}px`).toBeLessThan(0.02);
});
