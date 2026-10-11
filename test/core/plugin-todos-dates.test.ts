import { describe, expect, it } from "vitest";
import { addDays, dayOf, dueLabel, dueOffers, dueRange, dueState } from "../../src/web/plugins/todos/dates.ts";

describe("a due date beside today", () => {
  it("is the day on the member's own clock, not the day in UTC", () => {
    // Read the way a browser hands it over: the fields of a local time.
    const late = { getFullYear: () => 2026, getMonth: () => 2, getDate: () => 9 } as Date;

    expect(dayOf(late)).toBe("2026-03-09");
  });

  it("counts days across months, years and leap days", () => {
    expect([addDays("2026-10-31", 1), addDays("2026-01-01", -1), addDays("2024-02-28", 1), addDays("2026-02-28", 1), addDays("2026-03-08", 6)]).toEqual(["2026-11-01", "2025-12-31", "2024-02-29", "2026-03-01", "2026-03-14"]);
  });

  it("reads as a person says it", () => {
    const now = "2026-10-11";
    expect(["2026-10-11", "2026-10-12", "2026-10-10", "2026-10-14", "2026-10-17", "2026-10-18", "2026-10-01", "2027-01-02", "2025-12-31"].map((day) => dueLabel(day, now))).toEqual(["Today", "Tomorrow", "Yesterday", "Wednesday", "Saturday", "Oct 18", "Oct 1", "Jan 2, 2027", "Dec 31, 2025"]);
    expect(["2026-10-10", "2026-10-11", "2026-10-12"].map((day) => dueState(day, now))).toEqual(["overdue", "today", "later"]);
  });

  it("turns a filter into the days the server is asked for", () => {
    const now = "2026-12-28";
    expect([dueRange("any", now), dueRange("overdue", now), dueRange("today", now), dueRange("week", now), dueRange("none", now)]).toEqual([{}, { dueTo: "2026-12-27" }, { dueFrom: "2026-12-28", dueTo: "2026-12-28" }, { dueFrom: "2026-12-28", dueTo: "2027-01-03" }, { noDue: true }]);
  });

  it("offers days to someone typing due:", () => {
    const now = "2026-10-11";
    expect(dueOffers("", now).map((o) => `${o.label} ${o.day}`)).toEqual(["Today 2026-10-11", "Tomorrow 2026-10-12", "Tuesday 2026-10-13", "Wednesday 2026-10-14", "Thursday 2026-10-15", "Friday 2026-10-16", "Saturday 2026-10-17", "In a week 2026-10-18"]);
    expect(dueOffers("to", now).map((o) => o.label)).toEqual(["Today", "Tomorrow"]);
    expect(dueOffers("2026-10-1", now).map((o) => o.day)).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(dueOffers("2026-11", now)).toEqual([]);
  });
});
