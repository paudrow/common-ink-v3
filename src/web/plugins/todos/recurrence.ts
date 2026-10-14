import { counted, describeRule, isDay, nextDue, ordinal, parseRule, ruleLabel, writeRule, type End, type LastDone, type Rule, type Unit, type Weekday } from "../../plugin-api.ts";
import { dueLabel } from "./dates.ts";

/** What a recurrence chip says: the rule in a few plain words, or the token as written when it isn't a rule. */
export const everyLabel = (written: string) => {
  const rule = parseRule(written);
  return rule ? ruleLabel(rule) : written;
};

/** What a recurrence chip is called, for a title and a screen reader. */
export const everyName = (written: string | null) => {
  const rule = written === null ? null : parseRule(written);
  return rule ? `Recurs: ${describeRule(rule)}` : "Doesn't recur";
};

/** What a last-done chip says: the day beside today, and how many times. */
export const doneLabel = (done: LastDone, now: string) => `✓ ${dueLabel(done.on, now)} ×${done.times}`;

export const doneName = (done: LastDone, now: string) => `Last done ${dueLabel(done.on, now)}, ${done.times} ${done.times === 1 ? "time" : "times"}`;

/** The rules a click sets, first in the editor of a rule. */
export const PICKS: readonly { label: string; every: string }[] = [
  { label: "Daily", every: "1d" },
  { label: "Every weekday", every: "mon,tue,wed,thu,fri" },
  { label: "Weekly", every: "1w" },
  { label: "Every 2 weeks", every: "2w" },
  { label: "Monthly", every: "1m" },
  { label: "Yearly", every: "1y" },
];

/** The days of a week in the order a rule writes them, Monday first. */
export const WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
export const UNITS: readonly (readonly [Unit, one: string, many: string])[] = [["d", "day", "days"], ["w", "week", "weeks"], ["m", "month", "months"], ["y", "year", "years"]];

const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
/** The days of a month a rule can name: from its start, then from its end. */
export const DATES: readonly (readonly [date: number, label: string])[] = [...upTo(31).map((n) => [n, ordinal(n)] as const), [-1, "last day"], ...upTo(30).map((n) => [-n - 1, `${ordinal(n + 1)}-last day`] as const)];
/** Which of a weekday in its month a rule can name. */
export const NTHS: readonly (readonly [nth: number, label: string])[] = [...upTo(5).map((n) => [n, ordinal(n)] as const), [-1, "last"], ...upTo(4).map((n) => [-n - 1, `${ordinal(n + 1)}-last`] as const)];

export interface NthWeekday {
  nth: number;
  day: Weekday;
}

/**
 * The editor of a rule, as a sentence being built: "Every [n] [unit]", then what a week, a month or
 * a year picks, where it is counted from, and how it ends. It holds every unit's picks at once, so
 * choosing another unit and coming back finds what was there, and `unit` says which of them the
 * rule is made from. Every rule the grammar writes has a form, and `ruleOf` gives it back.
 */
export interface RuleForm {
  /** Not a whole number from 1 to 999 while the field is being typed in. */
  n: number;
  unit: Unit;
  /** Of a week. None is the due date's own day. */
  weekdays: readonly Weekday[];
  /** Of a month: the due date's day, days of the month, or weekdays of it. */
  monthOn: "due" | "dates" | "weekdays";
  dates: readonly number[];
  nths: readonly NthWeekday[];
  /** Of a year: the due date's day, a date, or a weekday of a month. */
  yearOn: "due" | "date" | "weekday";
  month: number;
  date: number;
  yearNth: NthWeekday;
  from: Rule["from"];
  ends: "never" | "until" | "times";
  until: string;
  times: number;
}

/** The form as it opens on a todo that recurs by `rule`, or on one that doesn't. `day` is its due date, or today, which the picks not yet made start from. */
export function formOf(rule: Rule | null, day: string): RuleForm {
  const at = new Date(`${day}T00:00:00Z`);
  const [month, date, weekday] = [at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCDay() as Weekday];
  const nth = { nth: Math.ceil(date / 7), day: weekday };
  const form: RuleForm = { n: 1, unit: "w", weekdays: [], monthOn: "due", dates: [date], nths: [nth], yearOn: "due", month, date, yearNth: nth, from: "due", ends: "never", until: "", times: 5 };
  if (!rule) return form;
  const set: RuleForm = { ...form, n: rule.n, unit: rule.unit, from: rule.from, ...(rule.end && ("until" in rule.end ? { ends: "until", until: rule.end.until } : { ends: "times", times: rule.end.times })) };
  if (rule.unit === "w") return { ...set, weekdays: rule.days.map((d) => d.day) };
  if (rule.month !== null) return rule.dates.length ? { ...set, yearOn: "date", month: rule.month, date: rule.dates[0]! } : { ...set, yearOn: "weekday", month: rule.month, yearNth: rule.days[0]! };
  if (rule.dates.length) return { ...set, monthOn: "dates", dates: rule.dates };
  if (rule.days.length) return { ...set, monthOn: "weekdays", nths: rule.days };
  return set;
}

const whole = (n: number, least: number, most: number) => Number.isInteger(n) && n >= least && n <= most;
/** How many days a month has at its longest, so February has 29. */
export const daysInMonth = (month: number) => new Date(Date.UTC(2024, month, 0)).getUTCDate();

/** Whether the form names its own days, and so can only count from the due date. */
export const namesDays = (form: RuleForm) => (form.unit === "w" && form.weekdays.length > 0) || (form.unit === "m" && form.monthOn !== "due") || (form.unit === "y" && form.yearOn !== "due");

/** The rule the form says, or null while it doesn't say one: a number out of range, a date that isn't one, or no day left in a list. */
export function ruleOf(form: RuleForm): Rule | null {
  if (!whole(form.n, 1, 999)) return null;
  let end: End | null = null;
  if (form.ends === "until") {
    if (!isDay(form.until)) return null;
    end = { until: form.until };
  } else if (form.ends === "times") {
    if (!whole(form.times, 1, 999)) return null;
    end = { times: form.times };
  }
  const picked = picks(form);
  // Written and read back, which puts each list in its one order.
  return picked && parseRule(writeRule({ unit: form.unit, n: form.n, from: namesDays(form) ? "due" : form.from, days: [], dates: [], month: null, end, ...picked }));
}

function picks(form: RuleForm): Partial<Rule> | null {
  if (!namesDays(form)) return {};
  if (form.unit === "w") return { days: form.weekdays.map((day) => ({ nth: 0, day })) };
  if (form.unit === "m") {
    if (form.monthOn === "dates") return form.dates.length ? { dates: [...new Set(form.dates)] } : null;
    const nths = form.nths.filter((a, i) => form.nths.findIndex((b) => b.nth === a.nth && b.day === a.day) === i);
    return nths.length ? { days: nths } : null;
  }
  if (form.yearOn === "date") return whole(form.date, 1, daysInMonth(form.month)) ? { month: form.month, dates: [form.date] } : null;
  return { month: form.month, days: [form.yearNth] };
}

/** What the form's rule is written as after `every:`, or null while it says none. */
export function everyOf(form: RuleForm): string | null {
  const rule = ruleOf(form);
  return rule && writeRule(rule);
}

/** The form with one day of the week picked or put back. */
export const toggledDay = (form: RuleForm, day: Weekday): RuleForm => ({ ...form, weekdays: form.weekdays.includes(day) ? form.weekdays.filter((d) => d !== day) : [...form.weekdays, day] });

/** The form with another day of the month in its list: the first it doesn't have yet. */
export const anotherDate = (form: RuleForm): RuleForm => ({ ...form, dates: [...form.dates, DATES.find(([date]) => !form.dates.includes(date))?.[0] ?? 1] });

/** The form with another weekday of the month in its list: the same day of the week, the first time in the month it isn't there yet. */
export function anotherNth(form: RuleForm): RuleForm {
  const day = form.nths.at(-1)?.day ?? 1;
  const nth = NTHS.find(([nth]) => !form.nths.some((had) => had.nth === nth && had.day === day))?.[0] ?? 1;
  return { ...form, nths: [...form.nths, { nth, day }] };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as a preview says it: "Nov 3", and the year too when it isn't this one. */
export const shortDay = (day: string, now: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}${day.slice(0, 4) === now.slice(0, 4) ? "" : `, ${day.slice(0, 4)}`}`;

/**
 * The next few days a todo would be due on by `rule`: after the one it is due on now, or, for a rule
 * counted from the day it was done, a todo with no due date and one that is overdue, if it were done
 * today. Fewer than `most` when the rule ends first, and none when this is its last time. `never`
 * is a rule with no end that has no day to come round on, such as a fifth Friday of February.
 */
export function preview(rule: Rule, due: string | null, now: string, most = 3): { lead: string; days: string[]; never: boolean } {
  const today = rule.from === "done" || due === null || due < now;
  const days: string[] = [];
  let at = nextDue(rule, { due, done: today ? now : due });
  for (let left = counted(rule); at !== null && days.length < most; left = counted(left)) {
    days.push(at);
    at = nextDue(left, { due: at, done: at });
  }
  return { lead: today ? "If done today:" : "After this one:", days: days.map((day) => shortDay(day, now)), never: !days.length && rule.end === null };
}

/** The rules offered while a member types `every:`, narrowed by what they have typed. */
export function everyOffers(typed: string): { label: string; every: string }[] {
  const offers = [...PICKS, { label: "Last day of the month", every: "last-day" }, { label: "A week after it was done", every: "1w-after-done" }];
  const wanted = typed.trim().toLowerCase();
  return offers.filter((offer) => offer.label.toLowerCase().includes(wanted) || offer.every.startsWith(wanted));
}
