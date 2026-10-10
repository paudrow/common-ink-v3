import { Annotation, ChangeSet, Transaction, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Note } from "../core/protocol.ts";
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
  private readonly noteId: string;
  private revision: number;
  private savedText: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private unacknowledged: Write | null = null;
  private typedSinceWrite: ChangeSet | null = null;
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
  }

  private doc(): Text | null {
    return this.closedDoc ?? this.view?.state.doc ?? null;
  }

  get dirty(): boolean {
    return this.unacknowledged !== null || (this.doc()?.toString() ?? this.savedText) !== this.savedText;
  }

  private onUpdate(update: ViewUpdate) {
    if (!update.docChanged || update.transactions.some((tr) => tr.annotation(fromServer))) return;
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
        const merged = changesBetween(write.text, saved.text).map(this.typedSinceWrite!);
        if (!merged.empty) {
          if (this.closedDoc) this.closedDoc = merged.apply(this.closedDoc);
          else this.view?.dispatch({ changes: merged, annotations: [fromServer.of(true), Transaction.addToHistory.of(false)] });
        }
        this.unacknowledged = null;
        this.typedSinceWrite = null;
        this.revision = saved.revision;
        this.savedText = saved.text;
        this.onSaved(saved);
        if (this.dirty) this.schedule(PAUSE_MS);
        else unsaved.delete(this);
        this.onState(this.dirty ? "unsaved" : "saved");
      } catch (err) {
        if (worthRetrying(err)) {
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

  /** Stop following the view, which can be destroyed right after, and commit what was typed. */
  close(): Promise<void> {
    this.closedDoc = this.view?.state.doc ?? null;
    return this.commit();
  }
}
