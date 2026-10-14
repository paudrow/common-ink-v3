import { parseRule, skippedTo, type Importance, type TodoChange } from "../../plugin-api.ts";
import { addDays, dueLabel } from "./dates.ts";
import { PICKS, shortDay } from "./recurrence.ts";

export const IMPORTANCE = ["Normal", "!", "!!", "!!!"] as const;

/** The chips of a todo that open a popover to be set with. A tag's chip narrows the list instead. */
export type ChipKind = "due" | "importance" | "every";

/** A chip whose popover is open: one that sets the todo, its last-done chip, which lists its completions, or an assignee's, which lists who it can be assigned to. */
export type Opened = ChipKind | "done" | "who";

/** Which todo's chip has its popover open, by the todo's key in the list, or nothing. One at a time, in the whole app. */
export type Picking = { row: string; chip: Opened } | null;

export type PickingEvent = { type: "open" | "closed"; row: string; chip: Opened };

/**
 * Opening a chip's popover shows it, and opening the one that is open closes it. A popover tells it
 * closed when it is gone however that came about (Escape, a press outside, a pick, its chip gone),
 * which closes it here only if it is the one open: the one before a newly opened one closes after it opens.
 */
export function picking(open: Picking, { type, row, chip }: PickingEvent): Picking {
  const same = open?.row === row && open.chip === chip;
  if (type === "open") return same ? null : { row, chip };
  return same ? null : open;
}

/** What a todo's chips are set from. `every` is its rule as written after `every:`, or null. */
export interface Picked {
  due: string | null;
  importance: Importance;
  every: string | null;
}

/** One way to set a chip, as its popover offers it. */
export interface Choice {
  label: string;
  /** Said after the label, quieter, such as the date "Next week" is. */
  detail?: string;
  change: TodoChange;
  /** Whether it is what the todo says now. */
  current: boolean;
}

/**
 * What a chip's popover offers for a todo, in the order shown, on day `now`. A date of the member's own is
 * the popover's date field, and a rule of their own the recurrence popover's form.
 */
export function choicesFor(chip: ChipKind, todo: Picked, now: string): Choice[] {
  if (chip === "importance") return ([3, 2, 1, 0] as const).map((level) => ({ label: IMPORTANCE[level], change: { importance: level }, current: todo.importance === level }));
  if (chip === "every") {
    const rule = todo.every === null ? null : parseRule(todo.every);
    const next = rule && skippedTo(rule, { due: todo.due, on: now });
    return [
      ...PICKS.map(({ label, every }) => ({ label, change: { every }, current: every === todo.every })),
      ...(next ? [{ label: "Skip this one", detail: `due ${shortDay(next, now)}`, change: { skip: true }, current: false }] : []),
      ...(todo.every === null ? [] : [{ label: "Stop recurring", change: { every: null }, current: false }]),
    ];
  }
  const day = (label: string, due: string, detail?: string): Choice => ({ label, ...(detail && { detail }), change: { due }, current: todo.due === due });
  const week = addDays(now, 7);
  return [day("Today", now), day("Tomorrow", addDays(now, 1)), day("Next week", week, dueLabel(week, now)), ...(todo.due ? [{ label: "Clear", change: { due: null }, current: false }] : [])];
}

/** What each chip is called, before what it says. */
export const CHIP_NAMES: Record<ChipKind, string> = { due: "Due date", importance: "Importance", every: "Recurrence" };

/** What a chip's popover is called, for the todo whose words are these where they are said. */
export const pickerLabel = (chip: ChipKind, words?: string) => `${CHIP_NAMES[chip]}${words ? ` of ${words}` : ""}`;
