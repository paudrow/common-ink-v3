import { dismissing, type Plugin } from "../../plugin-api.ts";
import { EMPTY, jump, visit } from "./jumplist.ts";
import { KEYS } from "./keys.ts";
import { surfaces } from "./surfaces.ts";

const isField = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);

/**
 * Vim keys in every note's editor, ctrl+o and ctrl+i to go back and forward through the notes
 * visited, and vim's keys for the rest of the window: its lists, its regions and its tabs. The
 * editing is loaded when the plugin is turned on, so nobody else carries it.
 */
export const vim: Plugin = {
  id: "vim",
  name: "Vim mode",
  description: "Vim's modes, motions and operators in every note's editor.",
  icon: "keyboard",
  enabledByDefault: false,
  settings: {
    screenLines: {
      type: "boolean",
      default: false,
      title: "j and k move by the rows on screen",
      description: "Off, j and k move by whole lines, as in vim, however many rows a long line wraps to, and gj and gk move by rows. On, j and k move by rows too, so the cursor can go into a wrapped line.",
    },
  },
  activate(host) {
    let jumps = EMPTY;
    let stopped = false;
    let ui: ReturnType<typeof surfaces> | undefined;
    /** When a key last opened a row or changed tabs: what that puts in front, soon after, takes focus. And when a note was last given focus for it, which leaves it in normal mode. */
    let arriving = 0;
    let calming = 0;
    let calm: (focused: HTMLElement) => void = () => {};
    const landed = (e: FocusEvent) => {
      if (Date.now() - calming > 10_000 || !(e.target instanceof HTMLElement) || !e.target.isContentEditable) return;
      calming = 0;
      calm(e.target);
    };

    host.onNavigate(() => {
      const app = host.app();
      if (app.noteId) jumps = visit(jumps, app.noteId);
      if (Date.now() - arriving > 3000) return;
      arriving = 0;
      // A note opened with a key is one to write in. A list put in front keeps the keys on its rows.
      if (app.noteId) {
        calming = Date.now();
        app.openNote(app.noteId, { preview: true, focus: true });
      } else if (app.opened) requestAnimationFrame(() => ui?.settle());
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
        // A reading of a note is not an editor: it has no cursor for vim to move, and no mode to show.
        host.editorExtensions.register({ id: "vim", extension: (editor) => (editor.reading ? [] : editing.extension) });
        const byRows = () => editing.moveByRows(host.settings.get<boolean>("screenLines"));
        byRows();
        host.settings.subscribe(byRows);
        /** In a field, these keys are the field's. In a note they are jumps only where vim would take them for jumps. */
        const when = () => !isField(document.activeElement) || editing.jumpsFrom(document.activeElement);
        host.commands.register({ id: "vim.back", title: "Go back to the note before", keys: ["ctrl+o"], when, run: go(-1) });
        host.commands.register({ id: "vim.forward", title: "Go forward to the note after", keys: ["ctrl+i"], when, run: go(1) });

        const outside = (ui = surfaces({ normal: editing.jumpsFrom, dismissing }));
        calm = editing.toNormal;
        document.addEventListener("focusin", landed);
        document.documentElement.dataset.vimKeys = "";
        for (const key of KEYS) {
          host.commands.register({
            id: `vim.${key.id}`,
            title: key.title,
            keys: key.keys,
            when: outside.on[key.surface],
            run: () => {
              if (key.arrives) arriving = Date.now();
              key.run(outside);
            },
          });
        }
      },
      () => !stopped && host.report(new Error("Vim's editing couldn't be loaded, so notes are edited without it. Reload the page to try again.")),
    );
    return () => {
      stopped = true;
      ui?.dispose();
      document.removeEventListener("focusin", landed);
      delete document.documentElement.dataset.vimKeys;
    };
  },
};
