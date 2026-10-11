import type { Plugin } from "../../plugin-api.ts";
import { EMPTY, jump, visit } from "./jumplist.ts";

const isField = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);

/**
 * Vim keys in every note's editor, and ctrl+o and ctrl+i to go back and forward through the notes
 * visited. The editing is loaded when the plugin is turned on, so nobody else carries it.
 */
export const vim: Plugin = {
  id: "vim",
  name: "Vim mode",
  enabledByDefault: false,
  activate(host) {
    let jumps = EMPTY;
    let stopped = false;

    host.onNavigate(() => {
      const { noteId } = host.app();
      if (noteId) jumps = visit(jumps, noteId);
    });

    const go = (by: -1 | 1) => () => {
      const app = host.app();
      const next = jump(jumps, by, app.noteId, (id) => !app.notes || app.notes.some((n) => n.id === id));
      if (next === jumps) return;
      jumps = next;
      app.openNote(next.notes[next.at]!, { preview: true, focus: true });
    };

    // The keys come with the editing, so a member is never left with vim's jumps and no vim.
    import("./editing.ts").then(
      ({ vimEditing }) => {
        if (stopped) return;
        const editing = vimEditing(host.commands.run);
        host.editorExtensions.register({ id: "vim", extension: editing.extension });
        /** In a field, these keys are the field's. In a note they are jumps only where vim would take them for jumps. */
        const when = () => !isField(document.activeElement) || editing.jumpsFrom(document.activeElement);
        host.commands.register({ id: "vim.back", title: "Go back to the note before", keys: ["ctrl+o"], when, run: go(-1) });
        host.commands.register({ id: "vim.forward", title: "Go forward to the note after", keys: ["ctrl+i"], when, run: go(1) });
      },
      () => !stopped && host.report(new Error("Vim's editing couldn't be loaded, so notes are edited without it. Reload the page to try again.")),
    );
    return () => {
      stopped = true;
    };
  },
};
