import { expect, test, type Page } from "@playwright/test";
import type { CalendarEvent } from "../../src/core/protocol.ts";
import { perform, signInAsNewPerson } from "./helpers.ts";

const ZONE = "America/New_York";
test.use({ timezoneId: ZONE });

let errors: string[];
test.beforeEach(({ page }) => {
  errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const DAY_MS = 86_400_000;
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
const dayIn = (time: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);

/** This week's dates where the browser is, Sunday first: the week the Calendar opens on. */
function thisWeek() {
  const today = dayIn(Date.now());
  const sunday = shift(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
  return Array.from({ length: 7 }, (_, i) => shift(sunday, i));
}

const calendar = (page: Page) => page.getByRole("region", { name: "Calendar", exact: true });
const grid = (page: Page) => calendar(page).getByRole("grid");
const column = (page: Page, day: string) => grid(page).locator(`.cal-col[data-day="${day}"]`);
const card = (page: Page, day: string, title: string) => column(page, day).getByRole("button", { name: new RegExp(` ${title}$`) });
const daysInView = (page: Page) => grid(page).getByRole("gridcell").evaluateAll((cells) => cells.map((c) => (c as HTMLElement).dataset.day));

async function openWithSample(page: Page, wholeWeek = true) {
  await signInAsNewPerson(page, "Ada Lovelace");
  await perform(page, { type: "source.connect", id: "sample-calendar", back: "/calendar" });
  await page.goto("/calendar");
  await expect(grid(page)).toHaveAttribute("aria-busy", "false");
  if (wholeWeek) await expect(card(page, thisWeek()[1]!, "Planning")).toBeVisible();
}

/** The events of the days given, as the server lists them for the signed-in person in the browser's zone. */
async function listed(page: Page, first: string, last: string): Promise<CalendarEvent[]> {
  const from = Date.parse(`${first}T04:00:00Z`) - DAY_MS;
  const { events } = await perform(page, { type: "event.list", from, to: Date.parse(`${last}T04:00:00Z`) + 2 * DAY_MS, timeZone: ZONE });
  return events;
}

/** Where on the page a time of day is in a day's column. The hours are scrolled so the whole working day is in view first. */
async function spot(page: Page, day: string, minutes: number, across = 0.5) {
  const box = (await column(page, day).boundingBox())!;
  return { x: box.x + box.width * across, y: box.y + (minutes / 60) * 48 };
}

async function showHours(page: Page, from: number) {
  await grid(page).locator(".cal-tg-scroll").evaluate((el, top) => (el.scrollTop = top), (from / 60) * 48);
}

/** Starts counting, every frame, what the grid looks like: whether a day in view was drawn before it was read, how far the hours are scrolled, and where the header's days are against the body's. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { seen: { unread: number; tops: number[]; offsets: number[]; misaligned: number; centres: number[] } };
    w.seen = { unread: 0, tops: [], offsets: [], misaligned: 0, centres: [] };
    const clip = document.querySelector(".cal-tg-body .cal-tg-clip")!;
    const scroller = document.querySelector(".cal-tg-scroll")!;
    const [head, , body] = [...document.querySelectorAll<HTMLElement>(".cal-tg-strip")];
    const tick = () => {
      const r = clip.getBoundingClientRect();
      for (const c of document.querySelectorAll<HTMLElement>(".cal-col")) {
        const b = c.getBoundingClientRect();
        if (b.right > r.left + 1 && b.left < r.right - 1 && !c.dataset.listed) w.seen.unread++;
      }
      w.seen.tops.push(scroller.scrollTop);
      const middle = document.elementsFromPoint(r.left + r.width / 2, scroller.getBoundingClientRect().top + 20).find((el) => el.classList.contains("cal-col")) as HTMLElement | undefined;
      if (middle) w.seen.centres.push(Date.parse(middle.dataset.day!) / 86_400_000);
      const [hx, bx] = [head!.getBoundingClientRect().left, body!.getBoundingClientRect().left];
      w.seen.offsets.push(bx - r.left);
      if (Math.abs(hx - bx) > 0.5) w.seen.misaligned++;
      requestAnimationFrame(tick);
    };
    tick();
  });
}
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: { unread: number; tops: number[]; offsets: number[]; misaligned: number; centres: number[] } }).seen);

/** How far the first day in view is from the grid's left edge, in pixels: 0 when the days have settled on a day's edge. */
const firstEdge = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector(".cal-tg-body .cal-tg-clip")!.getBoundingClientRect();
    const first = [...document.querySelectorAll(".cal-col")].map((c) => c.getBoundingClientRect()).find((b) => b.right > r.left + 1)!;
    return first.left - r.left;
  });

test("a sideways scroll slides the days continuously and settles on a day's edge, with the hours, the header and the gutter staying put and every day read before it shows", async ({ page }) => {
  await openWithSample(page);
  const week = thisWeek();
  expect(await daysInView(page)).toEqual(week);
  // The hours open near now, which late in the day is the foot of the grid: from the morning there is room to scroll down whenever this runs.
  await grid(page).locator(".cal-tg-scroll").evaluate((el) => (el.scrollTop = 7 * 48));
  const top = await grid(page).locator(".cal-tg-scroll").evaluate((el) => el.scrollTop);
  const header = await grid(page).locator(".cal-tg-head").boundingBox();
  const gutter = await grid(page).locator(".cal-hours").boundingBox();
  const width = (await column(page, week[0]!).boundingBox())!.width;
  await watch(page);

  // Over empty grid, where the half hour under the pointer is outlined.
  const over = await spot(page, week[3]!, 15 * 60 + 40);
  await page.mouse.move(over.x, over.y);
  await expect(column(page, week[3]!).locator(".cal-ghost")).toHaveCount(1);
  // A sideways trackpad stroke leans a little up and down as fingers do.
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(45, i % 2 ? 9 : -6);
    await page.waitForTimeout(16);
  }
  await expect.poll(() => firstEdge(page), { message: "settled on a day's edge" }).toBeCloseTo(0, 0);
  const moved = await daysInView(page);
  const by = (Date.parse(moved[0]!) - Date.parse(week[0]!)) / DAY_MS;
  expect(by, "it moved by whole days, about as far as the scroll went").toBeGreaterThanOrEqual(4);
  expect(moved).toEqual(week.map((day) => shift(day, by)));
  await expect(calendar(page).getByRole("heading", { level: 2 })).toContainText(String(Number(moved[0]!.slice(8))));

  const frames = await seen(page);
  expect(frames.offsets.some((x) => Math.abs(x / width - Math.round(x / width)) > 0.1), "the days slid through the positions between days").toBe(true);
  expect(new Set(frames.tops), "the hours never moved").toEqual(new Set([top]));
  expect(frames.misaligned, "the header's days moved with the body's").toBe(0);
  expect(frames.unread, "no day came into view before it was read").toBe(0);
  expect(await grid(page).locator(".cal-tg-head").boundingBox()).toEqual(header);
  expect(await grid(page).locator(".cal-hours").boundingBox()).toEqual(gutter);

  // Shift and a plain wheel go sideways too, one notch to the next day.
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 80);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await daysInView(page))[0]).toBe(shift(moved[0]!, 1));

  // An up-and-down scroll, once the sideways one is over, moves the hours and leaves the days alone.
  await page.waitForTimeout(300);
  await page.mouse.wheel(4, 240);
  await expect.poll(() => grid(page).locator(".cal-tg-scroll").evaluate((el) => el.scrollTop)).toBeGreaterThan(top + 100);
  await page.waitForTimeout(400);
  expect((await daysInView(page))[0]).toBe(shift(moved[0]!, 1));
  expect(await firstEdge(page)).toBeCloseTo(0, 0);
});

test("a long slide passes each day once and in order, while the window of days drawn moves under it, and a slide never flies further than it was asked", async ({ page }) => {
  await openWithSample(page);
  const week = thisWeek();
  await watch(page);
  await page.mouse.move(700, 300);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(60, 0);
    await page.waitForTimeout(16);
  }
  await expect.poll(() => firstEdge(page)).toBeCloseTo(0, 0);
  const { centres, unread } = await seen(page);
  const back = centres.findIndex((day, i) => i > 0 && day < centres[i - 1]!);
  expect(back, "the day in the middle never went back, so the days were never drawn in the wrong place").toBe(-1);
  expect(centres.at(-1)! - centres[0]!, "it went past more than one window of days").toBeGreaterThan(14);
  expect(unread).toBe(0);
  // The arrows go on from where the slide left the days, not from where an arrow last aimed.
  await calendar(page).getByRole("button", { name: "Next" }).click();
  await page.mouse.wheel(-200, 0);
  await expect.poll(() => firstEdge(page)).toBeCloseTo(0, 0);
  await page.waitForTimeout(300);
  const landed = (await daysInView(page))[0]!;
  await calendar(page).getByRole("button", { name: "Next" }).click();
  await expect.poll(async () => (await daysInView(page))[0]).toBe(shift(landed, 7));
  expect(Date.parse(landed) > Date.parse(week[0]!)).toBe(true);
});

test("Today, the arrows and the keys glide the days to the same places a scroll settles on, and the keys change the view", async ({ page }) => {
  await openWithSample(page);
  const week = thisWeek();
  await watch(page);

  await calendar(page).getByRole("button", { name: "Next" }).click();
  await expect.poll(() => daysInView(page)).toEqual(week.map((d) => shift(d, 7)));
  const frames = await seen(page);
  expect(new Set(frames.offsets.map(Math.round)).size, "it glided there, through the days between").toBeGreaterThan(4);
  await page.keyboard.press("k");
  await expect.poll(() => daysInView(page)).toEqual(week);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect.poll(() => daysInView(page)).toEqual(week.map((d) => shift(d, 14)));

  // From a week that starts on any day, Today goes back to this week from Sunday.
  await page.mouse.move(700, 450);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 80);
  await page.keyboard.up("Shift");
  await expect.poll(async () => (await daysInView(page))[0]).toBe(shift(week[0]!, 15));
  await page.keyboard.press("t");
  await expect.poll(() => daysInView(page)).toEqual(week);
  expect(await firstEdge(page)).toBeCloseTo(0, 0);
  expect((await seen(page)).unread).toBe(0);

  await page.keyboard.press("d");
  await expect(calendar(page).getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => daysInView(page)).toEqual([dayIn(Date.now())]);
  await page.keyboard.press("j");
  await expect.poll(() => daysInView(page)).toEqual([shift(dayIn(Date.now()), 1)]);
  await page.keyboard.press("m");
  await expect(calendar(page).getByRole("button", { name: "Month", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("a");
  await expect(calendar(page).getByRole("button", { name: "Agenda", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("w");
  await expect(calendar(page).getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(calendar(page).getByRole("button", { name: "Week", exact: true }), "the view is remembered").toHaveAttribute("aria-pressed", "true");
});

test("a drag on empty grid draws a draft on the quarter hour with its times, and its release opens the form, which adds nothing until Save", async ({ page }) => {
  await openWithSample(page);
  const tuesday = thisWeek()[2]!;
  await showHours(page, 7 * 60);

  const hover = await spot(page, tuesday, 9 * 60 + 47);
  await page.mouse.move(hover.x, hover.y);
  await expect(column(page, tuesday).locator(".cal-ghost")).toHaveText("9:30 AM");

  const before = (await listed(page, tuesday, tuesday)).length;
  const from = await spot(page, tuesday, 9 * 60 + 7);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const minutes of [9 * 60 + 20, 9 * 60 + 40, 10 * 60 + 2]) await page.mouse.move(from.x + 3, (await spot(page, tuesday, minutes)).y);
  await expect(column(page, tuesday).locator(".cal-ev.is-draft")).toHaveText("9:00 AM to 10:15 AM");
  await page.mouse.up();

  const form = page.getByRole("dialog", { name: "New event" });
  await expect(form.getByLabel("Title")).toBeFocused();
  await expect(form.getByLabel("Starts")).toHaveValue(tuesday);
  await expect(form.getByLabel("Start time")).toHaveValue("09:00");
  await expect(form.getByLabel("End time")).toHaveValue("10:15");
  await expect(form.getByLabel("Calendar")).toHaveValue("sample-calendar work");
  await expect(form.getByLabel("Calendar").locator("option"), "a calendar that can only be read isn't offered").toHaveText(["Work", "Personal"]);
  expect((await listed(page, tuesday, tuesday)).length, "nothing is added before Save").toBe(before);

  await form.getByLabel("Title").fill("Design sync");
  await form.getByLabel("Calendar").selectOption("sample-calendar personal");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText("Added Design sync")).toBeVisible();
  await expect(card(page, tuesday, "Design sync")).toHaveAccessibleName("9:00 – 10:15 AM Design sync");
  const made = (await listed(page, tuesday, tuesday)).find((e) => e.title === "Design sync")!;
  expect({ calendarId: made.calendarId, from: made.when.from, to: made.when.to }).toEqual({ calendarId: "personal", from: Date.parse(`${tuesday}T13:00:00Z`), to: Date.parse(`${tuesday}T14:15:00Z`) });

  // The next one starts in the calendar used last; Cancel adds nothing. A drag upward works too.
  await showHours(page, 12 * 60);
  const low = await spot(page, tuesday, 16 * 60 + 50);
  await page.mouse.move(low.x, low.y);
  await page.mouse.down();
  await page.mouse.move(low.x, (await spot(page, tuesday, 15 * 60 + 10)).y);
  await expect(column(page, tuesday).locator(".cal-ev.is-draft")).toHaveText("3:00 PM to 5:00 PM");
  await page.mouse.up();
  await expect(form.getByLabel("Calendar")).toHaveValue("sample-calendar personal");
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
  expect((await listed(page, tuesday, tuesday)).length).toBe(before + 1);

  // A click without moving asks for the half hour clicked.
  const click = await spot(page, tuesday, 18 * 60 + 40);
  await page.mouse.click(click.x, click.y);
  await expect(form.getByLabel("Start time")).toHaveValue("18:30");
  await expect(form.getByLabel("End time")).toHaveValue("19:00");
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
});

test("Escape drops a drag, and letting go after it opens nothing", async ({ page }) => {
  await openWithSample(page);
  const tuesday = thisWeek()[2]!;
  await showHours(page, 7 * 60);
  const from = await spot(page, tuesday, 8 * 60);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, (await spot(page, tuesday, 9 * 60)).y);
  await expect(column(page, tuesday).locator(".cal-ev.is-draft")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(column(page, tuesday).locator(".cal-ev.is-draft")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an event dragged to another day and time moves there at once and is saved, Undo puts it back, and its bottom edge changes its end", async ({ page }) => {
  await openWithSample(page);
  const week = thisWeek();
  const [monday, tuesday, wednesday] = [week[1]!, week[2]!, week[3]!];
  await showHours(page, 8 * 60);
  const lunch = card(page, tuesday, "Lunch with Sam");
  await expect(lunch).toHaveAccessibleName("1:00 – 2:00 PM Lunch with Sam");
  const held = (await lunch.boundingBox())!;

  // Held 10 minutes into it, dropped with that point at 3:12 PM on Wednesday: it starts at 3:00.
  await page.mouse.move(held.x + held.width / 2, held.y + 8);
  await page.mouse.down();
  const to = await spot(page, wednesday, 15 * 60 + 12);
  await page.mouse.move(to.x, to.y - 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 2 });
  await expect(column(page, wednesday).locator(".cal-ev.is-dragging")).toContainText("3:00 – 4:00 PM");
  await page.mouse.up();
  await expect(card(page, wednesday, "Lunch with Sam")).toHaveAccessibleName("3:00 – 4:00 PM Lunch with Sam");
  await expect(card(page, tuesday, "Lunch with Sam")).toHaveCount(0);
  await expect(page.getByRole("dialog"), "a drag doesn't open the event").toHaveCount(0);
  const named = async () => (await listed(page, monday, wednesday)).find((e) => e.title === "Lunch with Sam" && e.id.endsWith(tuesday))!.when;
  await expect.poll(named).toEqual({ allDay: false, from: Date.parse(`${wednesday}T19:00:00Z`), to: Date.parse(`${wednesday}T20:00:00Z`) });

  await expect(page.getByText("Moved Lunch with Sam")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(card(page, tuesday, "Lunch with Sam")).toHaveAccessibleName("1:00 – 2:00 PM Lunch with Sam");
  await expect.poll(named).toEqual({ allDay: false, from: Date.parse(`${tuesday}T17:00:00Z`), to: Date.parse(`${tuesday}T18:00:00Z`) });

  const planning = card(page, monday, "Planning");
  const box = (await planning.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, (await spot(page, monday, 12 * 60 + 33)).y, { steps: 4 });
  await page.mouse.up();
  await expect(card(page, monday, "Planning")).toHaveAccessibleName("11:00 AM – 12:30 PM Planning");
  await expect(page.getByText("Resized Planning")).toBeVisible();
  const planned = (await listed(page, monday, monday)).find((e) => e.title === "Planning")!.when;
  expect(planned).toEqual({ allDay: false, from: Date.parse(`${monday}T15:00:00Z`), to: Date.parse(`${monday}T16:30:00Z`) });

  // Let go outside the grid, an event stays on a day in view.
  const lunchAgain = (await card(page, tuesday, "Lunch with Sam").boundingBox())!;
  await page.mouse.move(lunchAgain.x + lunchAgain.width / 2, lunchAgain.y + 8);
  await page.mouse.down();
  await page.mouse.move(60, lunchAgain.y + 8, { steps: 6 });
  await page.mouse.up();
  await expect(card(page, week[0]!, "Lunch with Sam"), "on the first day in view, the nearest to where it was let go").toHaveCount(1);
  await expect(page.getByText("Moved Lunch with Sam"), "the notice is this move's, not the resize's before it").toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(card(page, tuesday, "Lunch with Sam")).toHaveCount(1);

  // A press without a drag still opens the event.
  await card(page, monday, "Planning").click();
  await expect(page.getByRole("dialog", { name: "Event: Planning" })).toBeVisible();
});

test("the Calendars button holds the data sources and a checkbox per calendar, which hides it from the grid and is remembered", async ({ page }) => {
  await openWithSample(page);
  const week = thisWeek();
  await expect(page.getByRole("region", { name: "Data sources" }), "nothing about sources across the page").toHaveCount(0);
  await calendar(page).getByRole("button", { name: "Calendars", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Calendars" });
  await expect(dialog.getByRole("listitem", { name: "Sample calendar" })).toContainText("Connected to Sample data");
  const shown = dialog.getByRole("list", { name: "Calendars in Sample calendar" });
  await expect(shown.getByRole("checkbox")).toHaveCount(3);
  await expect(shown.getByRole("listitem")).toHaveText(["Work", "Personal", "HolidaysRead-only"]);

  await shown.getByRole("checkbox", { name: "Work" }).uncheck();
  await expect(card(page, week[1]!, "Standup")).toHaveCount(0);
  await expect(card(page, week[1]!, "Planning")).toHaveCount(0);
  await expect(card(page, week[2]!, "Lunch with Sam")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.reload();
  await expect(grid(page)).toHaveAttribute("aria-busy", "false");
  await expect(card(page, week[2]!, "Lunch with Sam")).toBeVisible();
  await expect(card(page, week[1]!, "Standup"), "still hidden after a reload").toHaveCount(0);
  await calendar(page).getByRole("button", { name: "Calendars", exact: true }).click();
  await expect(shown.getByRole("checkbox", { name: "Work" })).not.toBeChecked();
  await shown.getByRole("checkbox", { name: "Work" }).check();
  await expect(card(page, week[1]!, "Standup")).toHaveCount(1);
});

test("overlapping events are laid out as v1 laid them out: side by side when they start under half an hour apart, stacked and indented otherwise", async ({ page }) => {
  await openWithSample(page);
  const thursday = thisWeek()[4]!;
  // What layoutDay answers for the sample Thursday, pinned in test/core/plugin-calendar-layout.test.ts: [title, start, lane, lanes, span, indent].
  const expected = [
    ["Standup", 10 * 60, 0, 1, 1, 0],
    ["Design review", 11 * 60, 0, 2, 1, 0],
    ["Dentist", 11 * 60 + 15, 1, 2, 1, 0],
    ["Focus time", 13 * 60, 0, 1, 1, 0],
    ["Coffee with Ada", 13 * 60 + 45, 0, 1, 1, 1],
    ["Call with Tokyo", 19 * 60 + 30, 0, 1, 1, 0],
  ].map(([title, top, lane, lanes, span, indent]) => ({ title: title as string, top: top as number, lane: lane as number, lanes: lanes as number, span: span as number, indent: indent as number }));
  expect((await listed(page, thursday, thursday)).filter((e) => !e.when.allDay && dayIn(e.when.from) === thursday).map((e) => e.title).sort()).toEqual(expected.map((p) => p.title).sort());
  const col = await column(page, thursday).evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left + el.clientLeft, width: el.clientWidth };
  });
  const nest = Math.min(28, col.width * 0.22);
  for (const piece of expected) {
    const box = (await card(page, thursday, piece.title).boundingBox())!;
    expect(box.x - col.left, `${piece.title}: its left`).toBeCloseTo(2 + (piece.lane * col.width) / piece.lanes + piece.indent * nest, 0);
    expect(box.width, `${piece.title}: its width`).toBeCloseTo((piece.span * col.width) / piece.lanes - piece.indent * nest - 3, 0);
    expect(box.y - (await column(page, thursday).boundingBox())!.y, `${piece.title}: its top`).toBeCloseTo((piece.top / 60) * 48, 0);
  }
  const [focus, coffee] = [card(page, thursday, "Focus time"), card(page, thursday, "Coffee with Ada")];
  const z = async (l: typeof focus) => Number(await l.evaluate((el) => getComputedStyle(el).zIndex));
  expect(await z(coffee), "the later one is on top").toBeGreaterThan(await z(focus));
});

test("every event in the week shows when it is, however narrow its card", async ({ page }) => {
  for (const width of [1280, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await openWithSample(page, width > 1000);
    await expect.poll(() => firstEdge(page)).toBeCloseTo(0, 0);
    // A narrow window shows fewer days: slide to this week's Thursday, the day with the most side by side, whatever today is.
    const thursday = thisWeek()[4]!;
    const first = (await daysInView(page))[0]!;
    const by = (Date.parse(thursday) - Date.parse(first)) / DAY_MS;
    if (by) {
      const width = (await column(page, first).boundingBox())!.width;
      await page.mouse.move(400, 500);
      await page.mouse.wheel(by * width, 0);
      await expect.poll(async () => (await daysInView(page))[0]).toBe(thursday);
      await expect.poll(() => firstEdge(page)).toBeCloseTo(0, 0);
    }
    const times = await grid(page)
      .locator(".cal-col:not([aria-hidden]) .cal-ev")
      .evaluateAll((cards) =>
        cards.map((el) => {
          const time = [...el.querySelectorAll<HTMLElement>(".cal-ev-time > span")].find((s) => getComputedStyle(s).display !== "none");
          const [c, t] = [el.getBoundingClientRect(), time?.getBoundingClientRect()];
          return { name: el.getAttribute("aria-label"), text: time?.textContent ?? "", inside: !!t && t.width > 0 && t.top >= c.top - 1 && t.bottom <= c.bottom + 1, whole: !!time && time.scrollWidth <= time.clientWidth + 1 && (time.parentElement!.scrollWidth <= time.parentElement!.clientWidth + 1) };
        }),
      );
    expect(times.length, `${width}: cards in view`).toBeGreaterThan(width > 1000 ? 8 : 1);
    for (const t of times) expect({ ...t, text: t.text.length > 0 }, `${width}: ${t.name}`).toEqual({ name: t.name, text: true, inside: true, whole: true });
  }
});
