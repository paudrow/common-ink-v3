import { EditorView, ViewPlugin } from "@codemirror/view";
import { useSyncExternalStore } from "react";
import type { PluginHost } from "../../plugin-api.ts";

export interface OpenNotes {
  /** The text of a note as its editor has it now, typing not yet saved included. Null when the note isn't open in an editor. Drawn again on each change. */
  useText(noteId: string | null): string | null;
  /** Scrolls a note's editor to a place in its text, without moving the cursor. */
  show(noteId: string, at: number): void;
}

/**
 * The notes open in editors, for a plugin that shows something about a note's text outside the
 * note, such as a count in the bottom bar. It is an editor extension of the plugin's own, so it
 * reads what the editor holds and never asks the server.
 */
export function openNotes(host: PluginHost): OpenNotes {
  const views = new Map<string, EditorView>();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version++;
    for (const listener of [...listeners]) listener();
  };
  host.editorExtensions.register({
    id: `${host.plugin.id}.open-notes`,
    // A reading of a note isn't where the note is being written, so nothing is read from one.
    extension: ({ noteId, reading }) =>
      reading ? [] : ViewPlugin.define((view) => {
        views.set(noteId, view);
        queueMicrotask(changed);
        return {
          update: (update) => void (update.docChanged && changed()),
          destroy() {
            if (views.get(noteId) !== view) return;
            views.delete(noteId);
            queueMicrotask(changed);
          },
        };
      }),
  });
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  return {
    useText(noteId) {
      useSyncExternalStore(subscribe, () => version);
      return noteId === null ? null : (views.get(noteId)?.state.doc.toString() ?? null);
    },
    show: (noteId, at) => views.get(noteId)?.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) }),
  };
}
