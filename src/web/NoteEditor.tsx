import { defaultKeymap, history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState, StateField, Transaction, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, panels, placeholder, type DecorationSet } from "@codemirror/view";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GrantAccess, Note } from "../core/protocol.ts";
import { ApiError, perform, session } from "./api.ts";
import { forEditor } from "./editorExtensions.ts";
import { completing } from "./completing.ts";
import { dismissing } from "./dismiss.ts";
import { embedding, embedsAre } from "./embedding.ts";
import { noteHighlighting } from "./highlight.ts";
import { readOnly } from "./readOnly.ts";
import { fontLoaded } from "./noteFont.ts";
import { openNote } from "./openNotes.ts";
import type { Completion, EditorExtension, AddressEmbed, Embed } from "./plugin-api.ts";
import { NoteSync, committed, worthRetrying, type SaveState } from "./sync.ts";

const UNSAVED_IN_TRASH = "Your last changes aren't saved: this note is in Trash. Restore it to save them.";

const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", unsaved: "Unsaved", saving: "Saving…", failed: "Couldn't save. Retrying…",
  signedOut: "Not saved: you're signed out",
  rejected: "Couldn't save this version. Edit the note to try again.",
  inTrash: UNSAVED_IN_TRASH,
};

/** What the bottom bar says of the note in front: whether it is saved, and whether that is bad news. */
export interface SaveShown {
  label: string;
  failed: boolean;
}

/** The quiet line under a note's title, one element for the life of its editor so what is drawn in it stays. */
class UnderTitle extends WidgetType {
  constructor(readonly dom: HTMLElement) {
    super();
  }
  eq(other: UnderTitle) {
    return other.dom === this.dom;
  }
  toDOM() {
    return this.dom;
  }
  ignoreEvent() {
    return true;
  }
}

/** Puts `dom` under the note's first line, which is its title. A block widget, so it is given directly and not by a function of the view. */
function underTitle(dom: HTMLElement) {
  const at = (doc: Text) => Decoration.set(Decoration.widget({ widget: new UnderTitle(dom), block: true, side: 1 }).range(doc.line(1).to));
  return StateField.define<DecorationSet>({
    create: (state) => at(state.doc),
    update: (marks, tr) => (tr.docChanged ? at(tr.state.doc) : marks),
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** Where reading a note has got to. Only a loaded note has text to say anything about, such as that it is saved. */
type Load = { kind: "loading" } | { kind: "loaded" } | { kind: "missing" } | { kind: "failed"; message: string };

/** How long after a read that failed the next is sent: a second, then twice as long each time, up to half a minute. */
const retryAfter = (failures: number) => Math.min(30_000, 1000 * 2 ** (failures - 1));

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
  /**
   * What the member may do with the note, as the workspace's listing has it. Until that is known it
   * is what the note itself said when it was read. With view, nothing in the editor changes the
   * note: not typing, not an embed, not a plugin's keys.
   */
  access: GrantAccess | undefined;
  /**
   * Where the note is in its life, as the workspace knows it, and until then as the note said when
   * it was read. A note in Trash is read and not changed, as with view.
   */
  state: Note["state"] | undefined;
  /** Whether the note has since been hidden from the member, or is gone. Its text is then no longer shown. */
  gone: boolean;
  /** Called when the server won't take what was typed: `rejected` may mean the member's access changed, and `inTrash` that the note went to Trash without the workspace hearing. */
  onRejected: (why: "rejected" | "inTrash") => void;
  /** What plugins have registered to draw inside a note. */
  embeds: readonly (Embed | AddressEmbed)[];
  /** The lists plugins offer at the cursor, such as the embed menu. */
  completions: readonly Completion[];
  /** Called for a completion that threw while being asked what it offers. */
  onContributionFailed: (contribution: object, error: unknown) => void;
  /** What plugins have added to every note's editor. One given as a function is made here, for this note. */
  extensions: readonly EditorExtension[];
  /** Called for an extension this editor had to leave out, with why. */
  onExtensionRefused: (extension: EditorExtension, error: unknown) => void;
  /** What plugins say of the note in a quiet line under its title, such as that it is archived. */
  marks: ReactNode;
  /** Told what the bottom bar is to say of this note as that changes, and null as the editor goes. `editor` tells apart two editors of one note. */
  onSaveShown: (editor: string, shown: SaveShown | null) => void;
  /** What plugins say of the note above its text, such as that it is in Trash. */
  above: ReactNode;
  /** In focus, the live things of the bottom bar, such as a running timer, which are then drawn at the foot of the note with whether it is saved. */
  live?: ReactNode;
}

/** Where a note's text begins across its pane, from the pane's left edge: what is kept under it, such as vim's mode, begins there too. */
function textLeftIn(view: EditorView, pane: HTMLElement): number {
  const content = view.contentDOM;
  const line = content.querySelector<HTMLElement>(".cm-line:not([class*=' '])") ?? content.querySelector<HTMLElement>(".cm-line");
  const padding = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).paddingLeft) || 0 : 0);
  return Math.round(content.getBoundingClientRect().left + padding(content) + padding(line) - pane.getBoundingClientRect().left);
}

export function NoteEditor({ workspaceId, noteId, onLoaded, onSaved, revision, onEdit, notice, focus, onFocused, access, state, gone, onRejected, embeds, completions, onContributionFailed, extensions: contributed, onExtensionRefused, marks, above, onSaveShown, live }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const footRow = useRef<HTMLDivElement>(null);
  const [textLeft, setTextLeft] = useState<number | null>(null);
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
  const [read, setRead] = useState<Pick<Note, "access" | "state"> | undefined>(undefined);
  const trashed = (state ?? read?.state) === "trashed";
  const canEdit = (access ?? read?.access) === "edit" && !trashed;
  const now = useRef({ focus, onFocused, extensions, access, state, onRejected });
  now.current = { focus, onFocused, extensions, access, state, onRejected };
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  /** Counts up to read the note again after a read that failed. */
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const signedOut = useSyncExternalStore(session.subscribe, session.signedOut);
  const [under] = useState(() => Object.assign(document.createElement("div"), { className: "note-marks" }));

  useEffect(() => {
    if (gone) return;
    let view: EditorView | null = null;
    let sync: NoteSync | null = null;
    let cancelled = false;
    let again: ReturnType<typeof setTimeout> | undefined;

    Promise.all([committed(noteId).then(() => perform(workspaceId, { type: "note.read", id: noteId })), fontLoaded()]).then(([note]) => note).then(
      (note) => {
        if (cancelled || !host.current) return;
        failures.current = 0;
        setLoad({ kind: "loaded" });
        onLoaded(note);
        setRead({ access: note.access, state: note.state });
        const inTrash = (now.current.state ?? note.state) === "trashed";
        const writable = (now.current.access ?? note.access) === "edit" && !inTrash;
        const { text } = note;
        sync = syncRef.current = new NoteSync(workspaceId, note, onSaved, (state) => {
          setSaveState(state);
          if (state === "rejected" || state === "inTrash") now.current.onRejected(state);
        });
        sync.hold(inTrash);
        view = viewRef.current = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              locked.of(writable ? [] : readOnly),
              // Before the editor's own keys, so a plugin's keys are tried first.
              added.of(now.current.extensions),
              // Undo and redo are commands, which choose between this stack and the note's history, so no keys are bound here.
              history(),
              underTitle(under),
              keymap.of(defaultKeymap),
              // GitHub-flavored, so tables, task lists and strikethrough are in the parse for the plugins that draw them.
              markdown({ base: markdownLanguage }),
              noteHighlighting,
              embedding(noteId),
              embedded.of(embedsAre(embedsNow.current)),
              completed.of(offeredNow.current),
              EditorView.lineWrapping,
              // What an extension keeps under the text, such as vim's mode, is kept at the foot of the pane and not under the last line.
              panels({ bottomContainer: foot.current ?? undefined }),
              EditorView.contentAttributes.of({ "aria-label": "Note text" }),
              placeholder("# Title"),
              sync.extension,
              openNote(noteId),
              EditorView.updateListener.of((u) => {
                if (u.transactions.some((tr) => tr.docChanged && tr.annotation(Transaction.userEvent))) edited.current();
              }),
            ],
          }),
        });
        sync.attach(view);
        // A note that took a while to load doesn't take the cursor from a field the member has since gone to, or from a menu opened meanwhile.
        if (!dismissing() && (!note.text || (now.current.focus && !typingIn(document.activeElement)))) view.focus();
        if (now.current.focus) now.current.onFocused();
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "not_found") return setLoad({ kind: "missing" });
        setLoad({ kind: "failed", message: err instanceof ApiError && err.status === 401 ? "You're signed out." : err instanceof Error ? err.message : String(err) });
        if (worthRetrying(err)) again = setTimeout(() => setAttempt((n) => n + 1), retryAfter(++failures.current));
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(again);
      syncRef.current = viewRef.current = null;
      void sync?.close();
      view?.destroy();
    };
  }, [workspaceId, noteId, gone, onLoaded, onSaved, embedded, completed, added, locked, attempt, under]);

  // A read refused for want of a session is sent again once there is one.
  const failedNow = useRef(false);
  failedNow.current = load.kind === "failed";
  useEffect(() => {
    if (!signedOut && failedNow.current) setAttempt((n) => n + 1);
  }, [signedOut]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: locked.reconfigure(canEdit ? [] : readOnly) });
  }, [canEdit, locked]);

  // Nothing is sent for a note in Trash, which the server would refuse. What was typed before the app knew is sent once the note is restored.
  useEffect(() => syncRef.current?.hold(trashed), [trashed]);

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

  // The pane and the column of text each change size on their own: a split dragged, focus entered, the reading width or the text size set.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const row = footRow.current;
    if (load.kind !== "loaded" || !view || !row || !host.current) return;
    const measure = () => setTextLeft(textLeftIn(view, row));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [load.kind]);

  /** A click in the room under the text puts the cursor at the note's end, as a click under the last line of a page does. */
  const toEnd = (event: MouseEvent<HTMLDivElement>) => {
    const view = viewRef.current;
    if (!view || event.button !== 0 || (event.target !== event.currentTarget && event.target !== host.current)) return;
    if (event.clientY <= view.contentDOM.getBoundingClientRect().bottom) return;
    // A press on the pane's own scrollbar is for scrolling.
    const pane = event.currentTarget;
    if (event.clientX >= pane.getBoundingClientRect().left + pane.clientLeft + pane.clientWidth) return;
    event.preventDefault();
    view.dispatch({ selection: { anchor: view.state.doc.length }, userEvent: "select.pointer" });
    view.focus();
  };

  const viewOnly = load.kind === "loaded" && !canEdit && !trashed;
  const label = notice ?? (load.kind === "loaded" ? (trashed && saveState !== "saved" ? UNSAVED_IN_TRASH : viewOnly && saveState === "saved" ? "View only" : SAVE_LABEL[saveState]) : load.kind === "failed" ? "Not loaded" : "");
  const bad = !!notice || load.kind === "failed" || saveState === "failed" || saveState === "rejected" || saveState === "inTrash" || saveState === "signedOut";
  const editorId = useId();
  const told = useRef(onSaveShown);
  told.current = onSaveShown;
  useEffect(() => told.current(editorId, label && !gone ? { label, failed: bad } : null), [editorId, label, bad, gone]);
  useEffect(() => () => told.current(editorId, null), [editorId]);

  if (load.kind === "missing" || gone) return <p className="notice">This note doesn't exist, or you can't see it.</p>;
  return (
    <section className="note" data-save-state={load.kind === "loaded" ? saveState : undefined}>
      {above}
      {createPortal(marks, under)}
      <div className="note-scroll" onMouseDown={toEnd}>
        {load.kind === "failed" && (
          <div className="notice" role="alert">
            <p>This note couldn't be loaded, so there is nothing here to type in yet. {load.message}</p>
            <button type="button" className="button small" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
        <div className="editor" ref={host} />
      </div>
      <div className="note-foot" ref={footRow} style={{ "--text-left": textLeft === null ? undefined : `${textLeft}px` } as CSSProperties}>
        <div className="note-panels" ref={foot} />
        {live && (
          <div className="note-live">
            {live}
            <span className="note-live-save">{load.kind === "loaded" ? (trashed && saveState !== "saved" ? UNSAVED_IN_TRASH : SAVE_LABEL[saveState]) : ""}</span>
          </div>
        )}
      </div>
    </section>
  );
}
