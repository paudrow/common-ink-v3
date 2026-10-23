import { linesOutsideCode } from "./lines.ts";
import { linksIn, linksOn, type WrittenLink } from "./links.ts";
import { blanked, codeSpans } from "./spans.ts";
import { isDay } from "./todos.ts";

/**
 * A day a note links, and the time of day on it where one is written: `[[2026-10-21]]` or
 * `[[2026-10-21 15:00]]`, a calendar day and a clock's time where the member is, with no time zone,
 * as a due date is a day with none. A date link goes to that day's daily note. A note's id never
 * looks like a day, so a link is to one or the other.
 */
export interface LinkedDay {
  day: string;
  /** HH:MM on a 24-hour clock. */
  time: string | null;
}

/** A date link in a note's text, and where it is. */
export type DayLink = WrittenLink & LinkedDay;

const TARGET = /^(\d{4}-\d{2}-\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?$/;

/** The day and time a link's target names, or null where it names no real calendar day. */
export function linkedDay(target: string): LinkedDay | null {
  const match = TARGET.exec(target);
  return match && isDay(match[1]!) ? { day: match[1]!, time: match[2] ?? null } : null;
}

/** How a note writes a link to a day, or a day and a time, with words of its own to show where it has them. */
export const writtenDayLink = ({ day, time }: LinkedDay, display?: string | null) => `[[${time === null ? day : `${day} ${time}`}${display ? `|${display}` : ""}]]`;

/** The date links on one line of a note, which starts at `offset`. Those inside inline code are left out. */
export const dayLinksOn = (line: string, offset = 0): DayLink[] => linksOn(line, offset).flatMap((link) => withDay(link));

/** Every date link in a note's text, outside code. */
export const dayLinksIn = (text: string): DayLink[] => linksIn(text).flatMap((link) => withDay(link));

const withDay = (link: WrittenLink): DayLink[] => {
  const day = linkedDay(link.target);
  return day ? [{ ...link, ...day }] : [];
};

/** What the record of a note's links holds for a link to `day`, which a daily note for that day is linked by. */
export const dayTarget = (day: string) => `day:${day}`;

/** The days a note's text links, each once, as the record of its links holds them. */
export const linkedDayTargets = (text: string) => [...new Set(dayLinksIn(text).map((link) => dayTarget(link.day)))];

/** A heading, as a daily note's title is its date: a date there was left as written. */
const HEADING = /^#{1,6}\s/;
/** A line up to a date that is inside an embed's braces, a link's brackets or a link's address, which the embed or the link drew. */
const OPEN = /\{[^}]*$|\[[^\]]*$|\]\($/;
/** A bare date, at the start of a line or after a space or an opening parenthesis, and before the end, a space or a mark that ends words. */
const BARE = /(?<=^|[\s(])(\d{4}-\d{2}-\d{2})(?: ((?:[01]\d|2[0-3]):[0-5]\d))?(?=$|[\s.,;!?)]|:(?!\d))/g;

/**
 * The dates a note wrote bare before dates were written as links, which were drawn as dates then: on
 * their own, not part of something longer such as `due:2026-10-21`, a link's words or an address,
 * and not in a heading, inside an embed's braces, a link's brackets or a link's address, or in code.
 * Each with where it is on the line, which starts at `offset`.
 */
export function bareDatesOn(line: string, offset = 0): (LinkedDay & { from: number; to: number })[] {
  if (HEADING.test(line)) return [];
  const read = blanked(line, codeSpans(line), "\0");
  const found = [];
  for (const match of read.matchAll(BARE)) {
    const [whole, day, time] = match;
    if (!isDay(day!) || OPEN.test(read.slice(0, match.index))) continue;
    found.push({ day: day!, time: time ?? null, from: offset + match.index, to: offset + match.index + whole.length });
  }
  return found;
}

/** A line that opens a block embed, `:::kanban{}`, whose lines up to a line of `:::` are the embed's, and one that is only `$$`, which opens or closes a formula. */
const BLOCK_OPENS = /^\s*:::[\p{L}\p{N}_-]+\{[^}]*\}\s*$/u;
const BLOCK_CLOSES = /^\s*:::\s*$/;
const FORMULA = /^\s*\$\$\s*$/;

/**
 * The text with each date it wrote bare, as `bareDatesOn` finds them, written as a link to its day.
 * Everything else is left as it is, and what is inside a block embed or a formula too: an embed's HTML
 * or a kanban card's words would show the brackets as written.
 */
export function datesAsLinks(text: string): string {
  let out = "";
  let at = 0;
  let inside: "embed" | "formula" | null = null;
  for (const { line, from } of linesOutsideCode(text)) {
    if (inside === null && BLOCK_OPENS.test(line)) inside = "embed";
    else if (inside === "embed" && BLOCK_CLOSES.test(line)) inside = null;
    else if (FORMULA.test(line) && inside !== "embed") inside = inside === "formula" ? null : "formula";
    if (inside !== null || BLOCK_CLOSES.test(line)) continue;
    for (const date of bareDatesOn(line, from)) {
      out += text.slice(at, date.from) + writtenDayLink(date);
      at = date.to;
    }
  }
  return out + text.slice(at);
}
