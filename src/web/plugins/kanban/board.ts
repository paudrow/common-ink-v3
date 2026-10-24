import { SWATCHES, type Swatch } from "../../plugin-api.ts";

/**
 * A kanban block's body, read as a board. Headings are columns and top-level list items are cards.
 * Every line of the body is kept in the place it was read from, so writing a board back out gives
 * the same markdown, and moving a card moves that card's lines and nothing else.
 */
export interface Board {
  /** The lines before the first heading. */
  before: readonly string[];
  columns: readonly Column[];
}

export interface Column {
  /** The heading line as written, such as `## Doing` or `## Doing {.blue}`. */
  heading: string;
  /** The heading's text, without its colour. */
  title: string;
  /** The colour the heading ends with, written as markdown writes a heading's class: `{.blue}`. */
  colour: Swatch | null;
  parts: readonly Part[];
}

/** A card, or lines between cards that aren't one: blank lines, paragraphs, code. */
export type Part = Card | { card: false; lines: readonly string[] };

export interface Card {
  card: true;
  /** The list item's line, and the lines that go with it: those indented under it, and any that carry its text on without a blank line between. */
  lines: readonly string[];
  /** The list item's own text, without its marker. */
  text: string;
  /** The lines under it, without their indent. */
  more: string;
}

export interface Place {
  column: number;
  /** The index among the column's cards. */
  card: number;
}

/** A heading's `#`s and the spaces after them. */
const HEADING_MARK = /^#{1,6}[ \t]+/;
/** The colour a heading's text ends with. Braces that name no colour are part of the title. */
const COLOUR = new RegExp(`\\{\\.(${SWATCHES.join("|")})\\}$`);
const ITEM = /^(?:[-*+]|\d+[.)])[ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** `---`, `* * *`, `___`: a rule across the page, which the list markers `-` and `*` would otherwise make a card of. */
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** Where the spaces and tabs that end at `end` of `text` start. */
function blanksBefore(text: string, end: number): number {
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return end;
}

/**
 * A heading's text, without its closing `#`s and the spaces around them, or null for a line that
 * isn't a heading. Cut by hand: as one pattern it tried again from every space, which took minutes
 * on a heading of many.
 */
function headingIn(line: string): string | null {
  const mark = HEADING_MARK.exec(line);
  if (!mark) return null;
  const text = line.slice(mark[0].length);
  // A line that holds a line break of another kind isn't a heading, as the pattern this was had it.
  if (/[\n\r\u2028\u2029]/.test(text)) return null;
  let end = blanksBefore(text, text.length);
  let hashes = end;
  while (hashes > 0 && text[hashes - 1] === "#") hashes--;
  if (hashes < end && hashes > 0 && (text[hashes - 1] === " " || text[hashes - 1] === "\t")) end = blanksBefore(text, hashes);
  return text.slice(0, end);
}

/** A heading's text read as its title and the colour it ends with, if it ends with one. */
function colouredIn(text: string): { title: string; colour: Swatch } | null {
  const colour = COLOUR.exec(text);
  return colour ? { title: text.slice(0, blanksBefore(text, colour.index)), colour: colour[1] as Swatch } : null;
}

const indented = (line: string) => /^[ \t]+\S/.test(line);
/** A line that carries a list item's paragraph on, which markdown reads as part of the item though it isn't indented. */
const carriesOn = (line: string) => line.trim() !== "" && headingIn(line) === null && !ITEM.test(line) && !FENCE.test(line) && !RULE.test(line);

export function parseBoard(body: string): Board {
  const lines = body.split("\n");
  const before: string[] = [];
  const columns: (Omit<Column, "parts"> & { parts: Part[] })[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const into = columns.at(-1);
    const other = () => (into ? into.parts.push({ card: false, lines: [line] }) : before.push(line));
    if (fence) {
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
      other();
      continue;
    }
    const heading = headingIn(line);
    const item = into && !RULE.test(line) && ITEM.exec(line);
    if (heading !== null) {
      const coloured = colouredIn(heading);
      columns.push({ heading: line, title: coloured?.title ?? heading, colour: coloured?.colour ?? null, parts: [] });
    }
    else if (item) {
      // A card takes the indented lines under it, blank lines only where an indented line follows them, and lines that carry on from the one before.
      let end = i + 1;
      for (let j = end; j < lines.length; j++) {
        const next = lines[j]!;
        if (indented(next) || (j === end && carriesOn(next))) end = j + 1;
        else if (next.trim() !== "") break;
      }
      const under = lines.slice(i + 1, end);
      const indent = Math.min(...under.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
      into.parts.push({ card: true, lines: lines.slice(i, end), text: item[1]!.trim(), more: under.map((l) => l.slice(indent)).join("\n") });
      i = end - 1;
    } else {
      fence = FENCE.exec(line)?.[1] ?? null;
      other();
    }
  }
  return { before, columns };
}

export const serializeBoard = (board: Board): string => [...board.before, ...board.columns.flatMap((c) => [c.heading, ...c.parts.flatMap((p) => p.lines)])].join("\n");

export const cardsOf = (column: Column): Card[] => column.parts.filter((p): p is Card => p.card);

/** How far into the board as written the end of a card's own line is, which is where its text is changed. Null for a place with no card. */
export function cardEnd(board: Board, at: Place): number | null {
  const card = board.columns[at.column] && cardsOf(board.columns[at.column]!)[at.card];
  if (!card) return null;
  const lengthOf = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0);
  let offset = lengthOf(board.before);
  for (const column of board.columns) {
    offset += column.heading.length + 1;
    for (const part of column.parts) {
      if (part === card) return offset + card.lines[0]!.length;
      offset += lengthOf(part.lines);
    }
  }
  return null;
}

const isBlank = (part: Part) => !part.card && part.lines.every((l) => l.trim() === "");

/** Where in a column's parts its `at`th card goes: before the card there now, or after the last one, ahead of the blank lines that end the column. */
function slot(parts: readonly Part[], at: number): number {
  const cards = parts.flatMap((p, i) => (p.card ? [i] : []));
  if (at < cards.length) return cards[at]!;
  if (cards.length) return cards.at(-1)! + 1;
  let end = parts.length;
  while (end > 0 && isBlank(parts[end - 1]!)) end--;
  return end;
}

const withParts = (board: Board, column: number, change: (parts: Part[]) => void): Board => ({
  ...board,
  columns: board.columns.map((c, i) => {
    if (i !== column) return c;
    const parts = [...c.parts];
    change(parts);
    return { ...c, parts };
  }),
});

/** The board with a card's lines written as `text`, as ticking its box or picking its due date writes them. Read again, so its text is what the lines now say. */
export function changeCard(board: Board, at: Place, text: string): Board {
  const card = board.columns[at.column] && cardsOf(board.columns[at.column]!)[at.card];
  if (!card || text === card.lines.join("\n")) return board;
  return parseBoard(serializeBoard(withParts(board, at.column, (parts) => void parts.splice(parts.indexOf(card), 1, { ...card, lines: text.split("\n") }))));
}

/**
 * Moves a card. `to.card` counts the cards of the column it goes to with the moved card already
 * taken out. A place that isn't on the board leaves the board as it is.
 */
export function moveCard(board: Board, from: Place, to: Place): Board {
  const card = board.columns[from.column] && cardsOf(board.columns[from.column]!)[from.card];
  if (!card || !board.columns[to.column] || to.card < 0) return board;
  const without = withParts(board, from.column, (parts) => void parts.splice(parts.indexOf(card), 1));
  return withParts(without, to.column, (parts) => void parts.splice(slot(parts, to.card), 0, card));
}

/** Adds a card to the end of a column, written with the list marker the board's cards use. */
export function addCard(board: Board, column: number, text: string): Board {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line || !board.columns[column]) return board;
  const marker = /^(?:[-*+]|\d+[.)])/.exec(board.columns.flatMap(cardsOf)[0]?.lines[0] ?? "")?.[0] ?? "-";
  const card: Card = { card: true, lines: [`${/\d/.test(marker) ? "1." : marker} ${line}`], text: line, more: "" };
  return withParts(board, column, (parts) => void parts.splice(slot(parts, Infinity), 0, card));
}

/** Gives a column a colour, or with null takes it away, by rewriting the end of its heading line and nothing else. */
export function colourColumn(board: Board, column: number, colour: Swatch | null): Board {
  const at = board.columns[column];
  if (!at || at.colour === colour) return board;
  const marks = HEADING_MARK.exec(at.heading)![0];
  const closing = at.heading.slice(marks.length + headingIn(at.heading)!.length);
  const heading = `${marks}${at.title}${colour ? ` {.${colour}}` : ""}${closing}`;
  return { ...board, columns: board.columns.map((c, i) => (i === column ? { ...c, heading, colour } : c)) };
}

/** A column's title as a heading can hold it: one line, with no colour mark of its own at its end. */
const titleOf = (text: string) => text.replace(/\s+/g, " ").replace(COLOUR, "").trim();

/** The `#`s a new column's heading is written with: those of the board's first heading, or `## `. */
const marksOf = (board: Board) => (board.columns[0] ? HEADING_MARK.exec(board.columns[0].heading)![0] : "## ");

const endsBlank = (column: Column) => {
  const last = column.parts.at(-1);
  return !!last && isBlank(last);
};

/** The column with a blank line at its end, as a column followed by another is written. */
const spaced = (column: Column): Column => (endsBlank(column) ? column : { ...column, parts: [...column.parts, { card: false, lines: [""] }] });

/** The columns written one after another: a blank line after each but the last, as the board's own are. */
const laidOut = (columns: readonly Column[]): Column[] => columns.map((c, i) => (i < columns.length - 1 ? spaced(c) : c));

/** Adds a column at the end of the board, with a heading written as the board's others are. A title with nothing in it adds none. */
export function addColumn(board: Board, title: string): Board {
  const name = titleOf(title);
  if (!name) return board;
  const column: Column = { heading: `${marksOf(board)}${name}`, title: name, colour: null, parts: [] };
  // An empty board's one empty line is no line of its own to keep.
  const before = board.columns.length || board.before.some((line) => line.trim()) ? board.before : [];
  return { before, columns: laidOut([...board.columns, column]) };
}

/** Gives a column another title, rewriting its heading's words and keeping its marks and its colour. */
export function renameColumn(board: Board, column: number, title: string): Board {
  const at = board.columns[column];
  const name = titleOf(title);
  if (!at || !name || name === at.title) return board;
  const marks = HEADING_MARK.exec(at.heading)![0];
  const closing = at.heading.slice(marks.length + headingIn(at.heading)!.length);
  const heading = `${marks}${name}${at.colour ? ` {.${at.colour}}` : ""}${closing}`;
  return { ...board, columns: board.columns.map((c, i) => (i === column ? { ...c, heading, title: name } : c)) };
}

/** Moves a column to another place among the columns, its heading and everything under it. */
export function moveColumn(board: Board, column: number, to: number): Board {
  if (!board.columns[column] || to < 0 || to >= board.columns.length || to === column) return board;
  const columns = [...board.columns];
  const [moved] = columns.splice(column, 1);
  columns.splice(to, 0, moved!);
  return { ...board, columns: laidOut(columns) };
}

/**
 * Takes a column off the board, its heading and everything under it. With `into`, its cards go to
 * the end of that column first, and only its other lines go with it.
 */
export function deleteColumn(board: Board, column: number, into: number | null = null): Board {
  const at = board.columns[column];
  if (!at || into === column || (into !== null && !board.columns[into])) return board;
  const moved = into === null ? board : withParts(board, into, (parts) => void parts.splice(slot(parts, Infinity), 0, ...cardsOf(at)));
  return { ...moved, columns: laidOut(moved.columns.filter((_, i) => i !== column)) };
}
