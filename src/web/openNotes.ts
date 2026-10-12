import { ViewPlugin, type EditorView } from "@codemirror/view";
import { useSyncExternalStore } from "react";

/** A note as its editor holds it now: typing not yet saved included. */
export interface OpenNote {
  text: string;
  /** What is selected in it, each range on a line of its own. Empty when nothing is. */
  selected: string;
}

/** The editor each open note is being written in. A note open in two groups is its editor the member was last in. */
const editors = new Map<string, EditorView>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The editor extension that keeps a note's editor where {@link useOpenNote} reads it. */
export const openNote = (noteId: string) =>
  ViewPlugin.define((view) => {
    editors.set(noteId, view);
    queueMicrotask(changed);
    return {
      update(update) {
        if (update.focusChanged && update.view.hasFocus) editors.set(noteId, update.view);
        if (update.docChanged || update.selectionSet || update.focusChanged) changed();
      },
      destroy() {
        if (editors.get(noteId) !== view) return;
        editors.delete(noteId);
        queueMicrotask(changed);
      },
    };
  });

/**
 * A note's text and selection as its editor has them, drawn again as either changes. Null when the
 * note isn't open in an editor: nothing is asked of the server, and a note only being read is not open.
 */
export function useOpenNote(noteId: string | null): OpenNote | null {
  useSyncExternalStore(subscribe, () => version);
  const state = noteId === null ? undefined : editors.get(noteId)?.state;
  if (!state) return null;
  return {
    text: state.doc.toString(),
    selected: state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => state.sliceDoc(range.from, range.to))
      .join("\n"),
  };
}
