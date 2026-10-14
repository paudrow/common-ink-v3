import type { Formula } from "../math/syntax.ts";

/** Draws a formula into an element. */
export type DrawMath = (el: HTMLElement, formula: Formula) => void;

let drawing: DrawMath | null = null;
const listeners = new Set<() => void>();

/**
 * How a formula is drawn outside a note's lines, as in a drawn table's cells: set by the LaTeX plugin
 * once its drawing is loaded, and null while it is off or not loaded, when a formula is shown as written.
 */
export const drawnMath = {
  get: () => drawing,
  set(draw: DrawMath | null) {
    drawing = draw;
    for (const listener of listeners) listener();
  },
  /** Calls `listener` each time formulas are drawn another way. */
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};
