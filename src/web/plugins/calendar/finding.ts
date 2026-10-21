import type { CalendarEvent, PluginHost } from "../../plugin-api.ts";
import { dayIn, dayLabel, daysBetween, daysOfEvent, isDay, shiftDay, timeLabel, type Day } from "./dates.ts";

/** How far back and ahead an event is looked for, to be linked from a note or gone to: a month back and three ahead. */
export const BACK_DAYS = 30;
export const AHEAD_DAYS = 90;

const DAY_MS = 86_400_000;
const RELATIVE = { today: 0, tomorrow: 1, yesterday: -1 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const wordsOf = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** What is typed to find an event: words its title has, and a day it is on. */
export interface Sought {
  words: string[];
  day: Day | null;
}

/** January's 0 for `jan`, `janu` or `january`: three letters or more of a month's name. */
const monthOf = (written: string) => {
  const word = written.replace(/\.$/, "");
  return word.length < 3 ? -1 : word === "sept" ? 8 : MONTHS.findIndex((month) => month.startsWith(word));
};

/** A year, a month from 0 and a day of it, or null for one that year hasn't. */
const dayOn = (year: number, month: number, date: number): Day | null => {
  const day = `${year}-${String(month + 1).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
  return isDay(day) ? day : null;
};

/** The day of a month and day with no year that is nearest `today`, or null for one no year has, as February 30. */
function nearest(month: number, date: number, today: Day): Day | null {
  const year = Number(today.slice(0, 4));
  const days = [year - 1, year, year + 1].flatMap((y) => dayOn(y, month, date) ?? []);
  return days.sort((a, b) => Math.abs(daysBetween(today, a)) - Math.abs(daysBetween(today, b)))[0] ?? null;
}

/**
 * Reads what was typed to find an event: a day written `oct 20`, `20 oct`, `October 20`, `Oct. 20 2026`,
 * `10/20`, `10/20/2026`, `2026-10-20`, `today`, `tomorrow` or `yesterday`, and the rest as words of its title. A day with
 * no year is the one nearest today. A month's name with no day beside it is a word, as "May" is.
 */
export function sought(typed: string, today: Day): Sought {
  const tokens = typed
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  let day: Day | null = null;
  const left: string[] = [];
  const ordinal = (token: string | undefined) => (token && /^\d{1,2}(st|nd|rd|th)?$/.test(token) ? parseInt(token, 10) : null);
  for (let i = 0; i < tokens.length; i++) {
    const [token, next] = [tokens[i]!, tokens[i + 1]];
    const slashed = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(token);
    /** The day this token says, alone or with the next one, and how many tokens that took. */
    const [found, used]: [Day | null, number] = Object.hasOwn(RELATIVE, token)
      ? [shiftDay(today, RELATIVE[token as keyof typeof RELATIVE]), 1]
      : isDay(token)
        ? [token, 1]
        : slashed
          ? [slashed[3] ? dayOn(Number(slashed[3]), Number(slashed[1]) - 1, Number(slashed[2])) : nearest(Number(slashed[1]) - 1, Number(slashed[2]), today), 1]
          : monthOf(token) >= 0 && ordinal(next) !== null && /^\d{4}$/.test(tokens[i + 2] ?? "")
            ? [dayOn(Number(tokens[i + 2]), monthOf(token), ordinal(next)!), 3]
            : monthOf(token) >= 0 && ordinal(next) !== null
              ? [nearest(monthOf(token), ordinal(next)!, today), 2]
              : ordinal(token) !== null && next && monthOf(next) >= 0
                ? [nearest(monthOf(next), ordinal(token)!, today), 2]
                : [null, 1];
    if (found && day === null) {
      day = found;
      i += used - 1;
    } else left.push(token);
  }
  return { words: wordsOf(left.join(" ")), day };
}

/**
 * The events that what was typed finds, the nearest to now first: each word starts a word of the
 * title, and a day typed is one the event is on in the member's zone. Each occurrence of a repeating
 * event is one of its own. Nothing typed finds nothing.
 */
export function finding(events: readonly CalendarEvent[], typed: string, now: number, timeZone: string): CalendarEvent[] {
  const { words, day } = sought(typed, dayIn(now, timeZone));
  if (!words.length && day === null) return [];
  const found = events.filter((event) => {
    const has = wordsOf(event.title);
    return words.every((word) => has.some((w) => w.startsWith(word))) && (day === null || daysOfEvent(event.when, timeZone).includes(day));
  });
  const startOf = (event: CalendarEvent) => (event.when.allDay ? Date.parse(`${event.when.from}T12:00:00Z`) : event.when.from);
  return found.sort((a, b) => Math.abs(startOf(a) - now) - Math.abs(startOf(b) - now) || startOf(a) - startOf(b));
}

/** The events still to start at `now`, soonest first: a timed one from `now`, and an all-day one from the next day, before the timed ones of its day. */
export function upcoming(events: readonly CalendarEvent[], now: number, timeZone: string): CalendarEvent[] {
  const today = dayIn(now, timeZone);
  const dayOf = ({ when }: CalendarEvent) => (when.allDay ? when.from : dayIn(when.from, timeZone));
  const timeOf = ({ when }: CalendarEvent) => (when.allDay ? 0 : when.from);
  return events.filter(({ when }) => (when.allDay ? when.from > today : when.from >= now)).toSorted((a, b) => dayOf(a).localeCompare(dayOf(b)) || timeOf(a) - timeOf(b));
}

/** What an event is listed as: its title, and its day, its time and its calendar after it. */
export function listedAs(event: CalendarEvent, timeZone: string): { label: string; detail: string } {
  const { when } = event;
  const day = when.allDay ? when.from : dayIn(when.from, timeZone);
  return {
    label: event.title || "Untitled",
    detail: [dayLabel(day, "long"), when.allDay ? "All day" : timeLabel(when.from, timeZone), event.calendar].join(" · "),
  };
}

/** How long the events read for finding stand before they are read again. */
const KEPT_MS = 60_000;
let kept: { by: string; at: number; read: Promise<readonly CalendarEvent[]>; events?: readonly CalendarEvent[] } | null = null;

/**
 * The member's events from a month back to three months ahead, from every calendar they connected,
 * as the core lists them to them alone. Read once a minute at most, and what was read stays to be
 * answered at once while it is read again; one with none connected has none, and a reading that
 * failed is tried again the next time. `now` is null until the first reading has landed.
 */
export function eventsToFind(host: PluginHost, timeZone: string): { now: readonly CalendarEvent[] | null; read: Promise<readonly CalendarEvent[]> } {
  const by = `${host.app().me.id} ${timeZone}`;
  const at = Date.now();
  if (!kept || kept.by !== by || at - kept.at > KEPT_MS) {
    const entry: NonNullable<typeof kept> = { by, at, read: Promise.resolve([]), events: kept?.by === by ? kept.events : undefined };
    entry.read = host.perform({ type: "event.list", from: at - BACK_DAYS * DAY_MS, to: at + AHEAD_DAYS * DAY_MS, timeZone }).then(
      ({ events }) => (entry.events = events),
      () => {
        if (kept === entry) kept = null;
        return entry.events ?? [];
      },
    );
    kept = entry;
  }
  return { now: kept.events ?? null, read: kept.read };
}

/** Whether the events have been read: false before the first reading lands, and after one that failed. */
export const eventsRead = () => kept?.events !== undefined;

/** Has the events read again the next time they are looked for, as after one is added or changed; what was read is answered meanwhile. */
export const forgetEventsToFind = () => void (kept &&= { ...kept, at: 0 });
