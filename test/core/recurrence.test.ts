// Every date here is a calendar date written YYYY-MM-DD, never an instant, so no time zone can move it.
import { describe, expect, it } from "vitest";
import { MONTHS, RULE_PATTERN, WEEKDAYS, counted, describeRule, nextDue, occurrences, ordinal, parseRule, pastThe28th, ruleLabel, writeRule, type End, type Rule, type Unit, type Weekday } from "../../src/core/recurrence.ts";

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

const every = (n: number, unit: Unit, more: Partial<Rule> = {}): Rule => ({ unit, n, from: "due", days: [], dates: [], month: null, end: null, ...more });
const weekly = (...days: Weekday[]) => ({ days: days.map((day) => ({ nth: 0, day })) });
const nth = (...days: [nth: number, day: Weekday][]) => ({ days: days.map(([nth, day]) => ({ nth, day })) });

describe("a rule as written", () => {
  /** What is written, the rule it is, what its chip says and the sentence it is set by. */
  const GRAMMAR: [written: string, rule: Rule, label: string, sentence: string][] = [
    ["1d", every(1, "d"), "every day", "Every day"],
    ["3d", every(3, "d"), "every 3 days", "Every 3 days"],
    ["1w", every(1, "w"), "every week", "Every week"],
    ["2w", every(2, "w"), "every 2 weeks", "Every 2 weeks"],
    ["1m", every(1, "m"), "every month", "Every month"],
    ["6m", every(6, "m"), "every 6 months", "Every 6 months"],
    ["1y", every(1, "y"), "every year", "Every year"],
    ["10y", every(10, "y"), "every 10 years", "Every 10 years"],
    ["999d", every(999, "d"), "every 999 days", "Every 999 days"],
    ["10w", every(10, "w"), "every 10 weeks", "Every 10 weeks"],
    ["3d-after-done", every(3, "d", { from: "done" }), "3 days after done", "3 days after it's done"],
    ["1d-after-done", every(1, "d", { from: "done" }), "1 day after done", "A day after it's done"],
    ["2y-after-done", every(2, "y", { from: "done" }), "2 years after done", "2 years after it's done"],
    ["mon", every(1, "w", weekly(1)), "every Mon", "Every week on Monday"],
    ["sun", every(1, "w", weekly(0)), "every Sun", "Every week on Sunday"],
    ["mon,thu", every(1, "w", weekly(1, 4)), "every Mon, Thu", "Every week on Monday and Thursday"],
    ["sat,sun", every(1, "w", weekly(6, 0)), "every Sat, Sun", "Every week on Saturday and Sunday"],
    ["mon,tue,wed,thu,fri", every(1, "w", weekly(1, 2, 3, 4, 5)), "every weekday", "Every weekday"],
    ["mon,tue,wed,thu,fri,sat,sun", every(1, "w", weekly(1, 2, 3, 4, 5, 6, 0)), "every Mon, Tue, Wed, Thu, Fri, Sat, Sun", "Every week on Monday, Tuesday, Wednesday, Thursday, Friday, Saturday and Sunday"],
    ["2w-mon", every(2, "w", weekly(1)), "every 2 weeks on Mon", "Every 2 weeks on Monday"],
    ["2w-mon,thu", every(2, "w", weekly(1, 4)), "every 2 weeks on Mon, Thu", "Every 2 weeks on Monday and Thursday"],
    ["3w-mon,tue,wed,thu,fri", every(3, "w", weekly(1, 2, 3, 4, 5)), "every 3 weeks on weekdays", "Every 3 weeks on weekdays"],
    ["1st-day", every(1, "m", { dates: [1] }), "monthly on the 1st", "Every month on the 1st"],
    ["3rd-day", every(1, "m", { dates: [3] }), "monthly on the 3rd", "Every month on the 3rd"],
    ["22nd-day", every(1, "m", { dates: [22] }), "monthly on the 22nd", "Every month on the 22nd"],
    ["31st-day", every(1, "m", { dates: [31] }), "monthly on the 31st", "Every month on the 31st"],
    ["last-day", every(1, "m", { dates: [-1] }), "monthly on the last day", "Every month on the last day"],
    ["2nd-last-day", every(1, "m", { dates: [-2] }), "monthly on the 2nd-last day", "Every month on the 2nd-last day"],
    ["31st-last-day", every(1, "m", { dates: [-31] }), "monthly on the 31st-last day", "Every month on the 31st-last day"],
    ["1st-day,15th-day", every(1, "m", { dates: [1, 15] }), "monthly on the 1st & 15th", "Every month on the 1st and 15th"],
    ["15th-day,last-day", every(1, "m", { dates: [15, -1] }), "monthly on the 15th & last day", "Every month on the 15th and last day"],
    ["1st-day,10th-day,2nd-last-day,last-day", every(1, "m", { dates: [1, 10, -2, -1] }), "monthly on the 1st, 10th, 2nd-last day & last day", "Every month on the 1st, 10th, 2nd-last day and last day"],
    ["1st-mon", every(1, "m", nth([1, 1])), "monthly on the 1st Mon", "Every month on the 1st Monday"],
    ["2nd-tue", every(1, "m", nth([2, 2])), "monthly on the 2nd Tue", "Every month on the 2nd Tuesday"],
    ["5th-sun", every(1, "m", nth([5, 0])), "monthly on the 5th Sun", "Every month on the 5th Sunday"],
    ["last-fri", every(1, "m", nth([-1, 5])), "monthly on the last Fri", "Every month on the last Friday"],
    ["2nd-last-fri", every(1, "m", nth([-2, 5])), "monthly on the 2nd-last Fri", "Every month on the 2nd-last Friday"],
    ["5th-last-mon", every(1, "m", nth([-5, 1])), "monthly on the 5th-last Mon", "Every month on the 5th-last Monday"],
    ["1st-tue,3rd-tue", every(1, "m", nth([1, 2], [3, 2])), "monthly on the 1st & 3rd Tue", "Every month on the 1st and 3rd Tuesday"],
    ["1st-mon,last-fri", every(1, "m", nth([1, 1], [-1, 5])), "monthly on the 1st Mon & last Fri", "Every month on the 1st Monday and last Friday"],
    ["3m-last-fri", every(3, "m", nth([-1, 5])), "every 3 months on the last Fri", "Every 3 months on the last Friday"],
    ["2m-1st-day,15th-day", every(2, "m", { dates: [1, 15] }), "every 2 months on the 1st & 15th", "Every 2 months on the 1st and 15th"],
    ["mar-1", every(1, "y", { month: 3, dates: [1] }), "yearly on Mar 1", "Every year on March 1"],
    ["feb-29", every(1, "y", { month: 2, dates: [29] }), "yearly on Feb 29", "Every year on February 29"],
    ["dec-31", every(1, "y", { month: 12, dates: [31] }), "yearly on Dec 31", "Every year on December 31"],
    ["1st-mon-mar", every(1, "y", { month: 3, ...nth([1, 1]) }), "yearly on the 1st Mon of Mar", "Every year on the 1st Monday of March"],
    ["last-fri-nov", every(1, "y", { month: 11, ...nth([-1, 5]) }), "yearly on the last Fri of Nov", "Every year on the last Friday of November"],
    ["2y-mar-1", every(2, "y", { month: 3, dates: [1] }), "every 2 years on Mar 1", "Every 2 years on March 1"],
    ["4y-2nd-last-sun-may", every(4, "y", { month: 5, ...nth([-2, 0]) }), "every 4 years on the 2nd-last Sun of May", "Every 4 years on the 2nd-last Sunday of May"],
    ["1m-times-5", every(1, "m", { end: { times: 5 } }), "every month · 5 left", "Every month, 5 more times"],
    ["1m-times-1", every(1, "m", { end: { times: 1 } }), "every month · 1 left", "Every month, this is the last time"],
    ["mon,thu-until-2026-12-31", every(1, "w", { ...weekly(1, 4), end: { until: "2026-12-31" } }), "every Mon, Thu · until Dec 31", "Every week on Monday and Thursday, until December 31, 2026"],
    ["3d-after-done-times-3", every(3, "d", { from: "done", end: { times: 3 } }), "3 days after done · 3 left", "3 days after it's done, 3 more times"],
    ["2w-mon,thu-times-5", every(2, "w", { ...weekly(1, 4), end: { times: 5 } }), "every 2 weeks on Mon, Thu · 5 left", "Every 2 weeks on Monday and Thursday, 5 more times"],
    ["2m-1st-tue,3rd-tue-until-2027-06-30", every(2, "m", { ...nth([1, 2], [3, 2]), end: { until: "2027-06-30" } }), "every 2 months on the 1st & 3rd Tue · until Jun 30", "Every 2 months on the 1st and 3rd Tuesday, until June 30, 2027"],
    ["feb-29-times-999", every(1, "y", { month: 2, dates: [29], end: { times: 999 } }), "yearly on Feb 29 · 999 left", "Every year on February 29, 999 more times"],
  ];

  it.each(GRAMMAR)("%s is read, written back the same, and said in words", (written, expected, label, sentence) => {
    expect(parseRule(written)).toEqual(expected);
    expect(writeRule(expected)).toBe(written);
    expect(ruleLabel(expected)).toBe(label);
    expect(describeRule(expected)).toBe(sentence);
  });

  it("reads every day of the month, from its start and from its end", () => {
    for (let n = 1; n <= 31; n++) {
      expect(parseRule(`${ordinal(n)}-day`)).toEqual(every(1, "m", { dates: [n] }));
      expect(parseRule(n === 1 ? "last-day" : `${ordinal(n)}-last-day`)).toEqual(every(1, "m", { dates: [-n] }));
    }
  });

  it("reads the days of a week alone in any order, and writes them Monday first", () => {
    expect(parseRule("thu,mon")).toEqual(every(1, "w", weekly(1, 4)));
    expect(writeRule(rule("thu,mon"))).toBe("mon,thu");
    expect(writeRule(rule("sun,sat,mon"))).toBe("mon,sat,sun");
  });

  it("says the day a rule takes from the due date, in its sentence", () => {
    // 6 October 2026 is a Tuesday.
    expect(describeRule(rule("1m"), "2026-10-06")).toBe("Every month on the 6th");
    expect(describeRule(rule("1y-times-3"), "2026-10-06")).toBe("Every year on October 6, 3 more times");
    expect(describeRule(rule("2w"), "2026-10-06")).toBe("Every 2 weeks on Tuesday");
    expect(describeRule(rule("3d"), "2026-10-06")).toBe("Every 3 days");
    expect(describeRule(rule("1m-after-done"), "2026-10-06")).toBe("A month after it's done");
    expect(describeRule(rule("15th-day"), "2026-10-06")).toBe("Every month on the 15th");
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
    // One spelling for each rule: every one is written with no number, and a list in its one order.
    "1w-mon",
    "1m-1st-day",
    "1m-last-fri",
    "1y-mar-1",
    "0w-mon",
    "02w-mon",
    "1000w-mon",
    "2w-thu,mon",
    "2w-mon,mon",
    "15th-day,1st-day",
    "1st-day,1st-day",
    "last-day,2nd-last-day",
    "last-day,1st-day",
    "3rd-tue,1st-tue",
    "1st-tue,1st-mon",
    "1st-tue,1st-tue",
    "last-fri,1st-mon",
    // A list is of days of the month or of weekdays, not both, and a rule of years names one day.
    "1st-day,2nd-tue",
    "mon,1st-day",
    "mar-1,apr-1",
    "1st-mon,2nd-mon-mar",
    "1st-day-mar",
    "last-day-feb",
    // Each unit takes its own picks.
    "2d-mon",
    "2m-mon",
    "2w-1st-day",
    "2w-mar-1",
    "2y-1st-day",
    "2y-mon",
    "2m-mar-1",
    "mar-0",
    "mar-01",
    "mar-32",
    "feb-30",
    "apr-31",
    "march-1",
    "Mar-1",
    "mar",
    "1st-mon-march",
    "6th-mon-mar",
    // Only a rule that picks no days counts from the day it was done.
    "mon-after-done",
    "last-day-after-done",
    "2w-mon-after-done",
    "mar-1-after-done",
    // The end is one of the two, written once, after the rule.
    "1m-times-0",
    "1m-times-01",
    "1m-times-1000",
    "1m-times",
    "1m-times-",
    "1m-until-2026-02-30",
    "1m-until-2026-1-1",
    "1m-until-0999-01-01",
    "1m-until",
    "1m-times-5-until-2026-12-31",
    "1m-until-2026-12-31-times-5",
    "2m-times-5-times-5",
    "times-5",
    "until-2026-12-31",
    "1m-times-5-after-done",
    // What v1 wrote and this doesn't.
    "weekly",
    "after-1m",
    "6th",
    "day-50",
    "RRULE:FREQ=DAILY",
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
    ["a every:2w-mon,thu, b", "2w-mon,thu"],
    ["a every:1st-day,15th-day.", "1st-day,15th-day"],
    ["a every:3m-last-fri b", "3m-last-fri"],
    ["a every:mar-1, b", "mar-1"],
    ["a every:1st-mon-mar)", "1st-mon-mar"],
    ["a every:1m-times-5.", "1m-times-5"],
    ["a every:mon,thu-until-2026-12-31, b", "mon,thu-until-2026-12-31"],
    ["a every:3d-after-done-times-3", "3d-after-done-times-3"],
    ["a every:1m-times-5x", null],
    ["a every:mar-1st", null],
  ];

  it.each(TOKENS)("in %j the token holds %j", (line, expected) => {
    const token = new RegExp("(?<=\\s)every:(" + RULE_PATTERN + ")(?=$|[\\s.,;:!?)])", "g");
    const found = [...line.matchAll(token)];
    expect(found.map((match) => match[1])).toEqual(expected === null ? [] : [expected]);
    expect(found.map((match) => match[0])).toEqual(expected === null ? [] : [`every:${expected}`]);
    expect(found.every((match) => match.length === 2)).toBe(true);
  });
});

describe("one spelling for each rule", () => {
  /** A generator of numbers that gives the same ones each run. */
  const random = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const rand = random(46);
  const upTo = (n: number) => Math.floor(rand() * n);
  const one = <T>(items: readonly T[]): T => items[upTo(items.length)]!;
  const some = <T>(items: readonly T[], most: number): T[] => [...new Set(Array.from({ length: 1 + upTo(most) }, () => one(items)))];
  const DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
  const DATES = [...Array.from({ length: 31 }, (_, i) => i + 1), ...Array.from({ length: 31 }, (_, i) => -i - 1)];
  const NTHS = [1, 2, 3, 4, 5, -1, -2, -3, -4, -5];
  const ENDS: (() => End | null)[] = [() => null, () => null, () => ({ times: 1 + upTo(999) }), () => ({ until: `20${10 + upTo(89)}-${String(1 + upTo(12)).padStart(2, "0")}-${String(1 + upTo(28)).padStart(2, "0")}` })];

  /** A rule of any kind the grammar has, with its lists in whatever order they came out. */
  const anyRule = (): Rule => {
    const end = one(ENDS)();
    const n = one([1, 1, 2, 3, 12, 999]);
    switch (upTo(7)) {
      case 0:
        return every(n, one(["d", "w", "m", "y"] as const), { from: one(["due", "done"] as const), end });
      case 1:
        return every(n, "w", { ...weekly(...some(DAYS, 7)), end });
      case 2:
        return every(n, "m", { dates: some(DATES, 4), end });
      case 3: {
        const days = some(NTHS, 3).flatMap((nth) => some(DAYS, 2).map((day) => ({ nth, day })));
        return every(n, "m", { days, end });
      }
      case 4:
        return every(n, "y", { month: 1 + upTo(12), dates: [1 + upTo(28)], end });
      case 5:
        return every(n, "y", { month: 1 + upTo(12), ...nth([one(NTHS), one(DAYS)]), end });
      default:
        return every(n, one(["d", "w", "m", "y"] as const), { end });
    }
  };

  /** A rule with its lists in the one order they are written in, so that two rules that are the same rule are equal. */
  const inOrder = (r: Rule) => parseRule(writeRule(r));

  it("writes every rule as a token that reads back as that rule, and no two rules as the same token", () => {
    const seen = new Map<string, string>();
    for (let i = 0; i < 4000; i++) {
      const made = anyRule();
      const written = writeRule(made);
      const back = parseRule(written);
      expect(back, written).not.toBeNull();
      expect(writeRule(back!), written).toBe(written);
      expect({ ...back!, days: [...back!.days].sort(byDay), dates: [...back!.dates].sort() }, written).toEqual({ ...made, days: [...made.days].sort(byDay), dates: [...made.dates].sort() });
      const same = JSON.stringify(inOrder(made));
      expect(seen.get(written) ?? same, written).toBe(same);
      seen.set(written, same);
      expect(new RegExp(`^${RULE_PATTERN}$`).test(written), written).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(2000);
  });

  const byDay = (a: { nth: number; day: number }, b: { nth: number; day: number }) => a.nth - b.nth || a.day - b.day;

  it("reads no token that it would write another way, but the days of a week alone", () => {
    const names = [...WEEKDAYS];
    const items = ["1st-day", "2nd-day", "15th-day", "31st-day", "last-day", "2nd-last-day", "1st-mon", "1st-tue", "3rd-tue", "last-fri", "2nd-last-fri", "5th-sun"];
    const bodies = () => {
      switch (upTo(6)) {
        case 0:
          return `${one(["0", "1", "2", "03", "12"])}${one(["d", "w", "m", "y"])}${one(["", "", "-after-done"])}`;
        case 1:
          return some(names, 4).join(",");
        case 2:
          return Array.from({ length: 1 + upTo(3) }, () => one(items)).join(",");
        case 3:
          return `${one(MONTHS)}-${one(["0", "1", "01", "15", "29", "30", "31", "32"])}`;
        case 4:
          return `${one(items)}-${one(MONTHS)}`;
        default:
          return one(["mon", "last-day", "mar-1", "1st-mon-mar", "2w"]);
      }
    };
    const prefixes = ["", "", "", "1w-", "2w-", "1m-", "2m-", "3m-", "1y-", "2y-", "02m-"];
    const ends = ["", "", "", "-times-5", "-times-0", "-times-05", "-until-2026-12-31", "-until-2026-02-30", "-times-5-times-5"];
    let read = 0;
    for (let i = 0; i < 20000; i++) {
      const body = bodies();
      const written = `${one(prefixes)}${body}${one(ends)}`;
      const parsed = parseRule(written);
      if (!parsed) continue;
      read++;
      const aloneInAWeek = written.startsWith(body) && body.split(",").every((name) => names.includes(name as (typeof names)[number]));
      if (!aloneInAWeek) expect(writeRule(parsed), written).toBe(written);
      else expect(writeRule(parsed).split(/-(?=times|until)/)[0]!.split(",").sort(), written).toEqual(body.split(",").sort());
    }
    expect(read).toBeGreaterThan(1000);
  });
});

describe("a rule with one time gone", () => {
  it("has one fewer left, and a rule with no count is as it was", () => {
    expect(writeRule(counted(rule("1m-times-5")))).toBe("1m-times-4");
    expect(writeRule(counted(rule("mon,thu-times-2")))).toBe("mon,thu-times-1");
    expect(writeRule(counted(rule("1m-times-1")))).toBe("1m-times-1");
    expect(writeRule(counted(rule("1m-until-2026-12-31")))).toBe("1m-until-2026-12-31");
    expect(writeRule(counted(rule("1m")))).toBe("1m");
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

describe("the next due date of the wider rules", () => {
  type Row = [written: string, due: string | null, done: string, next: string | null];

  const EVERY_OTHER_WEEK: Row[] = [
    // 12 October 2026 is a Monday. Weeks are counted from the week of the due date, Monday first.
    ["2w-mon,thu", "2026-10-12", "2026-10-12", "2026-10-15"],
    ["2w-mon,thu", "2026-10-15", "2026-10-15", "2026-10-26"],
    ["2w-mon,thu", "2026-10-26", "2026-10-26", "2026-10-29"],
    ["2w-mon", "2026-10-12", "2026-10-12", "2026-10-26"],
    // Done early: after the due date. Done late: the weeks that were missed are skipped, and the rhythm kept.
    ["2w-mon", "2026-10-12", "2026-10-01", "2026-10-26"],
    ["2w-mon", "2026-10-12", "2026-11-03", "2026-11-09"],
    ["2w-mon", "2026-10-12", "2026-11-09", "2026-11-23"],
    ["2w-mon,thu", "2026-10-12", "2026-10-27", "2026-10-29"],
    // A Sunday is the last day of its week, so the Monday six days before it is in the same one.
    ["2w-mon,sun", "2026-10-12", "2026-10-12", "2026-10-18"],
    ["2w-mon,sun", "2026-10-18", "2026-10-18", "2026-10-26"],
    ["2w-sun", "2026-10-11", "2026-10-11", "2026-10-25"],
    ["3w-wed", "2026-10-14", "2026-10-14", "2026-11-04"],
    // With no due date the weeks are counted from the week it was done in.
    ["2w-mon,thu", null, "2026-10-14", "2026-10-15"],
    ["2w-mon", null, "2026-10-14", "2026-10-26"],
    // Across a year's end: 21 December 2026 is a Monday.
    ["2w-mon,thu", "2026-12-21", "2026-12-21", "2026-12-24"],
    ["2w-mon,thu", "2026-12-24", "2026-12-24", "2027-01-04"],
    ["2w-mon,thu", "2027-01-04", "2027-01-04", "2027-01-07"],
    ["2w-fri", "2026-12-25", "2026-12-25", "2027-01-08"],
    ["52w-thu", "2026-12-31", "2026-12-31", "2027-12-30"],
  ];

  const SEVERAL_IN_A_MONTH: Row[] = [
    ["1st-day,15th-day", "2026-10-01", "2026-10-01", "2026-10-15"],
    ["1st-day,15th-day", "2026-10-15", "2026-10-15", "2026-11-01"],
    ["1st-day,15th-day", "2026-12-15", "2026-12-15", "2027-01-01"],
    ["1st-day,15th-day", null, "2026-10-20", "2026-11-01"],
    ["1st-day,15th-day", "2026-10-01", "2026-12-20", "2027-01-01"],
    ["15th-day,last-day", "2026-02-15", "2026-02-15", "2026-02-28"],
    ["15th-day,last-day", "2026-02-28", "2026-02-28", "2026-03-15"],
    ["15th-day,last-day", "2028-02-15", "2028-02-15", "2028-02-29"],
    // Both fall on February's last day, which comes once.
    ["30th-day,31st-day", "2026-01-31", "2026-01-31", "2026-02-28"],
    ["30th-day,31st-day", "2026-02-28", "2026-02-28", "2026-03-30"],
    ["30th-day,31st-day", "2026-03-30", "2026-03-30", "2026-03-31"],
    // 6 October 2026 is a Tuesday.
    ["1st-tue,3rd-tue", "2026-10-06", "2026-10-06", "2026-10-20"],
    ["1st-tue,3rd-tue", "2026-10-20", "2026-10-20", "2026-11-03"],
    ["1st-mon,last-fri", "2026-10-05", "2026-10-05", "2026-10-30"],
    ["1st-mon,last-fri", "2026-10-30", "2026-10-30", "2026-11-02"],
    // A fifth Friday is passed over where there is none, and the first still comes.
    ["1st-fri,5th-fri", "2026-10-30", "2026-10-30", "2026-11-06"],
    ["1st-fri,5th-fri", "2026-11-06", "2026-11-06", "2026-12-04"],
  ];

  const EVERY_OTHER_MONTH: Row[] = [
    // Months are counted from the month of the due date.
    ["3m-last-fri", "2026-10-30", "2026-10-30", "2027-01-29"],
    ["3m-last-fri", "2026-10-30", "2026-10-01", "2027-01-29"],
    ["3m-last-fri", "2026-10-30", "2027-02-10", "2027-04-30"],
    ["3m-last-fri", "2026-10-02", "2026-10-02", "2026-10-30"],
    ["2m-1st-day,15th-day", "2026-11-01", "2026-11-01", "2026-11-15"],
    ["2m-1st-day,15th-day", "2026-11-15", "2026-11-15", "2027-01-01"],
    ["2m-31st-day", "2026-12-31", "2026-12-31", "2027-02-28"],
    ["2m-31st-day", "2027-02-28", "2027-02-28", "2027-04-30"],
    ["2m-last-day", null, "2026-10-13", "2026-10-31"],
    ["12m-5th-fri", "2026-10-30", "2026-10-30", "2027-10-29"],
    // October has no fifth Friday again until 2031, so the years between are passed over.
    ["12m-5th-fri", "2027-10-29", "2027-10-29", "2031-10-31"],
  ];

  const YEARLY: Row[] = [
    ["mar-1", "2026-03-01", "2026-03-01", "2027-03-01"],
    ["mar-1", "2026-03-01", "2026-02-01", "2027-03-01"],
    ["mar-1", "2026-03-01", "2029-06-01", "2030-03-01"],
    ["mar-1", null, "2026-10-13", "2027-03-01"],
    ["mar-1", null, "2026-02-13", "2026-03-01"],
    // A due date in another month: the first 1 March after it.
    ["mar-1", "2026-10-13", "2026-10-13", "2027-03-01"],
    ["dec-31", "2026-12-31", "2026-12-31", "2027-12-31"],
    ["2y-mar-1", "2026-03-01", "2026-03-01", "2028-03-01"],
    ["2y-mar-1", "2026-03-01", "2028-03-01", "2030-03-01"],
    // 29 February is the 28th in a year that has none, and the 29th again in the next that does.
    ["feb-29", "2028-02-29", "2028-02-29", "2029-02-28"],
    ["feb-29", "2029-02-28", "2029-02-28", "2030-02-28"],
    ["feb-29", "2031-02-28", "2031-02-28", "2032-02-29"],
    ["feb-29", null, "2026-01-10", "2026-02-28"],
    ["4y-feb-29", "2096-02-29", "2096-02-29", "2100-02-28"],
    // 1 March 2026 is a Sunday, and 1 March 2027 a Monday.
    ["1st-mon-mar", null, "2026-01-10", "2026-03-02"],
    ["1st-mon-mar", "2026-03-02", "2026-03-02", "2027-03-01"],
    ["last-fri-nov", null, "2026-10-13", "2026-11-27"],
    ["last-fri-nov", "2026-11-27", "2026-11-27", "2027-11-26"],
    // February has a fifth Sunday only in a leap year that starts it on one: 2032, and then 2060.
    ["5th-sun-feb", null, "2026-10-13", "2032-02-29"],
    ["5th-sun-feb", "2032-02-29", "2032-02-29", "2060-02-29"],
  ];

  const ENDS: Row[] = [
    ["1w-until-2026-10-26", "2026-10-12", "2026-10-12", "2026-10-19"],
    ["1w-until-2026-10-26", "2026-10-19", "2026-10-19", "2026-10-26"],
    ["1w-until-2026-10-26", "2026-10-26", "2026-10-26", null],
    ["1w-until-2026-10-25", "2026-10-19", "2026-10-19", null],
    ["1w-until-2026-10-26", "2026-10-12", "2026-10-22", "2026-10-26"],
    ["1w-until-2026-10-26", "2026-10-12", "2026-10-26", null],
    ["3d-after-done-until-2026-10-20", "2026-10-10", "2026-10-17", "2026-10-20"],
    ["3d-after-done-until-2026-10-20", "2026-10-10", "2026-10-18", null],
    ["mon,thu-until-2026-10-15", "2026-10-12", "2026-10-12", "2026-10-15"],
    ["mon,thu-until-2026-10-15", "2026-10-15", "2026-10-15", null],
    ["1m-times-2", "2026-10-15", "2026-10-15", "2026-11-15"],
    ["1m-times-1", "2026-10-15", "2026-10-15", null],
    ["last-day-times-1", null, "2026-10-15", null],
    ["3d-after-done-times-1", "2026-10-10", "2026-10-10", null],
  ];

  const PAST_9999: Row[] = [
    // 31 December 9999 is a Friday.
    ["2w-mon", "9999-12-27", "9999-12-27", null],
    ["2w-fri", "9999-12-17", "9999-12-17", "9999-12-31"],
    ["2w-fri", "9999-12-31", "9999-12-31", null],
    ["mar-1", "9999-03-01", "9999-03-01", null],
    ["mar-1", "9998-03-01", "9998-03-01", "9999-03-01"],
    ["2m-1st-day,15th-day", "9999-12-15", "9999-12-15", null],
    ["12m-5th-sun", "9999-02-01", "9999-02-01", null],
    ["999y-1st-mon-mar", "2026-03-02", "9000-01-01", "9019-03-01"],
    ["999y-1st-mon-mar", "9019-03-01", "9019-03-01", null],
  ];

  const row = (written: string, due: string | null, done: string, next: string | null) => {
    expect(nextDue(rule(written), { due, done })).toBe(next);
  };

  it.each(EVERY_OTHER_WEEK)("every:%s due %s done %s is next due %s", row);
  it.each(SEVERAL_IN_A_MONTH)("every:%s due %s done %s is next due %s", row);
  it.each(EVERY_OTHER_MONTH)("every:%s due %s done %s is next due %s", row);
  it.each(YEARLY)("every:%s due %s done %s is next due %s", row);
  it.each(ENDS)("with an end, every:%s due %s done %s is next due %s", row);
  it.each(PAST_9999)("at the last year, every:%s due %s done %s is next due %s", row);

  const IN_TURN: [written: string, from: string, days: (string | null)[]][] = [
    ["2w-mon,thu", "2026-12-07", ["2026-12-10", "2026-12-21", "2026-12-24", "2027-01-04", "2027-01-07", "2027-01-18"]],
    ["1st-day,15th-day,last-day", "2026-01-31", ["2026-02-01", "2026-02-15", "2026-02-28", "2026-03-01", "2026-03-15", "2026-03-31"]],
    ["3m-1st-tue,3rd-tue", "2026-10-06", ["2026-10-20", "2027-01-05", "2027-01-19", "2027-04-06"]],
    ["feb-29", "2027-02-28", ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]],
    ["mar-1", "9997-03-01", ["9998-03-01", "9999-03-01", null]],
  ];

  it.each(IN_TURN)("every:%s from %s goes on %j", (written, from, days) => {
    expect(walk(written, from, days.length)).toEqual(days);
  });
});

describe("the dates a rule's editor previews", () => {
  it("are each the next after the one before, and no more than the rule has left", () => {
    expect(occurrences(rule("2w"), "2026-10-20", 3)).toEqual(["2026-11-03", "2026-11-17", "2026-12-01"]);
    expect(occurrences(rule("1m-times-3"), "2026-10-15", 5)).toEqual(["2026-11-15", "2026-12-15"]);
    expect(occurrences(rule("1m-times-1"), "2026-10-15", 5)).toEqual([]);
    expect(occurrences(rule("1w-until-2026-10-26"), "2026-10-12", 5)).toEqual(["2026-10-19", "2026-10-26"]);
    expect(occurrences(rule("1d"), "9999-12-30", 3)).toEqual(["9999-12-31"]);
    expect(occurrences(rule("1st-tue,3rd-tue"), "2026-10-06", 3)).toEqual(["2026-10-20", "2026-11-03", "2026-11-17"]);
  });
});

describe("a rule of months on a day past the 28th", () => {
  const lastDay = (written: string, due: string | null = null) => {
    const past = pastThe28th(rule(written), due);
    return past && { days: past.days, drifts: past.drifts, lastDay: writeRule(past.lastDay) };
  };

  it("names the days that shorter months don't have, and the same rule on the last day", () => {
    expect(lastDay("31st-day")).toEqual({ days: [31], drifts: false, lastDay: "last-day" });
    expect(lastDay("1st-day,30th-day")).toEqual({ days: [30], drifts: false, lastDay: "1st-day,last-day" });
    expect(lastDay("29th-day,31st-day,last-day")).toEqual({ days: [29, 31], drifts: false, lastDay: "last-day" });
    expect(lastDay("2m-15th-day,29th-day-times-4")).toEqual({ days: [29], drifts: false, lastDay: "2m-15th-day,last-day-times-4" });
  });

  it("says a rule that takes its day from the due date drifts", () => {
    expect(lastDay("1m", "2026-01-31")).toEqual({ days: [31], drifts: true, lastDay: "last-day" });
    expect(lastDay("3m-until-2027-01-01", "2026-01-29")).toEqual({ days: [29], drifts: true, lastDay: "3m-last-day-until-2027-01-01" });
  });

  it("is nothing for a rule that lands on no such day", () => {
    expect(lastDay("28th-day")).toBeNull();
    expect(lastDay("1m", "2026-01-28")).toBeNull();
    expect(lastDay("1m")).toBeNull();
    expect(lastDay("last-day")).toBeNull();
    expect(lastDay("2nd-last-day")).toBeNull();
    expect(lastDay("last-fri")).toBeNull();
    expect(lastDay("1m-after-done", "2026-01-31")).toBeNull();
    expect(lastDay("1y", "2026-01-31")).toBeNull();
    expect(lastDay("jan-31")).toBeNull();
    expect(lastDay("1w", "2026-01-31")).toBeNull();
  });
});
