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

/** Lines of a note written another way: the lines from `from` up to `to` become `lines`. */
export interface Edit {
  from: number;
  to: number;
  lines: string[];
  /** Where a line that was in the edit is after it, so the cursor and what is folded can go with their lines. */
  after(line: number): number;
  /** How far along its line the item's text moved. */
  shift: number;
}

const ITEM = /^([ \t]*)([-*+]|\d+[.)])(\s+|$)/;
const blank = (line: string) => !line.trim();
const leading = (line: string) => /^[ \t]*/.exec(line)![0];
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

/** Moves the item's lines in or out by `by` columns. A line that is moved is written with spaces before it, since a tab's width depends on where it starts. */
function shifted(lines: Lines, item: Item, by: number): Edit {
  const moved = slice(lines, item.line, item.end).map((line) => (blank(line) ? line : " ".repeat(Math.max(0, indentOf(line) + by)) + line.slice(leading(line).length)));
  return { from: item.line, to: item.end, lines: moved, after: (line) => line, shift: leading(moved[0]!).length - leading(lines.at(item.line)).length };
}

/** Puts the item on line `n` under the item before it, with everything under it. Null when it is the first of its list, which has nothing to go under. */
export function indent(lines: Lines, n: number): Edit | null {
  const item = itemAt(lines, n);
  const above = item && before(lines, item);
  return item && above ? shifted(lines, item, above.inside - item.indent) : null;
}

/** Puts the item on line `n` beside the item it is under, with everything under it. What followed it in its list is under it after. Null when it is under nothing. */
export function outdent(lines: Lines, n: number): Edit | null {
  const item = itemAt(lines, n);
  const parent = item && parentOf(lines, item);
  return item && parent ? shifted(lines, item, parent.indent - item.indent) : null;
}

/** Moves the item on line `n` past the item before it (`by` -1) or after it (1) in its list, with everything under it. Null when there is none. */
export function move(lines: Lines, n: number, by: -1 | 1): Edit | null {
  const item = itemAt(lines, n);
  const other = item && (by < 0 ? before(lines, item) : after(lines, item));
  if (!item || !other) return null;
  const [first, second] = by < 0 ? [other, item] : [item, other];
  const [a, gap, b] = [slice(lines, first.line, first.end), slice(lines, first.end, second.line), slice(lines, second.line, second.end)];
  const landed = (line: number) => (line >= second.line ? line - (second.line - first.line) : line < first.end ? line + (second.end - first.end) : line + b.length - a.length);
  return { from: first.line, to: second.end, lines: [...b, ...gap, ...a], after: landed, shift: 0 };
}

/** The text with the edit made. */
export function applied(text: string, edit: Edit): string {
  const lines = text.split("\n");
  return [...lines.slice(0, edit.from), ...edit.lines, ...lines.slice(edit.to)].join("\n");
}
