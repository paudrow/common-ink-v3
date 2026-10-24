import { describe, expect, it } from "vitest";
import { NONE, extend, follow, pruned, toggle, visual, type Picked } from "../../src/web/plugins/lib/selecting.ts";

const ORDER = ["a", "b", "c", "d", "e"];
const picked = (anchor: string | null, rows: string[], isVisual = false): Picked<string> => ({ anchor, rows, visual: isVisual });

describe("picking rows of a list", () => {
  it("widens from the row focus is on, and from the anchor after, down and back up", () => {
    const once = extend(ORDER, NONE, "b", "c");
    expect(once).toEqual(picked("b", ["b", "c"]));
    expect(extend(ORDER, once, "c", "d")).toEqual(picked("b", ["b", "c", "d"]));
    expect(extend(ORDER, once, "c", "b")).toEqual(picked("b", ["b"]));
    expect(extend(ORDER, once, "b", "a")).toEqual(picked("b", ["a", "b"]));
  });

  it("takes a range from the anchor to a row clicked, whichever comes first", () => {
    expect(extend(ORDER, picked("d", ["d"]), "a", "b")).toEqual(picked("d", ["b", "c", "d"]));
    // The anchor left the list: the range is from where focus is.
    expect(extend(ORDER, picked("z", ["z"]), "a", "c")).toEqual(picked("a", ["a", "b", "c"]));
  });

  it("picks a row by itself or lets it go, and the anchor is that row", () => {
    const two = toggle(toggle(NONE, "b"), "d");
    expect(two).toEqual(picked("d", ["b", "d"]));
    expect(toggle(two, "b")).toEqual(picked("b", ["d"]));
    expect(toggle(picked("b", ["b"]), "b")).toEqual(NONE);
    expect(extend(ORDER, two, "a", "e")).toEqual(picked("d", ["d", "e"]));
  });

  it("begins visual line selection on a row, widens it with each move, and ends it on V again", () => {
    const begun = visual(NONE, "b");
    expect(begun).toEqual(picked("b", ["b"], true));
    const down = follow(ORDER, begun, "d");
    expect(down).toEqual(picked("b", ["b", "c", "d"], true));
    expect(follow(ORDER, down, "a")).toEqual(picked("b", ["a", "b"], true));
    expect(visual(down, "d")).toEqual(NONE);
  });

  it("leaves what is picked as it is on a move outside visual", () => {
    const two = picked("b", ["b", "c"]);
    expect(follow(ORDER, two, "e")).toBe(two);
  });

  it("lets go of rows that left the list, keeps the rest in the list's order, and is the same when nothing left", () => {
    expect(pruned(["a", "c", "d"], picked("b", ["d", "b", "a"]))).toEqual(picked("a", ["a", "d"]));
    expect(pruned(["a", "c"], picked("b", ["b"], true))).toEqual(NONE);
    const kept = picked("a", ["a", "c"]);
    expect(pruned(ORDER, kept)).toBe(kept);
  });
});
