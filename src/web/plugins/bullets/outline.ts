/** A note's lines, read one at a time, so a long note isn't copied to look at a few of them. */
export interface Lines {
  count: number;
  /** The text of line `n`, counting from 0. */
  at(n: number): string;
}

export const linesOf = (text: string): Lines => {
  const lines = text.split("\n");
  return { count: lines.length, at: (n) => lines[n]! };
};

/** A list item and everything under it. */
export interface Item {
  /** The line its mark is on. */
  line: number;
  /** The line after the last line under it. `end - line` is 1 for an item with nothing under it. */
  end: number;
  /** How many columns come before its mark. A tab runs to the next multiple of four, as CommonMark counts it. */
  indent: number;
  /** How far in something under it is written: past its mark and the space after. */
  inside: number;
}

/** Lines of a note written another way: the lines from `from` up to `to` become `lines`. The note has as many lines after as before. */
export interface Edit {
  from: number;
  to: number;
  lines: string[];
  /** Where a line is after the edit, so the cursor and what is folded can go with their lines. */
  after(line: number): number;
}

const ITEM = /^([ \t]*)([-*+]|\d+[.)])(\s+|$)/;
const NUMBERED = /^([ \t]*)(\d+)([.)])/;
const blank = (line: string) => !line.trim();
export const leading = (line: string) => /^[ \t]*/.exec(line)![0];
/** How far along a line its own text starts: past its list mark and the space after, or past the space before it. */
export const textStart = (line: string) => (ITEM.exec(line)?.[0] ?? leading(line)).length;
/** The column a line's text starts in, with each tab running to the next multiple of four. */
export function indentOf(line: string) {
  let column = 0;
  for (const space of leading(line)) column = space === "\t" ? column + 4 - (column % 4) : column + 1;
  return column;
}

/** The list item whose mark is on line `n`, with what is under it: the lines after it that are further in, and blank lines among them. */
export function itemAt(lines: Lines, n: number): Item | null {
  const match = n >= 0 && n < lines.count ? ITEM.exec(lines.at(n)) : null;
  if (!match) return null;
  const indent = indentOf(lines.at(n));
  let end = n + 1;
  for (let m = n + 1; m < lines.count; m++) {
    const line = lines.at(m);
    if (blank(line)) continue;
    if (indentOf(line) <= indent) break;
    end = m + 1;
  }
  return { line: n, end, indent, inside: indent + match[2]!.length + 1 };
}

/** The item before this one in the same list, at the same depth. */
function before(lines: Lines, item: Item): Item | null {
  for (let n = item.line - 1; n >= 0; n--) {
    const line = lines.at(n);
    if (blank(line)) continue;
    const indent = indentOf(line);
    if (indent > item.indent) continue;
    return indent === item.indent ? itemAt(lines, n) : null;
  }
  return null;
}

/** The item after this one in the same list, at the same depth. */
function after(lines: Lines, item: Item): Item | null {
  for (let n = item.end; n < lines.count; n++) {
    if (blank(lines.at(n))) continue;
    return indentOf(lines.at(n)) === item.indent ? itemAt(lines, n) : null;
  }
  return null;
}

/** The item this one is under. */
function parentOf(lines: Lines, item: Item): Item | null {
  for (let n = item.line - 1; n >= 0; n--) {
    const line = lines.at(n);
    if (blank(line) || indentOf(line) >= item.indent) continue;
    return itemAt(lines, n);
  }
  return null;
}

const slice = (lines: Lines, from: number, to: number) => Array.from({ length: to - from }, (_, i) => lines.at(from + i));

/** The item on line `first`, and those after it in its list that start by line `last`, as one item: the lines an outline key moves together. */
function itemsFrom(lines: Lines, first: number, last: number): Item | null {
  const item = itemAt(lines, first);
  if (!item) return null;
  let end = item.end;
  for (let next = after(lines, item); next && next.line <= last; next = after(lines, next)) end = next.end;
  return { ...item, end };
}

/** Lines written another way, by line, over the lines they replace. */
type Rewrites = Map<number, string>;

const over = (lines: Lines, rewrites: Rewrites): Lines => ({ count: lines.count, at: (n) => rewrites.get(n) ?? lines.at(n) });

/** The line moved in or out by `by` columns, written with spaces before it, since a tab's width depends on where it starts. */
const moved = (line: string, by: number) => (blank(line) ? line : " ".repeat(Math.max(0, indentOf(line) + by)) + line.slice(leading(line).length));

/** Moves the item's lines in or out by `by` columns. */
function shift(lines: Lines, item: Item, by: number, into: Rewrites) {
  for (let n = item.line; n < item.end; n++) into.set(n, moved(lines.at(n), by));
}

const numbered = (lines: Lines, item: Item | null) => (item ? NUMBERED.exec(lines.at(item.line)) : null);

/** The numbered items of one list at one depth, first to last, that the item on line `n` is among. Empty when it isn't numbered. A bullet, or a number closed the other way (`1)` among `1.`), starts another list, as CommonMark reads it. */
function numberedList(lines: Lines, n: number): Item[] {
  const item = itemAt(lines, n);
  const closer = numbered(lines, item)?.[3];
  if (!item || !closer) return [];
  const same = (other: Item | null) => numbered(lines, other)?.[3] === closer;
  const list = [item];
  for (let prev = before(lines, item); prev && same(prev); prev = before(lines, prev)) list.unshift(prev);
  for (let next = after(lines, item); next && same(next); next = after(lines, next)) list.push(next);
  return list;
}

/** The number a list that starts on line `n` after an edit counts from: the first number of the list that started on that line before, or 1 for a list the edit began. */
function startAt(was: Lines, n: number) {
  const list = numberedList(was, n);
  return list[0]?.line === n ? Number(numbered(was, list[0])![2]) : 1;
}

/** The number two or more items all have, if they do. */
const shared = (numbers: string[]) => (numbers.length > 1 && numbers.every((number) => number === numbers[0]) ? numbers[0] : undefined);

/**
 * The number a list written as `1.`, `1.`, `1.` keeps on every item after an edit: the number the items that were in it share,
 * when two or more were. With fewer, the list the moved items came from counts too, when it was written that way.
 */
function sameNumber(was: Lines, lines: Lines, list: Item[], placed: Item | null) {
  const isPlaced = (item: Item) => !!placed && item.line >= placed.line && item.line < placed.end;
  const stayed = list.filter((item) => !isPlaced(item)).map((item) => numbered(lines, item)![2]!);
  if (stayed.length > 1) return shared(stayed);
  const came = list.find(isPlaced);
  const from = came ? numberedList(was, came.line).map((item) => numbered(was, item)![2]!) : [];
  return from.length > 1 ? shared([...stayed, ...from]) : undefined;
}

/**
 * Numbers the list the item on line `n` is in 1., 2., 3. in order, from the number it starts at, or with the one number
 * every item has when it is written that way (`sameNumber`). `placed` is the block the edit put in a new place, when it
 * stays on its lines.
 * A number that grows or shrinks a column takes what is written under its item along with its text.
 */
function renumber(was: Lines, rewrites: Rewrites, n: number, placed: Item | null) {
  const lines = over(was, rewrites);
  const list = numberedList(lines, n);
  if (!list.length) return;
  const start = startAt(was, list[0]!.line);
  const same = sameNumber(was, lines, list, placed);
  list.forEach((item, i) => {
    const [, space, number, closer] = numbered(lines, item)!;
    const to = same ?? String(start + i);
    const wider = to.length - number!.length;
    rewrites.set(item.line, `${space}${to}${closer}${lines.at(item.line).slice(space!.length + number!.length + 1)}`);
    if (!wider) return;
    for (let m = item.line + 1; m < item.end; m++) if (!blank(lines.at(m)) && indentOf(lines.at(m)) >= item.inside) rewrites.set(m, moved(lines.at(m), wider));
  });
}

/** The edit that writes these lines, with each numbered list on `lists` numbered in order after them. It spans only the lines that come out different. */
function made(was: Lines, rewrites: Rewrites, lists: readonly (number | undefined)[], placed: Item | null, landed: (line: number) => number = (line) => line): Edit {
  for (const n of lists) if (n !== undefined) renumber(was, rewrites, n, placed);
  const changed = [...rewrites.keys()].filter((n) => rewrites.get(n) !== was.at(n));
  if (!changed.length) changed.push(...rewrites.keys());
  const [from, to] = [Math.min(...changed), Math.max(...changed) + 1];
  return { from, to, lines: slice(over(was, rewrites), from, to), after: landed };
}

/**
 * Puts the item on line `n` under the item before it, with everything under it, and with the items
 * after it in its list that start by line `last`. Null when it is the first of its list, which has
 * nothing to go under. An item goes in only as far as the item before it writes its own text, so
 * it is never two levels further in than the item above it.
 */
export function indent(lines: Lines, n: number, last = n): Edit | null {
  const item = itemsFrom(lines, n, last);
  const above = item && before(lines, item);
  if (!item || !above) return null;
  const rewrites: Rewrites = new Map();
  shift(lines, item, above.inside - item.indent, rewrites);
  return made(lines, rewrites, [above.line, item.line], item);
}

/**
 * Puts the item on line `n` beside the item it is under, with everything under it, and with the
 * items after it in its list that start by line `last`. What followed them in their list is under
 * the last of them after. Null when it is under nothing.
 */
export function outdent(lines: Lines, n: number, last = n): Edit | null {
  const item = itemsFrom(lines, n, last);
  const parent = item && parentOf(lines, item);
  if (!item || !parent) return null;
  const rewrites: Rewrites = new Map();
  shift(lines, item, parent.indent - item.indent, rewrites);
  return made(lines, rewrites, [parent.line, item.line, before(lines, item)?.line, after(lines, item)?.line], item);
}

/**
 * Moves the item on line `n` past the item before it (`by` -1) or after it (1) in its list, with
 * everything under it, and with the items after it in its list that start by line `last`. Null when
 * there is none.
 */
export function move(lines: Lines, n: number, by: -1 | 1, last = n): Edit | null {
  const item = itemsFrom(lines, n, last);
  const other = item && (by < 0 ? before(lines, item) : after(lines, item));
  if (!item || !other) return null;
  const [first, second] = by < 0 ? [other, item] : [item, other];
  const [a, gap, b] = [slice(lines, first.line, first.end), slice(lines, first.end, second.line), slice(lines, second.line, second.end)];
  const rewrites: Rewrites = new Map([...b, ...gap, ...a].map((line, i) => [first.line + i, line]));
  const landed = (line: number) =>
    line < first.line || line >= second.end ? line : line >= second.line ? line - (second.line - first.line) : line < first.end ? line + (second.end - first.end) : line + b.length - a.length;
  // The two can be lists of their own, a bullet beside numbers, so the lists each one lands among are numbered, and the list after them.
  return made(lines, rewrites, [first.line, first.line + b.length + gap.length, after(lines, second)?.line], null, landed);
}

/** The text with the edit made. */
export function applied(text: string, edit: Edit): string {
  const lines = text.split("\n");
  return [...lines.slice(0, edit.from), ...edit.lines, ...lines.slice(edit.to)].join("\n");
}
