import { describe, expect, it } from "vitest";
import { IDLE, dragSpan, drafting, released, slotOf, type Draft, type Held, type Pointer } from "../../src/web/plugins/calendar/drafting.ts";

const run = (pointers: Pointer[], from: Draft = IDLE) => pointers.reduce(drafting, from);
const lunch: Held = { key: "lunch", start: 720, end: 780, edge: false, editable: true };

describe("the pointer on the grid", () => {
  it("outlines the half hour under it over empty grid, and nothing over an event", () => {
    expect(run([{ type: "hover", day: 3, at: 9 * 60 + 47, overEvent: false }])).toEqual({ kind: "hover", day: 3, slot: 570 });
    expect(run([{ type: "hover", day: 3, at: 600, overEvent: true }])).toEqual(IDLE);
    expect(run([{ type: "hover", day: 3, at: 600, overEvent: false }, { type: "leave" }])).toEqual(IDLE);
    expect([slotOf(0), slotOf(1439), slotOf(-5)]).toEqual([0, 1410, 0]);
  });

  it("takes a press that moves under 5px as a click on that half hour", () => {
    const draft = run([{ type: "down", day: 3, at: 615, px: 100, py: 300, held: null }, { type: "move", day: 3, at: 617, px: 103, py: 303 }]);
    expect(draft.kind).toBe("pressed");
    expect(released(draft)).toEqual({ kind: "click", day: 3, start: 600, end: 630 });
  });

  it("draws a draft once a press moves 5px, snapped to 15 minutes either way up, and asks for the form on release", () => {
    const down: Pointer = { type: "down", day: 3, at: 9 * 60 + 7, px: 100, py: 300, held: null };
    const draft = run([down, { type: "move", day: 3, at: 10 * 60 + 2, px: 100, py: 344 }]);
    expect(draft).toEqual({ kind: "drawing", day: 3, anchor: 547, at: 602 });
    expect(released(draft)).toEqual({ kind: "create", day: 3, start: 540, end: 615 });
    const upward = run([down, { type: "move", day: 5, at: 8 * 60 + 20, px: 200, py: 250 }]);
    expect(released(upward)).toEqual({ kind: "create", day: 3, start: 495, end: 555 });
    expect([dragSpan(600, 600), dragSpan(1435, 1439), dragSpan(-20, 10)]).toEqual([{ start: 600, end: 615 }, { start: 1425, end: 1440 }, { start: 0, end: 15 }]);
  });

  it("drops a drag on Escape, so releasing after it asks for nothing", () => {
    const draft = run([{ type: "down", day: 3, at: 600, px: 0, py: 0, held: null }, { type: "move", day: 3, at: 700, px: 0, py: 80 }, { type: "cancel" }]);
    expect(released(draft)).toEqual({ kind: "none" });
  });

  it("moves a pressed event to the column and quarter hour under the pointer, keeping where it was held and its length", () => {
    const draft = run([{ type: "down", day: 2, at: 740, px: 0, py: 0, held: lunch }, { type: "move", day: 4, at: 812, px: 300, py: 50 }]);
    expect(draft).toEqual({ kind: "moving", key: "lunch", day: 4, start: 795, length: 60, grab: 20 });
    expect(released(draft)).toEqual({ kind: "move", key: "lunch", day: 4, start: 795 });
    expect(released(run([{ type: "down", day: 2, at: 740, px: 0, py: 0, held: lunch }]))).toEqual({ kind: "open", key: "lunch" });
  });

  it("changes only the end from the bottom edge, a quarter hour long at least, on the event's own day", () => {
    const edge = { ...lunch, edge: true };
    const longer = run([{ type: "down", day: 2, at: 778, px: 0, py: 0, held: edge }, { type: "move", day: 5, at: 851, px: 300, py: 60 }]);
    expect(released(longer)).toEqual({ kind: "resize", key: "lunch", end: 855 });
    const shorter = run([{ type: "down", day: 2, at: 778, px: 0, py: 0, held: edge }, { type: "move", day: 2, at: 600, px: 0, py: -100 }]);
    expect(released(shorter)).toEqual({ kind: "resize", key: "lunch", end: 735 });
  });

  it("never moves an event the member can only read, and says so on release", () => {
    const draft = run([{ type: "down", day: 2, at: 740, px: 0, py: 0, held: { ...lunch, editable: false } }, { type: "move", day: 4, at: 812, px: 300, py: 50 }]);
    expect(released(draft)).toEqual({ kind: "refused", key: "lunch" });
  });
});
