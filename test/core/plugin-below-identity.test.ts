import { describe, expect, it } from "vitest";
import { keep, type Kept } from "../../src/web/belowIdentity.ts";

const video = (id: number, from: number, source = "a"): Kept => ({ id, from, name: "youtube", source });
const fresh = () => {
  let next = 100;
  return () => next++;
};
const shifted = (by: number, after = 0) => (pos: number) => (pos >= after ? pos + by : pos);

describe("which embed is which after a change", () => {
  it("is the same one when the text before it grew or shrank", () => {
    expect(keep([video(1, 10), video(2, 50, "b")], [{ from: 17, name: "youtube", source: "a" }, { from: 57, name: "youtube", source: "b" }], shifted(7), fresh())).toEqual([1, 2]);
    expect(keep([video(1, 10)], [{ from: 4, name: "youtube", source: "a" }], shifted(-6), fresh())).toEqual([1]);
  });

  it("tells two embeds that say the same thing apart by where they are", () => {
    const before = [video(1, 10), video(2, 50)];
    expect(keep(before, [{ from: 10, name: "youtube", source: "a" }, { from: 30, name: "youtube", source: "a" }, { from: 70, name: "youtube", source: "a" }], shifted(20, 20), fresh())).toEqual([1, 100, 2]);
    // The first was deleted: the one left is the second, not the first drawn over.
    expect(keep(before, [{ from: 10, name: "youtube", source: "a" }], (pos) => (pos === 50 ? 10 : 0), fresh())).toEqual([2]);
  });

  it("keeps what a change that replaced the whole text didn't alter", () => {
    const everything = () => 0;
    expect(keep([video(1, 10), video(2, 50, "b")], [{ from: 12, name: "youtube", source: "b" }, { from: 90, name: "youtube", source: "a" }], everything, fresh())).toEqual([2, 1]);
  });

  it("is the same one, with another source, when what it says changed where it is", () => {
    expect(keep([video(1, 10), video(2, 50, "b")], [{ from: 10, name: "youtube", source: "a2" }, { from: 51, name: "youtube", source: "b" }], shifted(1, 11), fresh())).toEqual([1, 2]);
  });

  it("is a new one when it is new, or another embed took its place", () => {
    expect(keep([], [{ from: 3, name: "youtube", source: "a" }], shifted(0), fresh())).toEqual([100]);
    expect(keep([video(1, 10)], [{ from: 10, name: "social", source: "a" }], shifted(0), fresh())).toEqual([100]);
  });
});
