import { describe, expect, it } from "vitest";
import { DATES, NTHS, PICKS, anotherDate, anotherNth, doneLabel, doneName, everyLabel, everyName, everyOf, everyOffers, formOf, namesDays, preview, ruleOf, shortDay, toggledDay, type RuleForm } from "../../src/web/plugins/todos/recurrence.ts";
import { MONTHS, WEEKDAYS, ordinal, parseRule, pastThe28th, writeRule, type Rule } from "../../src/web/plugin-api.ts";

/** A Tuesday, the 6th, and the first Tuesday of its month. */
const DUE = "2026-10-06";
const form = (written: string | null, day = DUE): RuleForm => formOf(written === null ? null : parseRule(written), day);

/** One of every kind of rule the grammar writes, and each with each kind of end. */
const BODIES = [
  "1d", "3d", "1w", "2w", "1m", "6m", "1y", "10y", "999d",
  "3d-after-done", "1w-after-done", "2m-after-done", "1y-after-done",
  "mon", "sun", "mon,thu", "sat,sun", "mon,tue,wed,thu,fri", "mon,tue,wed,thu,fri,sat,sun", "2w-mon", "2w-mon,thu", "52w-sun",
  "1st-day", "3rd-day", "31st-day", "last-day", "2nd-last-day", "31st-last-day", "1st-day,15th-day", "15th-day,last-day", "1st-day,10th-day,2nd-last-day,last-day", "2m-1st-day,15th-day", "12m-last-day",
  "1st-mon", "2nd-tue", "5th-sun", "last-fri", "2nd-last-fri", "5th-last-mon", "1st-tue,3rd-tue", "1st-mon,last-fri", "1st-mon,1st-fri", "3m-last-fri", "2m-1st-tue,3rd-tue",
  "mar-1", "feb-29", "dec-31", "1st-mon-mar", "last-fri-nov", "5th-last-sun-jan", "2y-mar-1", "4y-2nd-last-sun-may",
];
const ENDS = ["", "-times-1", "-times-5", "-times-999", "-until-2026-12-31"];
const EVERY_RULE = BODIES.flatMap((body) => ENDS.map((end) => body + end));

describe("the editor of a rule, as the form it holds", () => {
  it("opens on every rule the grammar writes and says the same rule back", () => {
    expect(EVERY_RULE.filter((written) => everyOf(form(written)) !== written)).toEqual([]);
    expect(EVERY_RULE.filter((written) => parseRule(written) === null)).toEqual([]);
  });

  it("does so for every day of the month, every weekday of it and every date of the year", () => {
    const all = [
      ...DATES.map(([date]) => writeRule({ ...parseRule("1st-day")!, dates: [date] })),
      ...NTHS.flatMap(([nth]) => WEEKDAYS.map((_, day) => writeRule({ ...parseRule("1st-mon")!, days: [{ nth, day: day as 0 }] }))),
      ...MONTHS.flatMap((month, i) => [1, 15, 28, i === 1 ? 29 : 30].map((date) => `${month}-${date}`)),
      ...NTHS.flatMap(([nth]) => MONTHS.map((_, i) => writeRule({ ...parseRule("1st-mon-jan")!, month: i + 1, days: [{ nth, day: 3 }] }))),
    ];

    expect(all).toHaveLength(62 + 70 + 48 + 120);
    expect(all.filter((written) => everyOf(form(written)) !== written)).toEqual([]);
    expect(DATES.map(([, label]) => label).slice(29, 34)).toEqual(["30th", "31st", "last day", "2nd-last day", "3rd-last day"]);
    expect(NTHS.map(([, label]) => label)).toEqual(["1st", "2nd", "3rd", "4th", "5th", "last", "2nd-last", "3rd-last", "4th-last", "5th-last"]);
  });

  it("opens on a todo that doesn't recur as every week, with each unit's picks taken from the due date", () => {
    const blank = form(null);

    expect(everyOf(blank)).toBe("1w");
    expect(everyOf({ ...blank, unit: "m", monthOn: "dates" })).toBe("6th-day");
    expect(everyOf({ ...blank, unit: "m", monthOn: "weekdays" })).toBe("1st-tue");
    expect(everyOf({ ...blank, unit: "y", yearOn: "date" })).toBe("oct-6");
    expect(everyOf({ ...blank, unit: "y", yearOn: "weekday" })).toBe("1st-tue-oct");
    // The 29th is in the fifth week of its month.
    expect(everyOf({ ...form(null, "2026-10-29"), unit: "m", monthOn: "weekdays" })).toBe("5th-thu");
  });

  it("keeps each unit's picks while another unit is chosen", () => {
    const monthly = form("1st-tue,3rd-tue-times-5");

    expect(everyOf({ ...monthly, unit: "w" })).toBe("1w-times-5");
    expect(everyOf({ ...monthly, unit: "y" })).toBe("1y-times-5");
    expect(everyOf({ ...{ ...monthly, unit: "w" as const }, unit: "m" })).toBe("1st-tue,3rd-tue-times-5");
    expect(everyOf({ ...monthly, monthOn: "due" })).toBe("1m-times-5");
    expect(everyOf({ ...monthly, monthOn: "dates" })).toBe("6th-day-times-5");
  });

  it("makes a rule of weekdays from the days toggled, Monday first whatever the order they were picked in, and the due date's own day from none", () => {
    let weekly = form("2w");
    for (const day of [0, 4, 1] as const) weekly = toggledDay(weekly, day);

    expect(everyOf(weekly)).toBe("2w-mon,thu,sun");
    expect(everyOf({ ...weekly, n: 1 })).toBe("mon,thu,sun");
    expect(everyOf(toggledDay(weekly, 4))).toBe("2w-mon,sun");
    expect(everyOf(toggledDay(toggledDay(toggledDay(weekly, 0), 4), 1))).toBe("2w");
  });

  it("adds a day or a weekday the list doesn't have yet, and writes a list in its one order with each once", () => {
    const dates = form("15th-day");
    const nths = form("3rd-tue");

    expect(everyOf(anotherDate(dates))).toBe("1st-day,15th-day");
    expect(everyOf(anotherDate(anotherDate(dates)))).toBe("1st-day,2nd-day,15th-day");
    expect(everyOf(anotherNth(nths))).toBe("1st-tue,3rd-tue");
    expect(everyOf(anotherNth(anotherNth(nths)))).toBe("1st-tue,2nd-tue,3rd-tue");
    expect(everyOf({ ...dates, dates: [-1, 15, 1, 15, -2] })).toBe("1st-day,15th-day,2nd-last-day,last-day");
    expect(everyOf({ ...nths, nths: [{ nth: -1, day: 5 }, { nth: 1, day: 1 }, { nth: -1, day: 5 }] })).toBe("1st-mon,last-fri");
    expect(everyOf({ ...dates, dates: [] })).toBeNull();
    expect(everyOf({ ...nths, nths: [] })).toBeNull();
  });

  it("counts from the day it was done only a rule that names no days, where the choice is offered", () => {
    const done = form("3d-after-done");

    expect(namesDays(done)).toBe(false);
    expect(everyOf({ ...done, from: "due" })).toBe("3d");
    expect(everyOf({ ...done, unit: "w" })).toBe("3w-after-done");
    expect(["mon,thu", "2w-mon", "15th-day", "last-fri", "mar-1", "1st-mon-mar"].map((written) => namesDays(form(written)))).toEqual([true, true, true, true, true, true]);
    expect(["1d", "2w", "1m", "1y"].map((written) => namesDays(form(written)))).toEqual([false, false, false, false]);
    // Naming a day counts from the due date whatever was chosen before, and the choice is back when no day is named.
    expect(everyOf(toggledDay({ ...done, unit: "w" }, 1))).toBe("3w-mon");
    expect(everyOf(toggledDay(toggledDay({ ...done, unit: "w" }, 1), 1))).toBe("3w-after-done");
  });

  it("ends never, on a day, or after so many times", () => {
    const monthly = form("1m");

    expect(everyOf({ ...monthly, ends: "times" })).toBe("1m-times-5");
    expect(everyOf({ ...monthly, ends: "times", times: 1 })).toBe("1m-times-1");
    expect(everyOf({ ...monthly, ends: "until", until: "2027-06-30" })).toBe("1m-until-2027-06-30");
    expect(everyOf({ ...form("1m-times-9"), ends: "never" })).toBe("1m");
  });

  it("says no rule while a number is out of range or not whole, or a date isn't one", () => {
    const weekly = form("2w");

    expect([0, 1000, 1.5, Number.NaN, -1].map((n) => everyOf({ ...weekly, n }))).toEqual([null, null, null, null, null]);
    expect([0, 1000, 2.5, Number.NaN].map((times) => everyOf({ ...weekly, ends: "times", times }))).toEqual([null, null, null, null]);
    expect(["", "2026-02-30", "soon"].map((until) => everyOf({ ...weekly, ends: "until", until }))).toEqual([null, null, null]);
    expect([0, 30, 31].map((date) => everyOf({ ...weekly, unit: "y", yearOn: "date", month: 2, date }))).toEqual([null, null, null]);
    expect(everyOf({ ...weekly, unit: "y", yearOn: "date", month: 2, date: 29 })).toBe("2y-feb-29");
    // A number that is out of range for a part of the form the rule isn't made from doesn't matter.
    expect(everyOf({ ...weekly, times: 0, date: 99 })).toBe("2w");
  });

  it("offers picks that are all rules, written as the core writes them", () => {
    expect(PICKS.map((pick) => [pick.label, writeRule(parseRule(pick.every)!)])).toEqual([["Daily", "1d"], ["Every weekday", "mon,tue,wed,thu,fri"], ["Weekly", "1w"], ["Every 2 weeks", "2w"], ["Monthly", "1m"], ["Yearly", "1y"]]);
  });

  it("opens on the last day of the month in place of a day past the 28th, as its note offers", () => {
    const last = (written: string, due: string) => everyOf(formOf(pastThe28th(parseRule(written)!, due)!.lastDay, due));

    expect(last("1m", "2026-01-31")).toBe("last-day");
    expect(last("1st-day,30th-day-times-4", DUE)).toBe("1st-day,last-day-times-4");
  });
});

describe("the dates the editor of a rule previews", () => {
  const NOW = "2026-10-13";
  const said = (written: string, due: string | null) => preview(parseRule(written) as Rule, due, NOW);

  it("are the next three after the one that is due, and fewer when the rule ends first", () => {
    expect(said("2w", "2026-10-20")).toEqual({ lead: "After this one:", days: ["Nov 3", "Nov 17", "Dec 1"], never: false });
    expect(said("1m", "2026-11-30")).toEqual({ lead: "After this one:", days: ["Dec 30", "Jan 30, 2027", "Feb 28, 2027"], never: false });
    expect(said("1m-times-3", "2026-10-15")).toEqual({ lead: "After this one:", days: ["Nov 15", "Dec 15"], never: false });
    // An overdue todo is counted from today, as completing it is, and a rule with no day to come round on says so.
    expect(said("1m", "2026-01-31")).toEqual({ lead: "If done today:", days: ["Oct 31", "Nov 30", "Dec 30"], never: false });
    expect(said("999y-5th-fri-feb", "2026-10-15")).toEqual({ lead: "After this one:", days: [], never: true });
    expect(said("1m-times-1", "2026-10-15")).toEqual({ lead: "After this one:", days: [], never: false });
    expect(said("1w-until-2026-10-27", "2026-10-13")).toEqual({ lead: "After this one:", days: ["Oct 20", "Oct 27"], never: false });
    expect(said("1st-tue,3rd-tue", "2026-10-06")).toEqual({ lead: "If done today:", days: ["Oct 20", "Nov 3", "Nov 17"], never: false });
  });

  it("are counted from today for a rule counted from the day it was done, and for a todo with no due date", () => {
    expect(said("3d-after-done", "2026-10-01")).toEqual({ lead: "If done today:", days: ["Oct 16", "Oct 19", "Oct 22"], never: false });
    expect(said("mon,thu", null)).toEqual({ lead: "If done today:", days: ["Oct 15", "Oct 19", "Oct 22"], never: false });
    expect(said("3d-after-done-times-2", null)).toEqual({ lead: "If done today:", days: ["Oct 16"], never: false });
  });

  it("says a day with its year when that isn't this one", () => {
    expect([shortDay("2026-11-03", NOW), shortDay("2027-01-05", NOW)]).toEqual(["Nov 3", "Jan 5, 2027"]);
  });
});

describe("what the recurrence and last-done chips say", () => {
  it("says a rule in a few plain words, and names it as a sentence", () => {
    expect(["2w", "2w-mon", "mon,thu", "1st-tue,3rd-tue", "mar-1", "3d-after-done", "1m-times-5", "15th-day-until-2027-06-30"].map(everyLabel)).toEqual([
      "every 2 weeks",
      "every 2 weeks on Mon",
      "every Mon, Thu",
      "monthly on the 1st & 3rd Tue",
      "yearly on Mar 1",
      "3 days after done",
      "every month · 5 left",
      "monthly on the 15th · until Jun 30",
    ]);
    expect([everyName("2w"), everyName("mon,thu"), everyName("3d-after-done"), everyName("last-fri-times-2"), everyName(null)]).toEqual(["Recurs: Every 2 weeks", "Recurs: Every week on Monday and Thursday", "Recurs: 3 days after it's done", "Recurs: Every month on the last Friday, 2 more times", "Doesn't recur"]);
  });

  it("is never wider than the token it is drawn over, counted in characters, for the last-done mark", () => {
    for (const [on, times] of [["2026-10-11", 1], ["2026-10-10", 12], ["2025-01-02", 999999], ["2026-03-04", 7]] as const) expect(doneLabel({ on, times }, "2026-10-11").length).toBeLessThanOrEqual(`done:${on}x${times}`.length);
  });

  it("says the day it was last done beside today, and how many times", () => {
    const now = "2026-10-11";

    expect([doneLabel({ on: "2026-10-11", times: 1 }, now), doneLabel({ on: "2026-10-10", times: 2 }, now), doneLabel({ on: "2026-10-01", times: 12 }, now), doneLabel({ on: "2025-12-31", times: 40 }, now)]).toEqual(["✓ Today ×1", "✓ Yesterday ×2", "✓ Oct 1 ×12", "✓ Dec 31, 2025 ×40"]);
    expect([doneName({ on: "2026-10-11", times: 1 }, now), doneName({ on: "2026-10-01", times: 12 }, now)]).toEqual(["Last done Today, 1 time", "Last done Oct 1, 12 times"]);
  });

  it("offers rules to someone typing every:", () => {
    expect(everyOffers("").map((o) => o.every)).toEqual(["1d", "mon,tue,wed,thu,fri", "1w", "2w", "1m", "1y", "last-day", "1w-after-done"]);
    expect(everyOffers("month").map((o) => o.every)).toEqual(["1m", "last-day"]);
    expect(everyOffers("1").map((o) => o.every)).toEqual(["1d", "1w", "1m", "1y", "1w-after-done"]);
    expect(everyOffers("zz")).toEqual([]);
    expect(everyOffers("").every((o) => parseRule(o.every))).toBe(true);
  });

  it("has an ordinal for each day a list offers", () => {
    expect(DATES.slice(0, 3).map(([date, label]) => [date, label])).toEqual([[1, ordinal(1)], [2, ordinal(2)], [3, ordinal(3)]]);
  });
});
