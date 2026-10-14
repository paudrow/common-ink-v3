import { describe, expect, it } from "vitest";
import { IDLE_MS, position, settleOn, sideways, still, windowStart, type Push, type Sideways } from "../../src/web/plugins/calendar/sideways.ts";

const COLUMN = 100;
const run = (state: Sideways, pushes: Push[]) => pushes.reduce(sideways, state);
const wheel = (at: number, dx: number, dy = 0, shift = false): Push => ({ type: "wheel", dx, dy, shift, at, column: COLUMN });
/** Frames every 16 ms from `from` until the days are still, or `until`. */
function frames(state: Sideways, from: number, until = from + 3000): Sideways {
  for (let at = from; at <= until && state.motion.kind !== "still"; at += 16) state = sideways(state, { type: "frame", at });
  return state;
}

describe("the days slid sideways", () => {
  it("follow a sideways wheel continuously, a pixel at a time", () => {
    const moved = run(still(100), [wheel(0, 30), wheel(16, 45), wheel(32, 5)]);
    expect(moved.x).toBeCloseTo(100.8, 9);
    expect([moved.motion.kind, moved.axis]).toEqual(["wheeling", "x"]);
  });

  it("settle on a whole day once the wheel stops, the nearest, nudged the way they were moving", () => {
    const slow = frames(run(still(100), [wheel(0, 20), wheel(60, 10)]), 60 + IDLE_MS);
    expect([slow.x, slow.motion.kind]).toEqual([100, "still"]);
    const notch = frames(run(still(100), [wheel(0, 0, 60, true)]), IDLE_MS);
    expect(notch.x, "one notch of shift and the wheel, 0.6 of a day, settles on the next day").toBe(101);
    const flung = frames(run(still(100), [wheel(0, 15), wheel(8, 15), wheel(16, 15)]), 16 + IDLE_MS);
    expect([flung.x, flung.motion.kind]).toEqual([101, "still"]);
    const back = frames(run(still(100), [wheel(0, -80), wheel(16, -10)]), 16 + IDLE_MS);
    expect(back.x).toBe(99);
    expect([settleOn(3.4, 0), settleOn(3.4, 0.002), settleOn(3.6, -0.002), settleOn(3.2, 1)]).toEqual([3, 4, 3, 4]);
  });

  it("move only while the wheel runs: a frame before it has been idle long enough leaves them where they are", () => {
    const moving = run(still(100), [wheel(0, 50)]);
    expect(sideways(moving, { type: "frame", at: IDLE_MS - 1 })).toBe(moving);
  });

  it("lock each gesture to the axis its first event leans to, so a sideways scroll never moves the hours and an up-and-down one never moves the days", () => {
    const sideway = run(still(100), [wheel(0, 40, 10), wheel(16, 5, 60), wheel(32, 0, 80)]);
    expect([sideway.axis, sideway.x]).toEqual(["x", 100.45]);
    const upDown = run(still(100), [wheel(0, 10, 40), wheel(16, 90, 5)]);
    expect([upDown.axis, upDown.x, upDown.motion.kind]).toEqual(["y", 100, "still"]);
    const later = run(upDown, [wheel(16 + 300, 50, 0)]);
    expect([later.axis, later.x]).toEqual(["x", 100.5]);
  });

  it("take shift and a plain wheel as sideways", () => {
    expect(run(still(100), [wheel(0, 0, 100, true)]).x).toBe(101);
  });

  it("glide to where a button or key sends them, by whole days, and a glide of months starts a week short", () => {
    const next = run(still(100), [{ type: "go", to: 107, at: 0 }]);
    expect(next.motion.kind).toBe("gliding");
    const halfway = position(next, 150);
    expect(halfway).toBeGreaterThan(100);
    expect(halfway).toBeLessThan(107);
    expect(frames(next, 0).x).toBe(107);
    const far = run(still(100), [{ type: "go", to: 9, at: 0 }]);
    expect(far.motion).toMatchObject({ kind: "gliding", from: 16, to: 9 });
  });

  it("take up from where a glide is when the wheel comes back mid-way", () => {
    const gliding = run(still(100), [{ type: "go", to: 107, at: 0 }]);
    const caught = sideways(gliding, wheel(120, 10));
    expect(caught.x).toBeCloseTo(position(gliding, 120) + 0.1, 9);
    expect(caught.motion.kind).toBe("wheeling");
  });

  it("re-centre the window of days drawn only once they have gone half its spare days from its middle", () => {
    expect([windowStart(86, 100, 14), windowStart(86, 106.9, 14), windowStart(86, 107.2, 14), windowStart(86, 92.6, 14)]).toEqual([86, 86, 93, 79]);
  });
});
