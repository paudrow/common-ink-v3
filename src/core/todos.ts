import { linesOutsideCode } from "./lines.ts";

/**
 * A todo as a note writes it: a list item with a checkbox, and its options as tokens on the same line.
 *
 *     - [ ] !! Call the bank due:2026-10-14 #money
 *
 * - `[ ]` is open and `[x]` is done.
 * - `!`, `!!` or `!!!` right after the checkbox is its importance. None is normal.
 * - `due:YYYY-MM-DD` is the day it is due: a calendar date, with no time and no time zone.
 * - `#tag` tags the whole note, on this line as on any other.
 *
 * A token stands alone: after a space, and before a space, the end of the line, or `.,;:!?)`. Text
 * in inline code, in a link to a note, and in a link's address is never a token. Tags match
 * ignoring case. docs/todos.md says the same to a person.
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
  /** The tags written on this line. They tag its note, as a tag on any line does. */
  tags: (Span & { name: string })[];
  /** The line without its list mark, checkbox, importance and due date. */
  words: string;
}

export interface Span {
  from: number;
  to: number;
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
const TAG = new RegExp(`(?<=^|\\s)#([\\p{L}\\p{N}_][\\p{L}\\p{N}_/-]*)${AFTER}`, "gu");

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

/** What a tag is matched by: its name in lower case. */
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

  let words = "";
  let at = start;
  for (const taken of [importanceAt, due].filter((s) => s !== null).sort((a, b) => a.from - b.from)) {
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
    tags: tagsOn(line, offset),
    words,
  };
}

/** What to change about a todo. Anything left out stays exactly as it is written. */
export interface TodoChange {
  done?: boolean;
  importance?: Importance;
  /** A day as YYYY-MM-DD, or null for no due date. */
  due?: string | null;
  /**
   * What the todo says, as `words` reads it: the line but its list mark, checkbox, importance and due date,
   * with its tags. Its importance stays where it is and its due date goes after the words. One line.
   */
  words?: string;
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

  if (tail) {
    const end = Math.max(line.trimEnd().length, todo.box.to);
    edits.push({ from: end, to: end, insert: tail });
  }
  return edits.sort((a, b) => a.from - b.from);
}

/**
 * The todo's line saying `words`, with the importance it has before them and the due date it has after
 * them, unless the words write their own: then theirs is the one, and the line has one of each.
 */
function reworded(line: string, words: string): string {
  if (/[\r\n]/.test(words)) throw new RangeError("A todo's words are one line");
  const todo = parseTodo(line);
  const said = words.trim();
  if (!todo || said.replace(/\s+/g, " ") === todo.words) return line;
  const own = parseTodo(`- [ ] ${said}`)!;
  const marks = todo.importanceAt && !own.importanceAt ? line.slice(todo.importanceAt.from, todo.importanceAt.to) : "";
  const due = todo.due && !own.due ? line.slice(todo.due.from, todo.due.to) : "";
  return [line.slice(0, todo.box.to), marks, said, due].filter(Boolean).join(" ");
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

/**
 * Checking a todo off, as the line it leaves. Every completion comes through here: the editor's
 * checkbox, the Todos page, and the todo.set operation. So what completing a todo does to its own
 * line (a recurring one staying open with its next due date, #20) has this one place to go.
 */
export const completeTodo = (line: string): string => rewriteTodo(line, { done: true });

/** The todo's line with `change` made, as todo.set makes it: checking it off is `completeTodo`'s to do, and the rest is `rewriteTodo`'s. */
export function changeTodo(line: string, { done, ...rest }: TodoChange): string {
  const next = rewriteTodo(line, done === false ? { ...rest, done } : rest);
  return done ? completeTodo(next) : next;
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

/**
 * What the index of todos holds for one note: its todos, and the note's tags. It is made from the
 * text alone, so it can always be made again.
 */
export interface TodoIndex {
  /** Line, done, importance, due, and the line as written. */
  todos: [line: number, done: 0 | 1, importance: Importance, due: string | null, text: string][];
  tags: [key: string, name: string][];
}

export function todoIndex(text: string): TodoIndex {
  const todos = todosIn(text);
  return {
    todos: todos.map((t) => [t.line, t.done ? 1 : 0, t.importance, t.due?.date ?? null, t.text]),
    tags: tagsIn(text).map((name) => [nameKey(name), name]),
  };
}
