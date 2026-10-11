// Every date here is a calendar date written YYYY-MM-DD, never an instant, so no time zone can move it.
import { describe, expect, it } from "vitest";
import { RULE_PATTERN, WEEKDAYS, describeRule, nextDue, parseRule, writeRule, type Rule } from "../../src/core/recurrence.ts";

const rule = (text: string): Rule => {
  const parsed = parseRule(text);
  if (!parsed) throw new Error(`${text} isn't a rule`);
  return parsed;
};

/** Each result fed back as both the due date and the day it was done. */
const walk = (text: string, from: string, steps: number) => {
  const days: (string | null)[] = [];
  let day: string | null = from;
  for (let i = 0; i < steps && day !== null; i++) days.push((day = nextDue(rule(text), { due: day, done: day })));
  return days;
};

describe("a rule as written", () => {
  /** What is written, the rule it is, and what it is written back as when that differs. */
  const GRAMMAR: [written: string, rule: Rule, back?: string][] = [
    ["3d", { kind: "interval", n: 3, unit: "d", after: "schedule" }],
    ["2w", { kind: "interval", n: 2, unit: "w", after: "schedule" }],
    ["1m", { kind: "interval", n: 1, unit: "m", after: "schedule" }],
    ["1y", { kind: "interval", n: 1, unit: "y", after: "schedule" }],
    ["999d", { kind: "interval", n: 999, unit: "d", after: "schedule" }],
    ["10w", { kind: "interval", n: 10, unit: "w", after: "schedule" }],
    ["3d-after-done", { kind: "interval", n: 3, unit: "d", after: "done" }],
    ["2y-after-done", { kind: "interval", n: 2, unit: "y", after: "done" }],
    ["mon", { kind: "weekdays", days: [1] }],
    ["sun", { kind: "weekdays", days: [0] }],
    ["mon,thu", { kind: "weekdays", days: [1, 4] }],
    ["thu,mon", { kind: "weekdays", days: [1, 4] }, "mon,thu"],
    ["sun,sat,mon", { kind: "weekdays", days: [1, 6, 0] }, "mon,sat,sun"],
    ["mon,tue,wed,thu,fri,sat,sun", { kind: "weekdays", days: [1, 2, 3, 4, 5, 6, 0] }],
    ["1st-day", { kind: "monthDay", nth: 1, fromEnd: false }],
    ["2nd-day", { kind: "monthDay", nth: 2, fromEnd: false }],
    ["3rd-day", { kind: "monthDay", nth: 3, fromEnd: false }],
    ["4th-day", { kind: "monthDay", nth: 4, fromEnd: false }],
    ["10th-day", { kind: "monthDay", nth: 10, fromEnd: false }],
    ["11th-day", { kind: "monthDay", nth: 11, fromEnd: false }],
    ["12th-day", { kind: "monthDay", nth: 12, fromEnd: false }],
    ["13th-day", { kind: "monthDay", nth: 13, fromEnd: false }],
    ["20th-day", { kind: "monthDay", nth: 20, fromEnd: false }],
    ["21st-day", { kind: "monthDay", nth: 21, fromEnd: false }],
    ["22nd-day", { kind: "monthDay", nth: 22, fromEnd: false }],
    ["23rd-day", { kind: "monthDay", nth: 23, fromEnd: false }],
    ["30th-day", { kind: "monthDay", nth: 30, fromEnd: false }],
    ["31st-day", { kind: "monthDay", nth: 31, fromEnd: false }],
    ["last-day", { kind: "monthDay", nth: 1, fromEnd: true }],
    ["2nd-last-day", { kind: "monthDay", nth: 2, fromEnd: true }],
    ["31st-last-day", { kind: "monthDay", nth: 31, fromEnd: true }],
    ["1st-mon", { kind: "monthWeekday", nth: 1, fromEnd: false, day: 1 }],
    ["2nd-tue", { kind: "monthWeekday", nth: 2, fromEnd: false, day: 2 }],
    ["5th-sun", { kind: "monthWeekday", nth: 5, fromEnd: false, day: 0 }],
    ["last-fri", { kind: "monthWeekday", nth: 1, fromEnd: true, day: 5 }],
    ["2nd-last-fri", { kind: "monthWeekday", nth: 2, fromEnd: true, day: 5 }],
    ["5th-last-mon", { kind: "monthWeekday", nth: 5, fromEnd: true, day: 1 }],
  ];

  it.each(GRAMMAR)("%s is read, and written back the same", (written, expected, back) => {
    expect(parseRule(written)).toEqual(expected);
    expect(writeRule(expected)).toBe(back ?? written);
  });

  it("names the weekdays by their number, Sunday first", () => {
    expect(WEEKDAYS).toEqual(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  });

  const REFUSED = [
    "",
    "0d",
    "01d",
    "1000d",
    "3x",
    "3",
    "d",
    "3D",
    "3d ",
    " 3d",
    "-3d",
    "3d-after",
    "3d-after-foo",
    "3d-after-due",
    "3d-after-schedule",
    "3d-after-done-",
    "mon,mon",
    "mon,thu,mon",
    "mon,",
    ",mon",
    "mon, thu",
    "mon thu",
    "Mon",
    "monday",
    "day",
    "2th-day",
    "11st-day",
    "12nd-day",
    "13rd-day",
    "1th-day",
    "21th-day",
    "03rd-day",
    "32nd-day",
    "0th-day",
    "3rd",
    "3rd-",
    "3-day",
    "6th-tue",
    "0th-tue",
    "6th-last-tue",
    "32nd-last-day",
    "1st-last-day",
    "1st-last-fri",
    "last",
    "last-",
    "last-last-day",
    "2nd-last",
    "every",
    "every:3d",
  ];

  it.each(REFUSED)("%j is not a rule", (written) => {
    expect(parseRule(written)).toBe(null);
  });

  it("is matched in full by the pattern the todo line's token is built from", () => {
    const whole = new RegExp(`^${RULE_PATTERN}$`);
    expect(GRAMMAR.filter(([written]) => !whole.test(written)).map(([written]) => written)).toEqual([]);
  });

  /** A line, and the rule its `every:` token holds. */
  const TOKENS: [line: string, rule: string | null][] = [
    ["a every:mon, b", "mon"],
    ["a every:mon,thu, b", "mon,thu"],
    ["a every:2w.", "2w"],
    ["a every:3d-after-done)", "3d-after-done"],
    ["a every:2nd-last-fri", "2nd-last-fri"],
    ["a every:last-day; b", "last-day"],
    ["a every:31st-day!", "31st-day"],
    ["a every:3d-after-foo", null],
    ["a every:monday", null],
    ["a every:3days", null],
    ["a every: 3d", null],
    ["severy:3d", null],
  ];

  it.each(TOKENS)("in %j the token holds %j", (line, expected) => {
    const token = new RegExp("(?<=\\s)every:(" + RULE_PATTERN + ")(?=$|[\\s.,;:!?)])", "g");
    const found = [...line.matchAll(token)];
    expect(found.map((match) => match[1])).toEqual(expected === null ? [] : [expected]);
    expect(found.map((match) => match[0])).toEqual(expected === null ? [] : [`every:${expected}`]);
    expect(found.every((match) => match.length === 2)).toBe(true);
  });
});

describe("a rule in words", () => {
  const WORDS: [written: string, words: string][] = [
    ["1d", "Every day"],
    ["1w", "Every week"],
    ["1m", "Every month"],
    ["1y", "Every year"],
    ["3d", "Every 3 days"],
    ["2w", "Every 2 weeks"],
    ["6m", "Every 6 months"],
    ["10y", "Every 10 years"],
    ["3d-after-done", "3 days after done"],
    ["1d-after-done", "1 day after done"],
    ["1y-after-done", "1 year after done"],
    ["mon", "Mon"],
    ["thu,mon", "Mon, Thu"],
    ["sun,sat", "Sat, Sun"],
    ["mon,tue,wed,thu,fri,sat,sun", "Mon, Tue, Wed, Thu, Fri, Sat, Sun"],
    ["1st-day", "1st day of the month"],
    ["3rd-day", "3rd day of the month"],
    ["22nd-day", "22nd day of the month"],
    ["last-day", "Last day of the month"],
    ["2nd-last-day", "2nd-last day of the month"],
    ["2nd-tue", "2nd Tue of the month"],
    ["5th-sun", "5th Sun of the month"],
    ["last-fri", "Last Fri of the month"],
    ["3rd-last-wed", "3rd-last Wed of the month"],
  ];

  it.each(WORDS)("%s reads %s", (written, words) => {
    expect(describeRule(rule(written))).toBe(words);
  });
});

describe("the next due date", () => {
  /** A rule, the due date, the day it was done, and the next due date. October 2026 starts on a Thursday. */
  type Row = [written: string, due: string | null, done: string, next: string | null];

  const INTERVALS: Row[] = [
    // On time, early, late by several periods, and with no due date, for each unit and each thing to count from.
    ["3d", "2026-10-10", "2026-10-10", "2026-10-13"],
    ["3d", "2026-10-10", "2026-10-08", "2026-10-13"],
    ["3d", "2026-10-10", "2026-10-20", "2026-10-22"],
    ["3d", null, "2026-10-10", "2026-10-13"],
    ["3d-after-done", "2026-10-10", "2026-10-10", "2026-10-13"],
    ["3d-after-done", "2026-10-10", "2026-10-08", "2026-10-11"],
    ["3d-after-done", "2026-10-10", "2026-10-20", "2026-10-23"],
    ["3d-after-done", null, "2026-10-10", "2026-10-13"],

    ["2w", "2026-10-05", "2026-10-05", "2026-10-19"],
    ["2w", "2026-10-05", "2026-10-01", "2026-10-19"],
    ["2w", "2026-10-05", "2026-11-20", "2026-11-30"],
    ["2w", null, "2026-10-10", "2026-10-24"],
    ["2w-after-done", "2026-10-05", "2026-10-05", "2026-10-19"],
    ["2w-after-done", "2026-10-05", "2026-10-01", "2026-10-15"],
    ["2w-after-done", "2026-10-05", "2026-11-20", "2026-12-04"],
    ["2w-after-done", null, "2026-10-10", "2026-10-24"],

    ["1m", "2026-10-15", "2026-10-15", "2026-11-15"],
    ["1m", "2026-10-15", "2026-10-01", "2026-11-15"],
    ["1m", "2026-10-15", "2027-02-20", "2027-03-15"],
    ["1m", null, "2026-10-11", "2026-11-11"],
    ["1m-after-done", "2026-10-15", "2026-10-15", "2026-11-15"],
    ["1m-after-done", "2026-10-15", "2026-10-01", "2026-11-01"],
    ["1m-after-done", "2026-10-15", "2027-02-20", "2027-03-20"],
    ["1m-after-done", null, "2026-10-11", "2026-11-11"],

    ["1y", "2026-10-15", "2026-10-15", "2027-10-15"],
    ["1y", "2026-10-15", "2026-10-01", "2027-10-15"],
    ["1y", "2026-10-15", "2029-11-01", "2030-10-15"],
    ["1y", null, "2026-10-11", "2027-10-11"],
    ["1y-after-done", "2026-10-15", "2026-10-15", "2027-10-15"],
    ["1y-after-done", "2026-10-15", "2026-10-01", "2027-10-01"],
    ["1y-after-done", "2026-10-15", "2029-11-01", "2030-11-01"],
    ["1y-after-done", null, "2026-10-11", "2027-10-11"],

    // Done on the day of a later occurrence: the one after it is next.
    ["3d", "2026-10-10", "2026-10-13", "2026-10-16"],
    ["3d", "2026-10-10", "2026-10-12", "2026-10-13"],
  ];

  const MONTH_ENDS: Row[] = [
    ["1m", "2026-01-31", "2026-01-31", "2026-02-28"],
    ["1m", "2028-01-31", "2028-01-31", "2028-02-29"],
    ["1m", "2026-03-31", "2026-03-31", "2026-04-30"],
    ["1m", "2026-05-30", "2026-05-30", "2026-06-30"],
    ["6m", "2026-08-31", "2026-08-31", "2027-02-28"],
    ["1m-after-done", null, "2026-05-31", "2026-06-30"],
    // Catching up counts from the due date, so March is the 31st and not the 28th February left it on.
    ["1m", "2026-01-31", "2026-03-01", "2026-03-31"],
    ["1m", "2026-01-31", "2026-02-28", "2026-03-31"],
    ["1m", "2026-01-31", "2026-02-27", "2026-02-28"],
    ["1m", "2026-01-31", "2026-04-30", "2026-05-31"],
  ];

  const LEAP_YEARS: Row[] = [
    ["1d", "2028-02-28", "2028-02-28", "2028-02-29"],
    ["1d", "2026-02-28", "2026-02-28", "2026-03-01"],
    ["1y", "2028-02-29", "2028-02-29", "2029-02-28"],
    ["4y", "2028-02-29", "2028-02-29", "2032-02-29"],
    ["1y", "2028-02-29", "2031-06-01", "2032-02-29"],
    ["1y", "2027-02-28", "2027-02-28", "2028-02-28"],
    // 2100 is not a leap year.
    ["1d", "2100-02-28", "2100-02-28", "2100-03-01"],
    ["1m", "2100-01-31", "2100-01-31", "2100-02-28"],
    ["4y", "2096-02-29", "2096-02-29", "2100-02-28"],
    ["8y", "2096-02-29", "2096-02-29", "2104-02-29"],
    ["1y", "2000-02-29", "2000-02-29", "2001-02-28"],
  ];

  const YEAR_BOUNDARIES: Row[] = [
    ["1d", "2026-12-31", "2026-12-31", "2027-01-01"],
    ["1m", "2026-12-15", "2026-12-15", "2027-01-15"],
    ["1w", "2026-12-28", "2026-12-28", "2027-01-04"],
    ["2m", "2026-11-30", "2026-11-30", "2027-01-30"],
    ["3m", "2026-11-30", "2026-11-30", "2027-02-28"],
    ["14m", "2026-11-15", "2026-11-15", "2028-01-15"],
    ["3d-after-done", "2026-12-01", "2026-12-30", "2027-01-02"],
  ];

  const WEEKDAY_SETS: Row[] = [
    // Due on the very day it names: a week on.
    ["mon", "2026-10-12", "2026-10-12", "2026-10-19"],
    ["mon,thu", "2026-10-12", "2026-10-12", "2026-10-15"],
    ["mon,thu", "2026-10-15", "2026-10-15", "2026-10-19"],
    ["sat,sun", "2026-10-10", "2026-10-10", "2026-10-11"],
    ["sat,sun", "2026-10-11", "2026-10-11", "2026-10-17"],
    ["mon,tue,wed,thu,fri,sat,sun", "2026-10-11", "2026-10-11", "2026-10-12"],
    // Done early: after the due date. Done late: after the day it was done.
    ["mon,thu", "2026-10-15", "2026-10-13", "2026-10-19"],
    ["mon,thu", "2026-10-12", "2026-10-21", "2026-10-22"],
    ["mon,thu", "2026-10-12", "2026-10-22", "2026-10-26"],
    ["mon,thu", null, "2026-10-11", "2026-10-12"],
    ["wed", null, "2026-10-14", "2026-10-21"],
    ["fri", "2026-12-25", "2026-12-25", "2027-01-01"],
  ];

  const MONTH_DAYS: Row[] = [
    ["3rd-day", "2026-10-01", "2026-10-01", "2026-10-03"],
    ["3rd-day", "2026-10-03", "2026-10-03", "2026-11-03"],
    ["3rd-day", "2026-10-03", "2026-10-20", "2026-11-03"],
    ["3rd-day", "2026-11-03", "2026-10-20", "2026-12-03"],
    ["3rd-day", null, "2026-10-02", "2026-10-03"],
    ["3rd-day", "2026-12-03", "2026-12-03", "2027-01-03"],
    ["31st-day", "2026-01-31", "2026-01-31", "2026-02-28"],
    ["31st-day", "2026-02-28", "2026-02-28", "2026-03-31"],
    ["31st-day", "2026-03-31", "2026-03-31", "2026-04-30"],
    ["31st-day", "2026-04-30", "2026-04-30", "2026-05-31"],
    ["31st-day", "2028-01-31", "2028-01-31", "2028-02-29"],
    ["30th-day", "2026-01-30", "2026-01-30", "2026-02-28"],
    ["last-day", "2026-01-31", "2026-01-31", "2026-02-28"],
    ["last-day", "2026-02-28", "2026-02-28", "2026-03-31"],
    ["last-day", "2028-01-31", "2028-01-31", "2028-02-29"],
    ["last-day", "2028-02-28", "2028-02-28", "2028-02-29"],
    ["last-day", "2026-12-31", "2026-12-31", "2027-01-31"],
    ["last-day", null, "2026-02-10", "2026-02-28"],
    ["2nd-last-day", null, "2026-02-10", "2026-02-27"],
    ["2nd-last-day", "2026-02-27", "2026-02-27", "2026-03-30"],
    ["2nd-last-day", null, "2028-02-01", "2028-02-28"],
    ["2nd-last-day", null, "2026-04-29", "2026-05-30"],
    // Counted from the end, the 31st-last day of January is its 1st, and of a shorter month the 1st too.
    ["31st-last-day", null, "2026-01-15", "2026-02-01"],
    ["31st-last-day", "2026-02-01", "2026-02-01", "2026-03-01"],
    ["31st-last-day", "2026-03-01", "2026-03-01", "2026-04-01"],
    ["31st-last-day", null, "2028-01-15", "2028-02-01"],
    ["30th-last-day", null, "2026-01-01", "2026-01-02"],
    ["30th-last-day", "2026-01-02", "2026-01-02", "2026-02-01"],
  ];

  const MONTH_WEEKDAYS: Row[] = [
    ["2nd-tue", null, "2026-10-01", "2026-10-13"],
    ["2nd-tue", null, "2026-10-12", "2026-10-13"],
    ["2nd-tue", "2026-10-13", "2026-10-13", "2026-11-10"],
    ["2nd-tue", "2026-10-13", "2026-11-10", "2026-12-08"],
    ["2nd-tue", "2026-12-08", "2026-12-08", "2027-01-12"],
    // December 2026 starts on a Tuesday.
    ["1st-tue", null, "2026-11-30", "2026-12-01"],
    ["1st-tue", "2026-12-01", "2026-12-01", "2027-01-05"],
    ["last-fri", null, "2026-10-11", "2026-10-30"],
    ["last-fri", "2026-10-30", "2026-10-30", "2026-11-27"],
    ["last-fri", "2026-10-30", "2026-10-20", "2026-11-27"],
    ["2nd-last-fri", null, "2026-10-11", "2026-10-23"],
    ["2nd-last-fri", "2026-10-23", "2026-10-23", "2026-11-20"],
    // 31 July 2026 is a Friday.
    ["last-fri", null, "2026-07-30", "2026-07-31"],
    ["5th-fri", null, "2026-07-30", "2026-07-31"],
  ];

  const PAST_9999: Row[] = [
    ["1d", "9999-12-30", "9999-12-30", "9999-12-31"],
    ["1d", "9999-12-31", "9999-12-31", null],
    ["1w", "9999-12-25", "9999-12-25", null],
    ["1m", "9999-12-01", "9999-12-01", null],
    ["1y", "9999-01-01", "9999-01-01", null],
    ["1y", "9998-12-31", "9998-12-31", "9999-12-31"],
    ["999y-after-done", null, "9999-06-01", null],
    ["999y", "2026-01-01", "9999-12-31", null],
    // 31 December 9999 is a Friday.
    ["fri", "9999-12-24", "9999-12-24", "9999-12-31"],
    ["fri", "9999-12-31", "9999-12-31", null],
    ["mon", "9999-12-28", "9999-12-28", null],
    ["last-day", "9999-12-30", "9999-12-30", "9999-12-31"],
    ["last-day", "9999-12-31", "9999-12-31", null],
    ["3rd-day", "9999-12-03", "9999-12-03", null],
    ["last-fri", "9999-12-30", "9999-12-30", "9999-12-31"],
    ["last-fri", "9999-12-31", "9999-12-31", null],
    ["5th-fri", "9999-12-31", "9999-12-31", null],
    ["2nd-tue", "9999-12-14", "9999-12-14", null],
  ];

  const row = (written: string, due: string | null, done: string, next: string | null) => {
    expect(nextDue(rule(written), { due, done })).toBe(next);
  };

  it.each(INTERVALS)("every:%s due %s done %s is next due %s", row);
  it.each(MONTH_ENDS)("at a month's end, every:%s due %s done %s is next due %s", row);
  it.each(LEAP_YEARS)("around a leap day, every:%s due %s done %s is next due %s", row);
  it.each(YEAR_BOUNDARIES)("over a year's end, every:%s due %s done %s is next due %s", row);
  it.each(WEEKDAY_SETS)("every:%s due %s done %s is next due %s", row);
  it.each(MONTH_DAYS)("every:%s due %s done %s is next due %s", row);
  it.each(MONTH_WEEKDAYS)("every:%s due %s done %s is next due %s", row);
  it.each(PAST_9999)("at the last year, every:%s due %s done %s is next due %s", row);

  /** A rule, a day to start from, and each next due date in turn. */
  const IN_TURN: [written: string, from: string, days: (string | null)[]][] = [
    ["31st-day", "2026-01-31", ["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]],
    ["last-day", "2027-11-30", ["2027-12-31", "2028-01-31", "2028-02-29", "2028-03-31"]],
    ["last-fri", "2026-10-11", ["2026-10-30", "2026-11-27", "2026-12-25", "2027-01-29"]],
    ["2nd-tue", "2026-10-01", ["2026-10-13", "2026-11-10", "2026-12-08", "2027-01-12"]],
    // Only January, May, July and October of 2026 have a fifth Friday.
    ["5th-fri", "2026-01-01", ["2026-01-30", "2026-05-29", "2026-07-31", "2026-10-30", "2027-01-29"]],
    // The fifth-last Monday is the first Monday of a month that has five.
    ["5th-last-mon", "2026-01-01", ["2026-03-02", "2026-06-01", "2026-08-03", "2026-11-02"]],
    ["mon,thu", "2026-12-24", ["2026-12-28", "2026-12-31", "2027-01-04", "2027-01-07"]],
    // Each step counts from the day before it, so a short month does pull the ones after it earlier.
    ["1m", "2026-01-31", ["2026-02-28", "2026-03-28", "2026-04-28"]],
    ["1d", "9999-12-29", ["9999-12-30", "9999-12-31", null]],
  ];

  it.each(IN_TURN)("every:%s from %s goes on %j", (written, from, days) => {
    expect(walk(written, from, days.length)).toEqual(days);
  });
});

describe("the next due date where a clock changes", () => {
  // The United States changes its clocks on 8 March and 1 November 2026, and Europe on 29 March and 25 October.
  it.each([
    ["2026-03-07", ["2026-03-08", "2026-03-09", "2026-03-10"]],
    ["2026-10-31", ["2026-11-01", "2026-11-02", "2026-11-03"]],
    ["2026-03-28", ["2026-03-29", "2026-03-30", "2026-03-31"]],
    ["2026-10-24", ["2026-10-25", "2026-10-26", "2026-10-27"]],
  ])("a day at a time from %s gives each day once", (from, days) => {
    expect(walk("1d", from, days.length)).toEqual(days);
    expect(walk("1d-after-done", from, days.length)).toEqual(days);
  });
});

describe("the next due date on the days a clock changes", () => {
  const ROWS: [written: string, due: string | null, done: string, next: string][] = [
    ["1d", "2026-03-07", "2026-03-07", "2026-03-08"],
    ["1d", "2026-03-08", "2026-03-08", "2026-03-09"],
    ["1d", "2026-03-09", "2026-03-09", "2026-03-10"],
    ["1d", "2026-10-31", "2026-10-31", "2026-11-01"],
    ["1d", "2026-11-01", "2026-11-01", "2026-11-02"],
    ["1d", "2026-11-02", "2026-11-02", "2026-11-03"],
    ["1d", "2026-03-28", "2026-03-28", "2026-03-29"],
    ["1d", "2026-03-29", "2026-03-29", "2026-03-30"],
    ["1d", "2026-03-30", "2026-03-30", "2026-03-31"],
    ["1d-after-done", null, "2026-03-08", "2026-03-09"],
    ["1d-after-done", null, "2026-11-01", "2026-11-02"],
    ["1d-after-done", null, "2026-03-29", "2026-03-30"],
    ["1w", "2026-03-04", "2026-03-04", "2026-03-11"],
    ["1w", "2026-10-28", "2026-10-28", "2026-11-04"],
    ["1m", "2026-02-08", "2026-02-08", "2026-03-08"],
    ["1m", "2026-10-01", "2026-10-01", "2026-11-01"],
    ["1d", "2026-03-01", "2026-03-10", "2026-03-11"],
    ["sun", "2026-03-01", "2026-03-01", "2026-03-08"],
    ["sun", "2026-03-08", "2026-03-08", "2026-03-15"],
    ["sun,mon", "2026-10-31", "2026-10-31", "2026-11-01"],
    ["sun,mon", "2026-11-01", "2026-11-01", "2026-11-02"],
    ["sun", "2026-03-22", "2026-03-22", "2026-03-29"],
    ["8th-day", null, "2026-03-07", "2026-03-08"],
    ["1st-day", null, "2026-10-31", "2026-11-01"],
    ["2nd-sun", null, "2026-03-07", "2026-03-08"],
    ["1st-sun", null, "2026-10-31", "2026-11-01"],
    ["last-sun", null, "2026-03-28", "2026-03-29"],
    ["last-sun", "2026-03-29", "2026-03-29", "2026-04-26"],
  ];

  it.each(ROWS)("every:%s due %s done %s is next due %s", (written, due, done, next) => {
    expect(nextDue(rule(written), { due, done })).toBe(next);
  });
});
