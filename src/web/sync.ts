import { redo, undo } from "@codemirror/commands";
import { Annotation, ChangeSet, Transaction, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Note, OpInput } from "../core/protocol.ts";
import { changesBetween } from "../core/text.ts";
import { ApiError, perform } from "./api.ts";

export const PAUSE_MS = 1000;
const RETRY_MS = 3000;

export type SaveState = "saved" | "unsaved" | "saving" | "failed" | "rejected";

/** Sending the same write again can succeed only after a network failure, a server fault, or signing back in. */
const worthRetrying = (err: unknown) => !(err instanceof ApiError) || err.status >= 500 || err.status === 401 || err.status === 429;

/** Every sync with typing the server may not have, including those whose editor has closed. */
const unsaved = new Set<NoteSync>();
addEventListener("pagehide", () => {
  for (const sync of unsaved) void sync.commit();
});
addEventListener("beforeunload", (e) => {
  if (unsaved.size) e.preventDefault();
});

/** Settles once typing in this note from editors that have closed has been sent, so a read after it includes that typing. */
export const committed = (noteId: string) => Promise.all([...unsaved].filter((sync) => sync.noteId === noteId).map((sync) => sync.commit()));

/** The sync of each note open in an editor. A note has at most one tab, so at most one sync. */
const open = new Map<string, NoteSync>();

type HistoryOp = Extract<OpInput, { type: "note.revert" | "note.revertChanges" | "note.reapplyChanges" | "note.undo" | "note.redo" }>;

/** Moves a note through its history. What's typed is saved first, and the note's editor takes the result if it's open. */
export async function moveThroughHistory(workspaceId: string, op: HistoryOp): Promise<Note> {
  const sync = open.get(op.id);
  await sync?.commit();
  const note = await perform(workspaceId, op);
  await sync?.take(note);
  return note;
}

type Step = Extract<HistoryOp, { type: "note.undo" | "note.redo" }>;

/**
 * Undo or redo, as the member means it: take back the last thing. Typing the server doesn't have is
 * undone in the editor, and anything already saved is taken back through the note's history. Null
 * when the editor did it alone.
 */
export async function undoOrRedo(workspaceId: string, op: Step): Promise<Note | null> {
  if (open.get(op.id)?.stepHere(op.type)) return null;
  return moveThroughHistory(workspaceId, op);
}

const fromServer = Annotation.define<boolean>();

interface Write {
  text: string;
  baseRevision: number;
  writeId: string;
}

/**
 * Commits a note's typing as one change on a pause or when the editor loses focus. A write that
 * fails is sent again unchanged, with the same id, until the server acknowledges it; typing in the
 * meantime waits for the next write. The server's merge is applied over that typing.
 */
export class NoteSync {
  readonly noteId: string;
  private revision: number;
  private savedText: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private unacknowledged: Write | null = null;
  private typedSinceWrite: ChangeSet | null = null;
  /** Whether the last write didn't reach the server and is waiting to be sent again. */
  private failing = false;
  /** Whether the member's last step was an undo in the editor, which is what a redo then puts back. */
  private undidHere = false;
  private view: EditorView | null = null;
  /** The document once the editor has closed; later merges apply here instead of to the view. */
  private closedDoc: Text | null = null;

  constructor(
    private readonly workspaceId: string,
    note: Note,
    private readonly onSaved: (note: Note) => void,
    private readonly onState: (state: SaveState) => void,
  ) {
    this.noteId = note.id;
    this.revision = note.revision;
    this.savedText = note.text;
  }

  readonly extension = [
    EditorView.updateListener.of((update) => this.onUpdate(update)),
    EditorView.focusChangeEffect.of((_, focusing) => {
      if (!focusing) void this.commit();
      return null;
    }),
  ];

  attach(view: EditorView) {
    this.view = view;
    open.set(this.noteId, this);
  }

  private doc(): Text | null {
    return this.closedDoc ?? this.view?.state.doc ?? null;
  }

  get dirty(): boolean {
    return this.unacknowledged !== null || (this.doc()?.toString() ?? this.savedText) !== this.savedText;
  }

  private onUpdate(update: ViewUpdate) {
    if (!update.docChanged || update.transactions.some((tr) => tr.annotation(fromServer))) return;
    if (!update.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) this.undidHere = false;
    if (this.typedSinceWrite) this.typedSinceWrite = this.typedSinceWrite.compose(update.changes);
    unsaved.add(this);
    this.onState("unsaved");
    this.schedule(PAUSE_MS);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.commit(), ms);
  }

  /** Send what's typed now, after any save already on its way. */
  async commit(): Promise<void> {
    clearTimeout(this.timer);
    while (this.inFlight) await this.inFlight;
    const doc = this.doc();
    if (!doc) return;
    if (!this.unacknowledged) {
      const text = doc.toString();
      if (text === this.savedText) {
        unsaved.delete(this);
        this.onState("saved");
        return;
      }
      this.unacknowledged = { text, baseRevision: this.revision, writeId: crypto.randomUUID() };
      this.typedSinceWrite = ChangeSet.empty(text.length);
    }
    const write = this.unacknowledged;
    this.onState("saving");
    this.inFlight = (async () => {
      try {
        const saved = await perform(this.workspaceId, { type: "note.write", id: this.noteId, ...write });
        this.apply(changesBetween(write.text, saved.text).map(this.typedSinceWrite!));
        this.unacknowledged = null;
        this.typedSinceWrite = null;
        this.failing = false;
        this.revision = saved.revision;
        this.savedText = saved.text;
        this.onSaved(saved);
        if (this.dirty) this.schedule(PAUSE_MS);
        else unsaved.delete(this);
        this.onState(this.dirty ? "unsaved" : "saved");
      } catch (err) {
        this.failing = worthRetrying(err);
        if (this.failing) {
          this.onState("failed");
          this.schedule(RETRY_MS);
        } else {
          this.unacknowledged = null;
          this.typedSinceWrite = null;
          this.onState("rejected");
        }
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  private apply(changes: ChangeSet) {
    if (changes.empty) return;
    if (this.closedDoc) this.closedDoc = changes.apply(this.closedDoc);
    // Kept out of the editor's undo stack, so the member's undo never takes back someone else's change.
    else this.view?.dispatch({ changes, annotations: [fromServer.of(true), Transaction.addToHistory.of(false)] });
  }

  /** Undoes or redoes in the editor alone. False when the step belongs to the note's history instead. */
  stepHere(type: Step["type"]): boolean {
    if (!this.view) return false;
    if (type === "note.redo") return this.undidHere && redo(this.view);
    const unsent = this.view.state.doc.toString() !== (this.unacknowledged?.text ?? this.savedText);
    this.undidHere = (unsent || this.failing) && undo(this.view);
    if (this.undidHere && this.failing && this.view.state.doc.toString() === this.savedText) {
      // The write that failed held only what was just undone. Sent later it would be recorded and then
      // deleted, and the next undo would take the deletion back.
      clearTimeout(this.timer);
      this.unacknowledged = this.typedSinceWrite = null;
      this.failing = false;
      unsaved.delete(this);
      this.onState("saved");
    }
    return this.undidHere;
  }

  /** Takes in a revision made elsewhere, such as an agent's edit or a revert. Typing not yet saved stays, moved to fit. */
  async take(note: Note): Promise<void> {
    while (this.inFlight) await this.inFlight;
    // A write still waiting on the server merges with what's there when it lands.
    if (note.revision <= this.revision || this.unacknowledged) return;
    const doc = this.doc();
    if (doc) this.apply(changesBetween(this.savedText, note.text).map(changesBetween(this.savedText, doc.toString())));
    this.revision = note.revision;
    this.savedText = note.text;
    if (this.dirty) this.schedule(PAUSE_MS);
  }

  /** Reads the note again when the server has a later revision than this editor does. */
  async pull(revision: number): Promise<void> {
    while (this.inFlight) await this.inFlight;
    if (revision <= this.revision) return;
    await this.take(await perform(this.workspaceId, { type: "note.read", id: this.noteId }));
  }

  /** Stop following the view, which can be destroyed right after, and commit what was typed. */
  close(): Promise<void> {
    if (open.get(this.noteId) === this) open.delete(this.noteId);
    this.closedDoc = this.view?.state.doc ?? null;
    return this.commit();
  }
}
