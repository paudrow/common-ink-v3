/** A table read from comma- or tab-separated text: its rows, at most as many as were asked for, how many cells its widest row has, and whether rows were left out. */
export interface Table {
  rows: string[][];
  width: number;
  more: boolean;
}

/**
 * The rows of a CSV or TSV, as RFC 4180 reads them and a little more leniently: a cell in quotes may
 * hold the separator, line breaks and doubled quotes; anything after a closing quote is still the
 * cell's; a quote left open runs to the end. CRLF, LF and a lone CR each end a row. Rows keep the
 * cells they have, so a ragged row stays ragged.
 */
export function tableOf(text: string, separator: "," | "\t", limit: number): Table {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  /** Whether nothing of the cell has been read yet, which is the one place a quote opens one. */
  let fresh = true;
  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
  };
  while (at < text.length && rows.length < limit) {
    const ch = text[at]!;
    if (ch === '"' && fresh) {
      const close = quoted(text, at + 1);
      cell += close.cell;
      at = close.at;
      fresh = false;
    } else if (ch === separator) {
      row.push(cell);
      cell = "";
      at++;
      fresh = true;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      at += ch === "\r" && text[at + 1] === "\n" ? 2 : 1;
      fresh = true;
    } else {
      cell += ch;
      at++;
      fresh = false;
    }
  }
  if (rows.length < limit && (!fresh || row.length)) endRow();
  return { rows, width: rows.reduce((widest, r) => Math.max(widest, r.length), 0), more: at < text.length };
}

/** A quoted cell's words from just after its opening quote, and where reading goes on: just after its closing quote. */
function quoted(text: string, from: number): { cell: string; at: number } {
  let cell = "";
  let at = from;
  while (at < text.length) {
    const close = text.indexOf('"', at);
    if (close < 0) return { cell: cell + text.slice(at), at: text.length };
    cell += text.slice(at, close);
    if (text[close + 1] !== '"') return { cell, at: close + 1 };
    cell += '"';
    at = close + 2;
  }
  return { cell, at };
}

/** What of a table is drawn: rows padded to one width, cut to so many columns and so many cells in all, and whether either cut left something out. */
export interface ShownTable {
  rows: string[][];
  width: number;
  columnsCut: boolean;
  rowsCut: boolean;
}

/** A table cut to draw: a row of thousands of empty cells is as costly to draw as thousands of rows. */
export function shownTable(table: Table, most: { columns: number; cells: number }): ShownTable {
  const width = Math.min(table.width, most.columns);
  const count = Math.min(table.rows.length, Math.max(1, Math.floor(most.cells / Math.max(1, width))));
  const rows = table.rows.slice(0, count).map((row) => (row.length >= width ? row.slice(0, width) : [...row, ...Array.from({ length: width - row.length }, () => "")]));
  return { rows, width, columnsCut: table.width > width, rowsCut: table.more || table.rows.length > count };
}
