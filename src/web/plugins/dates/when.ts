import { daysBetween, isDay, shiftDay, weekdayOf, WEEKDAY_NAMES, type Day } from "../calendar/dates.ts";

/**
 * A day a member means, and the time of day on it where they said one. A note writes it as the day
 * alone, `2026-10-21`, or with the time, `2026-10-21 15:00`: a calendar day and a clock's time where
 * the member is, with no time zone, as a due date is a day with none.
 */
export interface When {
  day: Day;
  /** HH:MM on a 24-hour clock. */
  time: string | null;
}

/** A day `@` offers for what was typed, with the name it was asked for by, such as Next Friday, where it has one. */
export interface Said extends When {
  name: string | null;
}

/** A written day or day and time found on a line, and where it is in the note. */
export interface Written extends When {
  from: number;
  to: number;
}

/** Whether a day and month written in numbers put the month first, as 10/21 does in the United States, or the day, as 21/10 does elsewhere. */
export type Order = "month-day" | "day-month";

/** Now where the member is: their date, and the time on their clock, HH:MM. */
export interface Now {
  day: Day;
  time: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** The fewest letters of a month's name taken as the month, so "ma" names neither March nor May. */
const MONTH_LETTERS = 3;

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (year: number, month: number, date: number): Day | null => {
  const day = `${String(year).padStart(4, "0")}-${pad(month)}-${pad(date)}`;
  return isDay(day) ? day : null;
};

/** The month a word names, 1 to 12: three or more letters of its name. */
const monthOf = (word: string): number | null => {
  if (word.length < MONTH_LETTERS) return null;
  const at = MONTHS.findIndex((name) => name.startsWith(word));
  return at < 0 ? null : at + 1;
};

/** A day of the month, with or without its ending: 21, 21st. */
const dateOf = (word: string): number | null => (/^\d{1,2}(st|nd|rd|th)?$/.test(word) ? parseInt(word, 10) : null);

/** A date written without its year, in the year that puts it nearest today, the coming one where two are as near. Feb 29 is the nearest leap year's. */
function nearest(month: number, date: number, today: Day): Day | null {
  const year = Number(today.slice(0, 4));
  const days = [-4, -3, -2, -1, 0, 1, 2, 3, 4].flatMap((by) => dayOf(year + by, month, date) ?? []);
  return days.sort((a, b) => Math.abs(daysBetween(today, a)) - Math.abs(daysBetween(today, b)) || b.localeCompare(a))[0] ?? null;
}

const yearOf = (word: string | undefined): number | null => (word === undefined ? null : /^\d{4}$/.test(word) ? Number(word) : /^\d{2}$/.test(word) ? 2000 + Number(word) : null);

/** A day written as a date: 2026-10-21, oct 21, 21 oct, october 21st 2027, 10/21, 10/21/27. */
function writtenDay(words: readonly string[], today: Day, order: Order): Day | null {
  const [first, second, third, ...rest] = words;
  if (!first || rest.length) return null;
  if (words.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(first)) return isDay(first) ? first : null;
  const numbers = words.length === 1 ? /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(first) : null;
  if (numbers) {
    const [a, b] = [Number(numbers[1]), Number(numbers[2])];
    const [month, date] = order === "month-day" ? [a, b] : [b, a];
    const year = yearOf(numbers[3]);
    return year === null ? nearest(month, date, today) : dayOf(year, month, date);
  }
  if (!second) return null;
  const [month, date] = monthOf(first) === null ? [monthOf(second), dateOf(first)] : [monthOf(first), dateOf(second)];
  if (month === null || date === null) return null;
  if (third === undefined) return nearest(month, date, today);
  const year = /^\d{4}$/.test(third) ? Number(third) : null;
  return year === null ? null : dayOf(year, month, date);
}

/**
 * The days with names, in the order `@` offers them: today and the days around it, now, the weekdays
 * of the coming seven days, then those of next week, which starts on the Monday after today's.
 */
function named(now: Now): { words: string[]; name: string; day: Day; time?: string }[] {
  const { day: today } = now;
  const nextMonday = shiftDay(today, 7 - ((weekdayOf(today) + 6) % 7));
  const week = (first: Day) => [0, 1, 2, 3, 4, 5, 6].map((n) => shiftDay(first, n));
  const nameOf = (day: Day) => WEEKDAY_NAMES[weekdayOf(day)]!;
  return [
    { words: ["today"], name: "Today", day: today },
    { words: ["tomorrow"], name: "Tomorrow", day: shiftDay(today, 1) },
    { words: ["yesterday"], name: "Yesterday", day: shiftDay(today, -1) },
    { words: ["now"], name: "Now", day: today, time: now.time },
    ...week(shiftDay(today, 1)).map((day) => ({ words: [nameOf(day).toLowerCase()], name: nameOf(day), day })),
    ...week(nextMonday).map((day) => ({ words: ["next", nameOf(day).toLowerCase()], name: `Next ${nameOf(day)}`, day })),
  ];
}

/**
 * Whether the words typed start the words of a name, one for one: "tom" starts Tomorrow and "nex fri"
 * starts Next Friday. A name of more words is started only once its first word is typed whole, so
 * "ne" offers none of the seven days after "next".
 */
function starts(typed: readonly string[], words: readonly string[]): boolean {
  if (!typed.length || typed.length > words.length) return false;
  const fewer = typed.length < words.length;
  return typed.every((word, i) => (fewer && i === typed.length - 1 ? word === words[i] : words[i]!.startsWith(word)));
}

/** A time typed as a clock's: 3pm, 3 pm, 3:30p, 15:30, noon, midnight. Hours alone, with no am or pm, are a number and not a time. */
function timeOf(text: string): string | null {
  if (text === "noon") return "12:00";
  if (text === "midnight") return "00:00";
  const twelve = /^(\d{1,2})(?::(\d{2}))?\s?([ap])m?$/.exec(text);
  if (twelve) {
    const [hour, minute] = [Number(twelve[1]), Number(twelve[2] ?? 0)];
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return `${pad((hour % 12) + (twelve[3] === "p" ? 12 : 0))}:${pad(minute)}`;
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!clock) return null;
  const [hour, minute] = [Number(clock[1]), Number(clock[2])];
  return hour > 23 || minute > 59 ? null : `${pad(hour)}:${pad(minute)}`;
}

/** What was typed taken apart into the words of a day and the time said before or after them, with or without "at". */
function apart(typed: string): { words: string[]; time: string | null } {
  const words = typed.toLowerCase().replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  for (const [take, from] of [
    [2, words.length - 2],
    [1, words.length - 1],
    [2, 0],
    [1, 0],
  ] as const) {
    if (from < 0 || take > words.length) continue;
    const time = timeOf(words.slice(from, from + take).join(" "));
    if (time === null) continue;
    const rest = [...words.slice(0, from), ...words.slice(from + take)];
    return { words: rest.at(-1) === "at" ? rest.slice(0, -1) : rest[0] === "at" ? rest.slice(1) : rest, time };
  }
  return { words: words.at(-1) === "at" && words.length > 1 ? words.slice(0, -1) : words, time: null };
}

/**
 * The days `@` offers for what was typed after it, best first: today, tomorrow and yesterday, a
 * weekday (the coming one, never today), "next" and a weekday (that day of next week), now, a
 * date written any of the ways `writtenDay` reads, and any of them with a time before or after it.
 * A time alone is today's. Nothing for nothing typed, or for words that start no day.
 */
export function saidFor(typed: string, now: Now, order: Order): Said[] {
  const { words, time } = apart(typed);
  if (!words.length) return time === null ? [] : [{ name: "Today", day: now.day, time }];
  const written = writtenDay(words, now.day, order);
  if (written) return [{ name: null, day: written, time }];
  return named(now)
    .filter((n) => starts(words, n.words) && !(n.time && time !== null))
    .map(({ name, day, time: own }) => ({ name, day, time: own ?? time }));
}

/** The days `@` alone offers, before anything is typed after it: today and tomorrow. */
export const soon = (now: Now): Said[] => named(now).flatMap(({ name, day }) => (name === "Today" || name === "Tomorrow" ? [{ name, day, time: null }] : []));

/** Whether what was typed asks for the date picker by name: "pick", "pick a date" on the way, or "date". */
export function asksToPick(typed: string): boolean {
  const words = typed.toLowerCase().trim().split(/\s+/).join(" ");
  return words === "date" || (words.startsWith("pick") && "pick a date".startsWith(words));
}

/** How a note writes a day, or a day and a time. */
export const written = ({ day, time }: When): string => (time === null ? day : `${day} ${time}`);

/**
 * The days written on a line that starts at `offset` in the note, as `written` writes them, each on
 * its own: at the start of the line or after a space or an opening parenthesis, and before the end,
 * a space or a mark that ends words. A date that is part of something longer, such as `due:2026-10-21`,
 * a link's words after `|`, or an address, is not one.
 */
export function writtenOn(line: string, offset: number): Written[] {
  const found: Written[] = [];
  for (const match of line.matchAll(/(?<=^|[\s(])(\d{4}-\d{2}-\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?(?=$|[\s.,;!?)]|:(?!\d))/g)) {
    const [whole, day, time] = match;
    if (!isDay(day!)) continue;
    found.push({ day: day!, time: time ?? null, from: offset + match.index, to: offset + match.index + whole.length });
  }
  return found;
}

// Chrome and Node put a narrow no-break space before AM and PM, which nobody can type or search for.
const plain = (text: string) => text.replace(/[  ]/g, " ");
const instant = ({ day, time }: When) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), Number(time?.slice(0, 2) ?? 0), Number(time?.slice(3, 5) ?? 0));
const format = (when: When, options: Intl.DateTimeFormatOptions, locale?: string) => plain(new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options }).format(instant(when)));

/** A time of day as the member reads it: 3:00 PM. */
export const timeWords = (time: string, locale?: string) => format({ day: "2000-01-01", time }, { hour: "numeric", minute: "2-digit" }, locale);

/** A written day as a chip reads it: Wed, Oct 21, with the year where it isn't `year`, and the time where there is one. */
export const chipWords = (when: When, year: string, locale?: string) =>
  format(when, { weekday: "short", month: "short", day: "numeric", ...(when.day.slice(0, 4) !== year && { year: "numeric" }), ...(when.time !== null && { hour: "numeric", minute: "2-digit" }) }, locale);

/** A day in full: Wednesday, October 21, 2026, with the time where there is one. */
export const fullWords = (when: When, locale?: string) => format(when, { dateStyle: "full", ...(when.time !== null && { timeStyle: "short" }) }, locale);

/** The day of the week: Wednesday. */
export const weekdayWords = (day: Day, locale?: string) => format({ day, time: null }, { weekday: "long" }, locale);

/** How far a day is from today, in the unit that reads best: today, tomorrow, in 3 days, in 2 weeks, 5 months ago. */
export function howFar(day: Day, today: Day, locale?: string): string {
  const days = daysBetween(today, day);
  const away = Math.abs(days);
  const [count, unit] = away < 14 ? [days, "day"] : away < 60 ? [Math.round(days / 7), "week"] : away < 730 ? [Math.round(days / 30.44), "month"] : [Math.round(days / 365.25), "year"];
  const words = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(count, unit as Intl.RelativeTimeFormatUnit);
  return words.charAt(0).toLocaleUpperCase(locale) + words.slice(1);
}

/** Which of a day and a month the member's locale writes first in numbers. */
export function orderIn(locale?: string): Order {
  const parts = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).formatToParts(Date.UTC(2026, 9, 21));
  return parts.findIndex((p) => p.type === "month") < parts.findIndex((p) => p.type === "day") ? "month-day" : "day-month";
}
