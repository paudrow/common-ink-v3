import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, RectangleMarker, ViewPlugin, drawSelection, keymap, layer } from "@codemirror/view";
import { Vim, getCM, vim, type MotionFn } from "@replit/codemirror-vim";
import { dismissing, following, historyStepped, noteJump } from "../../plugin-api.ts";
import { TODO_KEYS } from "./keys.ts";

let run: (commandId: string) => boolean = () => false;

// Vim's keys and ex commands are one table for the page, so they are defined once and run the commands of whichever host is on.

// Undo and redo are the app's commands, which choose between the editor's stack and the note's history, as ⌘Z does.
Vim.defineAction("appUndo", (cm) => {
  run("history.undo");
  // Typing that is undone leaves what was selected before it, which vim would take for visual mode.
  cm.setCursor(cm.getCursor("start"));
});
Vim.defineAction("appRedo", (cm) => {
  run("history.redo");
  cm.setCursor(cm.getCursor("start"));
});
Vim.mapCommand("u", "action", "appUndo", {}, { context: "normal" });
Vim.mapCommand("<C-r>", "action", "appRedo", {}, { context: "normal" });
// Elsewhere vim's ctrl+r isn't redo, and the library's would redo in the editor alone, behind the note's history.
Vim.defineAction("nothing", () => {});
for (const context of ["insert", "visual"]) Vim.mapCommand("<C-r>", "action", "nothing", {}, { context });
Vim.defineEx("undo", "u", () => void run("history.undo"));
Vim.defineEx("redo", "red", () => void run("history.redo"));

// Each jump vim makes in a note, with G, a search, % and the like, is a stop in the app's history, which ctrl+o and ctrl+i walk.
// It is said once the move is made, so the stop is where the cursor went. The list is reached through the library's testing hook,
// and `add` is called unbound, so wrapping it in place is all it takes: test/browser/getting-around.spec.ts walks G and a search.
const jumps = Vim.getVimGlobalState_().jumpList;
const added = jumps.add;
jumps.add = (cm, from, to) => {
  added(cm, from, to);
  const jump = { from: cm.indexFromPos(from), to: cm.indexFromPos(to) };
  queueMicrotask(() => cm.cm6.dispatch({ effects: noteJump.of(jump) }));
};

// Ctrl+I is Tab to vim, and the editor's own answer to it is another key's off a Mac.
Vim.defineAction("typeTab", (cm) => cm.replaceSelection("\t"));
Vim.mapCommand("<C-i>", "action", "typeTab", {}, { context: "insert" });

// A link is the nearest thing a note has to a definition, so gd follows the one under the cursor: to its note, or to its page in a new tab.
// On anything else a click opens, such as a mention or a reference, it does what the click does.
Vim.defineAction("followLink", (cm) => {
  const view = cm.cm6 as EditorView;
  if (!view.state.facet(following).some((follow) => follow(view))) run("links.follow");
});
Vim.mapCommand("gd", "action", "followLink", {}, { context: "normal" });

// A note's tabs are vim's tab pages. In a note g begins many of vim's own keys, so these two are vim's to map and not the window's.
Vim.defineAction("nextTab", () => void run("vim.tab.next"));
Vim.defineAction("previousTab", () => void run("vim.tab.previous"));
Vim.mapCommand("gt", "action", "nextTab", {}, { context: "normal" });
Vim.mapCommand("gT", "action", "previousTab", {}, { context: "normal" });

// gx, g- and g> put the todos on the cursor's line, or on the lines visual mode selects, in a state as ⌘Enter and its like do, and
// leave visual mode as Escape does. In a note g begins many of vim's own keys, so they are vim's to map and not the window's.
for (const { id, vim: keys, runs } of TODO_KEYS) {
  Vim.defineAction(id, (cm, _, state) => {
    run(runs);
    if (state.visualMode) Vim.exitVisualMode(cm);
  });
  for (const context of ["normal", "visual"]) Vim.mapCommand(keys, "action", id, {}, { context });
}

// zz, zt and zb put the cursor's line in the middle, at the top or at the foot of what is seen, and z., z<CR> and z- do the
// same with the cursor on the line's first letter. The library's own scroll the editor, which here never scrolls: its pane does.
Vim.defineAction("scrollCursorTo", (cm, given) => {
  const args = given as { position?: "center" | "start" | "end"; firstLetter?: boolean };
  const view = cm.cm6 as EditorView;
  if (args.firstLetter) {
    const { line } = cm.getCursor();
    cm.setCursor(line, /^\s*/.exec(cm.getLine(line))![0].length);
  }
  // After vim has put its cursor where it goes, which would otherwise take the place of this scroll with its own. The user event
  // marks a scroll the member asked for, and the place they asked for the line at, for whatever else keeps the line somewhere.
  const y = args.position ?? "center";
  setTimeout(() => view.dom.isConnected && view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y, yMargin: 0 }), userEvent: `scroll.cursor.${y}` }));
});
for (const [keys, position, firstLetter] of [
  ["zz", "center", false],
  ["zt", "start", false],
  ["zb", "end", false],
  ["z.", "center", true],
  ["z<CR>", "start", true],
  ["z-", "end", true],
] as const) {
  Vim.mapCommand(keys, "action", "scrollCursorTo", { position, firstLetter }, { context: "normal" });
  Vim.mapCommand(keys, "action", "scrollCursorTo", { position }, { context: "visual" });
}

// A note saves itself, so :w sends what's typed now, and :q closes the tab.
Vim.defineEx("write", "w", () => void run("note.save"));
Vim.defineEx("quit", "q", () => void run("tab.close"));
for (const [name, prefix] of [["wq", "wq"], ["xit", "x"]] as const) {
  Vim.defineEx(name, prefix, () => {
    run("note.save");
    run("tab.close");
  });
}

/** A note opened with nothing in it starts in insert mode, so its first words are typed at once here too. */
const startTyping = ViewPlugin.define((view) => {
  if (view.state.doc.length === 0 && !view.state.readOnly) {
    queueMicrotask(() => {
      const cm = getCM(view);
      if (cm && !cm.state.vim?.insertMode && view.state.doc.length === 0) Vim.handleKey(cm, "i", "mapping");
    });
  }
  return {};
});

let byRows = false;

/**
 * j and k by rows in visual mode, but by lines in visual line mode: its selection is whole lines with the cursor drawn at the last
 * one's end, so a move between the rows of a wrapped line would change nothing on screen. Vim calls a motion on its table of
 * motions, which is how this reaches its own two.
 */
const rowsOrLines: MotionFn = function (this: Record<string, MotionFn>, cm, head, args, state, input) {
  const by = state.visualLine ? this.moveByLines! : this.moveByDisplayLines!;
  // Each keeps the column of the last vertical move only after one of the two.
  if (state.lastMotion === rowsOrLines) state.lastMotion = by;
  return by.call(this, cm, head, args, state, input);
};
Vim.defineMotion("rowsOrLines", rowsOrLines);

/**
 * An undo or redo of what was saved comes back from the note's history a moment after the key, u,
 * ctrl+r or ⌘Z, and the cursor goes to it then, as vim's own puts it at the change: in the editor
 * the member is in, with the change brought to the middle of the pane.
 */
const toTheStep = EditorView.updateListener.of((update) => {
  if (!update.view.hasFocus || !update.transactions.some((tr) => tr.annotation(historyStepped))) return;
  let at = -1;
  update.changes.iterChangedRanges((_fromA, _toA, fromB) => {
    if (at < 0) at = fromB;
  });
  if (at < 0) return;
  const { view } = update;
  queueMicrotask(() => {
    const anchor = Math.min(at, view.state.doc.length);
    view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
  });
});

/**
 * In visual line mode every line selected is painted from its left edge to its right, a code block's across the whole block.
 * The editor's own painting runs the first line from where its text starts and the last to where its text ends, which in a
 * code block is short of the block's edges on both sides.
 */
/** Out of insert mode Tab and Shift+Tab change nothing, as in vim, and don't leave the note: Escape and then Tab does. */
const notTyped = (view: EditorView) => {
  const state = getCM(view)?.state.vim;
  return !!state && !state.insertMode;
};

const wholeLines = layer({
  above: false,
  class: "cm-selectionLayer",
  markers(view) {
    if (!getCM(view)?.state.vim?.visualLine) return [];
    const scroller = view.scrollDOM.getBoundingClientRect();
    const [left, top] = [scroller.left - view.scrollDOM.scrollLeft, scroller.top - view.scrollDOM.scrollTop];
    const painted: RectangleMarker[] = [];
    for (const range of view.state.selection.ranges) {
      for (const seen of view.visibleRanges) {
        for (let pos = Math.max(range.from, seen.from); pos <= Math.min(range.to, seen.to); ) {
          const line = view.state.doc.lineAt(pos);
          const { node } = view.domAtPos(line.from);
          const el = (node instanceof HTMLElement ? node : node.parentElement)?.closest(".cm-line");
          if (el) {
            const box = el.getBoundingClientRect();
            painted.push(new RectangleMarker("cm-selectionBackground", box.left - left, box.top - top, box.width, box.height));
          }
          pos = line.to + 1;
        }
      }
    }
    return painted;
  },
  update: (update) => update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged,
});

/** The editor extension for vim, with `runCommand` as the way it runs the app's commands. */
export function vimEditing(runCommand: (commandId: string) => boolean): { extension: Extension; jumpsFrom: (focused: HTMLElement) => boolean; toNormal: (focused: HTMLElement) => void; moveByRows: (on: boolean) => void } {
  run = runCommand;
  return {
    /** Whether j and k, and the arrows, move by the rows on screen, as gj and gk do, in normal and visual mode. After an operator and in visual line mode they are whole lines still: dj takes two lines, and so does Vj. */
    moveByRows(on) {
      if (on === byRows) return;
      byRows = on;
      for (const [key, rows, forward] of [["j", "gj", true], ["k", "gk", false], ["<Down>", "gj", true], ["<Up>", "gk", false]] as const) {
        if (on) {
          Vim.noremap(key, rows, "normal");
          Vim.mapCommand(key, "motion", "rowsOrLines", { forward }, { context: "visual" });
        } else for (const context of ["normal", "visual"]) Vim.unmap(key, context);
      }
    },
    extension: [
      // Escape closes what is open over the editor before it is vim's.
      Prec.highest(EditorView.domEventHandlers({ keydown: (e) => e.key === "Escape" && dismissing() })),
      vim({ status: true }),
      // Vim's library hides the browser's own selection in its modes and leaves the drawing of one to the editor.
      // Without this nothing selected in visual mode is painted anywhere.
      drawSelection(),
      wholeLines,
      keymap.of([{ key: "Tab", run: notTyped, shift: notTyped }]),
      toTheStep,
      // Visual block mode is a selection on each of its lines, which an editor keeps only when told it may. A click still makes one.
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of(() => false),
      startTyping,
      // Room under the last line for zz to bring a line near the end to the middle.
      EditorView.editorAttributes.of({ class: "cm-vim-room" }),
    ],
    /** Leaves insert or visual mode in the note whose text the element is, as Escape does. */
    toNormal(focused) {
      const view = EditorView.findFromDOM(focused);
      const cm = view && getCM(view);
      if (cm && (cm.state.vim?.insertMode || cm.state.vim?.visualMode)) Vim.handleKey(cm, "<Esc>", "mapping");
    },
    /** Whether the element is a note's text with vim in a mode where ctrl+o and ctrl+i are jumps: not insert mode, and not its `:` prompt. */
    jumpsFrom(focused) {
      const view = EditorView.findFromDOM(focused);
      const vim = view?.contentDOM.contains(focused) ? getCM(view)?.state.vim : undefined;
      return !!vim && !vim.insertMode;
    },
  };
}
