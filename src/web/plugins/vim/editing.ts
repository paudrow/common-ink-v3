import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import { dismissing } from "../../plugin-api.ts";

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

// A link is the nearest thing a note has to a definition, so gd follows the one under the cursor: to its note, or to its page in a new tab.
Vim.defineAction("followLink", () => void run("links.follow"));
Vim.mapCommand("gd", "action", "followLink", {}, { context: "normal" });

// A note saves itself, so :w sends what's typed now, and :q closes the tab.
Vim.defineEx("write", "w", () => void run("note.save"));
Vim.defineEx("quit", "q", () => void run("tab.close"));
for (const [name, prefix] of [["wq", "wq"], ["xit", "x"]] as const) {
  Vim.defineEx(name, prefix, () => {
    run("note.save");
    run("tab.close");
  });
}

const look = EditorView.theme({
  ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--muted)", zIndex: 1 },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-vim-panel": { padding: "0.25rem 0", fontFamily: "var(--mono)", fontSize: "0.8rem" },
  ".cm-vim-panel input": { color: "var(--ink)", fontFamily: "inherit" },
});

/** The editor extension for vim, with `runCommand` as the way it runs the app's commands. */
export function vimEditing(runCommand: (commandId: string) => boolean): { extension: Extension; jumpsFrom: (focused: HTMLElement) => boolean } {
  run = runCommand;
  return {
    extension: [
      // Escape closes what is open over the editor before it is vim's.
      Prec.highest(EditorView.domEventHandlers({ keydown: (e) => e.key === "Escape" && dismissing() })),
      vim({ status: true }),
      look,
    ],
    /** Whether the element is a note's text with vim in a mode where ctrl+o and ctrl+i are jumps: not insert mode, and not its `:` prompt. */
    jumpsFrom(focused) {
      const view = EditorView.findFromDOM(focused);
      const vim = view?.contentDOM.contains(focused) ? getCM(view)?.state.vim : undefined;
      return !!vim && !vim.insertMode;
    },
  };
}
