import { describe, expect, it } from "vitest";
import { parseQuery } from "../../src/web/plugin-api.ts";
import { addDays, dayOf, dueLabel, dueOffers, dueState, savedQuery } from "../../src/web/plugins/todos/dates.ts";

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

  it("reads what a browser kept of the page's old filters as the query that says the same, and every such query is one the todos take", () => {
    expect(savedQuery("due:<today", { tag: "x" })).toBe("due:<today");
    expect(savedQuery(undefined, undefined)).toBe("");
    expect(savedQuery(undefined, { folder: "", tag: "", due: "any", importance: "", completed: false, archived: false })).toBe("");
    const all = savedQuery(undefined, { folder: "abcdefghij12", tag: "Money", due: "week", importance: "2", completed: true, archived: true });
    expect(all).toBe("folder:abcdefghij12 tag:money due:today..+6d priority:medium (is:open OR is:done) (is:archived OR -is:archived)");
    for (const due of ["overdue", "today", "week", "none"]) expect(parseQuery(savedQuery(undefined, { due }), "todos").ok, due).toBe(true);
    expect(parseQuery(all, "todos").ok).toBe(true);
    // What was never one of its choices is no filter.
    expect(savedQuery(undefined, { folder: 'x" OR', tag: "a b", due: "soon", importance: "9", completed: "yes", archived: 1 })).toBe("");
    expect(savedQuery(undefined, "junk")).toBe("");
  });

  it("offers days to someone typing due:", () => {
    const now = "2026-10-11";
    expect(dueOffers("", now).map((o) => `${o.label} ${o.day}`)).toEqual(["Today 2026-10-11", "Tomorrow 2026-10-12", "Tuesday 2026-10-13", "Wednesday 2026-10-14", "Thursday 2026-10-15", "Friday 2026-10-16", "Saturday 2026-10-17", "In a week 2026-10-18"]);
    expect(dueOffers("to", now).map((o) => o.label)).toEqual(["Today", "Tomorrow"]);
    expect(dueOffers("2026-10-1", now).map((o) => o.day)).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(dueOffers("2026-11", now)).toEqual([]);
  });
});
