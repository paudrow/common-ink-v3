import { EditorView, ViewPlugin } from "@codemirror/view";
import { writtenLink, type Plugin } from "../../plugin-api.ts";
import { listable } from "../lib/listable.ts";
import { editorKey, redraw } from "../lib/live.ts";
import { matching } from "../lib/match.ts";
import { openPage } from "../lib/opening.ts";
import { linkAt } from "./at.ts";
import { linkDrawing } from "./drawing.ts";
import type { Linked } from "./words.ts";

const MOST_OFFERED = 50;

/**
 * Links between notes. `[[` lists the notes and picking one writes a link by its id, drawn as the
 * note's title as it is now or as the link's own display text. A click on a drawn link, or the
 * command vim's `gd` runs, follows it to its note, ⌘-click opens the note in a tab behind, and the
 * command follows a web address too.
 */
export const links: Plugin = {
  id: "links",
  name: "Links",
  activate(host) {
    const editors = new Map<string, EditorView>();
    /** Every note a link can be to: archived ones, and ones in Trash, which a link still opens. */
    const notes = () => {
      const app = host.app();
      return app.notes && [...app.notes, ...app.trashed];
    };
    const noteOf = (noteId: string): Linked => {
      const all = notes();
      return all ? (all.find((n) => n.id === noteId) ?? null) : undefined;
    };
    const open = (noteId: string, how?: { background: boolean }) => host.app().openNote(noteId, how?.background ? { background: true } : { preview: true, focus: true });

    host.completions.register({
      id: "links",
      trigger: "[[",
      spaces: true,
      anywhere: true,
      items(typed) {
        if (/[[\]]/.test(typed)) return [];
        // What is typed after a `|` is the link's display text, and the list goes on narrowing by what came before it.
        const [title = "", ...rest] = typed.split("|");
        const app = host.app();
        // A listing, so archived notes are left out of it. A link already written to one still opens it.
        return matching(listable(app.notes ?? [], false), title, (n) => n.title)
          .slice(0, MOST_OFFERED)
          .map((n) => ({ label: n.title || "Untitled", detail: app.folders?.pathName(n.folderId), insert: writtenLink(n.id, rest.join("|").trim()) }));
      },
    });

    const drawing = linkDrawing(noteOf, open);
    const focused = () => [...editors.values()].find((v) => v.hasFocus);

    host.editorExtensions.register({
      id: "links",
      extension: (editor) => [
        drawing.extension,
        ViewPlugin.define((view) => {
          const key = editorKey(editor);
          editors.set(key, view);
          return { destroy: () => void (editors.get(key) === view && editors.delete(key)) };
        }),
      ],
    });

    // A link is drawn from its note's title, which changes without the linking note changing.
    let titles = "";
    host.onItems(() => {
      const now = JSON.stringify((notes() ?? []).map((n) => [n.id, n.title, n.state]).sort());
      if (now === titles) return;
      titles = now;
      for (const view of editors.values()) view.dispatch({ effects: redraw.of(null) });
    });

    host.commands.register({
      id: "links.follow",
      title: "Follow the link at the cursor",
      run() {
        const view = focused() ?? editors.get(host.app().noteId ?? "");
        const to = view && linkAt(view.state, view.state.selection.main.head);
        if (!to) return;
        if ("page" in to) openPage(to.page);
        else if (noteOf(to.note) !== null) open(to.note);
      },
    });

    // An arrow key goes into a drawn link from either end. This goes straight to its words from beside it.
    host.commands.register({
      id: "links.edit",
      title: "Edit the link at the cursor",
      keys: ["alt+enter"],
      when: () => {
        const view = focused();
        return !!view && drawing.canEdit(view);
      },
      run: () => {
        const view = focused();
        if (view) drawing.edit(view);
      },
    });
  },
};