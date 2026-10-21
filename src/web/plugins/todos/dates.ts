/*
 * A due date is a calendar date, written YYYY-MM-DD, and "today" is the day it is where the member
 * is: the browser's own time zone. The server is only ever handed days, never asked what today is.
 */

import { PRIORITIES, dayOf, today } from "../../plugin-api.ts";

export { dayOf, today };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const utc = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!));
};

/** The day `days` after `day`, or before it when negative. */
export const addDays = (day: string, days: number) => {
  const made = utc(day);
  made.setUTCDate(made.getUTCDate() + days);
  return made.toISOString().slice(0, 10);
};

const daysFrom = (from: string, to: string) => Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);

/** How a due date reads beside today: Today, Tomorrow, Yesterday, a weekday within the week ahead, or the date. */
export function dueLabel(day: string, now: string): string {
  const away = daysFrom(now, day);
  if (away === 0) return "Today";
  if (away === 1) return "Tomorrow";
  if (away === -1) return "Yesterday";
  if (away > 1 && away < 7) return WEEKDAYS[utc(day).getUTCDay()]!;
  return dateLabel(day, now);
}

/** A day as its date, such as Oct 15, with its year when that isn't the year of `now`. */
export function dateLabel(day: string, now: string): string {
  const date = utc(day);
  const short = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return day.slice(0, 4) === now.slice(0, 4) ? short : `${short}, ${day.slice(0, 4)}`;
}

/** When a todo's line was ticked, as a date where the member is: never Today or a weekday, so it reads the same tomorrow. */
export const tickedLabel = (at: number, now: string) => `Done ${dateLabel(dayOf(new Date(at)), now)}`;

export type DueState = "overdue" | "today" | "later";

export const dueState = (day: string, now: string): DueState => (day < now ? "overdue" : day === now ? "today" : "later");

/** The due dates a list can be narrowed to, as a changed row's line names them, and the days each means today. */
export const DUE_FILTERS = { any: "Any date", overdue: "Overdue", today: "Today", week: "Next 7 days", none: "No date" } as const;
export type DueFilter = keyof typeof DUE_FILTERS;

export function dueRange(filter: DueFilter, now: string): { dueFrom?: string; dueTo?: string; noDue?: boolean } {
  if (filter === "overdue") return { dueTo: addDays(now, -1) };
  if (filter === "today") return { dueFrom: now, dueTo: now };
  if (filter === "week") return { dueFrom: now, dueTo: addDays(now, 6) };
  if (filter === "none") return { noDue: true };
  return {};
}

/**
 * The query the Todos page is left at. Before the page took a query it kept a choice from each of
 * its filters, and what a browser still holds of those is read as the query that says the same.
 */
export function savedQuery(query: unknown, filters: unknown): string {
  if (typeof query === "string") return query;
  const kept = typeof filters === "object" && filters !== null ? (filters as Record<string, unknown>) : {};
  const due = { overdue: "due:<today", today: "due:today", week: "due:today..+6d", none: "no:due" }[String(kept.due)];
  return [
    ...(typeof kept.folder === "string" && /^[a-z0-9]{12}$/.test(kept.folder) ? [`folder:${kept.folder}`] : []),
    ...(typeof kept.tag === "string" && /^[\p{L}\p{N}_][\p{L}\p{N}_/-]*$/u.test(kept.tag) && /\D/.test(kept.tag) ? [`tag:${kept.tag.toLowerCase()}`] : []),
    ...(due ? [due] : []),
    ...(typeof kept.importance === "string" && /^[0-3]$/.test(kept.importance) ? [`priority:${PRIORITIES[Number(kept.importance)]}`] : []),
    ...(kept.completed === true ? ["(is:open OR is:done)"] : []),
    ...(kept.archived === true ? ["(is:archived OR -is:archived)"] : []),
  ].join(" ");
}

/** The days offered while a member types `due:`, soonest first, narrowed by what they have typed. */
export function dueOffers(typed: string, now: string): { label: string; day: string }[] {
  const offers = [
    { label: "Today", day: now },
    { label: "Tomorrow", day: addDays(now, 1) },
    ...[2, 3, 4, 5, 6].map((days) => ({ label: dueLabel(addDays(now, days), now), day: addDays(now, days) })),
    { label: "In a week", day: addDays(now, 7) },
  ];
  const wanted = typed.trim().toLowerCase();
  return offers.filter((offer) => offer.label.toLowerCase().startsWith(wanted) || offer.day.startsWith(wanted));
}
