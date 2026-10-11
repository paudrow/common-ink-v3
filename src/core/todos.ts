import type { ChangeSet } from "@codemirror/state";
import { linesOutsideCode } from "./lines.ts";
import { mentionKey, mentionsOn, personKey, writtenMention, type WrittenMention } from "./mentions.ts";
import { RULE_PATTERN, nextDue, parseRule, type Rule } from "./recurrence.ts";
import { applyChanges } from "./text.ts";

/**
 * A todo as a note writes it: a list item with a checkbox, and its options as tokens on the same line.
 *
 *     - [ ] !! Call the bank due:2026-10-14 +Home #money
 *
 * - `[ ]` is open and `[x]` is done.
 * - `!`, `!!` or `!!!` right after the checkbox is its importance. None is normal.
 * - `due:YYYY-MM-DD` is the day it is due: a calendar date, with no time and no time zone.
 * - `every:2w` is how it recurs. `recurrence.ts` has the rules.
 * - `done:2026-10-10x12` is the day a recurring todo was last checked off, and how many times it has been.
 * - `+Name` puts it in a project. A name starts with a letter and goes on in letters, digits, `_` and `-`.
 * - `#tag` tags the whole note, on this line as on any other.
 * - `@[[id|Name]]` or `@[[Name]]` assigns it to a person. `mentions.ts` has how a mention is written.
 *
 * A token stands alone: after a space, and before a space, the end of the line, or `.,;:!?)`. Text
 * in inline code, in a link to a note, and in a link's address is never a token. Projects and tags
 * match ignoring case. docs/todos.md says the same to a person.
 */
export interface Todo {
  /** Where the `[ ]` is. */
  box: Span;
  done: boolean;
  importance: Importance;
  /** Where the `!`s are, when there are any. */
  importanceAt: Span | null;
  /** The first `due:` with a real date. */
  due: (Span & { date: string }) | null;
  /** The first `every:` with a rule that can be read. */
  every: (Span & { rule: Rule; written: string }) | null;
  /** The first `done:` with a real date. With no count it was done once. */
  lastDone: (Span & LastDone) | null;
  projects: (Span & { name: string })[];
  tags: (Span & { name: string })[];
  /** The people mentioned on the line, who are who it is assigned to. */
  assignees: WrittenMention[];
  /** The line without its list mark, checkbox, importance, due date, recurrence, last-done mark, projects and assignees. */
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

const BOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/;
const INLINE_CODE = /(`+)(?!`)[^]*?(?<!`)\1(?!`)/g;
const NOTE_LINK = /\[\[[^[\]\n]*\]\]/g;
const ADDRESS = /\]\([^)\n]*\)/g;
const AFTER = "(?=$|[\\s.,;:!?)])";
const IMPORTANCE = /^\s+(!{1,3})(?=\s|$)/;
const DUE = new RegExp(`(?<=\\s)due:(\\d{4}-\\d{2}-\\d{2})${AFTER}`, "g");
const EVERY = new RegExp(`(?<=\\s)every:(${RULE_PATTERN})${AFTER}`, "g");
const LAST_DONE = new RegExp(`(?<=\\s)done:(\\d{4}-\\d{2}-\\d{2})(?:x([1-9]\\d{0,5}))?${AFTER}`, "g");
const PROJECT = new RegExp(`(?<=\\s)\\+(\\p{L}[\\p{L}\\p{N}_-]*)${AFTER}`, "gu");
const TAG = new RegExp(`(?<=^|\\s)#([\\p{L}\\p{N}_][\\p{L}\\p{N}_/-]*)${AFTER}`, "gu");
const PROJECT_NAME = /^\p{L}[\p{L}\p{N}_-]*$/u;

/** The line with what is never a token put out of the way, each character still where it was. */
const readable = (line: string) => {
  const out = (text: string) => "\0".repeat(text.length);
  return line.replace(INLINE_CODE, out).replace(NOTE_LINK, out).replace(ADDRESS, out);
};

/** Whether `day` is a real calendar date written YYYY-MM-DD. */
export function isDay(day: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return false;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const made = new Date(Date.UTC(year, month - 1, date));
  return year >= 1000 && made.getUTCFullYear() === year && made.getUTCMonth() === month - 1 && made.getUTCDate() === date;
}

export const isProjectName = (name: string) => PROJECT_NAME.test(name);

/** What a project or a tag is matched by: its name in lower case. */
export const nameKey = (name: string) => name.toLowerCase();

/** The tags on one line of a note, which starts at `offset`. A tag has something in it besides digits, so `#12` is not one. */
export function tagsOn(line: string, offset = 0): (Span & { name: string })[] {
  if (!line.includes("#")) return [];
  return [...readable(line).matchAll(TAG)].filter((m) => /\D/.test(m[1]!)).map((m) => ({ from: offset + m.index, to: offset + m.index + m[0].length, name: m[1]! }));
}

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
  const projects = [...body.matchAll(PROJECT)].map((m) => ({ ...span(m.index, m[0].length), name: m[1]! }));
  const assignees = mentionsOn(line, offset).filter((m) => m.from >= offset + start);

  let words = "";
  let at = start;
  for (const taken of [importanceAt, due, every, lastDone, ...projects, ...assignees].filter((s) => s !== null).sort((a, b) => a.from - b.from)) {
    words += line.slice(at, taken.from - offset);
    at = taken.to - offset;
  }
  words = (words + line.slice(at)).replace(/\s+/g, " ").trim();

  return {
    box: { from: offset + box[1]!.length, to: offset + start },
    done: box[2] !== " ",
    importance: (marks?.[1]!.length ?? 0) as Importance,
    importanceAt,
    due,
    every,
    lastDone,
    projects,
    tags: tagsOn(line, offset),
    assignees,
    words,
  };
}

/** What to change about a todo. Anything left out stays exactly as it is written. */
export interface TodoChange {
  done?: boolean;
  importance?: Importance;
  /** A day as YYYY-MM-DD, or null for no due date. */
  due?: string | null;
  /** How it recurs, as a rule is written after `every:`, or null for not at all. */
  every?: string | null;
  /** When it was last checked off and how many times, or null to take the mark away. */
  lastDone?: LastDone | null;
  /** Puts it in a project, unless it is in it already. With `removeProject`, the new one takes the old one's place on the line. */
  addProject?: string;
  /** Takes it out of a project, ignoring case. */
  removeProject?: string;
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
 * too, and adding one writes a space before it: due dates and projects go at the end of the line,
 * importance right after the checkbox. Nothing else on the line is touched. None when the line
 * isn't a todo or already says all of it.
 */
export function todoEdits(line: string, change: TodoChange): Edit[] {
  const todo = parseTodo(line);
  if (!todo) return [];
  const edits: Edit[] = [];
  let tail = "";

  if (change.done !== undefined && change.done !== todo.done) edits.push({ from: todo.box.from + 1, to: todo.box.to - 1, insert: change.done ? "x" : " " });

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
    if (change.every !== null && !parseRule(change.every)) throw new RangeError(`${change.every} isn't a way to recur. docs/todos.md has the rules, such as 2w, mon,thu, 3d-after-done and last-fri`);
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

  if (change.addProject !== undefined && !isProjectName(change.addProject)) throw new RangeError(`${change.addProject} isn't a project's name: a letter, then letters, digits, _ and -`);
  const adding = change.addProject !== undefined && !todo.projects.some((p) => nameKey(p.name) === nameKey(change.addProject!)) ? change.addProject : undefined;
  const leaving = change.removeProject === undefined ? [] : todo.projects.filter((p) => nameKey(p.name) === nameKey(change.removeProject!));
  // A project asked to be both taken out and put in stays as it is written.
  if (change.addProject === undefined || change.removeProject === undefined || nameKey(change.addProject) !== nameKey(change.removeProject)) {
    leaving.forEach((p, i) => edits.push(i === 0 && adding ? { from: p.from, to: p.to, insert: `+${adding}` } : { from: p.from - 1, to: p.to, insert: "" }));
    if (adding && !leaving.length) tail += ` +${adding}`;
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

/** The todo's line with `change` made, and every other character as it was. */
export function rewriteTodo(line: string, change: TodoChange): string {
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
 * one, its `done:` mark says `on` and one more time, and the line as it was, checked and without how
 * it recurs, is what gets filed. Any other todo is checked, and nothing is filed. Every completion
 * comes through here on the server: the todo.set operation, and a write that checks a recurring
 * todo's box, which is what the editor's checkbox and a typed `x` are. The Todos page calls it to
 * show at once what the server will answer.
 */
export function completeTodo(line: string, on: string): Completed {
  const todo = parseTodo(line);
  if (!todo || todo.done) return { line, filed: null };
  const next = todo.every && nextDue(todo.every.rule, { due: todo.due?.date ?? null, done: on });
  if (!next) return { line: rewriteTodo(line, { done: true }), filed: null };
  const checked = rewriteTodo(line, { done: true, every: null, lastDone: null });
  return { line: rewriteTodo(line, { due: next, lastDone: { on, times: (todo.lastDone?.times ?? 0) + 1 } }), filed: `- ${checked.slice(todo.box.from)}` };
}

/** The todo's line with `change` made, as todo.set makes it on the day `on`: checking it off is `completeTodo`'s to do, and the rest is `rewriteTodo`'s. */
export function changeTodo(line: string, { done, ...rest }: TodoChange, on: string): Completed {
  const next = rewriteTodo(line, done === false ? { ...rest, done } : rest);
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

const reopened = (todo: NoteTodo) => rewriteTodo(todo.text, { done: false });

/**
 * The recurring todos a write checked off, as the note has them after it. `changes` is the write, as
 * a change to `was`. A todo is checked off when its line was an open todo and is a done, recurring
 * one now, whatever else on the line changed with it, and however the box came to be checked: the
 * checkbox, an `x` typed between the brackets, an agent writing the whole note. Which line is which
 * is read from where the changes are, never from what a line says. A line written already checked
 * was never open, and a change that runs from inside the line out past either end of it has replaced
 * the line with another, so neither is a completion.
 */
export function checkedOff(was: string, changes: ChangeSet): NoteTodo[] {
  const text = applyChanges(changes, was);
  if (!text.includes("every:")) return [];
  const done = todosIn(text).filter((todo) => todo.done && todo.every);
  if (!done.length) return [];
  const found = new Set<NoteTodo>();
  for (const open of todosIn(was)) {
    if (open.done) continue;
    const [from, to] = [open.from, open.from + open.text.length];
    let replaced = false;
    changes.iterChangedRanges((fromA, toA) => {
      if ((fromA < from && toA > from) || (fromA < to && toA > to)) replaced = true;
    });
    if (replaced) continue;
    const at = changes.mapPos(from, 1);
    const now = done.find((todo) => todo.from <= at && at <= todo.from + todo.text.length);
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
 * What the index of todos holds for one note: its todos, their projects, and the note's tags. It is
 * made from the text alone, so it can always be made again.
 */
export interface TodoIndex {
  /** Line, done, importance, due, and the line as written. */
  todos: [line: number, done: 0 | 1, importance: Importance, due: string | null, text: string][];
  /** Line, the project's key, and its name as written. */
  projects: [line: number, key: string, name: string][];
  tags: [key: string, name: string][];
}

export function todoIndex(text: string): TodoIndex {
  const todos = todosIn(text);
  return {
    todos: todos.map((t) => [t.line, t.done ? 1 : 0, t.importance, t.due?.date ?? null, t.text]),
    projects: todos.flatMap((t) => [...new Map(t.projects.map((p) => [nameKey(p.name), p.name])).entries()].map(([key, name]): [number, string, string] => [t.line, key, name])),
    tags: tagsIn(text).map((name) => [nameKey(name), name]),
  };
}
