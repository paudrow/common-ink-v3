import { DAY_NAMES, nameKey, ordinal, parseRule, skippedTo, tagsOn, writeRule, type Importance, type TodoChange } from "../../plugin-api.ts";
import { addDays, dueLabel } from "./dates.ts";
import { shortDay } from "./recurrence.ts";

/** A todo's priority in words, by its level: the note writes it `!`, `!!` or `!!!` after the checkbox, and nothing for None. */
export const PRIORITY = ["None", "Low", "Medium", "High"] as const;

/** The chips of a todo that open a popover of choices, in a note and on the Todos page. */
export type ChipKind = "due" | "importance" | "every";

/** The chips of a row on the Todos page that open a popover: those, and Add tag. A tag's own chip narrows the list instead. */
export type RowChip = ChipKind | "tag";

/** What a row's popover can be open for: one of its chips, or its last-done chip, which lists its completions. */
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
 * What the priority or the due date chip's popover offers for a todo, in the order shown, on day `now`.
 * A date of the member's own is the popover's date field. A todo that repeats can also skip to its next
 * date, with nothing checked off.
 */
export function choicesFor(chip: Exclude<ChipKind, "every">, todo: Picked, now: string): Choice[] {
  if (chip === "importance") return ([3, 2, 1, 0] as const).map((level) => ({ label: PRIORITY[level], change: { importance: level }, current: todo.importance === level }));
  const day = (label: string, due: string, detail?: string): Choice => ({ label, ...(detail && { detail }), change: { due }, current: todo.due === due });
  const week = addDays(now, 7);
  const rule = todo.every === null ? null : parseRule(todo.every);
  const next = rule && skippedTo(rule, { due: todo.due, on: now });
  return [
    day("Today", now),
    day("Tomorrow", addDays(now, 1)),
    day("Next week", week, dueLabel(week, now)),
    ...(next ? [{ label: `Skip to ${shortDay(next, now)}`, change: { skip: true }, current: false }] : []),
    ...(todo.due ? [{ label: "Clear", change: { due: null }, current: false }] : []),
  ];
}

/** One of the rules the Repeat popover lists; `every` is null for Doesn't repeat and for Custom, which opens the form of any rule. */
export interface Repeat {
  label: string;
  every: string | null;
  custom?: true;
}

/**
 * The rules the Repeat popover lists, for a todo due on `due`: Weekly and Monthly say the day the due
 * date gives them. A todo with no due date takes its days from when it is done, so they name none.
 */
export function repeats(due: string | null): Repeat[] {
  const at = due && new Date(`${due}T00:00:00Z`);
  return [
    { label: "Doesn't repeat", every: null },
    { label: "Daily", every: "1d" },
    { label: "Weekdays", every: "mon,tue,wed,thu,fri" },
    { label: at ? `Weekly on ${DAY_NAMES[at.getUTCDay()]}` : "Weekly", every: "1w" },
    { label: at ? `Monthly on the ${ordinal(at.getUTCDate())}` : "Monthly", every: "1m" },
    { label: "Yearly", every: "1y" },
    { label: "Custom", every: null, custom: true },
  ];
}

/** The rule as its token writes it, the one way each rule is written, or null for none, or for what isn't a rule. */
const written = (every: string | null) => {
  const rule = every === null ? null : parseRule(every);
  return rule && writeRule(rule);
};

/** Whether two rules as written are the same rule, or both none. */
export const sameRule = (a: string | null, b: string | null) => a === b || (written(a) !== null && written(a) === written(b));

/** Which of `repeats` a rule is: the one that writes it, Doesn't repeat for none, and Custom for any other. */
export function repeatOf(every: string | null, listed: readonly Repeat[]): Repeat {
  if (every === null) return listed[0]!;
  return listed.find((repeat) => !repeat.custom && repeat.every !== null && written(repeat.every) === written(every)) ?? listed.at(-1)!;
}

/** What each chip is called, before what it says. */
export const CHIP_NAMES: Record<RowChip, string> = { due: "Due date", importance: "Priority", every: "Repeat", tag: "Tag" };

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
