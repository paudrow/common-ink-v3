/** How far the pointer goes from where it was pressed before the press is a drag and not a click. */
const THRESHOLD_PX = 4;

export interface Point {
  x: number;
  y: number;
}

export interface Drag {
  /** Once the pointer has gone past the threshold. */
  start(): void;
  /** Where the pointer is, on each move from the start on. What is dragged shows here where it would land. */
  move(at: Point): void;
  /** Released after a start: what was shown is where it lands. */
  drop(): void;
  /** Escape, or the pointer taken away by the browser: it lands nowhere, and everything is as before the start. */
  cancel(): void;
}

/**
 * Follows a press of the primary button through to a drag, for anything dragged to a place: nothing
 * happens until the pointer has moved past a threshold, it is followed wherever it goes until it is
 * released, and Escape lets go. Where it would land, and how that snaps, is the caller's: it is told
 * where the pointer is and draws that.
 *
 * It listens on the window and not by capturing the pointer on the pressed element: a drop preview
 * often moves that element in the page, which would take the capture, and the drag, away.
 */
export function followDrag(event: { button: number; pointerId: number; clientX: number; clientY: number; preventDefault(): void }, drag: Drag) {
  if (event.button !== 0) return;
  event.preventDefault();
  const from = { x: event.clientX, y: event.clientY };
  let started = false;

  const moved = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    if (!started && Math.hypot(e.clientX - from.x, e.clientY - from.y) < THRESHOLD_PX) return;
    if (!started) drag.start();
    started = true;
    drag.move({ x: e.clientX, y: e.clientY });
  };
  const end = (dropped: boolean) => {
    removeEventListener("pointermove", moved);
    removeEventListener("pointerup", released);
    removeEventListener("pointercancel", lost);
    removeEventListener("keydown", escaped, true);
    if (started) (dropped ? drag.drop : drag.cancel)();
  };
  const released = (e: PointerEvent) => e.pointerId === event.pointerId && end(true);
  const lost = (e: PointerEvent) => e.pointerId === event.pointerId && end(false);
  const escaped = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  };
  addEventListener("pointermove", moved);
  addEventListener("pointerup", released);
  addEventListener("pointercancel", lost);
  addEventListener("keydown", escaped, true);
}
