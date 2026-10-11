import type { Note, NoteSummary, PluginHost } from "../../plugin-api.ts";
import type { MenuItem } from "./Menu.tsx";

const why = (err: unknown) => (err instanceof Error ? err.message : "Common Ink can't be reached.");

/** What the member is told once a note is back from Trash. */
export const restoredMessage = (folderGone: boolean) => (folderGone ? "Restored to Unsorted, because its folder was deleted." : "Restored from Trash.");

/**
 * The steps of a note's life, each told to the app so that listings, folder counts, open tabs and
 * links follow at once. One that doesn't happen is said in a notice, with the server's reason.
 */
export function lifecycle(host: PluginHost) {
  const took = (note: Note) => {
    const app = host.app();
    app.noteChanged(note);
    // Folder counts are the server's, and leave out an archived or trashed note.
    app.refresh();
  };
  const failed = (err: unknown) => host.app().notify({ message: why(err) });

  /** Throws with the server's reason when the note can't be restored. */
  const restoring = async (noteId: string) => {
    const { folderGone, ...note } = await host.perform({ type: "note.restore", id: noteId });
    took(note);
    return { folderGone };
  };
  const restore = (noteId: string) =>
    restoring(noteId).then(({ folderGone }) => host.app().notify({ message: restoredMessage(folderGone) }), failed);

  /** Archiving says so with a way back, since the note leaves most listings as it is archived. */
  const setArchived = (noteId: string, archived: boolean): Promise<void> =>
    host.perform({ type: "note.archive", id: noteId, archived }).then((note) => {
      took(note);
      if (archived) host.app().notify({ message: "Archived", action: { label: "Undo", run: () => void setArchived(noteId, false) } });
    }, failed);

  const trash = (noteId: string) =>
    host.perform({ type: "note.trash", id: noteId }).then((note) => {
      took(note);
      host.app().notify({ message: "Moved to Trash", action: { label: "Undo", run: () => void restore(noteId) } });
    }, failed);

  /** Removes a note in Trash for good. Throws with the server's reason, such as that the member didn't make the note. */
  const purge = async (noteId: string) => {
    await host.perform({ type: "note.purge", id: noteId });
    host.app().refresh();
  };

  /** What a note's menu offers about its life, wherever the note is listed. */
  const items = (note: NoteSummary | undefined): MenuItem[] => {
    if (!note) return [];
    const locked = note.access !== "edit";
    if (note.state === "trashed") return [{ label: "Restore", disabled: locked, action: () => void restore(note.id) }];
    return [
      { label: note.state === "archived" ? "Unarchive" : "Archive", disabled: locked, action: () => void setArchived(note.id, note.state !== "archived") },
      { label: "Move to Trash", disabled: locked, action: () => void trash(note.id) },
    ];
  };

  return { setArchived, trash, restore, restoring, purge, items };
}

/** Whether the member might be let remove a note from Trash for good: an admin, or the editor who made it, which only the server knows. */
export const mayPurge = (host: PluginHost, note: NoteSummary) => note.access === "edit" && (host.workspace.role === "admin" || host.workspace.role === "editor");
