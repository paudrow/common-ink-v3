import { redo, undo } from "@codemirror/commands";
import { Annotation, ChangeSet, Transaction, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Filed, Note, OpInput, Results, RevertedNotes, Written } from "../core/protocol.ts";
import { changesBetween } from "../core/text.ts";
import { ApiError, perform } from "./api.ts";
import { today } from "./time.ts";

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

/** Sends what's typed in a note now, without waiting for a pause. */
export const saveNow = (noteId: string) => open.get(noteId)?.commit();

const filing = new Set<() => void>();

/**
 * Calls `listener` when a change to one note changed daily notes too: checking off a recurring todo
 * files a line on one, which may be new, and taking a completion back takes its line off again.
 */
export function onFiled(listener: () => void): () => void {
  filing.add(listener);
  return () => void filing.delete(listener);
}

/** What an answer may say of the daily notes its change reached. */
interface Reached {
  id?: string;
  filed?: Filed;
  unfiled?: { dailyNoteIds?: readonly string[] };
}

/** After a change that may have reached daily notes: the app is told, and each one's open editor takes what was filed on it or taken off it. */
async function settle(answer: Reached): Promise<void> {
  if (!answer.filed && !answer.unfiled) return;
  for (const listener of [...filing]) listener();
  const dailies = [answer.filed?.dailyNoteId, ...(answer.unfiled?.dailyNoteIds ?? [])].filter((id) => id && id !== answer.id);
  // The change itself landed. A daily note that can't be read now is read again when the app next looks.
  await Promise.all([...new Set(dailies)].map((id) => open.get(id!)?.pull().catch(() => {})));
}

/** An operation that changes one note's text from outside its editor, and answers with the note. */
type HistoryOp = Extract<OpInput, { type: "note.revert" | "note.revertChanges" | "note.undo" | "note.redo" | "todo.set" }>;

/** Moves a note through its history, or rewrites a todo in it. What's typed is saved first, and the note's editor takes the result if it's open. */
export async function moveThroughHistory(workspaceId: string, op: HistoryOp): Promise<Note> {
  const sync = open.get(op.id);
  await sync?.commit();
  // A todo is completed on the member's own day, which the server can't know.
  const note: Written = await perform(workspaceId, op.type === "todo.set" && op.on === undefined ? { ...op, on: today() } : op);
  await sync?.take(note);
  await settle(note);
  return note;
}

/** Sends what is typed in these notes and not yet saved, so that what is read of them next is all of it. */
export const commitTyping = (noteIds: readonly string[]) => Promise.all(noteIds.flatMap((id) => [open.get(id)?.commit(), committed(id)]));

type RevertMany = Extract<OpInput, { type: "history.revert" }>;

/** Reverts changes of several notes. What's typed in them is saved first, and each reverted note's editor takes the result if it's open. */
export async function revertMany(workspaceId: string, changes: RevertMany["changes"]): Promise<RevertedNotes> {
  await commitTyping(changes.map((c) => c.noteId));
  const done = await perform(workspaceId, { type: "history.revert", changes });
  await Promise.all(done.reverted.map((r) => open.get(r.noteId)?.pull(r.revision)));
  for (const r of done.reverted) await settle({ id: r.noteId, unfiled: r.unfiled });
  return done;
}

const MOVES: ReadonlySet<string> = new Set<HistoryOp["type"]>(["note.revert", "note.revertChanges", "note.undo", "note.redo", "todo.set"]);

/**
 * Performs an operation and keeps the open editors true to it. Before one that moves notes through
 * history or rewrites a todo, or previews a revert, what's typed is saved, and each open editor takes
 * its note's result.
 */
export async function performInSync<T extends OpInput>(workspaceId: string, op: T): Promise<Results[T["type"]]> {
  if (MOVES.has(op.type)) return moveThroughHistory(workspaceId, op as HistoryOp) as Promise<Results[T["type"]]>;
  // A todo's history is asked for by its line, which the server has only once what is typed is saved.
  if (op.type === "todo.history") await open.get(op.id)?.commit();
  if (op.type === "history.revert") return revertMany(workspaceId, op.changes) as Promise<Results[T["type"]]>;
  if (op.type === "history.previewRevert") {
    // What is typed and not yet saved would change the note under the preview.
    await commitTyping(op.changes.map((c) => c.noteId)).catch(() => {});
    return perform(workspaceId, op);
  }
  if (op.type !== "history.revertAuthor") return perform(workspaceId, op);
  await Promise.all([...open.values()].map((sync) => sync.commit()));
  const result = await perform(workspaceId, op);
  for (const { note } of (result as Results["history.revertAuthor"]).reverted) {
    await open.get(note.id)?.pull(note.revision);
    await settle(note);
  }
  return result;
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
  /** The member's day when it was typed, which a recurring todo checked off in it is completed on. */
  on: string;
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
      this.unacknowledged = { text, baseRevision: this.revision, writeId: crypto.randomUUID(), on: today() };
      this.typedSinceWrite = ChangeSet.empty(text.length);
    }
    const write = this.unacknowledged;
    this.onState("saving");
    this.inFlight = (async () => {
      try {
        // What is typed is what is stored: a link is by id once it is picked from the list, and typing is never refused for a title.
        const saved = await perform(this.workspaceId, { type: "note.write", id: this.noteId, ...write, linkTitles: "keep" });
        this.apply(changesBetween(write.text, saved.text).map(this.typedSinceWrite!));
        this.unacknowledged = null;
        this.typedSinceWrite = null;
        this.failing = false;
        this.revision = saved.revision;
        this.savedText = saved.text;
        this.onSaved(saved);
        void settle(saved);
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
    // Not filtered, so it reaches the editor of a member who can't change the note themselves.
    else this.view?.dispatch({ changes, filter: false, annotations: [fromServer.of(true), Transaction.addToHistory.of(false)] });
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

  /** Reads the note again when the server has a later revision than this editor does, or may have when none is named. */
  async pull(revision?: number): Promise<void> {
    while (this.inFlight) await this.inFlight;
    if (revision !== undefined && revision <= this.revision) return;
    await this.take(await perform(this.workspaceId, { type: "note.read", id: this.noteId }));
  }

  /** Stop following the view, which can be destroyed right after, and commit what was typed. */
  close(): Promise<void> {
    if (open.get(this.noteId) === this) open.delete(this.noteId);
    this.closedDoc = this.view?.state.doc ?? null;
    return this.commit();
  }
}
