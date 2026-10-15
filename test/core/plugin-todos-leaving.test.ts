import { describe, expect, it } from "vitest";
import { leaving, type Narrowing } from "../../src/web/plugins/todos/leaving.ts";

const NOW = "2026-10-15";
const ANY: Narrowing = { completed: false, due: "any", importance: "", tag: "", folder: null };
const todo = (over: Partial<{ done: boolean; due: string | null; importance: 0 | 1 | 2 | 3; words: string }> = {}) => ({ done: false, due: null, importance: 0 as const, words: "Gym #health", ...over });
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
    expect(says(todo({ done: true }), {})).toBe("Checked off, so it no longer shows with the open todos. It leaves when you refresh.");
    expect(says(todo(), { search: "bank" })).toBe("Changed, so it no longer matches “bank”. It leaves when you refresh.");
  });

  it("names the first way it fails, and nothing for a row that still matches", () => {
    expect(leaving(todo({ due: "2026-10-16", importance: 1 }), { ...ANY, due: "today", importance: "3" }, NOW)?.reason).toBe("date");
    expect(leaving(todo({ due: "2026-10-15", importance: 1 }), { ...ANY, due: "today", importance: "3" }, NOW)?.reason).toBe("priority");
    expect(says(todo({ due: "2026-10-15", importance: 3, words: "Gym #HEALTH" }), { due: "today", importance: "3", tag: "health", folder: { name: "Home", holds: true } })).toBeNull();
    expect(says(todo({ done: true }), { completed: true })).toBeNull();
    expect(says(todo({ due: "2026-10-21" }), { due: "week" })).toBeNull();
    expect(says(todo({ due: "2026-10-14" }), { due: "overdue" })).toBeNull();
  });
});
