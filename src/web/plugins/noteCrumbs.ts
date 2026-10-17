import { ALL_NOTES, SHARED_WITH_ME, type Folders, type NoteSummary } from "../plugin-api.ts";
import { titleOf } from "./noteListView.ts";

/** How many rows a crumb's list shows at most, so a folder of thousands of notes is a list to type into and not one to scroll. */
export const MOST_ROWS = 100;

/** A place on an open note's way down from the workspace: the workspace itself, or a folder. The note is the last crumb and goes nowhere. */
export interface Crumb {
  /** The folder this crumb lists and goes to. `ALL_NOTES` for the workspace, whose list is every note. */
  folderId: string;
  /** The folder whose subfolders it lists: null for the workspace's top level. */
  parent: string | null;
  name: string;
}

/**
 * The crumbs for an open note: the workspace, then each folder from the top down to the note's own.
 * A note shared with a guest is in no folder, and is under "Shared with me".
 */
export function crumbsOf(tree: Folders, note: Pick<NoteSummary, "folderId">, workspaceName: string): Crumb[] {
  const folders = note.folderId === null ? [{ folderId: SHARED_WITH_ME, parent: "none", name: "Shared with me" }] : tree.pathOf(note.folderId).map((f) => ({ folderId: f.id, parent: f.id, name: f.name }));
  return [{ folderId: ALL_NOTES, parent: null, name: workspaceName }, ...folders];
}

/** A row of a crumb's list. */
export interface Entry {
  id: string;
  kind: "folder" | "note";
  label: string;
}

/**
 * What a crumb's list holds, below "Go to folder": the folder's subfolders, then its notes as they
 * are in the app now, never one in Trash or archived. The workspace's list is its top-level folders alone.
 * Only what the member can already see is in the app, so nothing here widens that.
 */
export function entriesOf(tree: Folders, notes: readonly NoteSummary[], crumb: Crumb): Entry[] {
  const folders = crumb.parent === "none" ? [] : tree.childrenOf(crumb.parent).map((f): Entry => ({ id: f.id, kind: "folder", label: f.name }));
  const own = crumb.folderId === ALL_NOTES ? [] : notes.filter((n) => n.state === "live" && n.folderId === (crumb.folderId === SHARED_WITH_ME ? null : crumb.folderId));
  return [...folders, ...own.sort((a, b) => titleOf(a).localeCompare(titleOf(b))).map((n): Entry => ({ id: n.id, kind: "note", label: titleOf(n) }))];
}

/** What "Go to folder" says on a crumb. */
export const goLabel = (crumb: Crumb) => (crumb.folderId === ALL_NOTES ? "Go to all notes" : "Go to folder");
