import { describe, expect, it } from "vitest";
import { COUNTED, doneLabel, doneName, everyLabel, everyName, everyOf, everyOffers, formOf, ruleOf, toggledDay, SIMPLE } from "../../src/web/plugins/todos/recurrence.ts";
import { parseRule, writeRule } from "../../src/web/plugin-api.ts";

const EVERY_KIND = ["1d", "2w", "6m", "1y", "10w-after-done", "mon", "mon,thu", "mon,tue,wed,thu,fri", "sat,sun", "1st-day", "3rd-day", "31st-day", "last-day", "2nd-last-day", "1st-mon", "2nd-tue", "5th-sun", "last-fri", "2nd-last-fri"];

describe("the form a recurrence is set with", () => {
  it("opens on a rule of every kind and says the same rule back", () => {
    expect(EVERY_KIND.map((written) => everyOf(formOf(parseRule(written))))).toEqual(EVERY_KIND);
  });

  it("says no rule for a todo that doesn't recur, until a kind is chosen", () => {
    const blank = formOf(null);

    expect(ruleOf(blank)).toBeNull();
    expect(everyOf({ ...blank, kind: "interval" })).toBe("1w");
    expect(everyOf({ ...blank, kind: "monthDay" })).toBe("1st-day");
    expect(everyOf({ ...blank, kind: "monthWeekday" })).toBe("1st-mon");
    expect(everyOf({ ...blank, kind: "weekdays" })).toBeNull();
  });

  it("keeps each kind's fields while another kind is chosen", () => {
    const form = { ...formOf(parseRule("3d-after-done")), kind: "monthWeekday" as const, nth: 2, nthFromEnd: true, weekday: 5 as const };

    expect(everyOf(form)).toBe("2nd-last-fri");
    expect(everyOf({ ...form, kind: "interval" })).toBe("3d-after-done");
  });

  it("counts an interval from the due date or from the day it was done, and no other way", () => {
    const form = formOf(parseRule("3d"));

    expect(COUNTED.map(([after]) => everyOf({ ...form, after }))).toEqual(["3d", "3d-after-done"]);
    expect(parseRule("3d-after-due")).toBeNull();
  });

  it("makes a rule of weekdays from the days toggled, Monday first whatever the order they were picked in", () => {
    let form = formOf(parseRule("2w"));
    for (const day of [0, 4, 1] as const) form = toggledDay(form, day);

    expect(everyOf(form)).toBe("mon,thu,sun");
    expect(everyOf(toggledDay(form, 4))).toBe("mon,sun");
    expect(everyOf(toggledDay(toggledDay(toggledDay(form, 0), 4), 1))).toBeNull();
  });

  it("says no rule while a number is out of range or not whole", () => {
    const interval = formOf(parseRule("2w"));

    expect([0, 1000, 1.5, Number.NaN].map((n) => everyOf({ ...interval, n }))).toEqual([null, null, null, null]);
    expect([0, 32].map((monthDay) => everyOf({ ...interval, kind: "monthDay", monthDay }))).toEqual([null, null]);
    expect([0, 6].map((nth) => everyOf({ ...interval, kind: "monthWeekday", nth }))).toEqual([null, null]);
  });

  it("offers simple rules that are all rules, written as the core writes them", () => {
    expect(SIMPLE.map((s) => writeRule(parseRule(s.every)!))).toEqual(["1d", "1w", "2w", "1m", "1y", "mon,tue,wed,thu,fri"]);
  });
});

describe("what the recurrence and last-done chips say", () => {
  it("says a rule as written, and names it as a person reads it", () => {
    expect(everyLabel("2w")).toBe("↻ 2w");
    expect([everyName("2w"), everyName("mon,thu"), everyName("3d-after-done"), everyName("last-fri"), everyName(null)]).toEqual(["Recurs: Every 2 weeks", "Recurs: Mon, Thu", "Recurs: 3 days after done", "Recurs: Last Fri of the month", "Doesn't recur"]);
  });

  it("is never wider than the token it is drawn over, counted in characters", () => {
    for (const written of EVERY_KIND) expect(everyLabel(written).length).toBeLessThanOrEqual(`every:${written}`.length);
    for (const [on, times] of [["2026-10-11", 1], ["2026-10-10", 12], ["2025-01-02", 999999], ["2026-03-04", 7]] as const) expect(doneLabel({ on, times }, "2026-10-11").length).toBeLessThanOrEqual(`done:${on}x${times}`.length);
  });

  it("says the day it was last done beside today, and how many times", () => {
    const now = "2026-10-11";

    expect([doneLabel({ on: "2026-10-11", times: 1 }, now), doneLabel({ on: "2026-10-10", times: 2 }, now), doneLabel({ on: "2026-10-01", times: 12 }, now), doneLabel({ on: "2025-12-31", times: 40 }, now)]).toEqual(["✓ Today ×1", "✓ Yesterday ×2", "✓ Oct 1 ×12", "✓ Dec 31, 2025 ×40"]);
    expect([doneName({ on: "2026-10-11", times: 1 }, now), doneName({ on: "2026-10-01", times: 12 }, now)]).toEqual(["Last done Today, 1 time", "Last done Oct 1, 12 times"]);
  });

  it("offers rules to someone typing every:", () => {
    expect(everyOffers("").map((o) => o.every)).toEqual(["1d", "1w", "2w", "1m", "1y", "mon,tue,wed,thu,fri", "last-day", "1w-after-done"]);
    expect(everyOffers("month").map((o) => o.every)).toEqual(["1m", "last-day"]);
    expect(everyOffers("1").map((o) => o.every)).toEqual(["1d", "1w", "1m", "1y", "1w-after-done"]);
    expect(everyOffers("zz")).toEqual([]);
    expect(everyOffers("").every((o) => parseRule(o.every))).toBe(true);
  });
});
