import type { CalendarEvent, EventWhen } from "../../plugin-api.ts";

/** A calendar date, written YYYY-MM-DD. Days are counted as dates and never as 24 hours: a day a clock changes on is 23 or 25 hours long. */
export type Day = string;

export const VIEWS = { month: "Month", week: "Week", day: "Day", agenda: "Agenda" } as const;
export type View = keyof typeof VIEWS;

/** How many days the agenda lists from the day it starts on. */
export const AGENDA_DAYS = 14;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const fields = (day: Day) => day.split("-").map(Number) as [number, number, number];
/** A date as the instant it starts in UTC, which is only ever used to count dates with. */
const counted = (day: Day) => Date.UTC(...(([y, m, d]) => [y, m - 1, d] as const)(fields(day)));
const written = (time: number): Day => new Date(time).toISOString().slice(0, 10);

export const isDay = (text: string): text is Day => /^\d{4}-\d{2}-\d{2}$/.test(text) && written(counted(text)) === text;

export function shiftDay(day: Day, by: number): Day {
  const [y, m, d] = fields(day);
  return written(Date.UTC(y, m - 1, d + by));
}

/** The first day of the month `by` months from the one `day` is in. */
export function shiftMonth(day: Day, by: number): Day {
  const [y, m] = fields(day);
  return written(Date.UTC(y, m - 1 + by, 1));
}

/** Sunday is 0. */
export const weekdayOf = (day: Day) => new Date(counted(day)).getUTCDay();

export const daysBetween = (from: Day, to: Day) => Math.round((counted(to) - counted(from)) / DAY_MS);
const daysFrom = (day: Day, count: number): Day[] => Array.from({ length: Math.max(0, count) }, (_, i) => shiftDay(day, i));
const startOfWeek = (day: Day) => shiftDay(day, -weekdayOf(day));

/** The days a view shows around `anchor`: its week from Sunday, the day itself, the whole weeks its month touches, or the days from it on. */
export function daysOf(view: View, anchor: Day): Day[] {
  if (view === "week") return daysFrom(startOfWeek(anchor), 7);
  if (view === "day") return [anchor];
  if (view === "agenda") return daysFrom(anchor, AGENDA_DAYS);
  const first = startOfWeek(shiftMonth(anchor, 0));
  const last = shiftDay(shiftMonth(anchor, 1), -1);
  return daysFrom(first, Math.ceil((daysBetween(first, last) + 1) / 7) * 7);
}

/** The anchor of the view before or after. */
export function step(view: View, anchor: Day, by: 1 | -1): Day {
  if (view === "month") return shiftMonth(anchor, by);
  return shiftDay(anchor, { week: 7, day: 1, agenda: AGENDA_DAYS }[view] * by);
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The date and the minutes into it that a clock in `timeZone` shows at `time`. */
function clockAt(time: number, timeZone: string): { day: Day; minutes: number } {
  let clock = clocks.get(timeZone);
  if (!clock) clocks.set(timeZone, (clock = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })));
  const read: Record<string, string> = {};
  for (const { type, value } of clock.formatToParts(time)) read[type] = value;
  return { day: `${read.year!.padStart(4, "0")}-${read.month}-${read.day}`, minutes: Number(read.hour) * 60 + Number(read.minute) };
}

/** How many minutes into its day a clock in `timeZone` shows at `time`. */
export const minutesIn = (time: number, timeZone: string) => clockAt(time, timeZone).minutes;

/** The day it is in `timeZone` at `time`. */
export const dayIn = (time: number, timeZone: string): Day => clockAt(time, timeZone).day;

/** The time of day in `timeZone` at `time`, written HH:MM as a time field holds it. */
export function timeIn(time: number, timeZone: string): string {
  const { minutes } = clockAt(time, timeZone);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** How far ahead of UTC a clock in `timeZone` is at `time`. */
function aheadAt(time: number, timeZone: string): number {
  const { day, minutes } = clockAt(time, timeZone);
  return counted(day) + minutes * MINUTE_MS - Math.floor(time / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant a clock in `timeZone` shows `minutes` into `day`. A time the clock shows twice, as it
 * does when it goes back, is the first of the two. A time it skips when it goes forward reads as the
 * time that far after the change, so the midnight that isn't there is the first instant of its day.
 */
export function instantAt(day: Day, minutes: number, timeZone: string): number {
  const asUtc = counted(day) + minutes * MINUTE_MS;
  const first = asUtc - aheadAt(asUtc, timeZone);
  const second = asUtc - aheadAt(first, timeZone);
  if (second === first || aheadAt(second, timeZone) === asUtc - second) return second;
  return Math.max(first, second);
}

/** The first instant of `day` in `timeZone`. */
export const startOfDay = (day: Day, timeZone: string) => instantAt(day, 0, timeZone);

/** What `event.list` is asked for so that it answers every event on `days`, which follow one another, as `timeZone` has them. */
export function spanOf(days: readonly Day[], timeZone: string): { from: number; to: number; timeZone: string } {
  return { from: startOfDay(days[0]!, timeZone), to: startOfDay(shiftDay(days.at(-1)!, 1), timeZone), timeZone };
}

/**
 * The days an event is on where the member is. An all-day event is on its own dates wherever it is
 * read. Any other is on the day it starts, and on each day after that it reaches when it lasts a
 * day or more: a call from 11:30 pm to 12:30 am is on one day, not two.
 */
export function daysOfEvent(when: EventWhen, timeZone: string): Day[] {
  if (when.allDay) return daysFrom(when.from, daysBetween(when.from, when.to) + 1);
  const first = dayIn(when.from, timeZone);
  if (when.to - when.from < DAY_MS) return [first];
  return daysFrom(first, daysBetween(first, dayIn(when.to - 1, timeZone)) + 1);
}

export interface Cell {
  day: Day;
  allDay: CalendarEvent[];
  timed: CalendarEvent[];
}

/** Each of `days` with the events on it, in the order they were listed. */
export function cellsOf(days: readonly Day[], events: readonly CalendarEvent[], timeZone: string): Cell[] {
  const cells = new Map<Day, Cell>(days.map((day) => [day, { day, allDay: [], timed: [] }]));
  for (const event of events) {
    for (const day of daysOfEvent(event.when, timeZone)) cells.get(day)?.[event.when.allDay ? "allDay" : "timed"].push(event);
  }
  return [...cells.values()];
}

// Chrome and Node put a narrow no-break space before AM and PM, which nobody can type or search for.
const plain = (text: string) => text.replace(/[  ]/g, " ");

/** A time of day as the member reads it, such as "11:30 AM". */
export const timeLabel = (time: number, timeZone: string, locale?: string) => plain(new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(time));

type DayStyle = "short" | "long" | "heading" | "full";
const DAY_STYLES: Record<DayStyle, Intl.DateTimeFormatOptions> = {
  full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
  short: { month: "short", day: "numeric" },
  long: { weekday: "short", month: "short", day: "numeric", year: "numeric" },
  heading: { weekday: "long", month: "long", day: "numeric" },
};

/** A date as the member reads it: "Oct 14", "Wed, Oct 14, 2026", or "Wednesday, October 14". */
export const dayLabel = (day: Day, style: DayStyle = "long", locale?: string) => plain(new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...DAY_STYLES[style] }).format(counted(day)));

export const weekdayLabel = (day: Day, locale?: string) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(counted(day));

/** When an event is, in full, in the member's zone. */
export function whenLabel(when: EventWhen, timeZone: string, locale?: string): string {
  if (when.allDay) return when.from === when.to ? `${dayLabel(when.from, "long", locale)}, all day` : `${dayLabel(when.from, "long", locale)} – ${dayLabel(when.to, "long", locale)}, all day`;
  const [first, last] = [dayIn(when.from, timeZone), dayIn(when.to, timeZone)];
  const start = `${dayLabel(first, "long", locale)}, ${timeLabel(when.from, timeZone, locale)}`;
  if (when.to === when.from) return start;
  return `${start} – ${first === last ? "" : `${dayLabel(last, "long", locale)}, `}${timeLabel(when.to, timeZone, locale)}`;
}

/** What the days on show are called: "October 2026" for a month, and otherwise the first and last of them. */
export function titleOf(view: View, anchor: Day, locale?: string): string {
  if (view === "month") return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", year: "numeric" }).format(counted(anchor));
  return titleOfDays(daysOf(view, anchor), locale);
}

/** What days that follow one another are called: "Oct 11 – Oct 17, 2026", or the day in full when there is one. */
export function titleOfDays(days: readonly Day[], locale?: string): string {
  if (days.length === 1) return dayLabel(days[0]!, "full", locale);
  return `${dayLabel(days[0]!, "short", locale)} – ${dayLabel(days.at(-1)!, "long", locale).replace(/^[^,]*, /, "")}`;
}

/** When an event is, as the fields of a form hold it: dates, and times of day in the member's zone. */
export interface WhenForm {
  allDay: boolean;
  fromDay: string;
  fromTime: string;
  toDay: string;
  toTime: string;
}

export function formOf(when: EventWhen, timeZone: string): WhenForm {
  if (when.allDay) return { allDay: true, fromDay: when.from, toDay: when.to, fromTime: "09:00", toTime: "10:00" };
  return { allDay: false, fromDay: dayIn(when.from, timeZone), fromTime: timeIn(when.from, timeZone), toDay: dayIn(when.to, timeZone), toTime: timeIn(when.to, timeZone) };
}

const minutesOf = (time: string) => {
  const read = /^(\d{2}):(\d{2})$/.exec(time);
  return read && Number(read[1]) < 24 && Number(read[2]) < 60 ? Number(read[1]) * 60 + Number(read[2]) : null;
};

/** What a form says an event's time is, or why it says none. */
export function whenOf(form: WhenForm, timeZone: string): EventWhen | { problem: string } {
  if (!isDay(form.fromDay) || !isDay(form.toDay)) return { problem: "Give the day it starts and the day it ends." };
  if (form.allDay) return form.toDay < form.fromDay ? { problem: "It ends before it starts." } : { allDay: true, from: form.fromDay, to: form.toDay };
  const [from, to] = [minutesOf(form.fromTime), minutesOf(form.toTime)];
  if (from === null || to === null) return { problem: "Give the time it starts and the time it ends." };
  const when = { allDay: false as const, from: instantAt(form.fromDay, from, timeZone), to: instantAt(form.toDay, to, timeZone) };
  return when.to < when.from ? { problem: "It ends before it starts." } : when;
}

export const sameWhen = (a: EventWhen, b: EventWhen) => a.allDay === b.allDay && a.from === b.from && a.to === b.to;
