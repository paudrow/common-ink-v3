import type { EditorState, Text } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { useSyncExternalStore } from "react";

/** A note as its editor holds it now: typing not yet saved included. */
export interface OpenNote {
  text: string;
  /** What is selected in it, each range on a line of its own. Empty when nothing is. */
  selected: string;
}

/** Every editor a note is open in, the one the member was last in at the end. One that opens while another is being written in takes nothing over. */
const editors = new Map<string, EditorView[]>();
/** What was read of an editor's state the last time, so a caret that only moves reads no text again. */
const read = new WeakMap<EditorState, OpenNote>();
const texts = new WeakMap<Text, string>();
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
    const others = () => (editors.get(noteId) ?? []).filter((other) => other !== view);
    editors.set(noteId, view.hasFocus ? [...others(), view] : [view, ...others()]);
    queueMicrotask(changed);
    return {
      update(update) {
        if (update.focusChanged && view.hasFocus) editors.set(noteId, [...others(), view]);
        if (update.docChanged || update.selectionSet || update.focusChanged) changed();
      },
      destroy() {
        const left = others();
        if (left.length) editors.set(noteId, left);
        else editors.delete(noteId);
        queueMicrotask(changed);
      },
    };
  });

function reading(state: EditorState): OpenNote {
  let note = read.get(state);
  if (note) return note;
  let text = texts.get(state.doc);
  if (text === undefined) texts.set(state.doc, (text = state.doc.toString()));
  note = {
    text,
    selected: state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => state.sliceDoc(range.from, range.to))
      .join("\n"),
  };
  read.set(state, note);
  return note;
}

/**
 * A note's text and selection as its editor has them, drawn again as either changes. Null when the
 * note isn't open in an editor: nothing is asked of the server, and a note only being read is not open.
 * Open in several editors, it is the one the member was last in. The text is the same string until the note changes.
 */
export function useOpenNote(noteId: string | null): OpenNote | null {
  useSyncExternalStore(subscribe, () => version);
  return readOpenNote(noteId);
}

/** The same, asked outside a drawing: by the app, for a plugin that runs shut off and is permitted to read notes. */
export const readOpenNote = (noteId: string | null): OpenNote | null => {
  const state = noteId === null ? undefined : editors.get(noteId)?.at(-1)?.state;
  return state ? reading(state) : null;
};

/** Calls `listener` when what {@link readOpenNote} answers may have changed for any note. */
export const watchOpenNotes = subscribe;
