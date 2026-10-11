import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Note } from "../core/protocol.ts";
import { ApiError, perform } from "./api.ts";
import { noteHighlighting } from "./highlight.ts";
import { TITLE_MARK } from "./titleMark.ts";
import { NoteSync, type SaveState } from "./sync.ts";

const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", failed: "Couldn't save. Retrying…",
  rejected: "Couldn't save this version. Edit the note to try again.",
};

/**
 * Someone who types or pastes a heading's mark after that one anyway, as they would in an empty
 * note, means that heading and not a second mark after the first.
 */
const titleMarkOnce = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("input") || tr.startState.doc.toString() !== TITLE_MARK) return tr;
  let typed: string | null = null;
  let changes = 0;
  tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    changes++;
    if (from === TITLE_MARK.length && to === from) typed = inserted.toString();
  });
  if (changes !== 1 || typed === null || !/^#{1,6}(?:\s|$)/.test(typed)) return tr;
  const insert: string = typed;
  return { changes: { from: 0, to: TITLE_MARK.length, insert }, selection: { anchor: insert.length }, annotations: Transaction.userEvent.of(tr.annotation(Transaction.userEvent)!), scrollIntoView: true };
});

interface Props {
  workspaceId: string;
  noteId: string;
  onLoaded: (note: Note) => void;
  onSaved: (note: Note) => void;
  meta: ReactNode;
  actions: ReactNode;
}

export function NoteEditor({ workspaceId, noteId, onLoaded, onSaved, meta, actions }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let view: EditorView | null = null;
    let sync: NoteSync | null = null;
    let cancelled = false;

    perform(workspaceId, { type: "note.read", id: noteId }).then(
      (note) => {
        if (cancelled || !host.current) return;
        onLoaded(note);
        const fresh = note.text === "";
        const text = fresh ? TITLE_MARK : note.text;
        // The sync is told the mark is what the server has, so an untouched note is never sent: there is nothing of the member's in it.
        sync = new NoteSync(workspaceId, { ...note, text }, onSaved, setSaveState);
        view = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text,
            selection: { anchor: fresh ? text.length : 0 },
            extensions: [
              history(),
              titleMarkOnce,
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
      },
      (err) => {
        if (!cancelled && err instanceof ApiError && err.code === "not_found") setMissing(true);
      },
    );

    return () => {
      cancelled = true;
      void sync?.close();
      view?.destroy();
    };
  }, [workspaceId, noteId, onLoaded, onSaved]);

  if (missing) return <p className="notice">This note doesn't exist, or you can't see it.</p>;
  return (
    <section className="note" data-save-state={saveState}>
      <header className="note-bar">
        <div className="note-meta">{meta}</div>
        <div className="save-state" role="status">
          {SAVE_LABEL[saveState]}
        </div>
        {actions}
      </header>
      <div className="note-scroll">
        <div className="editor" ref={host} />
      </div>
    </section>
  );
}
