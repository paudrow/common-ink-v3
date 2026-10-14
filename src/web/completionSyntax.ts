import type { CompletionItem } from "./plugin-api.ts";

/**
 * What has been typed after `trigger`, given the line up to the cursor, or null when the cursor
 * isn't after one that opens a list. A trigger opens a list only at the start of a line or after
 * a space, so the `/` of a URL, a path, a date, or a fraction opens nothing.
 */
export function typedAfter(before: string, trigger: string, spaces = false): string | null {
  for (let at = before.lastIndexOf(trigger); at >= 0; at = at === 0 ? -1 : before.lastIndexOf(trigger, at - 1)) {
    const typed = before.slice(at + trigger.length);
    if (!spaces && /\s/.test(typed)) return null;
    if (typed.startsWith(" ") || typed.includes(trigger)) continue;
    if (at === 0 || /\s/.test(before[at - 1]!)) return typed;
  }
  return null;
}

/** Blank space, a quote's `>`, and a list item's mark and task box: what may come before a trigger at the start of a line. */
const LEAD = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?$/;

/**
 * Whether the trigger `typedAfter` found starts its line, given the line up to the cursor and what
 * was typed after the trigger. For a prose trigger only there does Enter pick from the list: after
 * other words, a `/` and what follows it are as likely the member's own words.
 */
export function startsLine(before: string, typed: string, trigger: string): boolean {
  return LEAD.test(before.slice(0, before.length - typed.length - trigger.length));
}

export interface Placing {
  /** Where the trigger starts and the cursor is. */
  from: number;
  to: number;
  /** The rest of the line on each side of that. */
  before: string;
  after: string;
  /** Whether the line is the note's last. */
  last: boolean;
}

/** The edit that puts a picked item in the note in place of its trigger and what was typed, and where the cursor goes. */
export function placed(item: CompletionItem, at: Placing): { from: number; to: number; insert: string; anchor: number; head: number } {
  if (!item.block) {
    const [a, b] = item.select ?? [item.insert.length, item.insert.length];
    return { from: at.from, to: at.to, insert: item.insert, anchor: at.from + a, head: at.from + b };
  }
  // A block starts its line, so blank space before it goes, and anything else keeps its own line.
  const blank = !at.before.trim();
  const from = blank ? at.from - at.before.length : at.from;
  const lead = blank ? "" : "\n";
  // The cursor needs a line after the block to sit on, where it isn't in the block.
  const own = at.after !== "" || at.last;
  const insert = `${lead}${item.insert}${own ? "\n" : ""}`;
  const after = from + insert.length + (own ? 0 : 1);
  return { from, to: at.to, insert, anchor: after, head: after };
}
