/** How far a popover is from what it hangs from. */
const GAP = 4;
/** How far a popover keeps from the window's edges. */
export const EDGE = 8;

/**
 * Places `el`, laid over the app, hanging from `anchor`: under it, or above it where there is no room
 * under it, from its left edge, and in the window. Where it fits on neither side it is on the side with
 * more room, as tall as that room, and scrolls: never over its anchor, so the thing it is for stays in sight.
 */
export function hang(el: HTMLElement, anchor: HTMLElement): void {
  const at = anchor.getBoundingClientRect();
  const width = el.getBoundingClientRect().width;
  // Its whole height, however much of it is shown now.
  const height = el.scrollHeight;
  const below = at.bottom + GAP;
  const roomBelow = innerHeight - EDGE - below;
  const roomAbove = at.top - GAP - EDGE;
  const under = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
  const room = under ? roomBelow : roomAbove;
  el.style.maxHeight = height > room ? `${Math.max(room, 0)}px` : "";
  el.style.left = `${Math.max(EDGE, Math.min(at.left, innerWidth - EDGE - width))}px`;
  el.style.top = `${under ? below : Math.max(EDGE, at.top - GAP - Math.min(height, room))}px`;
}
