import type { Note, NoteSummary, PluginHost, Upload } from "../../plugin-api.ts";
import { record, type Step, type Telling } from "./listHistory.ts";
import type { MenuItem } from "./Menu.tsx";

const why = (err: unknown) => (err instanceof Error ? err.message : "Common Ink can't be reached.");
/** Throws the server's reason, which a step says when it can't be taken back or done again. */
const refused = (err: unknown): never => {
  throw new Error(why(err));
};

/** What the member is told once a note is back from Trash. */
export const restoredMessage = (folderGone: boolean) => (folderGone ? "Restored to Unsorted, because its folder was deleted." : "Restored from Trash.");

/** "3 notes", or "2 of 3 notes" when `of` were tried and the rest refused. */
const counted = (n: number, what: string, of?: number) => `${of ? `${n} of ${of}` : n} ${what}${(of ?? n) === 1 ? "" : "s"}`;

/** What is said of several restored at once, `orphans` of which went to Unsorted because their folder was deleted. */
const restoredMany = (n: number, what: string, orphans: number, of?: number) =>
  `Restored ${counted(n, what, of)} from Trash.${orphans ? ` ${orphans === n ? "They" : orphans} went to Unsorted, because ${orphans === 1 ? "its folder was" : "their folders were"} deleted.` : ""}`;

/**
 * Does `go` to each of `of`, one after another, as one step of the lists' undo (`record`). Folder
 * counts are the server's, and leave out what is archived or trashed: they are read again once for
 * all of them, after it is done, undone or redone.
 */
const each = <T>(host: PluginHost, of: readonly T[], go: (one: T) => Promise<Step | null>, telling: Omit<Telling, "after">) => record(host, of, go, { ...telling, after: () => void host.app().refresh() });

/**
 * The steps of a note's life, each told to the app so that listings, folder counts, open tabs and
 * links follow at once, and each a step that undo takes back from a list, wherever it was done. Each
 * is done to several notes as one, as to a list's selection. One that doesn't happen is said in a
 * notice, with the server's reason.
 */
export function lifecycle(host: PluginHost) {
  const took = (note: Note) => host.app().noteChanged(note);
  const archiving = (id: string, archived: boolean) => host.perform({ type: "note.archive", id, archived }).then(took, refused);
  const trashing = (id: string) => host.perform({ type: "note.trash", id }).then(took, refused);
  const restoring = (id: string) =>
    host.perform({ type: "note.restore", id }).then(({ folderGone, ...note }) => {
      took(note);
      return { note, folderGone };
    }, refused);

  /** Archiving says so with a way back, since the notes leave most listings as they are archived. Bringing them back says nothing. */
  const setArchived = (noteIds: readonly string[], archived: boolean) => {
    const told = archived ? "Archived" : "Unarchived";
    const icon = archived ? "archive" : "unarchive";
    return each(
      host,
      noteIds,
      async (id) => {
        await archiving(id, archived);
        return { told, icon, undo: () => archiving(id, !archived), redo: () => archiving(id, archived) };
      },
      { told: (n, of) => `${told} ${counted(n, "note", of)}`, icon, quietly: !archived },
    );
  };

  const trash = (noteIds: readonly string[]) =>
    each(
      host,
      noteIds,
      async (id) => {
        await trashing(id);
        return { told: "Moved to Trash", icon: "trash", undo: () => restoring(id).then(() => {}), redo: () => trashing(id) };
      },
      { told: (n, of) => `Moved ${counted(n, "note", of)} to Trash`, icon: "trash" },
    );

  const restore = (noteIds: readonly string[]) => {
    let orphans = 0;
    return each(
      host,
      noteIds,
      async (id) => {
        const { note, folderGone } = await restoring(id);
        if (folderGone) orphans++;
        return { told: `${note.title || "Untitled"}: ${restoredMessage(folderGone)}`, icon: "check", undo: () => trashing(id), redo: () => restoring(id).then(() => {}) };
      },
      { told: (n, of) => restoredMany(n, "note", orphans, of), icon: "check" },
    );
  };

  /** Moves notes to a folder, and undo takes each back to the folder it was in. One in it already, or in no folder the member can see, stays. */
  const move = (noteIds: readonly string[], folderId: string) => {
    const app = host.app();
    const name = app.folders?.pathName(folderId) ?? "the folder";
    const moving = (id: string, to: string) => host.app().moveNote(id, to).catch(refused);
    return each(
      host,
      noteIds,
      async (id) => {
        const from = app.notes?.find((n) => n.id === id)?.folderId;
        if (!from || from === folderId) return null;
        await moving(id, folderId);
        return { told: `Moved to ${name}`, icon: "folders", undo: () => moving(id, from), redo: () => moving(id, folderId) };
      },
      { told: (n, of) => `Moved ${counted(n, "note", of)} to ${name}`, icon: "folders" },
    );
  };

  /** Removes a note in Trash for good. Throws with the server's reason, such as that the member didn't make the note. It is no step: nothing takes it back. */
  const purge = async (noteId: string) => {
    await host.perform({ type: "note.purge", id: noteId });
    host.app().refresh();
  };

  /** What a note's menu offers about its life, wherever the note is listed. */
  const items = (note: NoteSummary | undefined): MenuItem[] => {
    if (!note) return [];
    const locked = note.access !== "edit";
    if (note.state === "trashed") return [{ label: "Restore", icon: "restore", disabled: locked, action: () => void restore([note.id]) }];
    return [
      { label: note.state === "archived" ? "Unarchive" : "Archive", icon: note.state === "archived" ? "unarchive" : "archive", disabled: locked, action: () => void setArchived([note.id], note.state !== "archived") },
      { label: "Move to Trash", icon: "trash", disabled: locked, action: () => void trash([note.id]) },
    ];
  };

  return { setArchived, trash, restore, move, purge, items };
}

/** An upload as its steps need it: which one, what it is called, and the folder it is in. */
export type Filed = Pick<Upload, "id" | "name" | "folderId">;

/** Told whenever an upload moves to another folder, which is nothing notes show, and so nothing `learn` tells of. */
const moved = new Set<() => void>();
export function onUploadMoved(listener: () => void) {
  moved.add(listener);
  return () => void moved.delete(listener);
}

/** The same steps of an upload's life, each told to the app so that every note that shows the file follows. */
export function uploadLifecycle(host: PluginHost) {
  const learnt = <U extends Upload>(upload: U) => {
    const { id, name, type, kind, size, width, height, state } = upload;
    host.uploads.learn([{ id, upload: { name, type, kind, size, width, height, state } }]);
    return upload;
  };
  const archiving = (id: string, archived: boolean) => host.perform({ type: "upload.archive", id, archived }).then((u) => void learnt(u), refused);
  const moving = (id: string, folderId: string) =>
    host.perform({ type: "upload.move", id, folderId }).then((u) => {
      learnt(u);
      for (const listener of [...moved]) listener();
    }, refused);
  const trashing = (id: string) => host.perform({ type: "upload.trash", id }).then(learnt, refused);
  const restoring = (id: string) => host.perform({ type: "upload.restore", id }).then(learnt, refused);

  const setArchived = (files: readonly Filed[], archived: boolean) => {
    const told = archived ? "Archived" : "Unarchived";
    const icon = archived ? "archive" : "unarchive";
    return each(
      host,
      files,
      async ({ id, name }) => {
        await archiving(id, archived);
        return { told: `${told} ${name}`, icon, undo: () => archiving(id, !archived), redo: () => archiving(id, archived) };
      },
      { told: (n, of) => `${told} ${counted(n, "file", of)}`, icon, quietly: !archived },
    );
  };

  /** A file in Trash is said to be there by every note that uses it, and the notice says so. */
  const trash = (files: readonly Filed[]) => {
    let used = false;
    return each(
      host,
      files,
      async ({ id }) => {
        const { usedIn } = await trashing(id);
        used ||= usedIn > 0;
        const told = usedIn > 0 ? `Moved to Trash. ${usedIn === 1 ? "1 note uses it and now says" : `${usedIn} notes use it and now say`} it is in Trash.` : "Moved to Trash";
        return { told, icon: "trash", undo: () => restoring(id).then(() => {}), redo: () => trashing(id).then(() => {}) };
      },
      { told: (n, of) => `Moved ${counted(n, "file", of)} to Trash.${used ? " The notes that use them now say they are in Trash." : ""}`, icon: "trash" },
    );
  };

  const restore = (files: readonly Filed[]) => {
    let orphans = 0;
    return each(
      host,
      files,
      async ({ id, name }) => {
        const { folderGone } = await restoring(id);
        if (folderGone) orphans++;
        return { told: `${name}: ${restoredMessage(folderGone)}`, icon: "check", undo: () => trashing(id).then(() => {}), redo: () => restoring(id).then(() => {}) };
      },
      { told: (n, of) => restoredMany(n, "file", orphans, of), icon: "check" },
    );
  };

  const move = (files: readonly Filed[], folderId: string) => {
    const to = host.app().folders?.pathName(folderId) ?? "the folder";
    return each(
      host,
      files,
      async ({ id, name, folderId: from }) => {
        if (!from || from === folderId) return null;
        await moving(id, folderId);
        return { told: `Moved ${name} to ${to}`, icon: "folders", undo: () => moving(id, from), redo: () => moving(id, folderId) };
      },
      { told: (n, of) => `Moved ${counted(n, "file", of)} to ${to}`, icon: "folders" },
    );
  };

  return { setArchived, trash, restore, move };
}

/** Whether the member might be let remove a note from Trash for good: an admin, or the editor who made it, which only the server knows. */
export const mayPurge = (host: PluginHost, note: NoteSummary) => note.access === "edit" && (host.workspace.role === "admin" || host.workspace.role === "editor");
