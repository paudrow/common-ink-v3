import { isDay, parseRule, parseTodo, type Note, type PluginHost } from "../../plugin-api.ts";
import { todaysNote } from "../daily/opening.ts";
import { orderIn, saidFor } from "../dates/when.ts";
import { everyOffers } from "./recurrence.ts";

/** A todo typed in the Todos page's Add field, as its line, and each `due:` or `every:` in it that says no day or no repeat, which stays as words. */
export interface Typed {
  line: string;
  unread: string[];
}

/**
 * Whether typed words name a day by its name, word for word: each word whole, or the first three
 * letters of it or more. `fri` and `next fri` name Friday and Next Friday; `f` and `n` name nothing,
 * though `@` offers days for them.
 */
const names = (typed: string, name: string) => {
  const said = typed.toLowerCase().split(/\s+/);
  const words = name.toLowerCase().split(" ");
  return said.length === words.length && said.every((word, i) => word === words[i] || (word.length >= 3 && words[i]!.startsWith(word)));
};

/** The day `due:` says, as `@` reads it: a date written any way it reads, or a day by its name. */
function dueDay(said: string, today: string): string | null {
  if (isDay(said)) return said;
  const offer = saidFor(said, { day: today, time: "00:00" }, orderIn()).find((each) => each.time === null && (each.name === null || names(said, each.name)));
  return offer?.day ?? null;
}

/** The rule `every:` says: one written as a rule is, or one its completion names, as Weekly is `1w` and Every weekday `mon,tue,wed,thu,fri`. */
function everyRule(said: string): string | null {
  if (parseRule(said)) return said;
  const named = said.toLowerCase();
  return everyOffers(said).find((offer) => [offer.label.toLowerCase(), offer.label.toLowerCase().replace(/^every /, "")].includes(named))?.every ?? null;
}

/**
 * What a todo typed in the Add field is written as, on the day `today`: a box and the words, which may
 * say `#tag`, `@name`, `due:`, `every:` and `!!` as a todo's line does. A box or a list mark typed
 * before the words is the one written, and an open box with none. `!`, `!!` or `!!!` anywhere is its
 * importance, which a line has right after its box. `due:` and `every:` in words are written as a line
 * reads them: `due:fri` as the coming Friday's date, `due:next mon` as the Monday after, and
 * `every:weekly` as `every:1w`. Null when there are no words.
 */
export function todoLine(typed: string, today: string): Typed | null {
  const boxed = /^\s*(?:[-*+]\s+)?(?:\[(.)\]\s*)?/u.exec(typed)!;
  const mark = boxed[1] !== undefined && parseTodo(`- [${boxed[1]}] x`) ? boxed[1] : " ";
  let marks = "";
  const unread: string[] = [];
  const words = typed
    .slice(boxed[1] === undefined || mark === boxed[1] ? boxed[0].length : 0)
    .replace(/(^|\s)(!{1,3})(?=\s|$)/u, (_, lead: string, bangs: string) => ((marks = bangs), lead))
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/(^|\s)due:(next \S+|\S+)/giu, (all, lead: string, said: string) => {
      const day = dueDay(said, today);
      if (day) return `${lead}due:${day}`;
      unread.push(`due:${said}`);
      return all;
    })
    .replace(/(^|\s)every:(\S+)/giu, (all, lead: string, said: string) => {
      const rule = everyRule(said);
      if (rule) return `${lead}every:${rule}`;
      unread.push(`every:${said}`);
      return all;
    });
  if (!words) return null;
  const line = `- [${mark}] ${marks ? `${marks} ` : ""}${words}`;
  return parseTodo(line) ? { line, unread } : null;
}

/** How many lines a note's text has, which is where a line added after its last goes. */
export const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/** Writes the line at the end of today's daily note, made first when there is none, as the member's edit. Sent again with the same `writeId`, as after a reply that was lost, it is written once. */
export async function addToToday(host: PluginHost, line: string, writeId: string): Promise<Note> {
  const daily = await todaysNote(host);
  const end = lineCount(daily.text);
  const note = await host.perform({ type: "note.edit", id: daily.id, baseRevision: daily.revision, edits: [{ from: end, to: end, text: line }], writeId });
  host.app().noteChanged(note);
  return note;
}
