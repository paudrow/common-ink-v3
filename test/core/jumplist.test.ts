import { describe, expect, it } from "vitest";
import { EMPTY, jump, visit, type Jumplist } from "../../src/web/plugins/vim/jumplist.ts";

const visited = (...ids: string[]) => ids.reduce(visit, EMPTY);
const any = () => true;
/** Where a jump lands, or null when it goes nowhere. */
const lands = (list: Jumplist, by: -1 | 1, here: string | null, canOpen: (id: string) => boolean = any) => {
  const next = jump(list, by, here, canOpen);
  return next === list ? null : next.notes[next.at];
};

describe("the jumplist of notes", () => {
  it("remembers notes in the order they were visited, and a note shown again without leaving it once", () => {
    expect(visited("a", "b", "b", "c")).toEqual({ notes: ["a", "b", "c"], at: 2 });
    expect(visited("a", "b", "a")).toEqual({ notes: ["a", "b", "a"], at: 2 });
  });

  it("steps back and forward through them, and stops at either end", () => {
    const list = visited("a", "b", "c");
    const atB = jump(list, -1, "c", any);
    const atA = jump(atB, -1, "b", any);

    expect(atB).toEqual({ notes: ["a", "b", "c"], at: 1 });
    expect(atA).toEqual({ notes: ["a", "b", "c"], at: 0 });
    expect(lands(atA, -1, "a")).toBeNull();
    expect(lands(atA, 1, "a")).toBe("b");
    expect(lands(list, 1, "c")).toBeNull();
  });

  it("doesn't count arriving where a jump went as a visit", () => {
    const atB = jump(visited("a", "b", "c"), -1, "c", any);

    expect(visit(atB, "b")).toBe(atB);
  });

  it("drops what was ahead when a note is visited after stepping back", () => {
    const atA = jump(jump(visited("a", "b", "c"), -1, "c", any), -1, "b", any);

    expect(visit(atA, "d")).toEqual({ notes: ["a", "d"], at: 1 });
  });

  it("goes back to the note it was on from a page, which shows no note, and forward from there to the next", () => {
    const atB = jump(visited("a", "b", "c"), -1, "c", any);

    expect(lands(atB, -1, null)).toBe("b");
    expect(lands(atB, 1, null)).toBe("c");
    expect(lands(visited("a"), -1, null)).toBe("a");
    expect(lands(EMPTY, -1, null)).toBeNull();
  });

  it("steps over a note that can no longer be opened", () => {
    const list = visited("a", "gone", "c");

    expect(lands(list, -1, "c", (id) => id !== "gone")).toBe("a");
    expect(lands(visited("gone", "c"), -1, "c", (id) => id !== "gone")).toBeNull();
  });

  it("keeps the latest hundred", () => {
    const list = Array.from({ length: 130 }, (_, i) => `n${i}`).reduce(visit, EMPTY);

    expect(list.notes).toHaveLength(100);
    expect(list.notes[0]).toBe("n30");
    expect(list.notes[list.at]).toBe("n129");
  });
});
