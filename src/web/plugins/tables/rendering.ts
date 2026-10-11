import { syntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { drawnInState, writable } from "../lib/live.ts";
import { replacing } from "../lib/rewrite.ts";
import { inlineMarkdown } from "./inline.ts";
import { addColumn, addRow, parseTable, pipedPart, removeColumn, removeRow, serializeTable, setCell, type At, type Table } from "./table.ts";

interface Found {
  from: number;
  to: number;
  text: string;
  table: Table;
}

/** What a drawn table is drawn from now, and the cell its buttons act on. */
interface Drawn {
  text: string;
  table: Table;
  at: At;
}

const drawn = new WeakMap<HTMLElement, Drawn>();
/** Set while a table is being drawn again. A cell taken out then loses the cursor, which is not the member leaving it. */
let drawing = false;

const keyOf = ([row, column]: At) => `${row},${column}`;
const cellAt = (el: HTMLElement, at: At) => el.querySelector<HTMLElement>(`[data-focus="${keyOf(at)}"]`);

function show(cell: HTMLElement, text: string) {
  cell.replaceChildren(inlineMarkdown(text));
}

/** Each cell is a box inside its `td`, so that while it is typed in it can be held at the size it was drawn. */
function build(el: HTMLElement, { table }: Drawn) {
  const editable = el.dataset.readonly === undefined;
  const grid = document.createElement("table");
  table.rows.forEach((cells, r) => {
    const row = grid.insertRow();
    cells.forEach((text, c) => {
      const cell = row.appendChild(document.createElement(r === 0 ? "th" : "td")).appendChild(document.createElement("div"));
      if (editable) cell.contentEditable = "true";
      cell.spellcheck = false;
      cell.dataset.focus = keyOf([r, c]);
      cell.parentElement!.style.textAlign = table.aligns[c] ?? "";
      show(cell, text);
    });
  });
  el.querySelector("table")!.replaceWith(grid);
}

/**
 * Where a row or a column of `was` is in `now`: the one that still says all it said, in order, if
 * there is exactly one, and else the same place. A row keeps its cells when a column is added
 * beside them, and a column its cells when a row is.
 */
function follows(was: readonly string[], now: readonly (readonly string[])[], at: number) {
  const holds = (cells: readonly string[]) => {
    let next = 0;
    for (const cell of cells) if (next < was.length && cell === was[next]) next++;
    return next === was.length;
  };
  const same = now.flatMap((cells, n) => (holds(cells) ? [n] : []));
  return same.length === 1 ? same[0]! : at;
}

/** Draws `next` in the element the table before it had. A table of the same shape keeps its cells, so the one being typed in isn't taken away. */
function sync(el: HTMLElement, next: Pick<Drawn, "text" | "table">) {
  const was = drawn.get(el)!;
  const now = { ...next, at: was.at };
  drawn.set(el, now);
  const sameShape = was.table.rows.length === next.table.rows.length && was.table.aligns.length === next.table.aligns.length;
  if (!sameShape) {
    // A cell being typed in when someone else adds a row or a column keeps the keyboard and what was typed, in the cell its row and column have become.
    const typing = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-focus]") : null;
    const typed = typing?.textContent ?? "";
    const [row, column] = typing ? (typing.dataset.focus!.split(",").map(Number) as [number, number]) : [0, 0];
    const columnsOf = (table: Table) => table.aligns.map((_, c) => table.rows.map((cells) => cells[c]!));
    const kept: At | undefined = typing ? [follows(was.table.rows[row]!, next.table.rows, row), follows(columnsOf(was.table)[column]!, columnsOf(next.table), column)] : undefined;
    drawing = true;
    try {
      build(el, now);
    } finally {
      drawing = false;
    }
    const wanted = el.dataset.focus;
    delete el.dataset.focus;
    const cell = cellAt(el, wanted ? (wanted.split(",").map(Number) as unknown as At) : (kept ?? [-1, -1]));
    cell?.focus();
    if (cell && !wanted) {
      cell.textContent = typed;
      getSelection()?.selectAllChildren(cell);
      getSelection()?.collapseToEnd();
    }
    return;
  }
  next.table.rows.forEach((cells, r) =>
    cells.forEach((text, c) => {
      const cell = cellAt(el, [r, c])!;
      cell.parentElement!.style.textAlign = next.table.aligns[c] ?? "";
      if (cell !== document.activeElement) show(cell, text);
    }),
  );
}

class TableWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly table: Table,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  override eq(other: TableWidget) {
    return other.text === this.text && other.readOnly === this.readOnly;
  }

  /** Close to what it measures, so a table further down the note is given its room before it is drawn. */
  override get estimatedHeight() {
    return this.table.rows.length * 38 + 12;
  }

  override toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "md-table";
    if (this.readOnly) el.dataset.readonly = "";
    el.appendChild(document.createElement("div")).append(document.createElement("table"));
    const state: Drawn = { text: this.text, table: this.table, at: [0, 0] };
    drawn.set(el, state);
    build(el, state);

    /** Where the table is in the note, if the note still writes it as it is drawn here. */
    const range = () => {
      let from: number;
      try {
        from = view.posAtDOM(el);
      } catch {
        return undefined;
      }
      const { text } = drawn.get(el)!;
      return view.state.sliceDoc(from, from + text.length) === text ? { from, to: from + text.length } : undefined;
    };
    /** Writes the table another way in the note, as an edit by the member, and says which cell is to have the cursor after. */
    const write = (next: Table, focus?: At) => {
      const where = writable(view.state) ? range() : undefined;
      const changes = where && replacing(drawn.get(el)!.text, serializeTable(next), where.from);
      if (!changes) return focus && cellAt(el, focus)?.focus();
      if (focus) el.dataset.focus = keyOf(focus);
      view.dispatch({ changes, userEvent: "input.table" });
      if (focus) cellAt(el, focus)?.focus();
      delete el.dataset.focus;
    };
    /** Hands the keyboard back to the note, with the cursor on the line before the table or the line after it. */
    const leave = (after: boolean) => {
      const where = range();
      view.focus();
      if (!where) return;
      const { doc } = view.state;
      const line = doc.lineAt(after ? where.to : where.from).number + (after ? 1 : -1);
      if (line >= 1 && line <= doc.lines) view.dispatch({ selection: { anchor: doc.line(line).from }, scrollIntoView: true });
    };
    const atOf = (cell: HTMLElement) => cell.dataset.focus!.split(",").map(Number) as unknown as At;
    const typedIn = (cell: HTMLElement) => (cell.textContent ?? "").replace(/\s*\n\s*/g, " ").trim();
    /** The table with what has been typed in `cell`. */
    const committed = (cell: HTMLElement) => setCell(drawn.get(el)!.table, atOf(cell), typedIn(cell));

    // A click on a cell's edge is a click in the cell.
    el.addEventListener("mousedown", (event) => {
      const inside = event.target instanceof HTMLTableCellElement ? event.target.querySelector<HTMLElement>("[data-focus][contenteditable]") : null;
      if (!inside) return;
      event.preventDefault();
      inside.focus();
    });
    el.addEventListener("focusin", (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-focus]");
      if (!cell) return;
      const at = atOf(cell);
      drawn.get(el)!.at = at;
      // A cell being typed in shows what the note writes for it, on one line in the box it was drawn in, so its
      // marks make the row no taller and nothing after the table moves. What doesn't fit scrolls sideways.
      const box = cell.getBoundingClientRect();
      Object.assign(cell.style, { width: `${box.width}px`, height: `${box.height}px` });
      cell.classList.add("md-cell-typing");
      cell.textContent = drawn.get(el)!.table.rows[at[0]]![at[1]]!;
      getSelection()?.selectAllChildren(cell);
    });
    el.addEventListener("focusout", (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-focus]");
      if (!cell || drawing) return;
      Object.assign(cell.style, { width: "", height: "" });
      cell.classList.remove("md-cell-typing");
      const [row, column] = atOf(cell);
      const { table } = drawn.get(el)!;
      const typed = typedIn(cell);
      show(cell, typed);
      // Looking at a cell writes nothing. Only a cell that says something else is written, and the table with it.
      if (typed !== table.rows[row]![column]) write(setCell(table, [row, column], typed));
    });
    el.addEventListener("paste", (event) => {
      event.preventDefault();
      document.execCommand("insertText", false, (event.clipboardData?.getData("text/plain") ?? "").replace(/\s*\n\s*/g, " "));
    });
    el.addEventListener("keydown", (event) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-focus]");
      if (!cell || event.isComposing) return;
      const [row, column] = atOf(cell);
      const { table } = drawn.get(el)!;
      const [rows, columns] = [table.rows.length, table.aligns.length];
      const go = (to: At) => {
        event.preventDefault();
        // A step off the end of the table makes the row it steps into.
        if (to[0] === rows) write(addRow(committed(cell), rows - 1), to);
        else cellAt(el, to)?.focus();
      };
      const out = (after: boolean) => {
        event.preventDefault();
        leave(after);
      };
      if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
        // Left to the browser, select-all takes the whole note, not the cell.
        event.preventDefault();
        getSelection()?.selectAllChildren(cell);
      } else if (event.key === "Enter") go([row + 1, column]);
      else if (event.key === "Tab" && event.shiftKey) go(column > 0 ? [row, column - 1] : row > 0 ? [row - 1, columns - 1] : [row, column]);
      else if (event.key === "Tab") go(column < columns - 1 ? [row, column + 1] : [row + 1, 0]);
      else if (event.key === "ArrowDown") row < rows - 1 ? go([row + 1, column]) : out(true);
      else if (event.key === "ArrowUp") row > 0 ? go([row - 1, column]) : out(false);
      else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cell.textContent = table.rows[row]![column]!;
        view.focus();
      }
    });

    if (this.readOnly) return el;
    const tools = el.appendChild(document.createElement("div"));
    tools.className = "md-table-tools";
    const tool = (label: string, run: (table: Table, at: At) => void) => {
      const button = tools.appendChild(document.createElement("button"));
      button.type = "button";
      button.textContent = label;
      // The cell being typed in keeps the cursor, and what was typed is in the table the button changes.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const { at } = drawn.get(el)!;
        const typing = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("[data-focus]") : null;
        run(typing ? committed(typing) : drawn.get(el)!.table, at);
      });
    };
    tool("Add row", (table, [row]) => write(addRow(table, row), [row + 1, 0]));
    tool("Add column", (table, [row, column]) => write(addColumn(table, column), [row, column + 1]));
    tool("Delete row", (table, [row, column]) => write(removeRow(table, row), [Math.min(row, table.rows.length - 2), column]));
    tool("Delete column", (table, [row, column]) => write(removeColumn(table, column), [row, Math.min(column, table.aligns.length - 2)]));
    return el;
  }

  override updateDOM(el: HTMLElement) {
    if (!drawn.has(el) || (el.dataset.readonly !== undefined) !== this.readOnly) return false;
    sync(el, { text: this.text, table: this.table });
    return true;
  }

  /** What happens in a table is the table's, so a click in a cell doesn't move the note's cursor. */
  override ignoreEvent() {
    return true;
  }
}

/** The tables in the note that can be drawn, from the parse. Only blocks at the top of the note are looked at, so a long note is read quickly. */
function tablesIn(state: EditorState): Found[] {
  const found: Found[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") return true;
      if (node.name !== "Table") return false;
      const text = pipedPart(state.sliceDoc(node.from, node.to));
      const table = node.from === state.doc.lineAt(node.from).from ? parseTable(text) : null;
      if (table) found.push({ from: node.from, to: node.from + text.length, text, table });
      return false;
    },
  });
  return found;
}

/**
 * A table is drawn as a table wherever the cursor is, and its cells are typed in where they are
 * drawn. Its pipes are never shown: a table's lines written out are a different height and width
 * from the table drawn, so showing them would move everything after it.
 */
const tables = drawnInState({
  read: tablesIn,
  draw: (state, found) => found.map((t) => Decoration.replace({ widget: new TableWidget(t.text, t.table, !writable(state)), block: true }).range(t.from, t.to)),
});

/**
 * A table is one thing to a deletion that reaches into it from outside, as it is to vim's j and k:
 * `dj` from the line above, `3dd`, or a line selection that ends on its header takes the whole
 * table. Without this the rows left behind would be half a table, shown as its pipes. A change
 * inside the table, such as a cell's own edit or its undo, is let through as it is.
 */
const deletedWhole = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const { found } = tr.startState.field(tables.field);
  const rest: { from: number; to: number }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length) return;
    for (const table of found) {
      const end = Math.min(table.to + 1, tr.startState.doc.length);
      if (fromA < table.from && toA > table.from && toA < end) rest.push({ from: toA, to: toA === tr.startState.doc.lineAt(toA).from ? end : table.to });
      else if (fromA > table.from && fromA <= table.to && toA > table.to) rest.push({ from: table.from, to: fromA });
    }
  });
  if (!rest.length) return tr;
  return [tr, { changes: rest.map(({ from, to }) => ({ from: tr.changes.mapPos(from, -1), to: tr.changes.mapPos(to, 1) })), sequential: true }];
});

/** The cell of the table at `from` to give the keyboard to: in its first row, or its last. */
function focusCell(view: EditorView, from: number, last: boolean) {
  const el = [...view.contentDOM.querySelectorAll<HTMLElement>(".md-table")].find((table) => view.posAtDOM(table) === from);
  const cell = el && (last ? [...el.querySelectorAll<HTMLElement>("tr:last-child [data-focus]")][0] : el.querySelector<HTMLElement>("[data-focus]"));
  cell?.focus();
  return !!cell;
}

/** An arrow key that would pass a table goes into it: down into its header, up into its last row. Vim's j and k pass it whole. */
const step = (down: boolean) => (view: EditorView) => {
  const { main } = view.state.selection;
  if (!main.empty) return false;
  const { head } = view.moveVertically(main, down);
  const into = view.state.field(tables.field).found.find((t) => (down ? main.head < t.from && head >= t.from : main.head > t.to && head <= t.to));
  return !!into && focusCell(view, into.from, !down);
};

/** The table nearest after the cursor, or else the last before it, for the command that goes into one. */
export function editTable(view: EditorView) {
  const { found } = view.state.field(tables.field);
  const { head } = view.state.selection.main;
  const table = found.find((t) => t.to >= head) ?? found[found.length - 1];
  if (!table) return false;
  view.dispatch({ effects: EditorView.scrollIntoView(table.from, { y: "nearest" }) });
  return focusCell(view, table.from, false);
}

/** Whether the element is a note's text in an editor that draws tables and has one. */
export const hasTable = (focused: Element | null) => {
  const view = focused instanceof HTMLElement ? EditorView.findFromDOM(focused) : null;
  return view?.contentDOM === focused && !!view.state.field(tables.field, false)?.found.length ? view : null;
};

const look = EditorView.baseTheme({
  ".md-table": { padding: "0.4em 0", position: "relative" },
  // No width of its own, then all of the column's: a table wider than the column scrolls in its box and doesn't widen the note.
  ".md-table > div:first-child": { overflowX: "auto", width: "0", minWidth: "100%" },
  ".md-table table": { borderCollapse: "collapse", fontSize: "0.95em" },
  ".md-table th, .md-table td": { border: "1px solid var(--line-strong)", padding: "0.3em 0.7em", minWidth: "3em", verticalAlign: "top" },
  ".md-table th": { backgroundColor: "var(--bg-side)", fontWeight: "600" },
  ".md-table [data-focus]": { outline: "none", minHeight: "1lh" },
  ".md-table th:focus-within, .md-table td:focus-within": { boxShadow: "inset 0 0 0 2px var(--accent)" },
  ".md-cell-typing": { boxSizing: "border-box", whiteSpace: "nowrap", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none" },
  ".md-table code": { fontFamily: "var(--mono)", fontSize: "0.92em", backgroundColor: "var(--bg-side)", borderRadius: "4px", padding: "0.1em 0.3em" },
  ".md-table .md-link": { color: "var(--accent)", textDecoration: "underline" },
  // Over what follows the table, so showing them moves nothing.
  ".md-table-tools": { display: "flex", gap: "0.3em", position: "absolute", top: "100%", marginTop: "-0.25em", zIndex: "2", visibility: "hidden" },
  ".md-table:hover .md-table-tools, .md-table:focus-within .md-table-tools": { visibility: "visible" },
  ".md-table-tools button": { font: "inherit", fontSize: "0.72em", padding: "0.15em 0.55em", border: "1px solid var(--line)", borderRadius: "6px", background: "var(--bg-elev)", color: "var(--muted)", cursor: "pointer" },
  ".md-table-tools button:hover": { color: "var(--ink)", borderColor: "var(--line-strong)" },
});

export const tableRendering: Extension = [
  tables.extension,
  deletedWhole,
  // The arrow keys pass over a table from side to side, as over one letter.
  EditorView.atomicRanges.of((view) => view.state.field(tables.field).drawn),
  // Not a keymap: one added here would put every editor key, Escape among them, ahead of vim's own handling.
  EditorView.domEventHandlers({
    keydown(event, view) {
      if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      if (!step(event.key === "ArrowDown")(view)) return false;
      event.preventDefault();
      return true;
    },
  }),
  look,
];
