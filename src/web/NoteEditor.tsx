import { defaultKeymap, history } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Note } from "../core/protocol.ts";
import { ApiError, perform } from "./api.ts";
import { forEditor } from "./editorExtensions.ts";
import { completing } from "./completing.ts";
import { embedding, embedsAre } from "./embedding.ts";
import { noteHighlighting } from "./highlight.ts";
import { readOnly } from "./readOnly.ts";
import type { Completion, EditorExtension, Embed } from "./plugin-api.ts";
import { NoteSync, committed, type SaveState } from "./sync.ts";

const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", failed: "Couldn't save. Retrying…",
  rejected: "Couldn't save this version. Edit the note to try again.",
};

const typingIn = (el: Element | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);

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
  /** Whether the editor is to take the cursor, now or once the note has loaded. `onFocused` is called when it has. */
  focus: boolean;
  onFocused: () => void;
  /** Whether the member can change the note. When they can't, nothing in the editor does: not typing, not an embed, not a plugin's keys. */
  canEdit: boolean;
  /** What plugins have registered to draw inside a note. */
  embeds: readonly Embed[];
  /** The lists plugins offer at the cursor, such as the embed menu. */
  completions: readonly Completion[];
  /** Called for a completion that threw while being asked what it offers. */
  onContributionFailed: (contribution: object, error: unknown) => void;
  /** What plugins have added to every note's editor. One given as a function is made here, for this note. */
  extensions: readonly EditorExtension[];
  /** Called for an extension this editor had to leave out, with why. */
  onExtensionRefused: (extension: EditorExtension, error: unknown) => void;
  meta: ReactNode;
  actions: ReactNode;
}

export function NoteEditor({ workspaceId, noteId, onLoaded, onSaved, revision, onEdit, notice, focus, onFocused, canEdit, embeds, completions, onContributionFailed, extensions: contributed, onExtensionRefused, meta, actions }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const syncRef = useRef<NoteSync | null>(null);
  const edited = useRef(onEdit);
  edited.current = onEdit;
  const viewRef = useRef<EditorView | null>(null);
  const [embedded] = useState(() => new Compartment());
  const embedsNow = useRef(embeds);
  embedsNow.current = embeds;
  const [completed] = useState(() => new Compartment());
  const failed = useRef(onContributionFailed);
  failed.current = onContributionFailed;
  const offered = useMemo(() => completing(completions, (completion, err) => failed.current(completion, err)), [completions]);
  const offeredNow = useRef(offered);
  offeredNow.current = offered;
  const [added] = useState(() => new Compartment());
  const mine = useMemo(() => forEditor({ noteId }), [noteId]);
  const { extensions, refused } = useMemo(() => mine(contributed), [mine, contributed]);
  const [locked] = useState(() => new Compartment());
  const now = useRef({ focus, onFocused, extensions, canEdit });
  now.current = { focus, onFocused, extensions, canEdit };
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
              locked.of(now.current.canEdit ? [] : readOnly),
              // Before the editor's own keys, so a plugin's keys are tried first.
              added.of(now.current.extensions),
              // Undo and redo are commands, which choose between this stack and the note's history, so no keys are bound here.
              history(),
              keymap.of(defaultKeymap),
              markdown(),
              noteHighlighting,
              embedding,
              embedded.of(embedsAre(embedsNow.current)),
              completed.of(offeredNow.current),
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
        // A note that took a while to load doesn't take the cursor from a field the member has since gone to.
        if (!note.text || (now.current.focus && !typingIn(document.activeElement))) view.focus();
        if (now.current.focus) now.current.onFocused();
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
  }, [workspaceId, noteId, onLoaded, onSaved, embedded, completed, added, locked]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: locked.reconfigure(canEdit ? [] : readOnly) });
  }, [canEdit, locked]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: added.reconfigure(extensions) });
  }, [extensions, added]);

  useEffect(() => {
    for (const [extension, err] of refused) onExtensionRefused(extension, err);
  }, [refused, onExtensionRefused]);

  useEffect(() => {
    if (!focus || !viewRef.current) return;
    viewRef.current.focus();
    now.current.onFocused();
  }, [focus]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: embedded.reconfigure(embedsAre(embeds)) });
  }, [embeds, embedded]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: completed.reconfigure(offered) });
  }, [offered, completed]);

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
