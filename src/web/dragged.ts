import type { DragEvent } from "react";
import type { Opened } from "./plugin-api.ts";

/** The drag type that carries a note's id, so a note dragged out of one plugin's view can be dropped on another's. */
export const NOTE_DRAG = "application/x-common-ink-note";

/**
 * What is dragged to the editor area: what a tab can hold, or a note that is made only once it is
 * dropped, in `folderId` or else where the New note button would put it.
 */
export type Dragged = Opened | { kind: "new note"; folderId?: string };

/**
 * Everything but a note is carried under this type, as JSON. A note is carried as its id under
 * `NOTE_DRAG`, so it also drops wherever a note does, as on a folder's row to move it there.
 */
const TAB_DRAG = "application/x-common-ink-tab";

function carry(data: DataTransfer, what: Dragged) {
  if (what.kind === "note") data.setData(NOTE_DRAG, what.id);
  else data.setData(TAB_DRAG, JSON.stringify(what));
  data.effectAllowed = "move";
}

/**
 * The props that make an element drag `what` to the editor area, where it lands as a tab does: an
 * edge of a group splits it, its middle adds a tab, and its tab bar puts the tab at the gap.
 * `started` is for the view the drag began in, to know what of its own is being dragged.
 */
export const draggableAs = (what: Dragged, started?: (e: DragEvent) => void) => ({
  draggable: true,
  onDragStart(e: DragEvent) {
    carry(e.dataTransfer, what);
    started?.(e);
  },
});

export const carriesTab = (data: DataTransfer) => data.types.includes(NOTE_DRAG) || data.types.includes(TAB_DRAG);

export function carried(data: DataTransfer): Dragged | null {
  const noteId = data.getData(NOTE_DRAG);
  if (noteId) return { kind: "note", id: noteId };
  try {
    const what = JSON.parse(data.getData(TAB_DRAG)) as Dragged;
    if (what.kind === "folder") return { kind: "folder", id: String(what.id) };
    if (what.kind === "page") return { kind: "page", id: String(what.id), path: String(what.path) };
    if (what.kind === "new note") return typeof what.folderId === "string" ? { kind: "new note", folderId: what.folderId } : { kind: "new note" };
    return null;
  } catch {
    return null;
  }
}

/**
 * The address of the app's own a drag carries as a link, as a link to a note on the Dashboard does,
 * or null for another site's and for none. A browser puts a dragged link under `text/uri-list`,
 * and some under `text/plain` alone.
 */
export function linkIn(data: DataTransfer): string | null {
  const said = data.getData("text/uri-list").split(/\r?\n/).find((line) => line && !line.startsWith("#")) ?? data.getData("text/plain").trim();
  try {
    const url = new URL(said);
    return url.origin === location.origin && !/\s/.test(said) ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}
