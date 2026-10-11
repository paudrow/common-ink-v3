export type Align = "left" | "center" | "right" | null;

/**
 * A table as a note writes it. `rows[0]` is the header. Every row has a cell for every column, and
 * a cell holds what it says: no padding, and a `|` where the note writes `\|`.
 */
export interface Table {
  aligns: Align[];
  rows: string[][];
}

const DELIMITER = /^:?-+:?$/;

/**
 * The part of a table's text that is drawn as the table: its lines down to the first with no pipe.
 * GitHub reads a line of plain words directly under a table as one more row. Drawn that way, the
 * words a member types on the line after a table would vanish into it, so here such a line stays
 * a line of text under the table, and the note says what it said.
 */
export function pipedPart(text: string): string {
  const lines = text.split("\n");
  const end = lines.findIndex((line, n) => n >= 2 && !line.includes("|"));
  return end < 0 ? text : lines.slice(0, end).join("\n");
}

/** A row's cells as written between its pipes, or null for a line that isn't a row. */
function cellsOf(line: string): string[] | null {
  if (/^\s/.test(line) || !line.includes("|")) return null;
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") cell += line[++i];
    else if (line[i] === "|") {
      cells.push(cell);
      cell = "";
    } else cell += line[i];
  }
  cells.push(cell);
  if (line.trimStart().startsWith("|")) cells.shift();
  if (/(?<!\\)\|\s*$/.test(line)) cells.pop();
  return cells.map((c) => c.trim());
}

/**
 * Reads a table: a header row, a row of dashes, then rows. Null for anything else, and for a table
 * that is indented or quoted, which is left as written. A row with fewer cells than the widest is
 * filled out with empty ones, so no cell is lost when the table is written again.
 */
export function parseTable(text: string): Table | null {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length < 2) return null;
  const read = lines.map(cellsOf);
  if (read.some((cells) => !cells)) return null;
  const [header, delimiter, ...body] = read as string[][];
  if (!header!.length || delimiter!.length !== header!.length || !delimiter!.every((d) => DELIMITER.test(d))) return null;
  const columns = Math.max(header!.length, ...body.map((row) => row.length));
  const wide = (row: string[]) => [...row, ...Array<string>(columns - row.length).fill("")];
  const aligns = wide(delimiter!).map((d): Align => (d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : null));
  return { aligns, rows: [header!, ...body].map(wide) };
}

const written = (cell: string) => cell.replace(/\s*\n\s*/g, " ").trim().replace(/\|/g, "\\|");

const dashes = (align: Align, width: number) => {
  const [left, right] = [align === "left" || align === "center" ? ":" : "", align === "right" || align === "center" ? ":" : ""];
  return left + "-".repeat(width - left.length - right.length) + right;
};

/** Writes a table with its columns lined up. A table already written that way is written the same again. */
export function serializeTable({ aligns, rows }: Table): string {
  const cells = rows.map((row) => row.map(written));
  const widths = aligns.map((_, c) => Math.max(3, ...cells.map((row) => row[c]!.length)));
  const line = (row: string[]) => `| ${row.map((cell, c) => cell.padEnd(widths[c]!)).join(" | ")} |`;
  return [line(cells[0]!), line(aligns.map((align, c) => dashes(align, widths[c]!))), ...cells.slice(1).map(line)].join("\n");
}

/** A cell of a table: its row, counting the header as 0, and its column. */
export type At = readonly [row: number, column: number];

export const setCell = (table: Table, [row, column]: At, text: string): Table => ({ ...table, rows: table.rows.map((cells, r) => (r === row ? cells.map((cell, c) => (c === column ? text : cell)) : cells)) });

/** A new empty row after `row`. */
export const addRow = (table: Table, row: number): Table => ({ ...table, rows: [...table.rows.slice(0, row + 1), table.aligns.map(() => ""), ...table.rows.slice(row + 1)] });

/** Without `row`. The header stays: a table has one. */
export const removeRow = (table: Table, row: number): Table => (row === 0 ? table : { ...table, rows: table.rows.filter((_, r) => r !== row) });

/** A new empty column after `column`. */
export const addColumn = (table: Table, column: number): Table => ({
  aligns: [...table.aligns.slice(0, column + 1), null, ...table.aligns.slice(column + 1)],
  rows: table.rows.map((cells) => [...cells.slice(0, column + 1), "", ...cells.slice(column + 1)]),
});

/** Without `column`. The last column stays: a table has one. */
export const removeColumn = (table: Table, column: number): Table =>
  table.aligns.length === 1 ? table : { aligns: table.aligns.filter((_, c) => c !== column), rows: table.rows.map((cells) => cells.filter((_, c) => c !== column)) };
