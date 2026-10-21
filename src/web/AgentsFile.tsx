import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, panels, placeholder } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { agentsFileLabel, type AgentsFileStore } from "./agentsFileStore.ts";
import { forEditor, usable } from "./editorExtensions.ts";
import { noteHighlighting } from "./highlight.ts";
import type { Host } from "./pluginHost.ts";
import { readOnly } from "./readOnly.ts";
import { changeBetween } from "./textChange.ts";

/** Where the workspace's agents file is open as a document of its own, in a tab. */
export const AGENTS_FILE = "/agents-file.md";

/** A change that came from the store, which is no typing to hand back to it. */
const fromStore = Annotation.define<boolean>();

/**
 * The workspace's agents file: Markdown that tells agents how the workspace is organized, in an editor drawn as a note's is,
 * with the plugins for how an editor is worked. It is no note, so it is in no listing, search, folder or export. An admin or
 * an editor writes it, and everyone else reads it here. It is saved once the typing pauses, and when the editor is left.
 */
export function AgentsFile({ store, host, canEdit }: { store: AgentsFileStore; host: Host; canEdit: boolean }) {
  const text = useSyncExternalStore(store.subscribe, store.text);
  const status = useSyncExternalStore(store.subscribe, store.status);
  const { editorExtensions } = useSyncExternalStore(host.subscribe, host.contributions);
  const unread = status.kind === "loading" || status.kind === "unread";
  const locked = unread || !canEdit;

  const parent = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [lock] = useState(() => new Compartment());
  const [added] = useState(() => new Compartment());
  const mine = useMemo(() => forEditor({ noteId: AGENTS_FILE }), []);
  const { extensions, refused } = useMemo(() => mine(usable(editorExtensions.filter((e) => e.anyText)).taken), [mine, editorExtensions]);
  const now = useRef(extensions);
  now.current = extensions;

  useEffect(() => {
    void store.load();
    const refresh = () => document.visibilityState === "visible" && void store.refresh();
    addEventListener("focus", refresh);
    addEventListener("pagehide", store.flush);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      store.flush();
      removeEventListener("focus", refresh);
      removeEventListener("pagehide", store.flush);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [store]);

  useEffect(() => {
    const view = (viewRef.current = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: store.text(),
        extensions: [
          lock.of(readOnly),
          // Before the editor's own keys, so a plugin's keys are tried first.
          added.of(now.current),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          noteHighlighting,
          EditorView.lineWrapping,
          panels({ bottomContainer: foot.current ?? undefined }),
          placeholder("# How this workspace is organized"),
          EditorView.contentAttributes.of({ "aria-label": "Agents file text" }),
          EditorView.focusChangeEffect.of((_, focusing) => {
            if (!focusing) store.flush();
            return null;
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromStore))) store.type(u.state.doc.toString());
          }),
        ],
      }),
    }));
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [store, lock, added]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const change = changeBetween(view.state.doc.toString(), text);
    // Not filtered, so the file as it arrives reaches an editor that is locked, and not in the editor's history: an undo takes back typing alone.
    if (change) view.dispatch({ changes: change, filter: false, annotations: [fromStore.of(true), Transaction.addToHistory.of(false)] });
  }, [text]);

  const unfocused = useRef(true);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: lock.reconfigure(locked ? readOnly : []) });
    if (locked || !unfocused.current) return;
    unfocused.current = false;
    // As the settings JSON's, once it can be typed in, which waits for the file to be read: on screen, in a tab the member opened, unless they have gone to a field meanwhile.
    const shown = requestAnimationFrame(() => location.pathname === AGENTS_FILE && (document.activeElement === document.body || !document.activeElement) && view.focus());
    return () => cancelAnimationFrame(shown);
  }, [locked, lock]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: added.reconfigure(extensions) });
  }, [extensions, added]);

  useEffect(() => {
    for (const [extension, err] of refused) host.fail(extension, err);
  }, [refused, host]);

  return (
    <section className="text-file" aria-label="Agents file">
      <div className="note-scroll">
        <div className="text-file-head">
          <p className="soon">
            How this workspace is organized, for the agents working in it: what goes where, and how notes are named and tagged. Every agent connected here reads it, and none can change it.{" "}
            {canEdit ? "Admins and editors write it." : "Only admins and editors change it."}
          </p>
        </div>
        <div className="editor" ref={parent} />
      </div>
      <div className="note-foot">
        <div className="note-panels" ref={foot} />
        {status.kind === "unread" && (
          <button type="button" className="button small" onClick={() => void store.load()}>
            Try again
          </button>
        )}
        <span role="status" className="text-file-state" data-failed={status.kind === "refused" || status.kind === "unread" || status.kind === "signedOut" || undefined}>
          {canEdit || unread ? agentsFileLabel(status) : "Read only"}
        </span>
      </div>
    </section>
  );
}
