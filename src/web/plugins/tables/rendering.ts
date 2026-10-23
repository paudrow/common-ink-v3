import { syntaxTree } from "@codemirror/language";
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { isReading } from "../../plugin-api.ts";
import { drawnMath } from "../lib/drawnMath.ts";
import { drawnInState, placed, writable } from "../lib/live.ts";
import { openPage } from "../lib/opening.ts";
import { replacing } from "../lib/rewrite.ts";
import { inlineMarkdown } from "./inline.ts";
import { openMenu } from "./menu.ts";
import { actOnCell, addColumn, addRow, CELL_ACTIONS, oneLine, parseTable, pipedPart, serializeTable, setCell, type At, type CellAction, type Table } from "./table.ts";

interface Found {
  from: number;
  to: number;
  text: string;
  table: Table;
}

/** What a drawn table is drawn from now. */
interface Drawn {
  text: string;
  table: Table;
}

const drawn = new WeakMap<HTMLElement, Drawn>();
/** How each drawn table does what a cell's menu lists, from one of its cells. */
const acting = new WeakMap<HTMLElement, (action: CellAction, at: At) => void>();
/** The cell the member was last in, which a command from the palette acts on. */
let last: { el: HTMLElement; at: At } | undefined;
/** Set while a table is being drawn again. A cell taken out then loses the cursor, which is not the member leaving it. */
let drawing = false;

const keyOf = ([row, column]: At) => `${row},${column}`;
const cellAt = (el: HTMLElement, at: At) => el.querySelector<HTMLElement>(`[data-focus="${keyOf(at)}"]`);

function show(cell: HTMLElement, text: string) {
  cell.replaceChildren(inlineMarkdown(text, drawnMath.get()));
}

/** The cells of this editor's tables, but the one being typed in, are drawn again once formulas can be drawn, and when they no longer can. */
const followingMath = ViewPlugin.define((view) => ({
  destroy: drawnMath.subscribe(() => {
    for (const el of view.dom.querySelectorAll<HTMLElement>(".md-table")) {
      const now = drawn.get(el);
      now?.table.rows.forEach((cells, r) =>
        cells.forEach((text, c) => {
          const cell = cellAt(el, [r, c]);
          if (cell && cell !== document.activeElement) show(cell, text);
        }),
      );
    }
    view.requestMeasure();
  }),
}));

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
  const now = { ...next };
  drawn.set(el, now);
  const sameShape = was.table.rows.length === next.table.rows.length && was.table.aligns.length === next.table.aligns.length;
  if (!sameShape) {
    // A cell being typed in when someone else adds a row or a column keeps the keyboard and what was typed, in the cell its row and column have become.
    const typing = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-focus]") : null;
    const typed = typing?.textContent ?? "";
    const [row, column] = typing ? (typing.dataset.focus!.split(",").map(Number) as [number, number]) : [0, 0];
    // Only what the member typed goes with them. A cell they were in and had not changed has nothing to carry: after an
    // undo that takes its row or column back out, the cell that comes to its place says what the note says.
    const changed = typing !== null && typed !== was.table.rows[row]?.[column];
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
    if (cell && !wanted && changed) {
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
    // A box that takes the column's width whatever is in it, a frame as wide as the table up to that, and in it the table, which scrolls when it is wider.
    const frame = el.appendChild(document.createElement("div")).appendChild(document.createElement("div"));
    frame.className = "md-table-frame";
    frame.appendChild(document.createElement("div")).append(document.createElement("table"));
    const state: Drawn = { text: this.text, table: this.table };
    drawn.set(el, state);
    build(el, state);

    /** Where the table is in the note, if the note still writes it as it is drawn here. */
    const range = () => {
      let to: number;
      try {
        to = view.posAtDOM(el);
      } catch {
        return undefined;
      }
      const { text } = drawn.get(el)!;
      const from = to - text.length;
      return from >= 0 && view.state.sliceDoc(from, to) === text ? { from, to } : undefined;
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
      if (line >= 1 && line <= doc.lines) view.dispatch({ selection: { anchor: doc.line(line).from }, scrollIntoView: true, annotations: placed.of(true) });
    };
    /** Opens a cell's menu. A table that can only be read has none. */
    let menu: ((cell: HTMLElement, point: { x: number; y: number }) => void) | undefined;
    const atOf = (cell: HTMLElement) => cell.dataset.focus!.split(",").map(Number) as unknown as At;
    const typedIn = (cell: HTMLElement) => oneLine(cell.textContent ?? "").trim();
    /** The table with what has been typed in `cell`. */
    const committed = (cell: HTMLElement) => setCell(drawn.get(el)!.table, atOf(cell), typedIn(cell));

    // A link in a cell opens its page, as a link in the note does; the rest of the cell is pressed to type in it.
    el.addEventListener("mousedown", (event) => {
      const link = event.button === 0 && event.target instanceof Element ? event.target.closest<HTMLElement>("[data-href]") : null;
      if (!link || link.closest(".md-cell-typing")) return;
      event.preventDefault();
      event.stopPropagation();
      openPage(link.dataset.href!);
    });
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
      last = { el, at };
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
      document.execCommand("insertText", false, oneLine(event.clipboardData?.getData("text/plain") ?? ""));
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
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        const box = cell.getBoundingClientRect();
        menu?.(cell, { x: box.left, y: box.bottom });
      } else if (event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)) {
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

    /** Does what a cell's menu lists from the cell `at`, with whatever is being typed in the table kept. */
    const act = (action: CellAction, at: At) => {
      const typing = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("[data-focus]") : null;
      const done = actOnCell(typing ? committed(typing) : drawn.get(el)!.table, at, action);
      if (done) write(done.table, done.at);
      else cellAt(el, at)?.focus();
    };
    acting.set(el, act);
    /** The menu of what can be done from `cell`. Closed with nothing picked, it hands the keyboard back to the cell. */
    const menuFor = (menu = (cell, point) => {
      const at = atOf(cell);
      const { table } = drawn.get(el)!;
      openMenu(
        "Table",
        point,
        CELL_ACTIONS.map(({ id, label }) => ({ label, disabled: !actOnCell(table, at, id), run: () => act(id, at) })),
        () => cellAt(el, at)?.focus(),
      );
    });
    el.addEventListener("contextmenu", (event) => {
      const cell = (event.target as HTMLElement).closest("th, td")?.querySelector<HTMLElement>("[data-focus]");
      if (!cell) return;
      event.preventDefault();
      menuFor(cell, { x: event.clientX, y: event.clientY });
    });

    /** One quiet plus on the table's bottom edge and one on its right edge, each adding at the end. */
    const plus = (side: "row" | "column", label: string, grown: (table: Table) => { table: Table; at: At }) => {
      const button = frame.appendChild(document.createElement("button"));
      button.type = "button";
      button.className = `md-table-add md-table-add-${side}`;
      button.setAttribute("aria-label", label);
      button.title = label;
      button.textContent = "+";
      // The cell being typed in keeps the cursor until the table is written, with what was typed in it.
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const typing = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>("[data-focus]") : null;
        const { table, at } = grown(typing ? committed(typing) : drawn.get(el)!.table);
        write(table, at);
      });
    };
    plus("row", "Add a row at the end", (table) => ({ table: addRow(table, table.rows.length - 1), at: [table.rows.length, 0] }));
    plus("column", "Add a column at the end", (table) => ({ table: addColumn(table, table.aligns.length - 1), at: [0, table.aligns.length] }));
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
 * Whether the cursor has been put anywhere. A note opens with its cursor at its start, where nobody
 * put it, and a table at the top of a note is not shown as written for that.
 */
const used = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => value || tr.selection !== undefined || tr.isUserEvent("input") || tr.isUserEvent("delete"),
});

/** Whether the cursor, and all of a selection, is in the table's own lines, which are then shown as written above it. Selecting the whole note shows no table's lines. */
const cursorIn = (state: EditorState, { from, to }: { from: number; to: number }) => {
  const { main } = state.selection;
  return state.field(used) && !isReading(state) && main.from >= from && main.to <= to;
};

const hiddenLines = Decoration.replace({ block: true });
const sourceLine = Decoration.line({ class: "md-table-source" });

/**
 * A table is drawn as a table wherever the cursor is, under its own lines, which are out of sight.
 * A click in a cell is typed in the cell, and the lines stay out of sight. The cursor moved into
 * the lines with the keys shows them as written above the table, which stays drawn and follows what
 * is typed in them, so the note is lower by those lines and nothing else moves.
 */
const tables = drawnInState({
  read: tablesIn,
  draw: (state, found) =>
    found.flatMap((t) => {
      const lines = [];
      if (cursorIn(state, t)) for (let n = state.doc.lineAt(t.from).number; n <= state.doc.lineAt(t.to).number; n++) lines.push(sourceLine.range(state.doc.line(n).from));
      else lines.push(hiddenLines.range(t.from, t.to));
      return [...lines, Decoration.widget({ widget: new TableWidget(t.text, t.table, !writable(state)), block: true, side: 1 }).range(t.to)];
    }),
  stepsIn: true,
});

/** The tables whose lines are out of sight. */
const hidden = (state: EditorState) => state.field(tables.field).found.filter((t) => !cursorIn(state, t));

/**
 * A press of the pointer never goes into a table's unseen lines: one that lands there, in the margin
 * beside the table, puts the cursor on the line after it, or before it when it ends the note.
 */
const pressedOutside = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection || tr.docChanged || !tr.isUserEvent("select.pointer") || !tr.newSelection.main.empty) return tr;
  const { head } = tr.newSelection.main;
  const table = hidden(tr.startState).find((t) => head >= t.from && head <= t.to);
  if (!table) return tr;
  const anchor = table.to < tr.startState.doc.length ? table.to + 1 : table.from > 0 ? table.from - 1 : null;
  return anchor === null ? tr : [tr, { selection: { anchor }, sequential: true }];
});

/**
 * A table is one thing to a deletion that reaches into it from outside, as it is to vim's j and k:
 * `dj` from the line above, `3dd`, or a line selection that ends on its header takes the whole
 * table. Without this the rows left behind would be half a table, shown as its pipes. A change
 * inside the table, such as a cell's own edit or its undo, is let through as it is, and so are the
 * table's last lines deleted whole, which is `dd` on one of its lines while they are shown.
 */
const deletedWhole = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const { found } = tr.startState.field(tables.field);
  const { doc } = tr.startState;
  const rest: { from: number; to: number }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length) return;
    for (const table of found) {
      const end = Math.min(table.to + 1, tr.startState.doc.length);
      if (fromA < table.from && toA > table.from && toA < end) rest.push({ from: toA, to: toA === tr.startState.doc.lineAt(toA).from ? end : table.to });
      else if (fromA > table.from && fromA <= table.to && toA > table.to) {
        // Its last lines, whole and nothing past them, are what `dd` takes on a line of a table that is shown: a shorter table is left.
        const itsLastLines = toA === table.to + 1 && fromA === doc.lineAt(fromA).from;
        if (!itsLastLines) rest.push({ from: table.from, to: fromA });
      }
    }
  });
  if (!rest.length) return tr;
  return [tr, { changes: rest.map(({ from, to }) => ({ from: tr.changes.mapPos(from, -1), to: tr.changes.mapPos(to, 1) })), sequential: true }];
});

/** The cell of the table that ends at `to` to give the keyboard to: its first. */
function focusCell(view: EditorView, to: number) {
  const el = [...view.contentDOM.querySelectorAll<HTMLElement>(".md-table")].find((table) => view.posAtDOM(table) === to);
  const cell = el?.querySelector<HTMLElement>("[data-focus]");
  cell?.focus();
  return !!cell;
}

/**
 * An arrow key that would pass a table goes into its lines, which shows them: Down from the last row
 * of the line above into its first line, Up from the first row of the line below into its last, as
 * far along as the cursor was.
 */
const step = (down: boolean) => (view: EditorView) => {
  const { state } = view;
  const { main } = state.selection;
  if (!main.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(main.head);
  const into = hidden(state).find((t) => (down ? line.to + 1 === t.from : line.from - 1 === t.to));
  if (!into) return false;
  // On a line that wraps, the key moves within the line until its last row.
  const moved = view.moveVertically(main, down).head;
  if (moved >= line.from && moved <= line.to && moved !== main.head) return false;
  const target = state.doc.lineAt(down ? into.from : into.to);
  view.dispatch({ selection: { anchor: Math.min(target.from + main.head - line.from, target.to) }, scrollIntoView: true, userEvent: "select" });
  return true;
};

/** The table nearest after the cursor, or else the last before it, for the command that goes into one. */
export function editTable(view: EditorView) {
  const { found } = view.state.field(tables.field);
  const { head } = view.state.selection.main;
  const table = found.find((t) => t.to >= head) ?? found[found.length - 1];
  if (!table) return false;
  view.dispatch({ effects: EditorView.scrollIntoView(table.to, { y: "nearest" }) });
  return focusCell(view, table.to);
}

/** Does what a cell's menu lists from the cell the member was last in, if its table is still on the page. */
export function actOnLastCell(action: CellAction) {
  const act = last?.el.isConnected ? acting.get(last.el) : undefined;
  if (act) act(action, last!.at);
  return !!act;
}

/** Whether the element is a note's text in an editor that draws tables and has one. */
export const hasTable = (focused: Element | null) => {
  const view = focused instanceof HTMLElement ? EditorView.findFromDOM(focused) : null;
  return view?.contentDOM === focused && !!view.state.field(tables.field, false)?.found.length ? view : null;
};

const look = EditorView.baseTheme({
  ".md-table": { padding: "0.4em 0", position: "relative" },
  // No width of its own, then all of the column's: a table wider than the column scrolls in its box and doesn't widen the note.
  ".md-table > div:first-child": { width: "0", minWidth: "100%" },
  // Short of the column's edge by half a plus, so the one on a wide table's right edge is all in sight.
  ".md-table-frame": { position: "relative", width: "fit-content", maxWidth: "calc(100% - 10px)" },
  ".md-table-frame > div": { overflowX: "auto" },
  // A word is not broken to make a column narrower: a table too wide for the column scrolls.
  ".md-table table": { borderCollapse: "collapse", fontSize: "0.95em", overflowWrap: "break-word", wordBreak: "normal" },
  ".md-table th, .md-table td": { border: "1px solid var(--line-strong)", padding: "0.3em 0.7em", minWidth: "3em", verticalAlign: "top" },
  ".md-table th": { backgroundColor: "var(--bg-side)", fontWeight: "600" },
  ".md-table [data-focus]": { outline: "none", minHeight: "1lh" },
  ".md-table th:focus-within, .md-table td:focus-within": { boxShadow: "inset 0 0 0 2px var(--accent)" },
  ".md-cell-typing": { boxSizing: "border-box", whiteSpace: "nowrap", overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none" },
  ".md-table code": { fontFamily: "var(--mono)", fontSize: "0.92em", backgroundColor: "var(--bg-side)", borderRadius: "4px", padding: "0.1em 0.3em" },
  ".md-table .md-link": { color: "var(--accent)", textDecoration: "underline" },
  // On the table's edges, over what is beside it, so they take no room and showing them moves nothing.
  ".md-table-add": {
    position: "absolute",
    zIndex: "2",
    display: "grid",
    placeItems: "center",
    width: "18px",
    height: "18px",
    padding: "0",
    border: "1px solid var(--line-strong)",
    borderRadius: "50%",
    background: "var(--bg-elev)",
    color: "var(--muted)",
    font: "500 calc(13px * var(--text-scale))/1 var(--prose)",
    cursor: "pointer",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 0.12s",
  },
  ".md-table-add-row": { left: "50%", bottom: "0", transform: "translate(-50%, 50%)" },
  ".md-table-add-column": { top: "50%", right: "0", transform: "translate(50%, -50%)" },
  ".md-table:hover .md-table-add, .md-table:focus-within .md-table-add": { opacity: "1", pointerEvents: "auto" },
  ".md-table-add:hover, .md-table-add:focus-visible": { color: "var(--accent)", borderColor: "var(--accent)", outline: "none" },
  // The table's own lines, shown above it with the cursor in them: as written, in the face markdown is written in.
  ".cm-line.md-table-source": { font: "calc(12.5px * var(--text-scale))/1.6 var(--mono)", color: "var(--accent)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  // A formula in them is drawn by its own rule, in its own faces.
  ".cm-line.md-table-source :not(.md-chip-math, .md-chip-math *)": { font: "inherit !important", color: "inherit !important", textDecoration: "none" },
});

export const tableRendering: Extension = [
  used,
  followingMath,
  tables.extension,
  pressedOutside,
  deletedWhole,
  // The arrow keys pass over a table's unseen lines from side to side, as over one letter.
  EditorView.atomicRanges.of((view) => Decoration.set(hidden(view.state).map((t) => hiddenLines.range(t.from, t.to)))),
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
