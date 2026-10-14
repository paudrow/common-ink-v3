import { nameKey, parseRule, skippedTo, tagsOn, type Importance, type TodoChange } from "../../plugin-api.ts";
import { addDays, dueLabel } from "./dates.ts";
import { PICKS, shortDay } from "./recurrence.ts";

export const IMPORTANCE = ["Normal", "!", "!!", "!!!"] as const;

/** The chips of a todo that open a popover of choices, in a note and on the Todos page. */
export type ChipKind = "due" | "importance" | "every";

/** The chips of a row on the Todos page that open a popover: those, and Add tag. A tag's own chip narrows the list instead. */
export type RowChip = ChipKind | "tag";

/** A chip whose popover is open: one that sets the todo, or its last-done chip, which lists its completions. */
export type Opened = RowChip | "done";

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
 * the popover's date field, and a rule of their own the Repeat popover's form.
 */
export function choicesFor(chip: ChipKind, todo: Picked, now: string): Choice[] {
  if (chip === "importance") return ([3, 2, 1, 0] as const).map((level) => ({ label: IMPORTANCE[level], change: { importance: level }, current: todo.importance === level }));
  if (chip === "every") {
    const rule = todo.every === null ? null : parseRule(todo.every);
    const next = rule && skippedTo(rule, { due: todo.due, on: now });
    return [
      ...PICKS.map(({ label, every }) => ({ label, change: { every }, current: every === todo.every })),
      ...(next ? [{ label: "Skip this one", detail: `due ${shortDay(next, now)}`, change: { skip: true }, current: false }] : []),
      ...(todo.every === null ? [] : [{ label: "Stop repeating", change: { every: null }, current: false }]),
    ];
  }
  const day = (label: string, due: string, detail?: string): Choice => ({ label, ...(detail && { detail }), change: { due }, current: todo.due === due });
  const week = addDays(now, 7);
  return [day("Today", now), day("Tomorrow", addDays(now, 1)), day("Next week", week, dueLabel(week, now)), ...(todo.due ? [{ label: "Clear", change: { due: null }, current: false }] : [])];
}

/** What each chip is called, before what it says. */
export const CHIP_NAMES: Record<RowChip, string> = { due: "Due date", importance: "Importance", every: "Repeat", tag: "Tag" };

/** What a chip's popover is called, for the todo whose words are these where they are said. */
export const pickerLabel = (chip: RowChip, words?: string) => `${CHIP_NAMES[chip]}${words ? ` of ${words}` : ""}`;

/** The tag typed into Add tag, without its #, or null when it can't be one: a tag is one word, and not only digits. */
export function typedTag(typed: string): string | null {
  const name = typed.trim().replace(/^#/, "");
  const found = tagsOn(`#${name}`);
  return found.length === 1 && found[0]!.name === name ? name : null;
}

/** A todo's words with a tag written after them, or as they are when they have it. */
export const tagged = (words: string, name: string): string => (tagsOn(words).some((tag) => nameKey(tag.name) === nameKey(name)) ? words : `${words} #${name}`.trim());
