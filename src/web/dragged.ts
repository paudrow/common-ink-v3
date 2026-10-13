import type { Opened } from "./plugin-api.ts";

/** The drag type that carries a note's id, so a note dragged out of one plugin's view can be dropped on another's. */
export const NOTE_DRAG = "application/x-common-ink-note";

/**
 * What is dragged to the editor area is what a tab can hold, wherever the drag began: a tab, a
 * card in a folder's list, a folder's row or a page's link in the sidebar. A note is carried as its
 * note, so it also drops wherever a note does; a folder's list or a page is carried under this type, as JSON.
 */
const TAB_DRAG = "application/x-common-ink-tab";

export function carry(data: DataTransfer, tab: Opened) {
  if (tab.kind === "note") data.setData(NOTE_DRAG, tab.id);
  else data.setData(TAB_DRAG, JSON.stringify(tab));
  data.effectAllowed = "move";
}

export const carriesTab = (data: DataTransfer) => data.types.includes(NOTE_DRAG) || data.types.includes(TAB_DRAG);

export function carried(data: DataTransfer): Opened | null {
  const noteId = data.getData(NOTE_DRAG);
  if (noteId) return { kind: "note", id: noteId };
  try {
    const tab = JSON.parse(data.getData(TAB_DRAG)) as Opened;
    return tab.kind === "folder" ? { kind: "folder", id: String(tab.id) } : tab.kind === "page" ? { kind: "page", id: String(tab.id), path: String(tab.path) } : null;
  } catch {
    return null;
  }
}
