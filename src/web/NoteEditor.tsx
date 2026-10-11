import { defaultKeymap, history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Note } from "../core/protocol.ts";
import { ApiError, perform } from "./api.ts";
import { embedding } from "./embedding.ts";
import { noteHighlighting } from "./highlight.ts";
import type { Embed } from "./plugin-api.ts";
import { NoteSync, committed, type SaveState } from "./sync.ts";

const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", failed: "Couldn't save. Retrying…",
  rejected: "Couldn't save this version. Edit the note to try again.",
};

interface Props {
  workspaceId: string;
  noteId: string;
  onLoaded: (note: Note) => void;
  onSaved: (note: Note) => void;
  /** The note's latest revision as the workspace knows it. A later one than the editor has is read in. */
  revision: number | undefined;
  /** Called on each change typed or pasted, not on changes from the server. */
  onEdit: () => void;
  /** Something the member should know about this note, such as an undo that failed. Shown in place of the save state. */
  notice: string | null;
  /** What plugins have registered to draw inside a note. */
  embeds: readonly Embed[];
  meta: ReactNode;
  actions: ReactNode;
}

export function NoteEditor({ workspaceId, noteId, onLoaded, onSaved, revision, onEdit, notice, embeds, meta, actions }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const syncRef = useRef<NoteSync | null>(null);
  const edited = useRef(onEdit);
  edited.current = onEdit;
  const viewRef = useRef<EditorView | null>(null);
  const [embedded] = useState(() => new Compartment());
  const embedsNow = useRef(embeds);
  embedsNow.current = embeds;
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let view: EditorView | null = null;
    let sync: NoteSync | null = null;
    let cancelled = false;

    committed(noteId).then(() => perform(workspaceId, { type: "note.read", id: noteId })).then(
      (note) => {
        if (cancelled || !host.current) return;
        onLoaded(note);
        sync = syncRef.current = new NoteSync(workspaceId, note, onSaved, setSaveState);
        view = viewRef.current = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: note.text,
            extensions: [
              // Undo and redo are commands, which choose between this stack and the note's history, so no keys are bound here.
              history(),
              keymap.of(defaultKeymap),
              markdown(),
              noteHighlighting,
              embedded.of(embedding(embedsNow.current)),
              EditorView.lineWrapping,
              EditorView.contentAttributes.of({ "aria-label": "Note text" }),
              placeholder("# Title"),
              sync.extension,
              EditorView.updateListener.of((u) => {
                if (u.transactions.some((tr) => tr.docChanged && tr.annotation(Transaction.userEvent))) edited.current();
              }),
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
      syncRef.current = viewRef.current = null;
      void sync?.close();
      view?.destroy();
    };
  }, [workspaceId, noteId, onLoaded, onSaved, embedded]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: embedded.reconfigure(embedding(embeds)) });
  }, [embeds, embedded]);

  useEffect(() => {
    if (revision !== undefined) void syncRef.current?.pull(revision).catch(() => {});
  }, [revision]);

  if (missing) return <p className="notice">This note doesn't exist, or you can't see it.</p>;
  return (
    <section className="note" data-save-state={saveState}>
      <header className="note-bar">
        <div className="note-meta">{meta}</div>
        <div className="save-state" role="status">
          {notice ?? SAVE_LABEL[saveState]}
        </div>
        {actions}
      </header>
      <div className="note-scroll">
        <div className="editor" ref={host} />
      </div>
    </section>
  );
}
