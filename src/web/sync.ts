import { Annotation, ChangeSet, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { Note } from "../core/protocol.ts";
import { changesBetween } from "../core/text.ts";
import { perform } from "./api.ts";

export const PAUSE_MS = 1000;
const RETRY_MS = 3000;

export type SaveState = "saved" | "unsaved" | "saving" | "failed";

const fromServer = Annotation.define<boolean>();

/**
 * Commits a note's typing as one change on a pause or when the editor loses focus. A save based on an
 * old revision comes back merged; the merge is applied over whatever was typed while it was in flight.
 */
export class NoteSync {
  private readonly noteId: string;
  private revision: number;
  private savedText: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private typedSinceSend: ChangeSet | null = null;
  private view: EditorView | null = null;
  private closed = false;

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

  get dirty(): boolean {
    return this.view !== null && this.view.state.doc.toString() !== this.savedText;
  }

  private onUpdate(update: ViewUpdate) {
    if (!update.docChanged || update.transactions.some((tr) => tr.annotation(fromServer))) return;
    if (this.typedSinceSend) this.typedSinceSend = this.typedSinceSend.compose(update.changes);
    this.onState("unsaved");
    this.schedule(PAUSE_MS);
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    if (!this.closed) this.timer = setTimeout(() => void this.commit(), ms);
  }

  /** Send what's typed now, after any save already on its way. */
  async commit(): Promise<void> {
    clearTimeout(this.timer);
    while (this.inFlight) await this.inFlight;
    const view = this.view;
    if (!view || !this.dirty) return;
    const sent = view.state.doc.toString();
    this.typedSinceSend = ChangeSet.empty(sent.length);
    this.onState("saving");
    this.inFlight = (async () => {
      try {
        const saved = await perform(this.workspaceId, { type: "note.write", id: this.noteId, baseRevision: this.revision, text: sent });
        const merged = changesBetween(sent, saved.text);
        if (!merged.empty && !this.closed) {
          view.dispatch({ changes: merged.map(this.typedSinceSend!), annotations: [fromServer.of(true), Transaction.addToHistory.of(false)] });
        }
        this.revision = saved.revision;
        this.savedText = saved.text;
        this.onSaved(saved);
        if (this.dirty) this.schedule(PAUSE_MS);
        this.onState(this.dirty ? "unsaved" : "saved");
      } catch {
        this.onState("failed");
        this.schedule(RETRY_MS);
      } finally {
        this.typedSinceSend = null;
        this.inFlight = null;
      }
    })();
    await this.inFlight;
  }

  /** Commit what's typed and stop. A destroyed view keeps its last state, so it can be destroyed right after. */
  close(): Promise<void> {
    const done = this.commit();
    this.closed = true;
    clearTimeout(this.timer);
    return done;
  }
}
