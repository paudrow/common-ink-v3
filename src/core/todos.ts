import type { ChangeSet } from "@codemirror/state";
import { BOX_PATTERN, markOf, stateOfMark, type TodoState } from "./boxes.ts";
import { following } from "./follow.ts";
import { linesOutsideCode } from "./lines.ts";
import { mentionKey, mentionsOn, personKey, writtenMention, type WrittenMention } from "./mentions.ts";
import { RULE_PATTERN, counted, nextDue, parseRule, skippedTo, writeRule, type Rule } from "./recurrence.ts";
import { applyChanges } from "./text.ts";
import { addressSpans, blanked, codeSpans } from "./spans.ts";

export { BOX_PATTERN, STATES_WRITTEN, TODO_STATES, markOf, stateOfMark, type TodoState } from "./boxes.ts";

/**
 * A todo as a note writes it: a list item with a checkbox, and its options as tokens on the same line.
 *
 *     - [ ] !! Call the bank due:2026-10-14 #money
 *
 * - `[ ]` is open, `[x]` is done, `[-]` is abandoned and `[>]` is in the backlog: `boxes.ts` has each mark.
 * - `!`, `!!` or `!!!` right after the checkbox is its importance. None is normal.
 * - `due:YYYY-MM-DD` is the day it is due: a calendar date, with no time and no time zone.
 * - `every:2w` is how it recurs. `recurrence.ts` has the rules.
 * - `done:2026-10-10x12` is the day a recurring todo was last checked off, and how many times it has been.
 * - `#tag` tags the whole note, on this line as on any other.
 * - `@[[id|Name]]` or `@[[Name]]` assigns it to a person. `mentions.ts` has how a mention is written.
 *
 * A token stands alone: after a space, and before a space, the end of the line, or `.,;:!?)`. Text
 * in inline code, in a link to a note, and in a link's address is never a token. Tags match
 * ignoring case. docs/todos.md says the same to a person.
 */
export interface Todo {
  /** Where the `[ ]` is. */
  box: Span;
  state: TodoState;
  importance: Importance;
  /** Where the `!`s are, when there are any. */
  importanceAt: Span | null;
  /** The first `due:` with a real date. */
  due: (Span & { date: string }) | null;
  /** The first `every:` with a rule that can be read. */
  every: (Span & { rule: Rule; written: string }) | null;
  /** The first `done:` with a real date. With no count it was done once. */
  lastDone: (Span & LastDone) | null;
  /** The tags written on this line. They tag its note, as a tag on any line does. */
  tags: (Span & { name: string })[];
  /** The people mentioned on the line, who are who it is assigned to. */
  assignees: WrittenMention[];
  /** The line without its list mark, checkbox, importance, due date, recurrence, last-done mark and assignees. */
  words: string;
}

export interface Span {
  from: number;
  to: number;
}

/** When a recurring todo was last checked off, and how many times it has been. */
export interface LastDone {
  on: string;
  times: number;
}

/** 0 is normal, and 1 to 3 are as many `!`s. */
export type Importance = 0 | 1 | 2 | 3;

const BOX = new RegExp(`^(\\s*(?:[-*+]|\\d+[.)])\\s+)(${BOX_PATTERN})(?=\\s|$)`);
const NOTE_LINK = /\[\[[^[\]\n]*\]\]/g;
const AFTER = "(?=$|[\\s.,;:!?)])";
const IMPORTANCE = /^\s+(!{1,3})(?=\s|$)/;
const DUE = new RegExp(`(?<=\\s)due:(\\d{4}-\\d{2}-\\d{2})${AFTER}`, "g");
const EVERY = new RegExp(`(?<=\\s)every:(${RULE_PATTERN})${AFTER}`, "g");
const LAST_DONE = new RegExp(`(?<=\\s)done:(\\d{4}-\\d{2}-\\d{2})(?:x([1-9]\\d{0,5}))?${AFTER}`, "g");
const TAG = new RegExp(`(?<=^|\\s)#([\\p{L}\\p{N}_][\\p{L}\\p{N}_/-]*)${AFTER}`, "gu");

/** The line with what is never a token put out of the way, each character still where it was. */
const readable = (line: string) => {
  const out = (text: string) => "\0".repeat(text.length);
  const read = blanked(line, codeSpans(line), "\0").replace(NOTE_LINK, out);
  return blanked(read, addressSpans(read), "\0");
};

/** Whether `day` is a real calendar date written YYYY-MM-DD. */
export function isDay(day: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return false;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const made = new Date(Date.UTC(year, month - 1, date));
  return year >= 1000 && made.getUTCFullYear() === year && made.getUTCMonth() === month - 1 && made.getUTCDate() === date;
}

/** What a tag is matched by: its name in lower case. */
export const nameKey = (name: string) => name.toLowerCase();

/** The tags on one line of a note, which starts at `offset`. A tag has something in it besides digits, so `#12` is not one. */
export function tagsOn(line: string, offset = 0): (Span & { name: string })[] {
  if (!line.includes("#")) return [];
  return [...readable(line).matchAll(TAG)].filter((m) => /\D/.test(m[1]!)).map((m) => ({ from: offset + m.index, to: offset + m.index + m[0].length, name: m[1]! }));
}

/** Whether `name` is a tag's whole name, as `#name` would write it. */
export const isTagName = (name: string) => tagsOn(`#${name}`)[0]?.name === name;

/** The todo on one line of a note, which starts at `offset`, or null when the line isn't one. */
export function parseTodo(line: string, offset = 0): Todo | null {
  const box = BOX.exec(line);
  if (!box) return null;
  const start = box[0].length;
  const read = readable(line);
  const body = read.slice(start);
  const span = (index: number, length: number): Span => ({ from: offset + start + index, to: offset + start + index + length });

  const marks = IMPORTANCE.exec(body);
  const importanceAt = marks ? span(marks[0].length - marks[1]!.length, marks[1]!.length) : null;
  const dated = [...body.matchAll(DUE)].find((m) => isDay(m[1]!));
  const due = dated ? { ...span(dated.index, dated[0].length), date: dated[1]! } : null;
  const recurs = [...body.matchAll(EVERY)].map((m) => ({ m, rule: parseRule(m[1]!) })).find((found) => found.rule);
  const every = recurs ? { ...span(recurs.m.index, recurs.m[0].length), rule: recurs.rule!, written: recurs.m[1]! } : null;
  const did = [...body.matchAll(LAST_DONE)].find((m) => isDay(m[1]!));
  const lastDone = did ? { ...span(did.index, did[0].length), on: did[1]!, times: Number(did[2] ?? 1) } : null;
  const assignees = mentionsOn(line, offset).filter((m) => m.from >= offset + start);

  let words = "";
  let at = start;
  for (const taken of [importanceAt, due, every, lastDone, ...assignees].filter((s) => s !== null).sort((a, b) => a.from - b.from)) {
    words += line.slice(at, taken.from - offset);
    at = taken.to - offset;
  }
  words = (words + line.slice(at)).replace(/\s+/g, " ").trim();

  return {
    box: { from: offset + box[1]!.length, to: offset + start },
    state: stateOfMark(box[2]![1]!)!,
    importance: (marks?.[1]!.length ?? 0) as Importance,
    importanceAt,
    due,
    every,
    lastDone,
    tags: tagsOn(line, offset),
    assignees,
    words,
  };
}

/** What to change about a todo. Anything left out stays exactly as it is written. */
export interface TodoChange {
  /** Done checks it off, as `completeTodo` does. Any other state is its box written so, and nothing else. */
  state?: TodoState;
  importance?: Importance;
  /** A day as YYYY-MM-DD, or null for no due date. */
  due?: string | null;
  /** How it recurs, as a rule is written after `every:`, or null for not at all. */
  every?: string | null;
  /** When it was last checked off and how many times, or null to take the mark away. */
  lastDone?: LastDone | null;
  /** True moves a recurring todo's due date to its next one, with nothing checked off. */
  skip?: boolean;
  /**
   * What the todo says, as `words` reads it: the line but its list mark, checkbox, importance and due date,
   * with its tags. Its importance stays where it is and its due date goes after the words. One line.
   */
  words?: string;
  /** Assigns it to a person, unless it is theirs already: a member by their id and name, anyone else by name. */
  assign?: { id?: string | null; name: string };
  /** Takes it from a person, named by their id or by a name ignoring case, or from each of several such. */
  unassign?: string | readonly string[];
}

export interface Edit extends Span {
  insert: string;
}

/**
 * The edits to a todo's line that make `change`, as offsets into the line, in order and apart from
 * each other. Each replaces one token's own characters. Taking a token away takes the space before it
 * too, and adding one writes a space before it: a due date goes at the end of the line,
 * importance right after the checkbox. Nothing else on the line is touched. None when the line
 * isn't a todo or already says all of it.
 */
export function todoEdits(line: string, change: Omit<TodoChange, "words">): Edit[] {
  const todo = parseTodo(line);
  if (!todo) return [];
  const edits: Edit[] = [];
  let tail = "";

  if (change.state !== undefined && change.state !== todo.state) edits.push({ from: todo.box.from + 1, to: todo.box.to - 1, insert: markOf(change.state) });

  if (change.importance !== undefined && change.importance !== todo.importance) {
    const marks = "!".repeat(change.importance);
    if (!todo.importanceAt) edits.push({ from: todo.box.to, to: todo.box.to, insert: ` ${marks}` });
    else if (marks) edits.push({ ...todo.importanceAt, insert: marks });
    else edits.push({ from: todo.box.to, to: todo.importanceAt.to, insert: "" });
  }

  if (change.due !== undefined && change.due !== (todo.due?.date ?? null)) {
    if (change.due !== null && !isDay(change.due)) throw new RangeError(`${change.due} isn't a date written YYYY-MM-DD`);
    if (!todo.due) tail += ` due:${change.due}`;
    else if (change.due) edits.push({ from: todo.due.from, to: todo.due.to, insert: `due:${change.due}` });
    else edits.push({ from: todo.due.from - 1, to: todo.due.to, insert: "" });
  }

  if (change.every !== undefined && change.every !== (todo.every?.written ?? null)) {
    if (change.every !== null && !parseRule(change.every)) throw new RangeError(`${change.every} isn't a way to repeat. docs/todos.md has the rules, such as 2w, mon,thu, 3d-after-done, last-fri, mar-1 and 1m-times-5`);
    if (!todo.every) tail += ` every:${change.every}`;
    else if (change.every) edits.push({ from: todo.every.from, to: todo.every.to, insert: `every:${change.every}` });
    else edits.push({ from: todo.every.from - 1, to: todo.every.to, insert: "" });
  }

  if (change.lastDone !== undefined) {
    const mark = change.lastDone && `done:${change.lastDone.on}x${change.lastDone.times}`;
    if (mark && !isDay(change.lastDone!.on)) throw new RangeError(`${change.lastDone!.on} isn't a date written YYYY-MM-DD`);
    if (!todo.lastDone) tail += mark ? ` ${mark}` : "";
    else if (mark) edits.push({ from: todo.lastDone.from, to: todo.lastDone.to, insert: mark });
    else edits.push({ from: todo.lastDone.from - 1, to: todo.lastDone.to, insert: "" });
  }

  const mention = change.assign === undefined ? undefined : writtenMention(change.assign);
  if (mention === "") throw new RangeError("A todo is assigned to a member's id or to a name, and that is neither");
  const taking = new Set((change.unassign === undefined ? [] : typeof change.unassign === "string" ? [change.unassign] : change.unassign).map(personKey));
  for (const assignee of todo.assignees) if (taking.has(mentionKey(assignee))) edits.push({ from: assignee.from - (line[assignee.from - 1] === " " ? 1 : 0), to: assignee.to, insert: "" });
  const theirs = change.assign && personKey(change.assign.id || change.assign.name);
  if (mention && !taking.has(theirs!) && !todo.assignees.some((a) => mentionKey(a) === theirs)) tail += ` ${mention}`;

  if (tail) {
    const end = Math.max(line.trimEnd().length, todo.box.to);
    edits.push({ from: end, to: end, insert: tail });
  }
  return edits.sort((a, b) => a.from - b.from);
}

/**
 * The todo's line saying `words`, with the importance it has before them and the due date, the rule,
 * the last-done mark and the assignees it has after them, unless the words write their own: then theirs
 * is the one, and the line has one of each. An assignee the words name is not written again.
 */
function reworded(line: string, words: string): string {
  if (/[\r\n]/.test(words)) throw new RangeError("A todo's words are one line");
  const todo = parseTodo(line);
  const said = words.trim();
  if (!todo || said.replace(/\s+/g, " ") === todo.words) return line;
  const own = parseTodo(`- [ ] ${said}`)!;
  const kept = (span: Span | null, theirs: Span | null) => (span && !theirs ? line.slice(span.from, span.to) : "");
  const named = new Set(own.assignees.map(mentionKey));
  const assignees = todo.assignees.filter((assignee) => !named.has(mentionKey(assignee))).map((assignee) => line.slice(assignee.from, assignee.to));
  const after = [kept(todo.due, own.due), kept(todo.every, own.every), kept(todo.lastDone, own.lastDone), ...assignees];
  return [line.slice(0, todo.box.to), kept(todo.importanceAt, own.importanceAt), said, ...after].filter(Boolean).join(" ");
}

/** The todo's line with `change` made. Every character it doesn't change is as it was, unless its words are rewritten. */
export function rewriteTodo(line: string, { words, ...change }: TodoChange): string {
  if (words !== undefined) line = reworded(line, words);
  let out = "";
  let at = 0;
  for (const edit of todoEdits(line, change)) {
    out += line.slice(at, edit.from) + edit.insert;
    at = edit.to;
  }
  return out + line.slice(at);
}

/** What checking a todo off leaves: its line, and for a recurring todo the checked line to file on the daily note. */
export interface Completed {
  line: string;
  filed: string | null;
}

/**
 * Checking a todo off on the day `on`. A todo that recurs stays open: its due date moves to the next
 * one, its `done:` mark says `on` and one more time, a rule that ends after so many times has one
 * fewer left, and the line as it was, checked and without how it recurs, is what gets filed. The
 * last time of a rule that ends checks the todo off for good, its tokens as written, and is filed
 * the same. Any other todo is checked, and nothing is filed. One abandoned or in the backlog is
 * checked off as an open one is, and one already done is left as it is. Every completion comes
 * through here on the server: the todo.set operation, and a write that checks a recurring todo's
 * box, which is what the editor's checkbox and a typed `x` are. The Todos page calls it to show at
 * once what the server will answer.
 */
export function completeTodo(written: string, on: string): Completed {
  const todo = parseTodo(written);
  if (!todo || todo.state === "done") return { line: written, filed: null };
  const line = rewriteTodo(written, { state: "open" });
  const rule = todo.every?.rule;
  const next = rule && nextDue(rule, { due: todo.due?.date ?? null, done: on });
  if (!rule || (!next && !rule.end)) return { line: rewriteTodo(line, { state: "done" }), filed: null };
  // The line is parsed as its first every: and its first done:. Another of either is still one, and the filed line has none.
  let shown = rewriteTodo(line, { state: "done", every: null, lastDone: null });
  for (;;) {
    const left = parseTodo(shown);
    if (!left?.every && !left?.lastDone) break;
    const next = rewriteTodo(shown, { every: null, lastDone: null });
    if (next === shown) break;
    shown = next;
  }
  const filed = `- ${shown.slice(todo.box.from)}`;
  if (!next) return { line: rewriteTodo(line, { state: "done" }), filed };
  return { line: rewriteTodo(line, { due: next, every: writeRule(counted(rule)), lastDone: { on, times: (todo.lastDone?.times ?? 0) + 1 } }), filed };
}

/**
 * Skipping a recurring todo's occurrence on the day `on`: its due date moves to the next one after
 * both its due date and that day, as if it had been done on the later of the two, and it counts as
 * one of the times of a rule that ends after so many. Nothing is checked off. It is refused for a
 * todo that doesn't recur, one that isn't open, and one with no later time to skip to.
 */
export function skipTodo(line: string, on: string): string {
  const todo = parseTodo(line);
  if (!todo?.every || todo.state !== "open") throw new RangeError("Only an open todo that repeats can be skipped");
  const next = skippedTo(todo.every.rule, { due: todo.due?.date ?? null, on });
  if (!next) throw new RangeError("This is the last time this todo repeats, so there is no later one to skip to. Check it off, or stop it repeating");
  return rewriteTodo(line, { due: next, every: writeRule(counted(todo.every.rule)) });
}

/**
 * The todo's line with `change` made, as todo.set makes it on the day `on`: checking it off is
 * `completeTodo`'s to do, skipping it `skipTodo`'s, and the rest is `rewriteTodo`'s. Abandoning a
 * todo that repeats, or putting it in the backlog, writes its box and nothing more: nothing is
 * filed, and it doesn't come due again until it is open.
 */
export function changeTodo(line: string, { state, skip, ...rest }: TodoChange, on: string): Completed {
  const done = state === "done";
  if (done && skip) throw new RangeError("A todo is checked off or skipped, not both");
  const next = rewriteTodo(line, done ? rest : { ...rest, state });
  if (skip) return { line: skipTodo(next, on), filed: null };
  return done ? completeTodo(next, on) : { line: next, filed: null };
}

/** A todo with where it is in its note. */
export interface NoteTodo extends Todo {
  /** Which line of the note it is, counted from 0. */
  line: number;
  /** Where that line starts. */
  from: number;
  /** The line as written. */
  text: string;
}

/** Every todo in a note's text, outside code. */
export function todosIn(text: string): NoteTodo[] {
  if (!text.includes("[")) return [];
  const found: NoteTodo[] = [];
  for (const { line, from, index } of linesOutsideCode(text)) {
    const todo = parseTodo(line, from);
    if (todo) found.push({ ...todo, line: index, from, text: line });
  }
  return found;
}

/** A note's tags, each once ignoring case, as first written, outside code. */
export function tagsIn(text: string): string[] {
  if (!text.includes("#")) return [];
  const tags = new Map<string, string>();
  for (const { line } of linesOutsideCode(text)) for (const { name } of tagsOn(line)) if (!tags.has(nameKey(name))) tags.set(nameKey(name), name);
  return [...tags.values()];
}

/** The tags `text` has that `base` doesn't, each once ignoring case, as `text` first writes them. */
export function tagsAdded(text: string, base: string): string[] {
  const had = new Set(tagsIn(base).map(nameKey));
  return tagsIn(text).filter((name) => !had.has(nameKey(name)));
}

/**
 * The name tag `name` is given when `from` is renamed `to`, or null when it isn't `from` or a tag
 * under it, as `#from/sub` is: `#from/sub` becomes `#to/sub`, keeping the case it was written in
 * below `from`. Matched ignoring case, part by part, so `#from-2` is another tag.
 */
export function renamedTag(name: string, from: string, to: string): string | null {
  const parts = name.split("/");
  const depth = from.split("/").length;
  if (parts.length < depth || nameKey(parts.slice(0, depth).join("/")) !== nameKey(from)) return null;
  return [to, ...parts.slice(depth)].join("/");
}

/**
 * The text with every tag `from` names, ignoring case, and every tag under it, written as `to`
 * renames it, and nothing else changed. Only where a tag is read: not in code, not in a link's
 * address, and never a longer tag such as `#from-2`.
 */
export function renamedTags(text: string, from: string, to: string): string {
  if (!text.includes("#")) return text;
  let renamed = "";
  let at = 0;
  for (const { line, from: start } of linesOutsideCode(text)) {
    for (const tag of tagsOn(line, start)) {
      const name = renamedTag(tag.name, from, to);
      if (name === null) continue;
      renamed += `${text.slice(at, tag.from)}#${name}`;
      at = tag.to;
    }
  }
  return renamed + text.slice(at);
}

/** The tags a note has on its lines but one, each once ignoring case, outside code. */
export function tagsBesides(text: string, line: number): string[] {
  if (!text.includes("#")) return [];
  const tags = new Map<string, string>();
  for (const { line: written, index } of linesOutsideCode(text)) if (index !== line) for (const { name } of tagsOn(written)) if (!tags.has(nameKey(name))) tags.set(nameKey(name), name);
  return [...tags.values()];
}

/**
 * Where to look for the todo that was listed as line `at.line` reading `at.text`, in a note that
 * may have been written since: the todo on that line when it still reads the same, and otherwise
 * the one todo anywhere that reads the same. It is a place to put the cursor, and a guess when two
 * todos read alike. Nothing is changed on its word: todo.set follows a todo through the note's
 * recorded changes instead.
 */
export function locateTodo(text: string, at: { line: number; text: string }): NoteTodo | null {
  const same = todosIn(text).filter((todo) => todo.text === at.text);
  return same.find((todo) => todo.line === at.line) ?? (same.length === 1 ? same[0]! : null);
}

const reopened = (todo: NoteTodo) => rewriteTodo(todo.text, { state: "open" });

/**
 * The recurring todos a write checked off, as the note has them after it. `changes` is the write, as
 * a change to `was`. A todo is checked off when its line was a todo not done (open, abandoned or in
 * the backlog) and is a done, recurring one now, whatever else on the line changed with it, and
 * however the box came to be checked: the checkbox, an `x` typed between the brackets, an agent
 * writing the whole note. Which line is which
 * is read from where the changes are. Where a change puts some lines in the place of others and so
 * doesn't say, the line is the one most like it there (`following`). A line written already checked
 * was never open, and one replaced by a line unlike it is gone, so neither is a completion.
 */
export function checkedOff(was: string, changes: ChangeSet): NoteTodo[] {
  const text = applyChanges(changes, was);
  if (!text.includes("every:")) return [];
  const done = todosIn(text).filter((todo) => todo.state === "done" && todo.every);
  if (!done.length) return [];
  const found = new Set<NoteTodo>();
  const after = following(was, changes, text);
  for (const open of todosIn(was)) {
    if (open.state === "done") continue;
    const at = after(open.from);
    const now = at === null ? undefined : done.find((todo) => todo.from <= at && at <= todo.from + todo.text.length);
    if (now) found.add(now);
  }
  return [...found].sort((a, b) => a.from - b.from);
}

/**
 * `text` with each of the `checked` todos in it completed on `on`, and what to file for each, with
 * where its line starts. One that `stale` answers for was already completed since the writer read
 * the note: its box is left open and nothing more is done.
 */
export function rolledForward(text: string, checked: readonly NoteTodo[], on: string, stale: (todo: NoteTodo) => boolean = () => false): { text: string; filed: { line: string; at: number }[] } {
  const filed: { line: string; at: number }[] = [];
  let out = "";
  let at = 0;
  for (const todo of checked) {
    const open = reopened(todo);
    const done = stale(todo) ? { line: open, filed: null } : completeTodo(open, on);
    out += text.slice(at, todo.from);
    if (done.filed) filed.push({ line: done.filed, at: out.length });
    out += done.line;
    at = todo.from + todo.text.length;
  }
  return { text: out + text.slice(at), filed };
}

/**
 * What the index of todos holds for one note: its todos, and the note's tags. It is made from the
 * text alone, so it can always be made again.
 */
export interface TodoIndex {
  /** Line, state, importance, due, and the line as written. */
  todos: [line: number, state: TodoState, importance: Importance, due: string | null, text: string][];
  tags: [key: string, name: string][];
}

export function todoIndex(text: string): TodoIndex {
  const todos = todosIn(text);
  return {
    todos: todos.map((t) => [t.line, t.state, t.importance, t.due?.date ?? null, t.text]),
    tags: tagsIn(text).map((name) => [nameKey(name), name]),
  };
}
