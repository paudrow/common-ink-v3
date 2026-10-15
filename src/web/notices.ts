import type { Notice } from "./plugin-api.ts";

/** A notice as it is shown: one card in the stack, with its own id so a newer one saying the same is drawn anew. */
export interface Told {
  id: number;
  notice: Notice;
}

/** The most cards shown at once. A newer one sends the oldest away. */
export const MOST_SHOWN = 3;

/**
 * The stack with `next` added at its foot. One saying what a card shown says takes that card's place,
 * so a second "Task completed" is not stacked over the first, and past `MOST_SHOWN` the oldest goes.
 */
export function stacked(shown: readonly Told[], next: Told): Told[] {
  const same = shown.findIndex((t) => t.notice.message === next.notice.message);
  if (same >= 0) return shown.map((t, i) => (i === same ? next : t));
  return [...shown, next].slice(-MOST_SHOWN);
}
