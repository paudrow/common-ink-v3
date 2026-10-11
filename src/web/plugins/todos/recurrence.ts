import { describeRule, parseRule, writeRule, type LastDone, type Rule, type Unit, type Weekday } from "../../plugin-api.ts";
import { dueLabel } from "./dates.ts";

/** What a recurrence chip says: the rule as its token writes it, which is always narrower than the token. */
export const everyLabel = (written: string) => `↻ ${written}`;

/** What a recurrence chip is called, for a title and a screen reader. */
export const everyName = (written: string | null) => {
  const rule = written === null ? null : parseRule(written);
  return rule ? `Recurs: ${describeRule(rule)}` : "Doesn't recur";
};

/** What a last-done chip says: the day beside today, and how many times. */
export const doneLabel = (done: LastDone, now: string) => `✓ ${dueLabel(done.on, now)} ×${done.times}`;

export const doneName = (done: LastDone, now: string) => `Last done ${dueLabel(done.on, now)}, ${done.times} ${done.times === 1 ? "time" : "times"}`;

/** The rules offered first, each one click. */
export const SIMPLE: readonly { label: string; every: string }[] = [
  { label: "Every day", every: "1d" },
  { label: "Every week", every: "1w" },
  { label: "Every 2 weeks", every: "2w" },
  { label: "Every month", every: "1m" },
  { label: "Every year", every: "1y" },
  { label: "Weekdays, Mon to Fri", every: "mon,tue,wed,thu,fri" },
];

/** The days of a week in the order a rule writes them, Monday first. */
export const WEEK: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const UNITS: readonly (readonly [Unit, string])[] = [["d", "days"], ["w", "weeks"], ["m", "months"], ["y", "years"]];
export const COUNTED: readonly (readonly [Interval["after"], string])[] = [["schedule", "from the due date"], ["done", "from the day it was done"]];

type Interval = Extract<Rule, { kind: "interval" }>;
export type Kind = Rule["kind"];

/**
 * The form a rule is set with. It holds every kind's fields at once, so choosing another kind and
 * coming back finds what was there, and `kind` says which of them the rule is made from. Null is a
 * todo that doesn't recur, before a kind is chosen.
 */
export interface RuleForm {
  kind: Kind | null;
  n: number;
  unit: Unit;
  after: Interval["after"];
  days: readonly Weekday[];
  monthDay: number;
  monthDayFromEnd: boolean;
  nth: number;
  nthFromEnd: boolean;
  weekday: Weekday;
}

const BLANK: RuleForm = { kind: null, n: 1, unit: "w", after: "schedule", days: [], monthDay: 1, monthDayFromEnd: false, nth: 1, nthFromEnd: false, weekday: 1 };

/** The form as it opens on a todo that recurs by `rule`, or on one that doesn't. */
export function formOf(rule: Rule | null): RuleForm {
  switch (rule?.kind) {
    case undefined:
      return BLANK;
    case "interval":
      return { ...BLANK, kind: rule.kind, n: rule.n, unit: rule.unit, after: rule.after };
    case "weekdays":
      return { ...BLANK, kind: rule.kind, days: rule.days };
    case "monthDay":
      return { ...BLANK, kind: rule.kind, monthDay: rule.nth, monthDayFromEnd: rule.fromEnd };
    case "monthWeekday":
      return { ...BLANK, kind: rule.kind, nth: rule.nth, nthFromEnd: rule.fromEnd, weekday: rule.day };
  }
}

const whole = (n: number, least: number, most: number) => Number.isInteger(n) && n >= least && n <= most;

/** The rule the form says, or null while it doesn't say one: no kind chosen, no day of the week picked, or a number out of range. */
export function ruleOf(form: RuleForm): Rule | null {
  switch (form.kind) {
    case null:
      return null;
    case "interval":
      return whole(form.n, 1, 999) ? { kind: "interval", n: form.n, unit: form.unit, after: form.after } : null;
    case "weekdays":
      return form.days.length ? { kind: "weekdays", days: WEEK.filter((day) => form.days.includes(day)) } : null;
    case "monthDay":
      return whole(form.monthDay, 1, 31) ? { kind: "monthDay", nth: form.monthDay, fromEnd: form.monthDayFromEnd } : null;
    case "monthWeekday":
      return whole(form.nth, 1, 5) ? { kind: "monthWeekday", nth: form.nth, fromEnd: form.nthFromEnd, day: form.weekday } : null;
  }
}

/** What the form's rule is written as after `every:`, or null while it says none. */
export function everyOf(form: RuleForm): string | null {
  const rule = ruleOf(form);
  return rule && writeRule(rule);
}

/** The form with one day of the week picked or put back, which makes it a rule of weekdays. */
export const toggledDay = (form: RuleForm, day: Weekday): RuleForm => ({ ...form, kind: "weekdays", days: form.days.includes(day) ? form.days.filter((d) => d !== day) : [...form.days, day] });

/** The rules offered while a member types `every:`, narrowed by what they have typed. */
export function everyOffers(typed: string): { label: string; every: string }[] {
  const offers = [...SIMPLE, { label: "Last day of the month", every: "last-day" }, { label: "A week after it was done", every: "1w-after-done" }];
  const wanted = typed.trim().toLowerCase();
  return offers.filter((offer) => offer.label.toLowerCase().includes(wanted) || offer.every.startsWith(wanted));
}
