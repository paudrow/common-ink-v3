import { EditorView, ViewPlugin } from "@codemirror/view";
import { linkedFolder, writtenFolderLink, writtenLink, type CompletionItem, type Folders, type ListedFolder, type NoteSummary, type Plugin } from "../../plugin-api.ts";
import { listable } from "../lib/listable.ts";
import { editorKey, isEditorOf, redraw } from "../lib/live.ts";
import { matching } from "../lib/match.ts";
import { openPage } from "../lib/opening.ts";
import { AT_ALONE, pointed } from "../lib/pointing.ts";
import { linkAt } from "./at.ts";
import { linkDrawing } from "./drawing.ts";
import { foldersAt } from "./folderPaths.ts";
import type { Linked } from "./words.ts";

const MOST_OFFERED = 50;
/** How many notes `@` offers at most, among the other kinds of thing it lists. */
const MOST_POINTED = 8;
const NO_FOLDERS: Folders = { unsortedId: null, byId: new Map(), childrenOf: () => [], pathOf: () => [], pathName: () => "" };

/**
 * Links between notes, and to folders. `[[` lists the notes, and so does `@` among everything else
 * it lists, with the folders too, found by name or by a path such as `proj/gar`, and picking one
 * writes a link by its id, drawn as the note's title or the folder's name as it is now, or as the
 * link's own display text. A click on a drawn link, or the command vim's `gd` runs, follows it to its
 * note, ⌘-click opens the note in a tab behind, and the command follows a web address too.
 */
export const links: Plugin = {
  id: "links",
  name: "Links",
  description: "Links between notes, and to folders, written with [[ or picked from @, and kept when a note or folder is renamed.",
  icon: "link",
  activate(host) {
    const editors = new Map<string, EditorView>();
    /** Every note a link can be to: archived ones, and ones in Trash, which a link still opens. */
    const notes = () => {
      const app = host.app();
      return app.notes && [...app.notes, ...app.trashed];
    };
    const noteOf = (target: string): Linked => {
      const folderId = linkedFolder(target);
      if (folderId !== null) {
        const { folders } = host.app();
        const folder = folders?.byId.get(folderId);
        // Undefined while the folders are still being listed, and null for one they don't hold.
        return folders ? (folder ? { title: folder.name, state: "live" } : null) : undefined;
      }
      const all = notes();
      return all ? (all.find((n) => n.id === target) ?? null) : undefined;
    };
    // A link opens its note in the pane it is in, whether or not another pane has it.
    const open = (target: string, how?: { background: boolean }) => {
      const folderId = linkedFolder(target);
      // A page that only reads a note, as a share link's, has no folders to open.
      if (folderId !== null) return void (typeof host.app().openFolder === "function" && host.app().openFolder(folderId));
      host.app().openNote(target, how?.background ? { background: true, here: true } : { preview: true, focus: true, here: true });
    };

    /** A listing, so archived notes are left out of it. A link already written to one still opens it. */
    const listed = () => listable(host.app().notes ?? [], false);
    const itemFor = (note: NoteSummary, display = ""): CompletionItem => ({
      kind: "note",
      label: note.title || "Untitled",
      description: host.app().folders?.pathName(note.folderId),
      ...(note.snippet && { preview: { text: note.snippet } }),
      insert: writtenLink(note.id, display),
    });
    const folderItem = (folder: ListedFolder): CompletionItem => {
      const within = folder.parentId === null ? "" : host.app().folders?.pathName(folder.parentId);
      return { kind: "folder", label: folder.name, description: within ? `Folder in ${within}` : "Folder", insert: writtenFolderLink(folder.id) };
    };

    host.completions.register({
      id: "links",
      trigger: "[[",
      spaces: true,
      anywhere: true,
      items(typed) {
        if (/[[\]]/.test(typed)) return [];
        // What is typed after a `|` is the link's display text, and the list goes on narrowing by what came before it.
        const [title = "", ...rest] = typed.split("|");
        return matching(listed(), title, (n) => n.title)
          .slice(0, MOST_OFFERED)
          .map((n) => itemFor(n, rest.join("|").trim()));
      },
    });
    host.completions.register({
      id: "links.at",
      trigger: "@",
      spaces: true,
      // `@` alone offers the notes edited last, other than the one it is typed in, and no folder.
      items: (typed, { noteId }) => [
        ...(typed
          ? pointed(listed(), typed, (n) => n.title).slice(0, MOST_POINTED)
          : listed()
              .filter((n) => n.id !== noteId)
              .toSorted((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, AT_ALONE.note)
        ).map((n) => itemFor(n)),
        ...foldersAt(typed, host.app().folders ?? NO_FOLDERS)
          .slice(0, MOST_POINTED)
          .map(folderItem),
      ],
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

    // A link is drawn from its note's title or its folder's name, which change without the linking note changing.
    let titles = "";
    host.onItems(() => {
      const now = JSON.stringify([(notes() ?? []).map((n) => [n.id, n.title, n.state]).sort(), [...(host.app().folders?.byId.values() ?? [])].map((f) => [f.id, f.name]).sort()]);
      if (now === titles) return;
      titles = now;
      for (const view of editors.values()) view.dispatch({ effects: redraw.of(null) });
    });

    host.commands.register({
      id: "links.follow",
      title: "Follow the link at the cursor",
      group: "Editor",
      run() {
        const inFront = host.app().noteId;
        const view = focused() ?? (inFront ? [...editors].findLast(([key]) => isEditorOf(key, inFront))?.[1] : undefined);
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
      group: "Editor",
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