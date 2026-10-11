export type Unit = "d" | "w" | "m" | "y";

/** 0 is Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * When a todo comes around again, as its `every:` token writes it.
 *
 * - `3d`, `2w`, `1m`, `1y` is every so many days, weeks, months or years, on a schedule counted from
 *   the due date. `3d-after-done` counts from the day it was checked off.
 * - `mon,thu` is those days of every week.
 * - `3rd-day` is that day of every month, `last-day` its last day, and `2nd-last-day` the day before.
 * - `2nd-tue` is that weekday of every month, counted from its start, and `last-fri` and
 *   `2nd-last-fri` from its end.
 */
export type Rule =
  | { kind: "interval"; n: number; unit: Unit; after: "schedule" | "done" }
  /** Each day once, Monday first through Sunday. */
  | { kind: "weekdays"; days: readonly Weekday[] }
  /** `nth` is 1 to 31. */
  | { kind: "monthDay"; nth: number; fromEnd: boolean }
  /** `nth` is 1 to 5. */
  | { kind: "monthWeekday"; nth: number; fromEnd: boolean; day: Weekday };

/** The three-letter names by Weekday. */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const NAME = `(?:${WEEKDAYS.join("|")})`;
const ORDINAL = "\\d+(?:st|nd|rd|th)";

/**
 * The source of a regular expression that matches a rule's characters, with no anchors and no
 * capture groups, for the todo line parser to build its token regex from. It is looser than
 * `parseRule`, which has the last word: `0d` and `2th-day` match and are not rules.
 */
export const RULE_PATTERN = `(?:\\d+[dwmy](?:-after-done)?|${NAME}(?:,${NAME})*|(?:${ORDINAL}-(?:last-)?|last-)(?:day|${NAME}))`;

const INTERVAL = /^([1-9]\d{0,2})([dwmy])(-after-done)?$/;
const LIST = new RegExp(`^${NAME}(?:,${NAME})*$`);
const MONTHLY = new RegExp(`^(?:(${ORDINAL})-)?(last-)?(day|${NAME})$`);

const UNIT_WORD: Record<Unit, string> = { d: "day", w: "week", m: "month", y: "year" };
const MS_PER_DAY = 86_400_000;

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
const mondayFirst = (a: Weekday, b: Weekday) => ((a + 6) % 7) - ((b + 6) % 7);

/** The rule written as `text`, or null when it isn't one. */
export function parseRule(text: string): Rule | null {
  const interval = INTERVAL.exec(text);
  if (interval) return { kind: "interval", n: Number(interval[1]), unit: interval[2] as Unit, after: interval[3] ? "done" : "schedule" };

  if (LIST.test(text)) {
    const days = text.split(",").map((name) => WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]) as Weekday);
    return new Set(days).size === days.length ? { kind: "weekdays", days: days.sort(mondayFirst) } : null;
  }

  const monthly = MONTHLY.exec(text);
  if (!monthly) return null;
  const [, counted, last, what] = monthly;
  if (!counted && !last) return null;
  const nth = counted ? parseInt(counted, 10) : 1;
  // The last one has one spelling, so `1st-last-day` is not a second.
  if (counted && (counted !== ordinal(nth) || (last && nth === 1))) return null;
  const fromEnd = Boolean(last);
  if (what === "day") return nth >= 1 && nth <= 31 ? { kind: "monthDay", nth, fromEnd } : null;
  return nth >= 1 && nth <= 5 ? { kind: "monthWeekday", nth, fromEnd, day: WEEKDAYS.indexOf(what as (typeof WEEKDAYS)[number]) as Weekday } : null;
}

/** The rule as its token writes it, which `parseRule` reads back to the same rule. */
export function writeRule(rule: Rule): string {
  switch (rule.kind) {
    case "interval":
      return `${rule.n}${rule.unit}${rule.after === "schedule" ? "" : "-after-done"}`;
    case "weekdays":
      return [...rule.days].sort(mondayFirst).map((day) => WEEKDAYS[day]).join(",");
    case "monthDay":
    case "monthWeekday":
      return `${nthWritten(rule)}-${rule.kind === "monthDay" ? "day" : WEEKDAYS[rule.day]}`;
  }
}

const nthWritten = (rule: { nth: number; fromEnd: boolean }) => (!rule.fromEnd ? ordinal(rule.nth) : rule.nth === 1 ? "last" : `${ordinal(rule.nth)}-last`);
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** How a person reads it, for a chip. */
export function describeRule(rule: Rule): string {
  switch (rule.kind) {
    case "interval": {
      const unit = UNIT_WORD[rule.unit];
      if (rule.after === "done") return `${rule.n} ${unit}${rule.n === 1 ? "" : "s"} after done`;
      return rule.n === 1 ? `Every ${unit}` : `Every ${rule.n} ${unit}s`;
    }
    case "weekdays":
      return [...rule.days].sort(mondayFirst).map((day) => capital(WEEKDAYS[day])).join(", ");
    case "monthDay":
      return `${capital(nthWritten(rule))} day of the month`;
    case "monthWeekday":
      return `${capital(nthWritten(rule))} ${capital(WEEKDAYS[rule.day])} of the month`;
  }
}

/**
 * A calendar date as a count of days, so that adding to one is plain arithmetic. It is counted in
 * UTC, where every day is 24 hours long, which is what keeps a clock change from moving a date.
 */
const count = (year: number, month: number, date: number) => Date.UTC(year, month, date) / MS_PER_DAY;
const read = (day: string) => count(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const LAST = count(9999, 11, 31);
const write = (day: number) => (day > LAST ? null : new Date(day * MS_PER_DAY).toISOString().slice(0, 10));

const parts = (day: number) => {
  const at = new Date(day * MS_PER_DAY);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth(), date: at.getUTCDate(), weekday: at.getUTCDay() };
};

/** `month` may run past December: it carries into the years after. */
const daysIn = (year: number, month: number) => parts(count(year, month + 1, 0)).date;

/** A month or a year on keeps the day of the month, or the month's last day when it has no such day. */
function add(day: number, n: number, unit: Unit): number {
  if (unit === "d" || unit === "w") return day + n * (unit === "d" ? 1 : 7);
  const { year, month, date } = parts(day);
  const to = month + n * (unit === "m" ? 1 : 12);
  return count(year, to, Math.min(date, daysIn(year, to)));
}

/** The first day after `after` that `dateIn` picks out of a month. A month where it picks none is passed over. */
function firstInAMonth(after: number, dateIn: (length: number, firstWeekday: number) => number | null): number | null {
  const { year, month } = parts(after);
  for (let to = month; count(year, to, 1) <= LAST; to++) {
    const date = dateIn(daysIn(year, to), parts(count(year, to, 1)).weekday);
    if (date !== null && count(year, to, date) > after) return count(year, to, date);
  }
  return null;
}

function next(rule: Rule, due: number | null, done: number): number | null {
  const after = due === null ? done : Math.max(due, done);
  switch (rule.kind) {
    case "interval": {
      if (due === null || rule.after === "done") return add(done, rule.n, rule.unit);
      // Each occurrence is counted from the due date, not from the one before, so a month's end doesn't pull the ones after it earlier.
      let times = 1;
      while (add(due, times * rule.n, rule.unit) <= done) times++;
      return add(due, times * rule.n, rule.unit);
    }
    case "weekdays":
      for (let day = after + 1; day <= after + 7; day++) if (rule.days.includes(parts(day).weekday as Weekday)) return day;
      return null;
    case "monthDay":
      return firstInAMonth(after, (length) => (rule.fromEnd ? Math.max(1, length - rule.nth + 1) : Math.min(rule.nth, length)));
    case "monthWeekday":
      return firstInAMonth(after, (length, firstWeekday) => {
        const first = 1 + ((rule.day - firstWeekday + 7) % 7);
        const last = first + 7 * Math.floor((length - first) / 7);
        const date = rule.fromEnd ? last - 7 * (rule.nth - 1) : first + 7 * (rule.nth - 1);
        return date >= 1 && date <= length ? date : null;
      });
  }
}

/**
 * The next due date of a todo due on `due` and checked off on `done`, or null when it would be past
 * the year 9999. A schedule skips the occurrences already missed, and the rules that name days give
 * the first such day after both dates.
 */
export function nextDue(rule: Rule, at: { due: string | null; done: string }): string | null {
  const day = next(rule, at.due === null ? null : read(at.due), read(at.done));
  return day === null ? null : write(day);
}
