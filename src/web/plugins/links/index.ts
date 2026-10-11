import { EditorView, ViewPlugin } from "@codemirror/view";
import { writtenLink, type Plugin } from "../../plugin-api.ts";
import { redraw } from "../lib/live.ts";
import { matching } from "../lib/match.ts";
import { openPage } from "../lib/opening.ts";
import { linkAt } from "./at.ts";
import { linkDrawing } from "./drawing.ts";

const MOST_OFFERED = 50;

/**
 * Links between notes. `[[` lists the notes and picking one writes a link by its id, drawn as the
 * note's title as it is now or as the link's own display text. ⌘-click, or the command vim's `gd`
 * runs, follows a link to its note, and the command follows a web address too.
 */
export const links: Plugin = {
  id: "links",
  name: "Links",
  activate(host) {
    const editors = new Map<string, EditorView>();
    const notes = () => host.app().notes;
    const titleOf = (noteId: string) => {
      const all = notes();
      return all ? (all.find((n) => n.id === noteId)?.title ?? null) : undefined;
    };
    const open = (noteId: string) => host.app().openNote(noteId, { preview: true, focus: true });

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
        return matching(app.notes ?? [], title, (n) => n.title)
          .slice(0, MOST_OFFERED)
          .map((n) => ({ label: n.title || "Untitled", detail: app.folders?.pathName(n.folderId), insert: writtenLink(n.id, rest.join("|").trim()) }));
      },
    });

    const drawing = linkDrawing(titleOf, open);
    const focused = () => [...editors.values()].find((v) => v.hasFocus);

    host.editorExtensions.register({
      id: "links",
      extension: ({ noteId }) => [
        drawing.extension,
        ViewPlugin.define((view) => {
          editors.set(noteId, view);
          return { destroy: () => void (editors.get(noteId) === view && editors.delete(noteId)) };
        }),
      ],
    });

    // A link is drawn from its note's title, which changes without the linking note changing.
    let titles = "";
    host.onNotes(() => {
      const now = JSON.stringify((notes() ?? []).map((n) => [n.id, n.title]).sort());
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
        else if (titleOf(to.note) !== null) open(to.note);
      },
    });

    // The cursor passes a drawn link whole, so going into one to change it is asked for: by a click, or by this.
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