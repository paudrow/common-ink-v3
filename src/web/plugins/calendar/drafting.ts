import { DAY_MINUTES } from "./layout.ts";

/*
 * What the pointer is doing on the Week and Day grids, as v1 had it. Over empty grid the half hour
 * under it is outlined. A press that moves 5px draws a draft snapped to 15 minutes in the column it
 * started in, and its release asks for the event form; a press that doesn't move is a click on that
 * half hour. A press on an event the member may change moves it, or from its bottom edge, changes
 * its end. Days are counted from the grid's fixed Sunday; minutes are from the day's midnight.
 */

/** How far a press moves before it is a drag and not a click. */
export const THRESHOLD_PX = 5;
/** What drags snap to, and what a hover or a click covers. */
export const SNAP = 15;
export const SLOT = 30;

/** An event pressed: its key, where it is on the day it was pressed on, and whether the press was on its bottom edge. */
export interface Held {
  key: string;
  start: number;
  end: number;
  edge: boolean;
  /** False for an event in a calendar the member can only read: it is never moved. */
  editable: boolean;
}

export type Draft =
  | { kind: "idle" }
  | { kind: "hover"; day: number; slot: number }
  | { kind: "pressed"; day: number; at: number; px: number; py: number; held: Held | null }
  | { kind: "drawing"; day: number; anchor: number; at: number }
  | { kind: "moving"; key: string; day: number; start: number; length: number; grab: number }
  | { kind: "resizing"; key: string; day: number; start: number; end: number }
  | { kind: "refused"; key: string };

export type Pointer =
  | { type: "hover"; day: number; at: number; overEvent: boolean }
  | { type: "leave" }
  | { type: "down"; day: number; at: number; px: number; py: number; held: Held | null }
  | { type: "move"; day: number; at: number; px: number; py: number }
  | { type: "cancel" };

/** What a release asks for. */
export type Outcome =
  | { kind: "none" }
  | { kind: "click"; day: number; start: number; end: number }
  | { kind: "open"; key: string }
  | { kind: "create"; day: number; start: number; end: number }
  | { kind: "move"; key: string; day: number; start: number }
  | { kind: "resize"; key: string; end: number }
  | { kind: "refused"; key: string };

export const IDLE: Draft = { kind: "idle" };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const snapped = (minutes: number) => Math.round(minutes / SNAP) * SNAP;
export const slotOf = (minutes: number) => clamp(Math.floor(minutes / SLOT) * SLOT, 0, DAY_MINUTES - SLOT);

/** The span a drag down a column covers between two points: the earlier floored and the later ceiled to SNAP, SNAP long at least, either way up. */
export function dragSpan(a: number, b: number): { start: number; end: number } {
  const lo = clamp(Math.floor(Math.min(a, b) / SNAP) * SNAP, 0, DAY_MINUTES - SNAP);
  const hi = Math.min(DAY_MINUTES, Math.max(lo + SNAP, Math.ceil(Math.max(a, b) / SNAP) * SNAP));
  return { start: lo, end: hi };
}

export function drafting(draft: Draft, pointer: Pointer): Draft {
  switch (pointer.type) {
    case "hover":
      if (draft.kind !== "idle" && draft.kind !== "hover") return draft;
      return pointer.overEvent ? IDLE : { kind: "hover", day: pointer.day, slot: slotOf(pointer.at) };
    case "leave":
      return draft.kind === "hover" ? IDLE : draft;
    case "cancel":
      return IDLE;
    case "down":
      return { kind: "pressed", day: pointer.day, at: pointer.at, px: pointer.px, py: pointer.py, held: pointer.held };
    case "move": {
      if (draft.kind === "pressed") {
        if (Math.hypot(pointer.px - draft.px, pointer.py - draft.py) < THRESHOLD_PX) return draft;
        const { held } = draft;
        if (!held) return { kind: "drawing", day: draft.day, anchor: draft.at, at: pointer.at };
        if (!held.editable) return { kind: "refused", key: held.key };
        if (held.edge) return drafting({ kind: "resizing", key: held.key, day: draft.day, start: held.start, end: held.end }, pointer);
        return drafting({ kind: "moving", key: held.key, day: draft.day, start: held.start, length: held.end - held.start, grab: draft.at - held.start }, pointer);
      }
      if (draft.kind === "drawing") return { ...draft, at: pointer.at };
      if (draft.kind === "moving") return { ...draft, day: pointer.day, start: clamp(snapped(pointer.at - draft.grab), 0, DAY_MINUTES - SNAP) };
      // An end is moved on the day the event is on, whatever column the pointer wanders into.
      if (draft.kind === "resizing") return { ...draft, end: Math.max(draft.start + SNAP, Math.min(DAY_MINUTES, snapped(pointer.at))) };
      return draft;
    }
  }
}

/** What letting go asks for, from the draft as it was just before. */
export function released(draft: Draft): Outcome {
  switch (draft.kind) {
    case "pressed":
      if (draft.held) return { kind: "open", key: draft.held.key };
      return { kind: "click", day: draft.day, start: slotOf(draft.at), end: slotOf(draft.at) + SLOT };
    case "drawing":
      return { kind: "create", day: draft.day, ...dragSpan(draft.anchor, draft.at) };
    case "moving":
      return { kind: "move", key: draft.key, day: draft.day, start: draft.start };
    case "resizing":
      return { kind: "resize", key: draft.key, end: draft.end };
    case "refused":
      return { kind: "refused", key: draft.key };
    default:
      return { kind: "none" };
  }
}
