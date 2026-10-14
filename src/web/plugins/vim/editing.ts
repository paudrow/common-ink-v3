import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, RectangleMarker, ViewPlugin, drawSelection, layer } from "@codemirror/view";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import { TITLE_MARK, dismissing } from "../../plugin-api.ts";

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

// Ctrl+I is Tab to vim, and the editor's own answer to it is another key's off a Mac.
Vim.defineAction("typeTab", (cm) => cm.replaceSelection("\t"));
Vim.mapCommand("<C-i>", "action", "typeTab", {}, { context: "insert" });

// A note's tabs are vim's tab pages. In a note g begins many of vim's own keys, so these two are vim's to map and not the window's.
Vim.defineAction("nextTab", () => void run("vim.tab.next"));
Vim.defineAction("previousTab", () => void run("vim.tab.previous"));
Vim.mapCommand("gt", "action", "nextTab", {}, { context: "normal" });
Vim.mapCommand("gT", "action", "previousTab", {}, { context: "normal" });

// A note saves itself, so :w sends what's typed now, and :q closes the tab.
Vim.defineEx("write", "w", () => void run("note.save"));
Vim.defineEx("quit", "q", () => void run("tab.close"));
for (const [name, prefix] of [["wq", "wq"], ["xit", "x"]] as const) {
  Vim.defineEx(name, prefix, () => {
    run("note.save");
    run("tab.close");
  });
}

/**
 * A note opened with nothing in it but the mark of its title starts in insert mode after the mark,
 * so the title is typed at once here too. In normal mode the cursor would stand on the mark's space,
 * and `i` would type the title into the mark.
 */
const titleFirst = ViewPlugin.define((view) => {
  if (view.state.doc.toString() === TITLE_MARK && !view.state.readOnly) {
    queueMicrotask(() => {
      const cm = getCM(view);
      if (cm && !cm.state.vim?.insertMode && view.state.doc.toString() === TITLE_MARK) Vim.handleKey(cm, "A", "mapping");
    });
  }
  return {};
});

let byRows = false;

/**
 * In visual line mode every line selected is painted from its left edge to its right, a code block's across the whole block.
 * The editor's own painting runs the first line from where its text starts and the last to where its text ends, which in a
 * code block is short of the block's edges on both sides.
 */
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
    /** Whether j and k, and the arrows, move by the rows on screen, as gj and gk do, in normal and visual mode. After an operator they are whole lines still: dj takes two lines. */
    moveByRows(on) {
      if (on === byRows) return;
      byRows = on;
      for (const [key, rows] of [["j", "gj"], ["k", "gk"], ["<Down>", "gj"], ["<Up>", "gk"]] as const) {
        for (const context of ["normal", "visual"] as const) {
          if (on) Vim.noremap(key, rows, context);
          else Vim.unmap(key, context);
        }
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
      // Visual block mode is a selection on each of its lines, which an editor keeps only when told it may. A click still makes one.
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of(() => false),
      titleFirst,
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
