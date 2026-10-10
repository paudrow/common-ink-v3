import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import type { Note } from "../core/protocol.ts";
import { ApiError, perform } from "./api.ts";
import { noteHighlighting } from "./highlight.ts";
import { NoteSync, type SaveState } from "./sync.ts";

const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", failed: "Couldn't save. Retrying…" };

interface Props {
  workspaceId: string;
  noteId: string;
  onLoaded: (note: Note) => void;
  onSaved: (note: Note) => void;
}

export function NoteEditor({ workspaceId, noteId, onLoaded, onSaved }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let view: EditorView | null = null;
    let sync: NoteSync | null = null;
    let cancelled = false;
    const onPageHide = () => void sync?.commit();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (sync?.dirty) e.preventDefault();
    };

    perform(workspaceId, { type: "note.read", id: noteId }).then(
      (note) => {
        if (cancelled || !host.current) return;
        onLoaded(note);
        sync = new NoteSync(workspaceId, note, onSaved, setSaveState);
        view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: note.text,
            extensions: [
              history(),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              markdown(),
              noteHighlighting,
              EditorView.lineWrapping,
              EditorView.contentAttributes.of({ "aria-label": "Note text" }),
              placeholder("# Title"),
              sync.extension,
            ],
          }),
        });
        sync.attach(view);
        if (!note.text) view.focus();
        addEventListener("pagehide", onPageHide);
        addEventListener("beforeunload", onBeforeUnload);
      },
      (err) => {
        if (!cancelled && err instanceof ApiError && err.code === "not_found") setMissing(true);
      },
    );

    return () => {
      cancelled = true;
      removeEventListener("pagehide", onPageHide);
      removeEventListener("beforeunload", onBeforeUnload);
      void sync?.close();
      view?.destroy();
    };
  }, [workspaceId, noteId, onLoaded, onSaved]);

  if (missing) return <p className="notice">This note doesn't exist, or you can't see it.</p>;
  return (
    <section className="note" data-save-state={saveState}>
      <div className="save-state" role="status">
        {SAVE_LABEL[saveState]}
      </div>
      <div className="editor" ref={host} />
    </section>
  );
}
