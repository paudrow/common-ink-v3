import { describe, expect, it } from "vitest";
import { draggedTo, foldsAt, grabbed, type Dragged } from "../../src/web/sideDrag.ts";

const SIDE = { min: 150, max: 480, folded: 44 };
/** Where each width the pointer asks for leaves a side, one after another. */
const through = (kept: number, from: Dragged, ...asked: number[]) => asked.map((at) => (from = draggedTo(SIDE, kept, from, at)));
const shown = ({ open, width }: Dragged) => (open ? width : "folded");

describe("a side dragged by its edge", () => {
  it("follows the pointer between its least and greatest widths", () => {
    expect(through(216, grabbed(true, 216), 300, 600, 151, 120).map(shown)).toEqual([300, 480, 151, 150]);
  });

  it("folds half way from its least width to its bar, less the slack, and is as wide as it was kept when it opens", () => {
    expect(foldsAt(SIDE)).toBe(97);
    expect(through(216, grabbed(true, 216), 90, 85, 84).map(shown)).toEqual([150, 150, "folded"]);
    expect(draggedTo(SIDE, 216, grabbed(true, 216), 0)).toEqual({ open: false, width: 216, follows: false });
  });

  it("stays as it is while the pointer is within the slack of where it folds", () => {
    expect(through(216, grabbed(true, 216), 84, 97, 109, 90, 109).map(shown)).toEqual(["folded", "folded", "folded", "folded", "folded"]);
    expect(through(216, grabbed(false, 216), 110, 97, 85, 100, 84, 100).map(shown)).toEqual([216, 216, 216, 216, "folded", "folded"]);
  });

  it("opens as wide as it was kept, and follows the pointer once the pointer is out that far", () => {
    expect(through(216, grabbed(false, 216), 60, 110, 180, 215, 216, 300, 170).map(shown)).toEqual(["folded", 216, 216, 216, 216, 300, 170]);
  });

  it("is given its kept width back when a drag that narrowed it folds it", () => {
    expect(through(300, grabbed(true, 300), 200, 60, 120).map(({ open, width }) => [open, width])).toEqual([
      [true, 200],
      [false, 300],
      [true, 300],
    ]);
  });
});
