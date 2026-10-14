export type Move = "down" | "up" | "first" | "last" | "halfDown" | "halfUp";

/**
 * The row a move ends on, of `count` rows. `at` is the row that has focus, or -1 when none has: a
 * step then lands on `resting`, the row the list was last left on, so the first j goes into a list
 * and not past its first row. `half` is how many rows half a page is.
 */
export function land(move: Move, at: number, count: number, resting: number, half: number): number {
  if (!count) return -1;
  if (move === "first") return 0;
  if (move === "last") return count - 1;
  if (at < 0) return Math.min(Math.max(resting, 0), count - 1);
  const by = { down: 1, up: -1, halfDown: half, halfUp: -half }[move];
  return Math.min(Math.max(at + by, 0), count - 1);
}

export type Side = "left" | "down" | "up" | "right";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Which box is next to `boxes[from]` on a side, or -1: the nearest of those that lie wholly beyond
 * that side, and of two as near, the one that shares more of the edge. A box that lies over another,
 * as a panel over the page does, has that one next to it on each side the other reaches past it.
 */
export function toward(boxes: readonly Box[], from: number, side: Side): number {
  const here = boxes[from]!;
  const across = side === "left" || side === "right";
  const beyond = (b: Box) => ({ left: here.left - b.right, right: b.left - here.right, up: here.top - b.bottom, down: b.top - here.bottom })[side];
  const shared = (b: Box) => (across ? Math.min(b.bottom, here.bottom) - Math.max(b.top, here.top) : Math.min(b.right, here.right) - Math.max(b.left, here.left));
  const under = (b: Box) =>
    (across ? b.left <= here.left && b.right >= here.right : b.top <= here.top && b.bottom >= here.bottom) &&
    ({ left: b.left < here.left - 1, right: b.right > here.right + 1, up: b.top < here.top - 1, down: b.bottom > here.bottom + 1 })[side];
  const gap = (b: Box) => (under(b) ? 0 : beyond(b));
  let best = -1;
  boxes.forEach((box, i) => {
    if (i === from || gap(box) < -1) return;
    const than = boxes[best];
    if (!than || gap(box) < gap(than) - 1 || (Math.abs(gap(box) - gap(than)) <= 1 && shared(box) > shared(than))) best = i;
  });
  return best;
}
