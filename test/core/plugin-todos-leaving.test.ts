import { describe, expect, it } from "vitest";
import type { InheritedTag } from "../../src/core/tagScope.ts";
import type { TodoState } from "../../src/core/todos.ts";
import { leaving, narrowingOf, type Narrowing } from "../../src/web/plugins/todos/leaving.ts";

const NOW = "2026-10-15";
const ANY: Narrowing = { states: ["open"], due: "any", importance: "", tag: "", folder: null };
const todo = (over: Partial<{ state: TodoState; due: string | null; importance: 0 | 1 | 2 | 3; words: string; tagsElsewhere: InheritedTag[] }> = {}) => ({ state: "open" as TodoState, due: null, importance: 0 as const, words: "Gym #health", tagsElsewhere: [] as InheritedTag[], ...over });
/** A tag a todo has from the first line of its note. */
const fromNote = (name: string): InheritedTag => ({ name, line: 0, by: "note", under: null });
const says = (row: ReturnType<typeof todo>, by: Partial<Narrowing>) => leaving(row, { ...ANY, ...by }, NOW)?.says ?? null;

describe("why a changed row leaves the Todos page's list", () => {
  it("says one sentence for each way the list is narrowed, naming what changed and that it leaves on refresh", () => {
    expect(says(todo({ due: "2026-10-16" }), { due: "today" })).toBe("Moved to tomorrow, so it no longer shows under Today. It leaves when you refresh.");
    expect(says(todo({ due: "2026-10-20" }), { due: "today" })).toBe("Moved to Tuesday, so it no longer shows under Today. It leaves when you refresh.");
    expect(says(todo({ due: "2026-11-02" }), { due: "week" })).toBe("Moved to Nov 2, so it no longer shows under Next 7 days. It leaves when you refresh.");
    expect(says(todo({ due: null }), { due: "overdue" })).toBe("Its date was taken off, so it no longer shows under Overdue. It leaves when you refresh.");
    expect(says(todo({ due: "2026-10-15" }), { due: "none" })).toBe("Moved to today, so it no longer shows under No date. It leaves when you refresh.");
    expect(says(todo({ importance: 1 }), { importance: "3" })).toBe("Set to Low, so it no longer shows under Priority: High. It leaves when you refresh.");
    expect(says(todo({ importance: 0 }), { importance: "2" })).toBe("Its priority was taken off, so it no longer shows under Priority: Medium. It leaves when you refresh.");
    expect(says(todo({ words: "Gym" }), { tag: "Health" })).toBe("#Health was taken off, so it no longer shows under #Health. It leaves when you refresh.");
    expect(says(todo(), { folder: { name: "Work / Plans", holds: false } })).toBe("Its note is no longer in Work / Plans, so it no longer shows there. It leaves when you refresh.");
    expect(says(todo({ state: "done" }), {})).toBe("Checked off, so it no longer shows with the open todos. It leaves when you refresh.");
    expect(says(todo(), { search: "bank" })).toBe("Changed, so it no longer matches “bank”. It leaves when you refresh.");
  });

  it("says what was done to a row whose state the list doesn't have, and names the list by its one state", () => {
    expect(says(todo({ state: "abandoned" }), {})).toBe("Abandoned, so it no longer shows with the open todos. It leaves when you refresh.");
    expect(says(todo({ state: "backlog" }), {})).toBe("Moved to the backlog, so it no longer shows with the open todos. It leaves when you refresh.");
    expect(says(todo({ state: "open" }), { states: ["backlog"] })).toBe("Opened again, so it no longer shows with the backlog. It leaves when you refresh.");
    expect(says(todo({ state: "abandoned" }), { states: ["open", "done"] })).toBe("Abandoned, so it no longer shows in this list. It leaves when you refresh.");
    // The state comes first: a row put away and moved off the day says why by what was done to it last.
    expect(says(todo({ state: "backlog", due: "2026-10-16" }), { due: "today" })).toBe("Moved to the backlog, so it no longer shows with the open todos. It leaves when you refresh.");
  });

  it("names the first way it fails, and nothing for a row that still matches", () => {
    expect(leaving(todo({ due: "2026-10-16", importance: 1 }), { ...ANY, due: "today", importance: "3" }, NOW)?.reason).toBe("date");
    expect(leaving(todo({ due: "2026-10-15", importance: 1 }), { ...ANY, due: "today", importance: "3" }, NOW)?.reason).toBe("priority");
    expect(says(todo({ due: "2026-10-15", importance: 3, words: "Gym #HEALTH" }), { due: "today", importance: "3", tag: "health", folder: { name: "Home", holds: true } })).toBeNull();
    expect(says(todo({ state: "done" }), { states: ["open", "done"] })).toBeNull();
    expect(says(todo({ state: "abandoned" }), { states: null })).toBeNull();
    expect(says(todo({ due: "2026-10-21" }), { due: "week" })).toBeNull();
    expect(says(todo({ due: "2026-10-14" }), { due: "overdue" })).toBeNull();
  });
});

describe("what a todos query narrows to, for those sentences", () => {
  const by = (query: string) => narrowingOf(query);
  it("reads a due date, a priority and a tag at the query's top as the filters they are, and keeps the query as the search", () => {
    expect(by("due:today")).toEqual({ states: ["open"], due: "today", importance: "", tag: "", folder: null, search: "due:today" });
    expect(by("due:<today").due).toBe("overdue");
    expect(by("due:today..+6d").due).toBe("week");
    expect(by("no:due").due).toBe("none");
    expect(by("-has:due").due).toBe("none");
    expect(by("priority:high").importance).toBe("3");
    expect(by("importance:1").importance).toBe("1");
    expect(by("call #Health tag:work").tag).toBe("health");
  });

  it("reads the states a query lists: open when it names none, as the server lists them", () => {
    expect(by("").states).toEqual(["open"]);
    expect(by("#work due:today").states).toEqual(["open"]);
    expect(by("is:backlog").states).toEqual(["backlog"]);
    expect(by("is:open OR is:done").states).toEqual(["open", "done"]);
    expect(by("-is:done").states).toEqual(["open", "abandoned", "backlog"]);
    expect(by("is:abandoned -is:abandoned").states).toEqual([]);
    expect(by("is:open is:done").states).toEqual([]);
    expect(by("is:archived #home").states).toEqual(["open"]);
    expect(by("is:backlog OR #home").states).toBeNull();
    expect(by("(is:done #home) OR is:open").states).toBeNull();
  });

  it("leaves what it can't say as a filter to the search", () => {
    expect(by("due:tomorrow")).toMatchObject({ due: "any", search: "due:tomorrow" });
    expect(by("due:today OR #home")).toMatchObject({ due: "any", tag: "" });
    expect(by("-#home priority:>=medium")).toMatchObject({ tag: "", importance: "" });
    expect(by("priority:urgent")).toMatchObject({ importance: "", search: "priority:urgent" });
  });

  it("says the date and the priority as the filters did, and the rest as the search", () => {
    expect(leaving(todo({ due: "2026-10-16" }), by("due:today #health"), NOW)?.says).toBe("Moved to tomorrow, so it no longer shows under Today. It leaves when you refresh.");
    expect(leaving(todo({ importance: 1 }), by("priority:high"), NOW)?.says).toBe("Set to Low, so it no longer shows under Priority: High. It leaves when you refresh.");
    expect(leaving(todo({ words: "Gym" }), by("#health"), NOW)?.says).toBe("#health was taken off, so it no longer shows under #health. It leaves when you refresh.");
    expect(leaving(todo(), by("bank due:today..+6d"), NOW)?.says).toBe("Its date was taken off, so it no longer shows under Next 7 days. It leaves when you refresh.");
    expect(leaving(todo({ due: "2026-10-15" }), by("bank due:today"), NOW)?.says).toBe("Changed, so it no longer matches “bank due:today”. It leaves when you refresh.");
    expect(leaving(todo({ words: "call", tagsElsewhere: [fromNote("work")] }), by("#work budget"), NOW)?.says).toBe("Changed, so it no longer matches “#work budget”. It leaves when you refresh.");
    expect(leaving(todo({ words: "Gym", tagsElsewhere: [fromNote("health")] }), by("#health"), NOW)?.says).toBe("Changed, so it no longer matches “#health”. It leaves when you refresh.");
    expect(leaving(todo({ words: "Gym", tagsElsewhere: [fromNote("health")] }), { ...ANY, tag: "health" }, NOW)).toBeNull();
    expect(leaving(todo(), by(""), NOW)).toBeNull();
  });
});
