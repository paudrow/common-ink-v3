import { StateEffect, type ChangeDesc, type EditorState, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
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

/** Whether a note is open in an editor now. */
export const isOpen = (noteId: string) => editors.has(noteId);

/** Other tabs of this browser, asked which notes they have open. A tab never hears what it sent itself. */
const tabs = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ink.open-notes");
tabs?.addEventListener("message", (e: MessageEvent<{ ask?: string; open?: string; id: string }>) => {
  if (e.data.ask && editors.has(e.data.ask)) tabs.postMessage({ open: e.data.ask, id: e.data.id });
});

/** Whether another tab of this browser has a note open in an editor, which may hold typing not yet sent. It answers false when none says so in a moment. */
export function openInAnotherTab(noteId: string): Promise<boolean> {
  if (!tabs) return Promise.resolve(false);
  const id = crypto.randomUUID();
  return new Promise((answer) => {
    const done = (open: boolean) => {
      clearTimeout(waiting);
      tabs.removeEventListener("message", reply);
      answer(open);
    };
    const reply = (e: MessageEvent<{ open?: string; id: string }>) => e.data.open === noteId && e.data.id === id && done(true);
    const waiting = setTimeout(() => done(false), 250);
    tabs.addEventListener("message", reply);
    tabs.postMessage({ ask: noteId, id });
  });
}

/**
 * A move of the cursor within a note that is a jump, as vim's G or a search is: going back comes back
 * to `from`. An editor extension puts it on a transaction of its own after the move.
 */
export const noteJump = StateEffect.define<{ from: number; to: number }>();

/** Where the cursor last was in each note's editor, kept once the editor has gone. */
const cursors = new Map<string, number>();
/** Where the next editor of a note is to put the cursor, for a note being opened, and until when: one that never opened puts nothing later. */
const putting = new Map<string, { at: number; until: number }>();
const PUTTING_MS = 10_000;
type Heard = { jumped: (noteId: string, jump: { from: number; to: number }) => void; changed: (noteId: string, changes: ChangeDesc) => void };
const nobody: Heard = { jumped: () => {}, changed: () => {} };
let heard = nobody;

/** Where the cursor is in a note's editor, or last was. Null for a note no editor has had open. */
export const cursorIn = (noteId: string): number | null => cursors.get(noteId) ?? null;

/** Puts the cursor at `at` in the note's editor and scrolls to it, or in the next one when it has none yet. */
export function putCursor(noteId: string, at: number) {
  const view = editors.get(noteId)?.at(-1);
  if (view) place(view, at);
  else putting.set(noteId, { at, until: Date.now() + PUTTING_MS });
}

const place = (view: EditorView, at: number) => {
  const anchor = Math.min(at, view.state.doc.length);
  view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: "center" }) });
};

/** Hears each {@link noteJump}, and each change to a note's text, in whichever note's editor: what keeps places in a note where they were. */
export function onNoteMoves(listener: Heard) {
  heard = listener;
  return () => {
    if (heard === listener) heard = nobody;
  };
}

/** The editor extension that keeps a note's editor where {@link useOpenNote} reads it, and its cursor where {@link cursorIn} does. */
export const openNote = (noteId: string) =>
  ViewPlugin.define((view) => {
    const others = () => (editors.get(noteId) ?? []).filter((other) => other !== view);
    editors.set(noteId, view.hasFocus ? [...others(), view] : [view, ...others()]);
    const asked = putting.get(noteId);
    putting.delete(noteId);
    const put = asked && asked.until > Date.now() ? asked.at : undefined;
    if (put === undefined) cursors.set(noteId, view.state.selection.main.head);
    else {
      cursors.set(noteId, put);
      queueMicrotask(() => place(view, put));
    }
    queueMicrotask(changed);
    return {
      update(update) {
        if (update.focusChanged && view.hasFocus) editors.set(noteId, [...others(), view]);
        if (update.selectionSet) cursors.set(noteId, update.state.selection.main.head);
        if (update.docChanged) heard.changed(noteId, update.changes);
        for (const tr of update.transactions) for (const e of tr.effects) if (e.is(noteJump)) heard.jumped(noteId, e.value);
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
  const state = noteId === null ? undefined : editors.get(noteId)?.at(-1)?.state;
  return state ? reading(state) : null;
}
