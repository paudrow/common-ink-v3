/*
 * The Week and Day grids slide sideways as macOS Calendar's week view does: a sideways wheel or
 * trackpad scroll (or shift and the wheel) moves the days continuously, then settles on a day's
 * edge, and the buttons and keys glide to theirs. Where the days are is `x`, the first day in view
 * counted in days from a fixed Sunday, fractional while they move. Nothing here touches the page.
 */

/** A wheel gesture is one run of events with no gap longer than this; its axis is decided by its first event. */
export const GESTURE_GAP_MS = 200;
/** How long after the last wheel event of a run the days start to settle. A trackpad's own momentum keeps the run going. */
export const IDLE_MS = 90;
/** How far the speed of the last moments carries the settling, in ms of travel, and at most half a day either way. */
const CARRY_MS = 80;
const MOST_CARRY = 0.5;
/** A slide that has gone this far past the edge it left, in pixels, or half a day if that is less, goes on to the next edge: on a day as wide as the Day view's, half a day is a long way to swipe. */
const COMMIT_PX = 72;
/** A glide that would pass more days than this starts this many days short of where it lands. */
const FARTHEST_GLIDE = 7;

export type Motion =
  | { kind: "still" }
  /** Moving under a wheel. `velocity` is in days a millisecond, smoothed over the last few events; `heading` is which way the last event moved them, and `column` a day's width in pixels. */
  | { kind: "wheeling"; at: number; velocity: number; heading: -1 | 0 | 1; column: number }
  /** Settling eases out from where a wheel left the days; a glide asked for by a button or key eases in and out. */
  | { kind: "gliding"; from: number; to: number; start: number; duration: number; settling: boolean };

export interface Sideways {
  x: number;
  motion: Motion;
  /** The axis the wheel gesture under way is locked to, and when it last had an event. */
  axis: "x" | "y" | null;
  axisAt: number;
}

export type Push =
  /** A wheel event, in pixels, with the width of one day in pixels. */
  | { type: "wheel"; dx: number; dy: number; shift: boolean; at: number; column: number }
  /** An animation frame. */
  | { type: "frame"; at: number }
  /** Glide to a first day, as the buttons and keys do. */
  | { type: "go"; to: number; at: number };

export const still = (x: number): Sideways => ({ x, motion: { kind: "still" }, axis: null, axisAt: -Infinity });

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

function glide(from: number, to: number, start: number, duration: number, settling: boolean): Motion {
  return from === to ? { kind: "still" } : { kind: "gliding", from, to, start, duration, settling };
}

/** The day the days settle on: the nearest edge, nudged the way they were moving, or the next edge the way they were heading once they went far enough past the one they left. */
export function settleOn(x: number, velocity: number, heading: -1 | 0 | 1 = 0, column = 0): number {
  const carry = Math.max(-MOST_CARRY, Math.min(MOST_CARRY, velocity * CARRY_MS));
  const left = heading > 0 ? Math.floor(x) : Math.ceil(x);
  if (heading !== 0 && Math.abs(x - left) * column >= Math.min(COMMIT_PX, column / 2)) return left + heading;
  return Math.round(x + carry);
}

export function sideways(state: Sideways, push: Push): Sideways {
  if (push.type === "wheel") {
    const fresh = state.axis === null || push.at - state.axisAt > GESTURE_GAP_MS;
    const axis = fresh ? (push.shift || Math.abs(push.dx) > Math.abs(push.dy) ? "x" : "y") : state.axis!;
    if (axis === "y") return { ...state, axis, axisAt: push.at };
    // Shift turns a plain wheel sideways; where the browser already did that, dx carries it.
    const delta = push.dx !== 0 ? push.dx : push.shift ? push.dy : 0;
    const days = delta / push.column;
    const x = position(state, push.at) + days;
    // The first event of a run says nothing of speed; one notch of a mouse wheel then settles on the nearest day.
    const was = state.motion.kind === "wheeling" && push.at - state.motion.at < IDLE_MS ? state.motion : null;
    const velocity = was ? was.velocity * 0.6 + (days / Math.max(8, push.at - was.at)) * 0.4 : 0;
    const heading = days > 0 ? 1 : days < 0 ? -1 : was ? was.heading : 0;
    return { x, motion: { kind: "wheeling", at: push.at, velocity, heading, column: push.column }, axis, axisAt: push.at };
  }
  if (push.type === "go") {
    const from = position(state, push.at);
    const far = Math.abs(push.to - from) > FARTHEST_GLIDE * 3;
    const start = far ? push.to - Math.sign(push.to - from) * FARTHEST_GLIDE : from;
    return { x: start, motion: glide(start, push.to, push.at, 240 + 20 * Math.min(FARTHEST_GLIDE, Math.abs(push.to - start)), false), axis: state.axis, axisAt: state.axisAt };
  }
  const { motion } = state;
  if (motion.kind === "wheeling" && push.at - motion.at >= IDLE_MS) {
    const to = settleOn(state.x, motion.velocity, motion.heading, motion.column);
    return { ...state, motion: glide(state.x, to, push.at, Math.min(420, 160 + 260 * Math.abs(to - state.x)), true) };
  }
  if (motion.kind === "gliding") {
    if (push.at >= motion.start + motion.duration) return { ...state, x: motion.to, motion: { kind: "still" } };
    return { ...state, x: position(state, push.at) };
  }
  return state;
}

/** Where the days are at `at`: a glide is worked out from its start, so a frame that comes late lands where it should. */
export function position(state: Sideways, at: number): number {
  const { motion } = state;
  if (motion.kind !== "gliding") return state.x;
  const t = Math.min(1, Math.max(0, (at - motion.start) / motion.duration));
  return motion.from + (motion.to - motion.from) * (motion.settling ? easeOut : easeInOut)(t);
}

/** The first day of a window of days drawn around `x`: re-centred only once `x` has gone `buffer / 2` days from where it was. */
export function windowStart(current: number, x: number, buffer: number): number {
  const centre = current + buffer;
  return Math.abs(x - centre) > buffer / 2 ? Math.round(x) - buffer : current;
}
