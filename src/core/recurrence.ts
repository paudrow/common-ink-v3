export type Unit = "d" | "w" | "m" | "y";

/** 0 is Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** How a rule ends: no occurrence after a day, or so many more times, counting the one due now. */
export type End = { until: string } | { times: number };

/**
 * When a todo comes around again, as its `every:` token writes it: every `n` units, on the days
 * `days`, `dates` and `month` pick out of each such period, until `end`.
 *
 * - `3d`, `2w`, `1m`, `1y` picks nothing: it is every so many days, weeks, months or years counted
 *   from the due date, and `3d-after-done` from the day it was checked off.
 * - `mon,thu` is those days of every week, and `2w-mon,thu` of every second week, counted from the
 *   week of the due date, Monday first.
 * - `3rd-day` is that day of every month, `last-day` its last day, `2nd-last-day` the day before,
 *   and `1st-day,15th-day` both. `2nd-tue` is that weekday of every month, counted from its start,
 *   `last-fri` and `2nd-last-fri` from its end, and `1st-tue,3rd-tue` both. `3m-last-fri` is every
 *   third month, counted from the month of the due date.
 * - `mar-1` is that date of every year and `1st-mon-mar` that weekday of that month, and `2y-mar-1`
 *   of every second year, counted from the year of the due date.
 * - `-until-2026-12-31` or `-times-5` after any of them is its end.
 *
 * `parseRule` makes only rules its grammar writes: `days` with `nth` 0 in a rule of weeks alone,
 * `dates` or `days` with an `nth`, never both, in a rule of months or years, and `month` in a rule
 * of years with one of either. Only a rule that picks nothing counts from the day it was done.
 */
export interface Rule {
  unit: Unit;
  /** 1 to 999. */
  n: number;
  from: "due" | "done";
  /** Weekdays. `nth` 0 is each one of the week; 1 to 5 is that one of the month, and -1 to -5 that one from its end. */
  days: readonly { nth: number; day: Weekday }[];
  /** Days of the month, 1 to 31, and -1 to -31 counted from its end. */
  dates: readonly number[];
  /** The month of a rule of years, 1 for January, and null for any other rule. */
  month: number | null;
  end: End | null;
}

/** The three-letter names by Weekday. */
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** The three-letter names of the months, January first. */
export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

const NAME = `(?:${WEEKDAYS.join("|")})`;
const MONTH = `(?:${MONTHS.join("|")})`;
const ORDINAL = "\\d+(?:st|nd|rd|th)";
const NTH = `(?:${ORDINAL}-(?:last-)?|last-)`;
const ITEM = `${NTH}(?:day|${NAME})`;

/**
 * The source of a regular expression that matches a rule's characters, with no anchors and no
 * capture groups, for the todo line parser to build its token regex from. It is looser than
 * `parseRule`, which has the last word: `0d` and `2th-day` match and are not rules.
 */
export const RULE_PATTERN = `(?:\\d+[dwmy](?:-after-done)?|(?:\\d+w-)?${NAME}(?:,${NAME})*|(?:\\d+m-)?${ITEM}(?:,${ITEM})*|(?:\\d+y-)?(?:${MONTH}-\\d+|${NTH}${NAME}-${MONTH}))(?:-until-\\d{4}-\\d{2}-\\d{2}|-times-\\d+)?`;

const COUNT = "[1-9]\\d{0,2}";
const END = new RegExp(`^(.+?)-(?:until-(\\d{4}-\\d{2}-\\d{2})|times-(${COUNT}))$`);
const INTERVAL = new RegExp(`^(${COUNT})([dwmy])(-after-done)?$`);
const EVERY_OTHER = new RegExp(`^(${COUNT})([wmy])-(.+)$`);
const LIST = new RegExp(`^${NAME}(?:,${NAME})*$`);
const MONTHLY = new RegExp(`^(?:(${ORDINAL})-)?(last-)?(day|${NAME})$`);
const DATE = new RegExp(`^(${MONTH})-([1-9]\\d?)$`);
const IN_MONTH = new RegExp(`^(.+)-(${MONTH})$`);

const UNIT_WORD: Record<Unit, string> = { d: "day", w: "week", m: "month", y: "year" };
const MS_PER_DAY = 86_400_000;

export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
/** Where a weekday is in a week that starts on Monday. */
const inWeek = (day: Weekday) => (day + 6) % 7;
const weekday = (name: string) => WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]) as Weekday;
/** Where one of a month's days or weekdays comes in a list: counted from the start first, then from the end, the last one last. */
const place = (nth: number) => (nth > 0 ? nth : 100 + nth);
const rising = (keys: readonly number[]) => keys.every((key, i) => i === 0 || keys[i - 1]! < key);

const blank = (unit: Unit, n = 1): Rule => ({ unit, n, from: "due", days: [], dates: [], month: null, end: null });

/** One of a month's days or weekdays as a list writes it, such as `3rd-day`, `last-fri` or `2nd-last-tue`. */
function parseItem(text: string): { nth: number; day: Weekday | null } | null {
  const item = MONTHLY.exec(text);
  if (!item) return null;
  const [, counted, last, what] = item;
  if (!counted && !last) return null;
  const nth = counted ? parseInt(counted, 10) : 1;
  // The last one has one spelling, so `1st-last-day` is not a second.
  if (counted && (counted !== ordinal(nth) || (last && nth === 1))) return null;
  if (nth < 1 || nth > (what === "day" ? 31 : 5)) return null;
  return { nth: last ? -nth : nth, day: what === "day" ? null : weekday(what!) };
}

/** What a rule picks out of each period, written without how often and without its end. */
function parsePicks(text: string, unit: Unit | null): Pick<Rule, "unit" | "days" | "dates" | "month"> | null {
  if ((unit ?? "w") === "w" && LIST.test(text)) {
    const days = text.split(",").map(weekday);
    // The days of a week alone read in any order, as they always have. Every newer list has one order.
    const ordered = unit === null ? new Set(days).size === days.length : rising(days.map(inWeek));
    return ordered ? { unit: "w", days: days.sort((a, b) => inWeek(a) - inWeek(b)).map((day) => ({ nth: 0, day })), dates: [], month: null } : null;
  }
  if ((unit ?? "m") === "m") {
    const items = text.split(",").map(parseItem);
    if (items.every((item) => item !== null)) {
      const dates = items.filter((item) => item.day === null).map((item) => item.nth);
      const days = items.flatMap((item) => (item.day === null ? [] : [{ nth: item.nth, day: item.day }]));
      if (dates.length && days.length) return null;
      return rising(dates.map(place)) && rising(days.map((d) => place(d.nth) * 7 + inWeek(d.day))) ? { unit: "m", days, dates, month: null } : null;
    }
  }
  if ((unit ?? "y") === "y") {
    const date = DATE.exec(text);
    // 2024 is a leap year, so `feb-29` is a date.
    if (date) return Number(date[2]) <= daysIn(2024, MONTHS.indexOf(date[1] as (typeof MONTHS)[number])) ? { unit: "y", days: [], dates: [Number(date[2])], month: MONTHS.indexOf(date[1] as (typeof MONTHS)[number]) + 1 } : null;
    const within = IN_MONTH.exec(text);
    const item = within && parseItem(within[1]!);
    if (item && item.day !== null) return { unit: "y", days: [{ nth: item.nth, day: item.day }], dates: [], month: MONTHS.indexOf(within![2] as (typeof MONTHS)[number]) + 1 };
  }
  return null;
}

/** The rule written as `text`, or null when it isn't one. */
export function parseRule(text: string): Rule | null {
  const ended = END.exec(text);
  const body = ended ? ended[1]! : text;
  const end: End | null = !ended ? null : ended[2] ? { until: ended[2] } : { times: Number(ended[3]) };
  if (end && "until" in end && !isDate(end.until)) return null;

  const interval = INTERVAL.exec(body);
  if (interval) return { ...blank(interval[2] as Unit, Number(interval[1])), from: interval[3] ? "done" : "due", end };

  const other = EVERY_OTHER.exec(body);
  // Every one is written with no number, so `1w-mon` is not a second spelling of `mon`.
  if (other && Number(other[1]) < 2) return null;
  const picks = other ? parsePicks(other[3]!, other[2] as Unit) : parsePicks(body, null);
  return picks && { ...picks, n: other ? Number(other[1]) : 1, from: "due", end };
}

const nthWritten = (nth: number) => (nth > 0 ? ordinal(nth) : nth === -1 ? "last" : `${ordinal(-nth)}-last`);

/** The rule as its token writes it, which `parseRule` reads back to the same rule. */
export function writeRule(rule: Rule): string {
  const end = !rule.end ? "" : "until" in rule.end ? `-until-${rule.end.until}` : `-times-${rule.end.times}`;
  const picks = written(rule);
  if (picks === null) return `${rule.n}${rule.unit}${rule.from === "done" ? "-after-done" : ""}${end}`;
  return `${rule.n === 1 ? "" : `${rule.n}${rule.unit}-`}${picks}${end}`;
}

function written(rule: Rule): string | null {
  if (rule.month !== null) return rule.dates.length ? `${MONTHS[rule.month - 1]}-${rule.dates[0]}` : `${nthWritten(rule.days[0]!.nth)}-${WEEKDAYS[rule.days[0]!.day]}-${MONTHS[rule.month - 1]}`;
  if (rule.dates.length) return [...rule.dates].sort((a, b) => place(a) - place(b)).map((nth) => `${nthWritten(nth)}-day`).join(",");
  if (!rule.days.length) return null;
  if (rule.unit === "w") return [...rule.days].sort((a, b) => inWeek(a.day) - inWeek(b.day)).map((d) => WEEKDAYS[d.day]).join(",");
  return [...rule.days].sort((a, b) => place(a.nth) * 7 + inWeek(a.day) - (place(b.nth) * 7 + inWeek(b.day))).map((d) => `${nthWritten(d.nth)}-${WEEKDAYS[d.day]}`).join(",");
}

/** Whether a rule picks no days of its own, and so is every so many days, weeks, months or years on. */
export const isInterval = (rule: Rule) => !rule.days.length && !rule.dates.length && rule.month === null;

/** The rule as it is after one of its times: one fewer of them left. A rule with no count is the same rule. */
export const counted = (rule: Rule): Rule => (rule.end && "times" in rule.end && rule.end.times > 1 ? { ...rule, end: { times: rule.end.times - 1 } } : rule);

const list = (items: readonly string[], and: string) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`);
const short = (name: string) => name.slice(0, 3);
const WORK_WEEK = "1,2,3,4,5";

/** What a rule picks, in words: "Mon, Thu", "the 1st & 3rd Tue", "the last day", "Mar 1", "the 1st Mon of Mar". */
function picked(rule: Rule, long: boolean): string {
  const name = (day: Weekday) => (long ? DAY_NAMES[day] : short(DAY_NAMES[day]));
  const and = long ? "and" : "&";
  const nth = (n: number) => nthWritten(n);
  if (rule.unit === "w") {
    const days = [...rule.days].sort((a, b) => inWeek(a.day) - inWeek(b.day)).map((d) => d.day);
    if (days.join() === WORK_WEEK) return "weekdays";
    return long ? list(days.map(name), and) : days.map(name).join(", ");
  }
  const month = rule.month === null ? "" : long ? MONTH_NAMES[rule.month - 1]! : short(MONTH_NAMES[rule.month - 1]!);
  if (rule.month !== null && rule.dates.length) return `${month} ${rule.dates[0]}`;
  if (rule.dates.length) {
    const dates = [...rule.dates].sort((a, b) => place(a) - place(b));
    return `the ${list(dates.map((d) => (d > 0 ? ordinal(d) : `${nth(d)} day`)), and)}`;
  }
  const days = [...rule.days].sort((a, b) => place(a.nth) * 7 + inWeek(a.day) - (place(b.nth) * 7 + inWeek(b.day)));
  const oneDay = days.every((d) => d.day === days[0]!.day);
  const words = oneDay ? `${list(days.map((d) => nth(d.nth)), and)} ${name(days[0]!.day)}` : list(days.map((d) => `${nth(d.nth)} ${name(d.day)}`), and);
  return `the ${words}${month && ` of ${month}`}`;
}

const dayWords = (day: string, long: boolean) => {
  const month = MONTH_NAMES[Number(day.slice(5, 7)) - 1]!;
  return long ? `${month} ${Number(day.slice(8, 10))}, ${Number(day.slice(0, 4))}` : `${short(month)} ${Number(day.slice(8, 10))}`;
};

/** How a rule ends, as its chip says it after the rule (" · 5 left", " · until Jun 30"), and "" for a rule with no end. */
export function endLabel(end: End | null): string {
  if (!end) return "";
  return "times" in end ? ` · ${end.times} left` : ` · until ${dayWords(end.until, false)}`;
}

/** How a person reads a rule on a chip: "every 2 weeks on Mon", "monthly on the 15th", "3 days after done · 5 left". */
export function ruleLabel(rule: Rule): string {
  const units = `${rule.n} ${UNIT_WORD[rule.unit]}${rule.n === 1 ? "" : "s"}`;
  const end = endLabel(rule.end);
  if (isInterval(rule)) return (rule.from === "done" ? `${units} after done` : rule.n === 1 ? `every ${UNIT_WORD[rule.unit]}` : `every ${units}`) + end;
  const picks = picked(rule, false);
  if (rule.unit === "w") return (rule.n === 1 ? `every ${picks === "weekdays" ? "weekday" : picks}` : `every ${units} on ${picks}`) + end;
  return `${rule.n === 1 ? (rule.unit === "m" ? "monthly" : "yearly") : `every ${units}`} on ${picks}${end}`;
}

/**
 * A rule as a sentence, for where it is set: "Every 2 weeks on Monday and Thursday, 5 more times".
 * With the todo's due date, a rule that takes its day from that date says which day that is.
 */
export function describeRule(rule: Rule, due: string | null = null): string {
  const units = `${rule.n} ${UNIT_WORD[rule.unit]}${rule.n === 1 ? "" : "s"}`;
  const every = rule.n === 1 ? `Every ${UNIT_WORD[rule.unit]}` : `Every ${units}`;
  const end = !rule.end ? "" : "until" in rule.end ? `, until ${dayWords(rule.end.until, true)}` : rule.end.times === 1 ? ", this is the last time" : `, ${rule.end.times} more times`;
  if (rule.from === "done") return `${rule.n === 1 ? `A ${UNIT_WORD[rule.unit]}` : units} after it's done${end}`;
  if (isInterval(rule)) return `${every}${due === null ? "" : fromDue(rule.unit, read(due))}${end}`;
  const picks = picked(rule, true);
  if (rule.unit === "w" && rule.n === 1 && picks === "weekdays") return `Every weekday${end}`;
  return `${every} on ${picks}${end}`;
}

/** The day a rule that picks none takes from the due date: " on Tuesday", " on the 6th", " on October 6". */
function fromDue(unit: Unit, due: number): string {
  const { month, date, weekday: day } = parts(due);
  if (unit === "d") return "";
  return unit === "w" ? ` on ${DAY_NAMES[day]}` : unit === "m" ? ` on the ${ordinal(date)}` : ` on ${MONTH_NAMES[month]} ${date}`;
}

/**
 * A calendar date as a count of days, so that adding to one is plain arithmetic. It is counted in
 * UTC, where every day is 24 hours long, which is what keeps a clock change from moving a date.
 */
const count = (year: number, month: number, date: number) => Date.UTC(year, month, date) / MS_PER_DAY;
const read = (day: string) => count(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const LAST = count(9999, 11, 31);
const write = (day: number) => (day > LAST ? null : new Date(day * MS_PER_DAY).toISOString().slice(0, 10));
const isDate = (day: string) => Number(day.slice(0, 4)) >= 1000 && write(read(day)) === day;

const parts = (day: number) => {
  const at = new Date(day * MS_PER_DAY);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth(), date: at.getUTCDate(), weekday: at.getUTCDay() as Weekday };
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

/**
 * The days a rule picks out of one month, in order. A day of the month the month doesn't have is
 * its nearest end, and a weekday it doesn't have, a fifth Friday, is passed over.
 */
function inMonth(rule: Rule, year: number, month: number): number[] {
  const length = daysIn(year, month);
  const first = parts(count(year, month, 1)).weekday;
  const dates = rule.dates.map((d) => (d > 0 ? Math.min(d, length) : Math.max(1, length + d + 1)));
  for (const { nth, day } of rule.days) {
    const start = 1 + ((day - first + 7) % 7);
    const last = start + 7 * Math.floor((length - start) / 7);
    const date = nth > 0 ? start + 7 * (nth - 1) : last + 7 * (nth + 1);
    if (date >= 1 && date <= length) dates.push(date);
  }
  return [...new Set(dates)].sort((a, b) => a - b).map((date) => count(year, month, date));
}

/**
 * Every day the rule gives in the `k`th period after the one `anchor` is in, a period being `n` of
 * the rule's units. Each is counted from the anchor and not from the one before, so a month's end
 * doesn't pull the ones after it earlier. Null once the period starts past the year 9999.
 */
function period(rule: Rule, anchor: number, k: number): number[] | null {
  const from = parts(anchor);
  if (isInterval(rule)) {
    const day = add(anchor, k * rule.n, rule.unit);
    return day > LAST ? null : [day];
  }
  if (rule.unit === "w") {
    const monday = anchor - inWeek(from.weekday) + 7 * k * rule.n;
    return monday > LAST ? null : rule.days.map((d) => monday + inWeek(d.day)).sort((a, b) => a - b);
  }
  const [year, month] = rule.unit === "m" ? [from.year, from.month + k * rule.n] : [from.year + k * rule.n, rule.month! - 1];
  return count(year, month, 1) > LAST ? null : inMonth(rule, year, month);
}

/** The most days a period of one unit can span, so a jump to the period before a day never passes it. */
const LONGEST: Record<Unit, number> = { d: 1, w: 7, m: 31, y: 366 };

function next(rule: Rule, due: number | null, done: number): number | null {
  if (rule.from === "done") return add(done, rule.n, rule.unit);
  const anchor = due ?? done;
  const after = Math.max(anchor, done);
  for (let k = Math.max(0, Math.floor((after - anchor) / (LONGEST[rule.unit] * rule.n)) - 1); ; k++) {
    const days = period(rule, anchor, k);
    if (!days) return null;
    const day = days.find((d) => d > after);
    if (day !== undefined) return day;
  }
}

/**
 * The next due date of a todo due on `due` and checked off on `done`, or null when there is none:
 * it would be past the year 9999, or the rule has ended, this being its last time or the next one
 * falling after the day it runs until. A rule counted from the due date skips the occurrences
 * already missed, and gives the first of its days after both dates.
 */
export function nextDue(rule: Rule, at: { due: string | null; done: string }): string | null {
  if (rule.end && "times" in rule.end && rule.end.times <= 1) return null;
  const day = next(rule, at.due === null ? null : read(at.due), read(at.done));
  if (day === null || (rule.end && "until" in rule.end && day > read(rule.end.until))) return null;
  return write(day);
}

/**
 * The due date a todo moves to when its occurrence is skipped on the day `on`: the next one, as if
 * it had been done on the later of its due date and that day. Null when there is no later one.
 */
export const skippedTo = (rule: Rule, at: { due: string | null; on: string }): string | null => nextDue(rule, { due: at.due, done: at.due !== null && at.due > at.on ? at.due : at.on });

/** The next `most` due dates of a todo due on `due`, each checked off on the day it is due, or as many as the rule has left. */
export function occurrences(rule: Rule, due: string, most: number): string[] {
  const days: string[] = [];
  let at = due;
  for (let left = rule; days.length < most; left = counted(left)) {
    const following = nextDue(left, { due: at, done: at });
    if (following === null) break;
    days.push((at = following));
  }
  return days;
}

/**
 * The days past the 28th that a rule of months lands on, which shorter months don't have, and the
 * same rule on the last day of the month in their place. A rule that takes its day from the due
 * date `drifts`: a shorter month's last day becomes the due date, and stays the day from then on.
 * Null for a rule that lands on none.
 */
export function pastThe28th(rule: Rule, due: string | null = null): { days: number[]; drifts: boolean; lastDay: Rule } | null {
  if (rule.unit !== "m" || rule.from !== "due" || rule.days.length) return null;
  const drifts = !rule.dates.length;
  const dueDay = due === null ? 0 : Number(due.slice(8, 10));
  const days = drifts ? (dueDay > 28 ? [dueDay] : []) : rule.dates.filter((d) => d > 28);
  if (!days.length) return null;
  return { days, drifts, lastDay: { ...rule, dates: [...new Set([...rule.dates.filter((d) => d <= 28 && d !== -1), -1])].sort((a, b) => place(a) - place(b)) } };
}

/** The grammar of a rule as a short table, for a model that is to write one unaided. docs/todos.md says the same to a person. */
export const RULE_GRAMMAR = [
  "3d 2w 1m 1y: every N days, weeks, months or years after the due date (N 1 to 999)",
  "3d-after-done: N after the day it was last checked off",
  "mon,thu: those days of every week (mon tue wed thu fri sat sun, in that order); 2w-mon,thu: of every 2nd week",
  "15th-day last-day 2nd-last-day: that day of every month; 2nd-tue last-fri 2nd-last-fri: that weekday of every month",
  "1st-day,15th-day or 1st-tue,3rd-tue: several of either, in order; 3m-last-fri: of every 3rd month",
  "mar-1: that date every year; 1st-mon-mar: that weekday of that month; 2y-mar-1: every 2nd year",
  "any rule then -until-2026-12-31 (none after that day) or -times-5 (5 more times, counting the one due now)",
].join("\n");
