/*
 * A due date is a calendar date, written YYYY-MM-DD, and "today" is the day it is where the member
 * is: the browser's own time zone. The server is only ever handed days, never asked what today is.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The day it is at `time`, where the member is. */
export const dayOf = (time: Date) => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;

export const today = () => dayOf(new Date());

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
  const date = utc(day);
  if (away > 1 && away < 7) return WEEKDAYS[date.getUTCDay()]!;
  const short = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return day.slice(0, 4) === now.slice(0, 4) ? short : `${short}, ${day.slice(0, 4)}`;
}

export type DueState = "overdue" | "today" | "later";

export const dueState = (day: string, now: string): DueState => (day < now ? "overdue" : day === now ? "today" : "later");

/** The due dates a member picks from, and the days each means today. */
export const DUE_FILTERS = { any: "Any date", overdue: "Overdue", today: "Today", week: "Next 7 days", none: "No date" } as const;
export type DueFilter = keyof typeof DUE_FILTERS;

export function dueRange(filter: DueFilter, now: string): { dueFrom?: string; dueTo?: string; noDue?: boolean } {
  if (filter === "overdue") return { dueTo: addDays(now, -1) };
  if (filter === "today") return { dueFrom: now, dueTo: now };
  if (filter === "week") return { dueFrom: now, dueTo: addDays(now, 6) };
  if (filter === "none") return { noDue: true };
  return {};
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
