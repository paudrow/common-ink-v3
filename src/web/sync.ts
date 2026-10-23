import { redo, undo } from "@codemirror/commands";
import { Annotation, ChangeSet, Transaction, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Filed, Note, OpInput, Results, RevertedNotes, Written } from "../core/protocol.ts";
import { IN_TRASH } from "../core/lifecycle.ts";
import { applyChanges, changesBetween } from "../core/text.ts";
import { ApiError, getMe, perform, session } from "./api.ts";
import { seen, tellFault } from "./faults.ts";
import { historyStepped, mirrored } from "./openNotes.ts";
import { forget, keep, kept, type Kept, type NoteWrite } from "./stash.ts";
import { today } from "./time.ts";

export const PAUSE_MS = 1000;
const RETRY_MS = 3000;
/** Typing kept in the browser longer than this is dropped rather than sent over a week of other changes. */
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** `rejected`: the server won't take what was typed. `inTrash`: it won't because the note is in Trash, and will once the note is restored. */
export type SaveState = "saved" | "unsaved" | "saving" | "failed" | "signedOut" | "rejected" | "inTrash";

/** Asking the same again by itself can succeed only after a network failure, a server fault, or a write that lost to too many others at once. */
export const worthRetrying = (err: unknown) => !(err instanceof ApiError) || err.status >= 500 || err.status === 429 || err.status === 409;

/** The session ended. The same write succeeds once the member has signed in again, and not before. */
const signedOut = (err: unknown) => err instanceof ApiError && err.status === 401;

/** The server says a refusal is for Trash only in its message, which is the same wherever a trashed note is refused. */
const refusedForTrash = (err: unknown) => err instanceof ApiError && err.code === "conflict" && err.message === IN_TRASH;

/** Every sync with typing the server may not have, including those whose editor has closed. */
const unsaved = new Set<NoteSync>();
const keepAll = () => {
  for (const sync of unsaved) {
    void sync.commit();
    sync.keepForNextLoad();
  }
};
addEventListener("pagehide", keepAll);
// A tab the browser discards in the background, and a page Safari unloads, may never see pagehide. Kept twice, the typing is still sent once: each write keeps its id.
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && keepAll());
// Back from the browser's cache, the page sends its own typing again.
addEventListener("pageshow", (e) => {
  if (e.persisted) for (const sync of unsaved) sync.cameBack();
});
addEventListener("beforeunload", (e) => {
  if (unsaved.size) e.preventDefault();
});

session.subscribe(() => {
  if (!session.signedOut()) for (const sync of unsaved) void sync.commit();
});

/** Typing the server refused that no editor holds any longer, so the member is the only one left who can keep it. */
export interface Lost {
  noteId: string;
  text: string;
  why: "rejected" | "inTrash";
  /** The member is done with it: the browser stops keeping it. Until then a reload offers it again. */
  dismiss: () => void;
}

/** Who is told of lost typing in each workspace: the workspace open in this page. */
const losing = new Map<string, (lost: Lost) => void>();

export function onLost(workspaceId: string, listener: (lost: Lost) => void): () => void {
  losing.set(workspaceId, listener);
  return () => void (losing.get(workspaceId) === listener && losing.delete(workspaceId));
}

/** Whether the member was told. Nobody is told while their workspace isn't open, and the typing is kept to tell them later. */
const lose = (workspaceId: string, lost: Lost) => {
  losing.get(workspaceId)?.(lost);
  return losing.has(workspaceId);
};

/** Who typing is kept in the browser for, in each workspace whose kept typing this page has sent. */
const members = new Map<string, string>();
/** What each note's kept typing has come to on its first try to reach the server. */
let recovered: Promise<Map<string, Promise<unknown>>> = Promise.resolve(new Map());
/** Each page keeps its own typing, so that one page never forgets another's. */
const PAGE = crypto.randomUUID();
/**
 * Held for as long as this page lives, so that another page leaves the typing this one keeps to it:
 * sent from elsewhere, it would take the id of this page's next write, which the server would then
 * answer with the note as it was, without what was typed here since.
 */
const LIVE = (page: string) => `ink-page:${page}`;
void navigator.locks?.request(LIVE(PAGE), () => new Promise(() => {}));
const livePages = async () => new Set(((await navigator.locks?.query())?.held ?? []).map((lock) => lock.name));

/**
 * Sends the typing the browser kept for this member in this workspace as earlier pages went, once a
 * page. One kept longer than `KEPT_MS` is dropped.
 */
export function recover(workspaceId: string, personId: string) {
  if (members.get(workspaceId) === personId) return;
  members.set(workspaceId, personId);
  recovered = Promise.all([kept(), livePages().catch(() => new Set<string>())]).then(([all, live]) => {
    const sending = new Map<string, Promise<unknown>>();
    for (const typing of all) {
      // Anyone's, so that a member who never signed out on a shared browser doesn't leave typing in it for good.
      if (Date.now() - typing.at > KEPT_MS) forget(typing.key);
      else if (typing.workspaceId === workspaceId && typing.personId === personId && !live.has(LIVE(typing.key.split(":")[0]!))) sending.set(typing.op.id, Promise.all([sending.get(typing.op.id), resend(typing)]));
    }
    return sending;
  });
}

/**
 * Sends kept typing as its page would have: its write on the way first, with the id it was first sent
 * with so that the server records it only once, and then what was typed after it, merged over the
 * server's answer. Settles after the first try. One that can't reach the server is tried again while
 * this page is open, one refused is offered back to the member, and one refused for a session that
 * ended is kept for the next load.
 */
async function resend(typing: Kept): Promise<void> {
  try {
    const saved = await perform(typing.workspaceId, typing.op);
    if (typing.text !== typing.op.text) {
      const text = applyChanges(changesBetween(typing.op.text, saved.text).map(changesBetween(typing.op.text, typing.text)), typing.text);
      typing = { ...typing, op: { ...typing.op, text, baseRevision: saved.revision, writeId: typing.nextWriteId }, text, nextWriteId: crypto.randomUUID() };
      keep(typing);
      await perform(typing.workspaceId, typing.op);
    }
    // A retry lands after the note's editor read it, which then takes it in.
    void open.get(typing.op.id)?.pull();
  } catch (err) {
    if (signedOut(err)) return;
    if (!refusedForTrash(err) && worthRetrying(err)) return void setTimeout(() => void retry(typing), RETRY_MS);
    // Kept until the member dismisses it, or for the next load to offer while nobody here can be told.
    lose(typing.workspaceId, { noteId: typing.op.id, text: typing.text, why: refusedForTrash(err) ? "inTrash" : "rejected", dismiss: () => forget(typing.key) });
    return;
  }
  forget(typing.key);
}

/** Sends kept typing again, only while the browser is still signed in as the member it was kept for, as another tab may have changed. */
async function retry(typing: Kept) {
  const me = await getMe().catch(() => null);
  if (!me) return void setTimeout(() => void retry(typing), RETRY_MS);
  if (me.person.id === typing.personId) await resend(typing);
}

/** Settles once typing in this note from editors that have closed, and from earlier pages, has been sent, so a read after it includes that typing. */
export const committed = (noteId: string) =>
  recovered.then((sending) => sending.get(noteId)).then(() => Promise.all([...unsaved].filter((sync) => sync.noteId === noteId).map((sync) => sync.commit())));

/** The sync of each note open in an editor. A note open in several panes has one sync, which every one of its editors shares. */
const open = new Map<string, NoteSync>();

/** Sends what's typed in a note now, without waiting for a pause. */
export const saveNow = (noteId: string) => open.get(noteId)?.commit();
/** Reads each open note again that the listing has a later revision of than its editor, as after a read of that revision failed. */
export const catchUp = (listed: readonly Pick<Note, "id" | "revision">[]) => {
  for (const note of listed) void open.get(note.id)?.pull(note.revision).catch(() => {});
};
/** Sends what is typed in every open note and not yet saved, before the app is loaded again. */
export const saveAll = (): Promise<unknown> => Promise.allSettled([...open.values()].map((sync) => sync.commit()));

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
export async function moveThroughHistory(workspaceId: string, op: HistoryOp, by: typeof perform = perform): Promise<Note> {
  const sync = open.get(op.id);
  await sync?.commit();
  // A todo is completed on the member's own day, which the server can't know.
  const note: Written = await by(workspaceId, op.type === "todo.set" && op.on === undefined ? { ...op, on: today() } : op);
  await sync?.take(note, op.type === "note.undo" || op.type === "note.redo");
  await settle(note);
  return note;
}

/** Sends what is typed in these notes and not yet saved, so that what is read of them next is all of it. */
export const commitTyping = (noteIds: readonly string[]) => Promise.all(noteIds.flatMap((id) => [open.get(id)?.commit(), committed(id)]));

type RevertMany = Extract<OpInput, { type: "history.revert" }>;

/** Reverts changes of several notes. What's typed in them is saved first, and each reverted note's editor takes the result if it's open. */
export async function revertMany(workspaceId: string, changes: RevertMany["changes"], by: typeof perform = perform): Promise<RevertedNotes> {
  await commitTyping(changes.map((c) => c.noteId));
  const done = await by(workspaceId, { type: "history.revert", changes });
  await Promise.all(done.reverted.map((r) => open.get(r.noteId)?.pull(r.revision)));
  for (const r of done.reverted) await settle({ id: r.noteId, unfiled: r.unfiled });
  return done;
}

const MOVES: ReadonlySet<string> = new Set<HistoryOp["type"]>(["note.revert", "note.revertChanges", "note.undo", "note.redo", "todo.set"]);

/**
 * Performs an operation and keeps the open editors true to it. Before one that moves notes through
 * history or rewrites a todo, or previews a revert, what's typed is saved, and each open editor takes
 * its note's result. `by` is how the operation reaches the server, for one that isn't sent as the
 * member's own.
 */
export async function performInSync<T extends OpInput>(workspaceId: string, op: T, by: typeof perform = perform): Promise<Results[T["type"]]> {
  if (MOVES.has(op.type)) return moveThroughHistory(workspaceId, op as HistoryOp, by) as Promise<Results[T["type"]]>;
  // A todo's history is asked for by its line, which the server has only once what is typed is saved.
  // A note goes to Trash with what was typed in it, which it wouldn't take afterwards.
  if (op.type === "todo.history" || op.type === "note.trash") await open.get(op.id)?.commit();
  if (op.type === "history.revert") return revertMany(workspaceId, op.changes, by) as Promise<Results[T["type"]]>;
  // Dates written as links on opening are pulled into the open note at once, so they are drawn as dates from the first.
  if (op.type === "note.linkDates") {
    const result = (await by(workspaceId, op)) as Results["note.linkDates"];
    if (result.changed) await open.get(op.id)?.pull(result.revision);
    return result as Results[T["type"]];
  }
  if (op.type === "history.previewRevert") {
    // What is typed and not yet saved would change the note under the preview.
    await commitTyping(op.changes.map((c) => c.noteId)).catch(() => {});
    return by(workspaceId, op);
  }
  if (op.type !== "history.revertAuthor") return by(workspaceId, op);
  await Promise.all([...open.values()].map((sync) => sync.commit()));
  const result = await by(workspaceId, op);
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

/**
 * What an editor of a note is told: the note as each write leaves it, and how saving goes. A note
 * open in several editors is saved once, so `onSaved` is told to the first of them, and `lead` says
 * which editor is to act on a state, as by saying the note was refused, and not only show it.
 */
interface Listener {
  onSaved: (note: Note) => void;
  onState: (state: SaveState, lead: boolean) => void;
}

/**
 * Commits a note's typing as one change on a pause or when the editor loses focus. A write that
 * fails is sent again unchanged, with the same id, until the server acknowledges it; typing in the
 * meantime waits for the next write. The server's merge is applied over that typing.
 */
export class NoteSync {
  readonly noteId: string;
  /** What this page keeps the note's typing under in the browser as it goes. */
  readonly key: string;
  private revision: number;
  private savedText: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private unacknowledged: NoteWrite | null = null;
  private typedSinceWrite: ChangeSet | null = null;
  /** The id of the next write, chosen ahead so that typing kept as the page goes names the write that will send it. */
  private nextWriteId = crypto.randomUUID();
  /** Whether the last write didn't reach the server and is waiting to be sent again. */
  private failing = false;
  /** Whether the member's last step was an undo in the editor, which is what a redo then puts back. */
  private undidHere = false;
  /** The editors the note is open in, the one last opened at the end. Each holds the same text. */
  private views: EditorView[] = [];
  private listeners = new Map<EditorView, Listener>();
  /** The document once the last editor has closed; later merges apply here instead of to the views. */
  private closedDoc: Text | null = null;
  /** The text of the editor a change was made in, while that change is copied into the others, which don't have it yet. A save started meanwhile takes this text. */
  private copying: Text | null = null;
  /** Whether nothing is to be sent, because the server would refuse it: the note is in Trash. What is typed is kept, and counts as unsaved. */
  private held = false;

  private constructor(
    private readonly workspaceId: string,
    note: Note,
  ) {
    this.noteId = note.id;
    this.key = `${PAGE}:${note.id}`;
    this.revision = note.revision;
    this.savedText = note.text;
  }

  /** The sync of a note already open in another editor, which a new one shares, or a new one from the note as it was read. */
  static of(workspaceId: string, note: Note): NoteSync {
    return open.get(note.id) ?? new NoteSync(workspaceId, note);
  }

  /** The text every editor of the note holds now, for one opened beside them: typing not yet saved included. Null before the first editor. */
  get text(): string | null {
    return this.views[0]?.state.doc.toString() ?? null;
  }

  private onSaved(note: Note) {
    [...this.listeners.values()][0]?.onSaved(note);
  }

  private onState(state: SaveState) {
    this.lastState = state;
    [...this.listeners.values()].forEach((listener, i) => listener.onState(state, i === 0));
  }

  private lastState: SaveState = "saved";

  readonly extension = [
    EditorView.updateListener.of((update) => {
      if (update.focusChanged && update.view.hasFocus) this.lastIn = update.view;
      this.onUpdate(update);
    }),
    EditorView.focusChangeEffect.of((_, focusing) => {
      if (!focusing) void this.commit();
      return null;
    }),
  ];

  /** Follows an editor of the note, and tells it the note as each write leaves it and how saving goes, starting with how it goes now: shown, not acted on again. */
  attach(view: EditorView, listener: Listener) {
    this.views.push(view);
    this.listeners.set(view, listener);
    open.set(this.noteId, this);
    listener.onState(this.lastState, false);
  }

  /** The editor the member was last in, whose undo has what was typed there. */
  private lastIn: EditorView | null = null;

  private doc(): Text | null {
    return this.closedDoc ?? this.copying ?? this.views[0]?.state.doc ?? null;
  }

  get dirty(): boolean {
    return this.unacknowledged !== null || (this.doc()?.toString() ?? this.savedText) !== this.savedText;
  }

  private onUpdate(update: ViewUpdate) {
    if (!update.docChanged || update.transactions.some((tr) => tr.annotation(fromServer) || tr.annotation(mirrored))) return;
    this.lastIn = update.view;
    if (!update.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))) this.undidHere = false;
    if (this.typedSinceWrite) this.typedSinceWrite = this.typedSinceWrite.compose(update.changes);
    unsaved.add(this);
    this.onState("unsaved");
    this.schedule(PAUSE_MS);
    // The note's other editors take the change, kept out of their undo: each editor undoes what was typed in it.
    // One whose text isn't what this change was made to, as while a merge is being put in each in turn, takes it from the server's answer instead.
    // An editor the cursor has just left notices it as it takes the copy, and saves. It saves this editor's text, which has the change
    // already counted in `typedSinceWrite` above: its own text doesn't have the change yet, and the next save would leave it out.
    const outer = this.copying;
    this.copying = update.state.doc;
    try {
      for (const other of this.views) if (other !== update.view && other.state.doc.eq(update.startState.doc)) other.dispatch({ changes: update.changes, filter: false, annotations: [mirrored.of(true), Transaction.addToHistory.of(false)] });
    } finally {
      this.copying = outer;
    }
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.commit(), ms);
  }

  /** Send what's typed now, after any save already on its way. It answers with the note as that write left it, or with nothing when there was nothing to send or the write didn't land. */
  async commit(): Promise<Written | undefined> {
    clearTimeout(this.timer);
    while (this.inFlight) await this.inFlight;
    const doc = this.doc();
    if (!doc || this.held) return;
    if (!this.unacknowledged) {
      const text = doc.toString();
      if (text === this.savedText) {
        this.settled();
        this.onState("saved");
        return;
      }
      this.unacknowledged = this.write(text);
      this.nextWriteId = crypto.randomUUID();
      this.typedSinceWrite = ChangeSet.empty(text.length);
    }
    const write = this.unacknowledged;
    let landed: Written | undefined;
    this.onState("saving");
    this.inFlight = (async () => {
      let saved: Written;
      try {
        saved = await perform(this.workspaceId, write);
      } catch (err) {
        // A conflict is asked again, but not one for Trash: the server takes nothing more until the note is restored.
        this.failing = !refusedForTrash(err) && (worthRetrying(err) || signedOut(err));
        if (signedOut(err)) {
          // Kept to be sent as it is once the member is signed in again, which the session says.
          this.onState("signedOut");
        } else if (this.failing) {
          this.onState("failed");
          this.schedule(RETRY_MS);
        } else {
          this.unacknowledged = null;
          this.typedSinceWrite = null;
          const why = refusedForTrash(err) ? "inTrash" : "rejected";
          this.onState(why);
          if (this.closedDoc) this.giveUp(why);
        }
        return;
      }
      // The server has the write, so it is never sent again: a fault of the page's own after this is told, not asked again.
      const typed = this.typedSinceWrite;
      this.unacknowledged = null;
      this.typedSinceWrite = null;
      this.failing = false;
      this.revision = saved.revision;
      this.savedText = saved.text;
      for (const step of [
        () => saved.text !== write.text && this.apply(changesBetween(write.text, saved.text).map(this.fitted(write.text, typed))),
        () => this.onSaved(saved),
        () => {
          landed = saved;
          void settle(saved);
          if (this.dirty) this.schedule(PAUSE_MS);
          else this.settled();
          this.onState(this.dirty ? "unsaved" : "saved");
        },
      ]) {
        // Each goes on whatever the one before did, and none fails the save: whoever waits on it hears it landed.
        try {
          step();
        } catch (err) {
          tellFault({ ...seen(err), op: "note.write" });
        }
      }
    })().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    return landed;
  }

  /**
   * What was typed since a write of `text`, as changes to it: as it was followed, or, when that doesn't fit or an undo let go
   * of it, found again by comparing the text with the editor's. Not fitting is a fault of the page's own, and is told.
   */
  private fitted(text: string, typed: ChangeSet | null): ChangeSet {
    const now = this.doc()?.toString() ?? text;
    if (typed && typed.length === text.length && typed.newLength === now.length) return typed;
    if (typed) tellFault({ name: "SyncError", message: `What was typed since a write doesn't fit it: ${typed.length} to ${typed.newLength} characters, where the write has ${text.length} and the editor ${now.length}`, op: "note.write" });
    return changesBetween(text, now);
  }

  private write(text: string): NoteWrite {
    // What is typed is what is stored: a link is by id once it is picked from the list, and typing is never refused for a title.
    // `on` is the member's day as it was typed, which a recurring todo checked off in it is completed on.
    return { type: "note.write", id: this.noteId, text, baseRevision: this.revision, writeId: this.nextWriteId, on: today(), linkTitles: "keep" };
  }

  /** The server has all the typing, or none of it is to be sent. */
  private settled() {
    unsaved.delete(this);
    forget(this.key);
  }

  /**
   * Hands typing that no editor holds any longer, and that the server won't take, to the member. It
   * isn't sent again. While nobody can be told, it stays unsaved, and is kept as the page goes.
   */
  private giveUp(why: Lost["why"]) {
    this.held = true;
    if (!lose(this.workspaceId, { noteId: this.noteId, text: this.closedDoc!.toString(), why, dismiss: () => forget(this.key) })) return;
    // The card is the member's only copy until they dismiss it, so the browser keeps one through a reload.
    this.keepForNextLoad();
    unsaved.delete(this);
  }

  /** Back from the browser's cache: a later load may have sent this page's kept typing with the next write's id, which the page then mustn't reuse. */
  cameBack() {
    forget(this.key);
    this.nextWriteId = crypto.randomUUID();
  }

  /**
   * Keeps the typing in the browser for a later load to send, in case no write that is on its way
   * outlasts the page. The page's own write and a later load's carry the same ids, so the server
   * records each once.
   */
  keepForNextLoad() {
    const personId = members.get(this.workspaceId);
    const text = this.doc()?.toString();
    if (!personId || text === undefined || !this.dirty) return;
    const op = this.unacknowledged ?? this.write(text);
    keep({ key: this.key, workspaceId: this.workspaceId, personId, op, text, nextWriteId: this.nextWriteId, at: Date.now() });
  }

  private apply(changes: ChangeSet, stepped = false) {
    if (changes.empty) return;
    if (this.closedDoc) {
      this.closedDoc = changes.apply(this.closedDoc);
      return;
    }
    // Kept out of the editor's undo stack, so the member's undo never takes back someone else's change.
    // Not filtered, so it reaches the editor of a member who can't change the note themselves.
    // Each of the note's editors takes it; past the first it is a copy, so what follows the note's changes hears it once.
    // An editor the cursor has just left can notice it as it takes a change from elsewhere, and save: it saves the text with the change.
    const first = this.views[0];
    if (!first) return;
    const outer = this.copying;
    this.copying = changes.apply(first.state.doc);
    try {
      this.views.forEach((view, i) => view.dispatch({ changes, filter: false, annotations: [fromServer.of(true), Transaction.addToHistory.of(false), ...(i ? [mirrored.of(true)] : []), ...(stepped ? [historyStepped.of(true)] : [])] }));
    } finally {
      this.copying = outer;
    }
  }

  /** Stops sending while `held`, and sends what was typed meanwhile when it is let go. */
  hold(held: boolean) {
    if (this.held === held) return;
    this.held = held;
    if (!held) void this.commit();
  }

  /** Undoes or redoes in the editor alone. False when the step belongs to the note's history instead. */
  stepHere(type: Step["type"]): boolean {
    // In the editor the member is in, or was last in, whose undo has what was typed there.
    const view = this.views.find((v) => v.hasFocus) ?? (this.lastIn && this.views.includes(this.lastIn) ? this.lastIn : this.views.at(-1));
    if (!view) return false;
    if (type === "note.redo") return this.undidHere && redo(view);
    const unsent = view.state.doc.toString() !== (this.unacknowledged?.text ?? this.savedText);
    this.undidHere = (unsent || this.failing) && undo(view);
    if (this.undidHere && this.failing && view.state.doc.toString() === this.savedText) {
      // The write that failed held only what was just undone. Sent later it would be recorded and then
      // deleted, and the next undo would take the deletion back.
      clearTimeout(this.timer);
      this.unacknowledged = this.typedSinceWrite = null;
      this.failing = false;
      this.settled();
      this.onState("saved");
    }
    return this.undidHere;
  }

  /** Takes in a revision made elsewhere, such as an agent's edit or a revert, or the member's own undo or redo when `stepped`. Typing not yet saved stays, moved to fit. */
  async take(note: Note, stepped = false): Promise<void> {
    while (this.inFlight) await this.inFlight;
    // A write still waiting on the server merges with what's there when it lands.
    if (note.revision <= this.revision || this.unacknowledged) return;
    const doc = this.doc();
    const changes = doc && changesBetween(this.savedText, note.text).map(changesBetween(this.savedText, doc.toString()));
    // Taken first, so a save started as the editors take the change is a write on this revision.
    this.revision = note.revision;
    this.savedText = note.text;
    if (changes) this.apply(changes, stepped);
    if (this.dirty) this.schedule(PAUSE_MS);
  }

  /** Reads the note again when the server has a later revision than this editor does, or may have when none is named. */
  async pull(revision?: number): Promise<void> {
    while (this.inFlight) await this.inFlight;
    // A write still waiting on the server takes in what is there when it lands, and take() would drop the reading.
    if (this.unacknowledged) return;
    if (revision !== undefined && revision <= this.revision) return;
    await this.take(await perform(this.workspaceId, { type: "note.read", id: this.noteId }));
  }

  /** Stop following an editor, which can be destroyed right after, and commit what was typed. The note's other editors go on as they were. */
  async close(view: EditorView | null): Promise<void> {
    if (view) {
      this.views = this.views.filter((v) => v !== view);
      this.listeners.delete(view);
    }
    if (this.views.length) return void (await this.commit());
    if (open.get(this.noteId) === this) open.delete(this.noteId);
    this.closedDoc ??= view?.state.doc ?? null;
    // A write on its way decides whether there is anything left to send, and gives up on typing the server refused.
    while (this.inFlight) await this.inFlight;
    if (!unsaved.has(this)) return;
    // Held for Trash, it would wait for a restore that no editor is left to see.
    if (this.held && this.dirty) return this.giveUp("inTrash");
    await this.commit();
  }
}
