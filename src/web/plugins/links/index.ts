import { EditorView, ViewPlugin } from "@codemirror/view";
import { linkedFolder, writtenFolderLink, writtenLink, type CompletionItem, type Folders, type ListedFolder, type NoteSummary, type Plugin } from "../../plugin-api.ts";
import { listable } from "../lib/listable.ts";
import { editorKey, isEditorOf, redraw } from "../lib/live.ts";
import { matching } from "../lib/match.ts";
import { openPage } from "../lib/opening.ts";
import { AT_ALONE, pointed } from "../lib/pointing.ts";
import { linkAt } from "./at.ts";
import { newTitle } from "./creating.ts";
import { linkDrawing } from "./drawing.ts";
import { foldersAt, newFolderPath } from "./folderPaths.ts";
import type { Linked } from "./words.ts";

const MOST_OFFERED = 50;
/** How many notes `@` offers at most, among the other kinds of thing it lists. */
const MOST_POINTED = 8;
/** How long a link to a folder just made waits for the folders to be read again with it, before it is written anyway. */
const LISTING_MS = 3000;
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
      host.app().openNote(target, how?.background ? { background: true } : { preview: true, focus: true });
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
    /** The folder of note `noteId`, where the member may add to it: where a note `@` creates goes. Elsewhere, the server's Unsorted. */
    const besideOf = (noteId: string) => {
      const app = host.app();
      const folderId = app.notes?.find((n) => n.id === noteId)?.folderId;
      return folderId && app.folders?.byId.get(folderId)?.access === "edit" ? folderId : undefined;
    };
    /** Creates a note titled `title` in `folderId` and answers the link to write to it. It says so with a way to open it, or says why not. */
    const create = async (title: string, folderId: string | undefined): Promise<string | null> => {
      const app = host.app();
      try {
        const note = await host.perform({ type: "note.create", text: `# ${title}\n`, ...(folderId && { folderId }) });
        app.noteChanged(note);
        app.notify({ message: `Created note ${title}`, icon: "check", action: { label: "Open", run: () => open(note.id) } });
        return writtenLink(note.id);
      } catch (err) {
        app.notify({ message: err instanceof Error ? err.message : "The note couldn't be created." });
        return null;
      }
    };
    /**
     * Makes the folders of `parts` that aren't there, each inside the one before, from inside the last
     * of `there`, and answers the link to write to the last. It says so with a way to open it, or says
     * why not. Each is made unless one of its name is there by then, which is used instead.
     */
    const makeFolders = async (parts: readonly string[], there: readonly ListedFolder[]): Promise<string | null> => {
      const app = host.app();
      let parentId = there.at(-1)?.id;
      try {
        for (const name of parts.slice(there.length)) parentId = (await host.perform({ type: "folder.create", name, ...(parentId && { parentId }), ifExists: "return" })).id;
      } catch (err) {
        // Those of the path made before it failed are there, and are listed.
        void app.refresh();
        app.notify({ message: err instanceof Error ? err.message : "The folder couldn't be created." });
        return null;
      }
      await app.refresh();
      // So the link is drawn from the folders that hold it, and reads as its name from the first.
      await listing(parentId!);
      app.notify({ message: `Created folder ${parts.join("/")}`, icon: "check", action: { label: "Open", run: () => open(`folder:${parentId}`) } });
      return writtenFolderLink(parentId!);
    };
    /** Settles once the folders the app holds have `id`, or a moment later where they never do. */
    const listing = (id: string) =>
      new Promise<void>((done) => {
        if (host.app().folders?.byId.has(id)) return done();
        const settle = () => {
          stop();
          clearTimeout(timer);
          done();
        };
        const stop = host.onItems(() => host.app().folders?.byId.has(id) && settle());
        const timer = setTimeout(settle, LISTING_MS);
      });
    /** Creating something makes it once: picked again while it is on its way, it is answered by the same creating. */
    const creating = new Map<string, Promise<string | null>>();
    const once = (key: string, make: () => Promise<string | null>) => {
      const pending = creating.get(key) ?? make().finally(() => creating.delete(key));
      creating.set(key, pending);
      return pending;
    };
    /** What `@` offers to create for what was typed after it: a note of that title, where none is so titled and the member can make one, then a folder of that name or path. */
    const creatable = (typed: string, noteId: string): CompletionItem[] => {
      const app = host.app();
      // An archived note is left out of the listing, but its title is taken all the same.
      const title = app.canCreateNote ? newTitle(typed, (app.notes ?? []).map((n) => n.title)) : null;
      const folderId = besideOf(noteId);
      // A guest's note can go only where they may add to: with nowhere beside this one, none is offered.
      const note: CompletionItem[] =
        title === null || (!folderId && host.workspace.role === "guest") ? [] : [{ kind: "new", label: `Create note “${title}”`, description: folderId ? `New note in ${app.folders?.pathName(folderId)}` : "New note", insert: () => once(`note ${folderId ?? ""} ${title.toLowerCase()}`, () => create(title, folderId)) }];
      return [...note, ...folderToMake(typed)];
    };
    /** A folder `@` offers to create of what was typed: where the member may make it, inside the last folder of the path that is there, or at the top. */
    const folderToMake = (typed: string): CompletionItem[] => {
      const app = host.app();
      const path = app.canEdit && app.folders ? newFolderPath(typed, app.folders) : null;
      if (!path) return [];
      const { parts, there } = path;
      const inside = there.at(-1);
      if (inside ? inside.access !== "edit" : host.workspace.role === "guest") return [];
      const name = parts.join("/");
      const made = parts.length - there.length > 1 ? "New folders" : "New folder";
      return [{ kind: "new", label: `Create folder “${name}”`, description: inside ? `${made} in ${app.folders!.pathName(inside.id)}` : `${made} at the top`, insert: () => once(`folder ${name.toLowerCase()}`, () => makeFolders(parts, there)) }];
    };

    host.completions.register({
      id: "links.at",
      trigger: "@",
      spaces: true,
      // After the others on `@`, so among what is new, creating a contact comes before creating a note, as people come before notes.
      order: 1,
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
        ...creatable(typed, noteId),
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