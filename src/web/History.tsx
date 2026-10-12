import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Author, AuthorRef, ChangedNote, Diff, HistoryEntry, HistoryPage, HistorySummary, Note, NoteSummary, OpInput, RevertPreview } from "../core/protocol.ts";
import { perform } from "./api.ts";
import { useDismiss } from "./dismiss.ts";
import { moveThroughHistory } from "./sync.ts";
import { ago, useNow } from "./time.ts";

/** What narrows history: to some notes, some authors, a span of time. */
type Filters = Omit<Extract<OpInput, { type: "history.summary" }>, "type" | "before" | "limit">;

const NOTES_A_PAGE = 30;
const CHANGES_A_PAGE = 30;
/** As many as one request answers with, so a list that grew is read again whole up to here. */
const MOST_A_PAGE = 100;

const refOf = (author: Author): AuthorRef => (author.kind === "agent" ? { kind: "agent", id: author.agentId } : { kind: "member", id: author.personId });
const authorKey = (author: Author) => `${author.kind}:${refOf(author).id}`;
const titleOf = (title: string) => title || "Untitled";
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const nameOf = (author: Author) => (author.kind === "agent" ? `${author.name} (agent)` : author.name);

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="change-stat">
      <span className="added">+{added}</span> <span className="removed">−{removed}</span>
    </span>
  );
}

const MARK = { add: "+", del: "−", same: "" } as const;

function DiffView({ diff }: { diff: Diff }) {
  if (!diff.hunks.length) return <p className="diff-none">No text changed.</p>;
  return (
    <div className="diff">
      {diff.hunks.map((hunk) => (
        <div key={hunk.oldStart} className="hunk">
          <div className="hunk-head">
            @@ −{hunk.oldStart} +{hunk.newStart} @@
          </div>
          {hunk.lines.map((line, i) => {
            const Line = line.kind === "add" ? "ins" : line.kind === "del" ? "del" : "div";
            return (
              <Line key={i} className="diff-line">
                <span className="diff-mark" aria-hidden="true">
                  {MARK[line.kind]}
                </span>
                <span className="diff-text">{line.text || " "}</span>
              </Line>
            );
          })}
        </div>
      ))}
      {diff.omitted > 0 && <p className="diff-none">{count(diff.omitted, "more line")}</p>}
    </div>
  );
}

/** One change's diff, read when the change is opened. */
function ChangeDiff({ workspaceId, noteId, revision }: { workspaceId: string; noteId: string; revision: number }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    perform(workspaceId, { type: "note.diff", id: noteId, revision }).then(
      (read) => live && setDiff(read),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, noteId, revision]);
  if (error) return <p role="alert" className="error">{error}</p>;
  return diff && <DiffView diff={diff} />;
}

/** The changes a sentence names, each one a way to it. More than a few are only counted. */
function Named({ revisions, onShow }: { revisions: number[]; onShow: (revision: number) => void }) {
  if (revisions.length > 3) return <>{revisions.length} changes</>;
  return (
    <>
      {revisions.length === 1 ? "change " : "changes "}
      {revisions.map((revision, i) => (
        <Fragment key={revision}>
          {i > 0 && (i === revisions.length - 1 ? " and " : ", ")}
          <button type="button" className="link change-ref" aria-label={`Change ${revision}`} onClick={() => onShow(revision)}>
            {revision}
          </button>
        </Fragment>
      ))}
    </>
  );
}

/** What a change did when it wasn't an edit, in the words a member reads. */
function whatItDid(change: HistoryEntry, onShow: (revision: number) => void): ReactNode {
  const { reverts } = change;
  if (!reverts) return null;
  if (reverts.to !== undefined) return `Reverts the note to revision ${reverts.to}`;
  const named = <Named revisions={reverts.revisions} onShow={onShow} />;
  if (reverts.how === "undo") return <>Undoes {named}</>;
  if (reverts.how === "redo") return <>Redoes what {named} undid</>;
  return <>Reverts {named}</>;
}

type RevertOp = Extract<OpInput, { type: "note.revert" | "note.revertChanges" }>;

type Previewed = { state: "reading" } | { state: "read"; preview: RevertPreview } | { state: "failed"; message: string };

interface RevertDialogProps {
  workspaceId: string;
  op: RevertOp;
  noteTitle: string;
  /** Changes when the note does, so the preview is read again. */
  version: number;
  onShow: (revision: number) => void;
  onReverted: (note: Note) => void;
  onClose: () => void;
}

/** What a revert would do, shown before it is made: the changes it reverts, the note's lines it changes, and the later changes that overlap. */
function RevertDialog({ workspaceId, op, noteTitle, version, onShow, onReverted, onClose }: RevertDialogProps) {
  const ids = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const inside = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [previewed, setPreviewed] = useState<Previewed>({ state: "reading" });
  const [busy, setBusy] = useState(false);
  const asked = JSON.stringify(op.type === "note.revert" ? { id: op.id, to: op.revision } : { id: op.id, revisions: op.revisions });

  useDismiss(onClose, inside);
  useEffect(() => {
    const focused = document.activeElement;
    const modal = dialog.current!;
    modal.showModal();
    cancel.current!.focus();
    return () => {
      // While it is still open as a modal the rest of the page can't take focus.
      modal.close();
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);
  useEffect(() => {
    let live = true;
    perform(workspaceId, { type: "note.previewRevert", ...(JSON.parse(asked) as { id: string; to: number } | { id: string; revisions: number[] }) }).then(
      (preview) => live && setPreviewed({ state: "read", preview }),
      (err: Error) => live && setPreviewed({ state: "failed", message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, asked, version]);

  const revert = async () => {
    setBusy(true);
    try {
      onReverted(await moveThroughHistory(workspaceId, op));
    } catch (err) {
      setPreviewed({ state: "failed", message: (err as Error).message });
      setBusy(false);
    }
  };

  const preview = previewed.state === "read" ? previewed.preview : null;
  const reverted = preview && [...preview.revisions].sort((a, b) => a - b);
  const changesNothing = preview !== null && !preview.diff.hunks.length;
  const show = (revision: number) => {
    onClose();
    onShow(revision);
  };
  return (
    <dialog ref={dialog} className="revert-dialog" aria-labelledby={`${ids}-title`} onCancel={(e) => e.preventDefault()}>
      <div ref={inside} className="revert-dialog-body">
        <h2 id={`${ids}-title`}>{op.type === "note.revert" ? `Revert note to revision ${op.revision}` : `Revert ${op.revisions.length === 1 ? `change ${op.revisions[0]}` : `${op.revisions.length} changes`}`}</h2>
        {previewed.state === "reading" && <p className="diff-none">Working out what this would change…</p>}
        {previewed.state === "failed" && <p role="alert" className="error">{previewed.message}</p>}
        {preview && reverted && (
          <>
            {reverted.length > 0 && (
              <p>
                Reverts <Named revisions={reverted} onShow={show} /> to {noteTitle} as one new change.
              </p>
            )}
            {changesNothing ? <p>Nothing in the note would change.</p> : <DiffView diff={preview.diff} />}
            {preview.overlaps.length > 0 && (
              <p className="revert-overlap">
                Later, <Named revisions={preview.overlaps} onShow={show} /> edited the same lines. {preview.overlaps.length === 1 ? "Its" : "Their"} edits stay, on lines this revert otherwise returns to how they were.
              </p>
            )}
          </>
        )}
        <div className="revert-dialog-actions">
          <button ref={cancel} type="button" className="button small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button small primary" disabled={busy || !preview || changesNothing} onClick={revert}>
            Revert
          </button>
        </div>
      </div>
    </dialog>
  );
}

interface NoteChangesProps {
  workspaceId: string;
  noteId: string;
  /** The note as a change names it, " to Plan", where notes are listed together. Empty where there is one note. */
  where: string;
  filters: Filters;
  /** Changes when the note does, so its changes are read again. */
  version: number;
  /** Whether the member may change the note, and so revert and label its changes. */
  canEdit: boolean;
  /** The note's latest revision, when known. */
  head: number | undefined;
  /** A note a revert changed. The caller answers with a new `version`. */
  onChanged: (note: Note) => void;
  onLoaded?: (changes: HistoryEntry[]) => void;
}

/** One note's changes, newest first and each closed: opening one shows its diff. A change can be reverted, alone or with others ticked, labeled, or the note reverted to it. Every revert is shown in a dialog first. */
function NoteChanges({ workspaceId, noteId, where, filters, version, canEdit, head, onChanged, onLoaded }: NoteChangesProps) {
  const now = useNow();
  const list = useRef<HTMLOListElement>(null);
  const [changes, setChanges] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<HistoryPage["next"]>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [labeling, setLabeling] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [reverting, setReverting] = useState<RevertOp | null>(null);
  const [reloads, reload] = useState(0);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const shown = useRef(0);
  shown.current = changes?.length ?? 0;
  const asked = JSON.stringify({ ...filters, noteIds: [noteId] });

  const read = useCallback(
    (page: { before?: NonNullable<HistoryPage["next"]>; limit: number }) => perform(workspaceId, { type: "history.list", ...(JSON.parse(asked) as Filters), diffs: false, ...page }),
    [workspaceId, asked],
  );

  useEffect(() => {
    let live = true;
    read({ limit: Math.min(MOST_A_PAGE, Math.max(CHANGES_A_PAGE, shown.current)) }).then(
      (page) => {
        if (!live) return;
        setChanges(page.changes);
        setNext(page.next);
        loaded.current?.(page.changes);
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [read, version, reloads]);

  const toggle = (revision: number) => {
    const opened = new Set(open);
    if (!opened.delete(revision)) opened.add(revision);
    setOpen(opened);
  };

  /** Brings a change into view, reading older changes until it is among them. */
  const show = async (revision: number) => {
    let [all, before] = [changes ?? [], next];
    while (before && all.at(-1)!.revision > revision) {
      const page = await read({ before, limit: MOST_A_PAGE });
      [all, before] = [[...all, ...page.changes], page.next];
    }
    setChanges(all);
    setNext(before);
    requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>(`[data-revision="${revision}"] .change-toggle`);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus();
    });
  };

  const pick = (revision: number) => {
    const ticked = new Set(picked);
    if (!ticked.delete(revision)) ticked.add(revision);
    setPicked(ticked);
  };
  const stopReverting = useCallback(() => setReverting(null), []);

  const label = async (change: HistoryEntry, name: string) => {
    setLabeling(null);
    setError(null);
    try {
      await perform(workspaceId, { type: "note.label", id: noteId, revision: change.revision, name: name.trim() || null });
      reload((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!changes) return error ? <p role="alert" className="error">{error}</p> : null;
  // Only ticks on changes that are listed and still stand count, so one reverted or filtered out since is not sent.
  const ticked = changes.filter((c) => picked.has(c.revision) && c.revertedBy === null).map((c) => c.revision);
  return (
    <div className="note-changes">
      {error && <p role="alert" className="error">{error}</p>}
      {canEdit && changes.some((c) => c.revertedBy === null) && (
        <div className="change-list-head">
          <button type="button" className="button small" disabled={!ticked.length} onClick={() => setReverting({ type: "note.revertChanges", id: noteId, revisions: ticked })}>
            Revert {ticked.length ? `${count(ticked.length, "change")}…` : "changes…"}
          </button>
        </div>
      )}
      <ol className={canEdit ? "change-list pickable" : "change-list"} aria-label={`Changes${where}`} ref={list}>
        {changes.map((change) => {
          const { revision } = change;
          const did = whatItDid(change, show);
          const isOpen = open.has(revision);
          return (
            <li key={revision} className="change" data-revision={revision} aria-label={`Change ${revision}${where} by ${change.author.name}`}>
              {canEdit && change.revertedBy === null && <input type="checkbox" className="change-pick" aria-label={`Select change ${revision}${where}`} checked={picked.has(revision)} onChange={() => pick(revision)} />}
              <button type="button" className="change-toggle" aria-expanded={isOpen} onClick={() => toggle(revision)}>
                <span className="caret" aria-hidden="true" />
                <span className="change-author">{change.author.name}</span>
                {change.author.kind === "agent" && <span className="badge">agent</span>}
                <time dateTime={new Date(change.createdAt).toISOString()} title={new Date(change.createdAt).toLocaleString()}>
                  {ago(change.createdAt, now)}
                </time>
                <Stat added={change.added} removed={change.removed} />
              </button>
              <div className="change-meta">
                <span>Change {revision}</span>
                {change.label && <span className="label-chip">{change.label}</span>}
                {did && <span className="change-note">{did}</span>}
                {change.revertedBy !== null && (
                  <span className="change-note">
                    Reverted by <Named revisions={[change.revertedBy]} onShow={show} />
                  </span>
                )}
                {canEdit && change.revertedBy === null && (
                  <button type="button" className="link change-revert" aria-label={`Revert change ${revision}${where}…`} onClick={() => setReverting({ type: "note.revertChanges", id: noteId, revisions: [revision] })}>
                    Revert…
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="change-body">
                  <ChangeDiff workspaceId={workspaceId} noteId={noteId} revision={revision} />
                  {canEdit &&
                    (labeling === revision ? (
                      <form
                        className="change-actions"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void label(change, new FormData(e.currentTarget).get("name") as string);
                        }}
                      >
                        <input
                          name="name"
                          autoFocus
                          maxLength={60}
                          aria-label={`Label for revision ${revision}`}
                          placeholder="Name this revision"
                          defaultValue={change.label ?? ""}
                          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setLabeling(null))}
                        />
                        <button type="submit" className="button small">
                          Save
                        </button>
                      </form>
                    ) : (
                      <div className="change-actions">
                        <button type="button" className="link" onClick={() => setLabeling(revision)}>
                          {change.label ? "Rename label" : "Label"}
                        </button>
                        {head !== revision && (
                          <button type="button" className="link" onClick={() => setReverting({ type: "note.revert", id: noteId, revision })}>
                            Revert note to here…
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {next && (
        <button
          type="button"
          className="button small"
          onClick={async () => {
            const page = await read({ before: next, limit: CHANGES_A_PAGE });
            setChanges([...changes, ...page.changes]);
            setNext(page.next);
          }}
        >
          Show older changes
        </button>
      )}
      {reverting && (
        <RevertDialog
          workspaceId={workspaceId}
          op={reverting}
          noteTitle={titleOf(changes[0]?.noteTitle ?? "")}
          version={version}
          onShow={show}
          onClose={stopReverting}
          onReverted={(note) => {
            setReverting(null);
            setPicked(new Set());
            onChanged(note);
          }}
        />
      )}
    </div>
  );
}

/** Who changed a note and over what time, as one line. */
function Span({ note, now }: { note: ChangedNote; now: number }) {
  const [first, last] = [ago(note.firstAt, now), ago(note.lastAt, now)];
  return (
    <span className="changed-note-meta">
      {count(note.changes, "change")} · {note.authors.map(nameOf).join(", ")} · {first === last ? last : `${first} to ${last}`}
    </span>
  );
}

/** The notes that changed, read a page at a time and again whenever `version` does. */
function useSummary(workspaceId: string, filters: Filters, version: number) {
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(0);
  shown.current = summary?.notes.length ?? 0;
  const asked = JSON.stringify(filters);

  useEffect(() => {
    let live = true;
    perform(workspaceId, { type: "history.summary", ...(JSON.parse(asked) as Filters), limit: Math.min(MOST_A_PAGE, Math.max(NOTES_A_PAGE, shown.current)) }).then(
      (read) => live && (setSummary(read), setError(null)),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, asked, version]);

  const more = async () => {
    if (!summary?.next) return;
    const page = await perform(workspaceId, { type: "history.summary", ...filters, before: summary.next, limit: NOTES_A_PAGE });
    setSummary({ notes: [...summary.notes, ...page.notes], next: page.next });
  };
  return { summary, error, more };
}

interface NoteHistoryProps {
  workspaceId: string;
  noteId: string;
  /** The note's latest revision, so the list follows the note as it changes. */
  revision: number;
  canEdit: boolean;
  onChanged: (note: Note) => void;
  /** Called with the latest revision each time the member is shown the note's changes. */
  onSeen: (noteId: string, revision: number) => void;
}

const NO_FILTERS: Filters = {};

/** The open note's history, for the inspector: what its changes come to, then each change, closed. */
export function NoteHistory({ workspaceId, noteId, revision, canEdit, onChanged, onSeen }: NoteHistoryProps) {
  const now = useNow();
  const filters = useMemo<Filters>(() => ({ noteIds: [noteId] }), [noteId]);
  const { summary, error } = useSummary(workspaceId, filters, revision);
  const note = summary?.notes.find((n) => n.noteId === noteId);
  return (
    <div className="changes">
      {error && <p role="alert" className="error">{error}</p>}
      {summary && !note && <p className="empty">Nothing has been written in this note yet.</p>}
      {note && (
        <p className="changed-note-total" aria-label="All changes to this note">
          <Stat added={note.added} removed={note.removed} />
          <Span note={note} now={now} />
        </p>
      )}
      <NoteChanges
        key={noteId}
        workspaceId={workspaceId}
        noteId={noteId}
        where=""
        filters={NO_FILTERS}
        version={revision}
        canEdit={canEdit}
        head={revision}
        onChanged={onChanged}
        onLoaded={(changes) => onSeen(noteId, changes[0]?.revision ?? 0)}
      />
    </div>
  );
}

interface ChangedNotesProps {
  workspaceId: string;
  filters: Filters;
  version: number;
  canEdit: boolean;
  head: (noteId: string) => number | undefined;
  empty: string;
  onChanged: (note: Note) => void;
  onOpenNote: (noteId: string) => void;
}

/** The notes that changed, one closed row each: opening a note lists its changes. */
function ChangedNotes({ workspaceId, filters, version, canEdit, head, empty, onChanged, onOpenNote }: ChangedNotesProps) {
  const now = useNow();
  const ids = useId();
  const { summary, error, more } = useSummary(workspaceId, filters, version);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  if (!summary) return error ? <p role="alert" className="error">{error}</p> : null;
  return (
    <div className="changes">
      {error && <p role="alert" className="error">{error}</p>}
      {!summary.notes.length && <p className="empty">{empty}</p>}
      <ul className="changed-notes" aria-label="Notes that changed">
        {summary.notes.map((note) => {
          const isOpen = open.has(note.noteId);
          const panel = `${ids}-${note.noteId}`;
          return (
            <li key={note.noteId} className="changed-note" aria-label={titleOf(note.noteTitle)}>
              <button
                type="button"
                className="changed-note-toggle"
                aria-expanded={isOpen}
                aria-controls={panel}
                onClick={() => {
                  const opened = new Set(open);
                  if (!opened.delete(note.noteId)) opened.add(note.noteId);
                  setOpen(opened);
                }}
              >
                <span className="caret" aria-hidden="true" />
                <Stat added={note.added} removed={note.removed} />
                <span className="changed-note-title">{titleOf(note.noteTitle)}</span>
              </button>
              <div className="changed-note-about">
                <Span note={note} now={now} />
                <button type="button" className="link" onClick={() => onOpenNote(note.noteId)}>
                  Open note
                </button>
              </div>
              <div id={panel} hidden={!isOpen}>
                {isOpen && (
                  <NoteChanges
                    workspaceId={workspaceId}
                    noteId={note.noteId}
                    where={` to ${titleOf(note.noteTitle)}`}
                    filters={filters}
                    version={head(note.noteId) ?? note.changes}
                    canEdit={canEdit}
                    head={head(note.noteId)}
                    onChanged={onChanged}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {summary.next && (
        <button type="button" className="button small" onClick={more}>
          Show more notes
        </button>
      )}
    </div>
  );
}

const DAY_MS = 86_400_000;
const dayStart = (key: string) => new Date(`${key}T00:00:00`);

interface NoteScopeProps {
  notes: readonly NoteSummary[];
  picked: string[];
  onPick: (noteIds: string[]) => void;
}

/** Which notes the history covers: all of them, or the ones ticked. */
function NoteScope({ notes, picked, onPick }: NoteScopeProps) {
  const ids = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open ? close : null, ref);
  const needle = filter.trim().toLowerCase();
  return (
    <div className="note-scope" ref={ref}>
      <button type="button" className="chip" aria-expanded={open} aria-controls={`${ids}-notes`} aria-pressed={picked.length > 0} onClick={() => setOpen(!open)}>
        {picked.length ? count(picked.length, "note") : "All notes"}
      </button>
      {open && (
        <div id={`${ids}-notes`} className="menu note-scope-menu" role="group" aria-label="Notes to show">
          <input type="search" className="filter" aria-label="Find a note" placeholder="Find a note" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
          <ul>
            {notes
              .filter((n) => !needle || titleOf(n.title).toLowerCase().includes(needle))
              .map((n) => (
                <li key={n.id}>
                  <label>
                    <input type="checkbox" checked={picked.includes(n.id)} onChange={(e) => onPick(e.target.checked ? [...picked, n.id] : picked.filter((id) => id !== n.id))} />
                    <span>{titleOf(n.title)}</span>
                  </label>
                </li>
              ))}
          </ul>
          <button type="button" className="link" disabled={!picked.length} onClick={() => onPick([])}>
            Show all notes
          </button>
        </div>
      )}
    </div>
  );
}

interface HistoryModeProps {
  workspaceId: string;
  /** Every note in the workspace, for scoping history to some of them. */
  notes: readonly NoteSummary[];
  canEdit: boolean;
  onOpenNote: (noteId: string) => void;
  onChanged: (note: Note) => void;
}

interface FolderHistoryProps {
  workspaceId: string;
  /** The folder's notes. */
  notes: readonly NoteSummary[];
  /** Whether they are every note of the workspace, as All notes lists. */
  whole: boolean;
  canEdit: boolean;
  onOpenNote: (noteId: string) => void;
  onChanged: (note: Note) => void;
}

/** As many notes as history can be narrowed to at once. A folder with more shows the ones changed last. */
const MOST_NOTES = 200;

/** A folder's history: the notes that changed as History mode lists them, and only the folder's. */
export function FolderHistory({ workspaceId, notes, whole, canEdit, onOpenNote, onChanged }: FolderHistoryProps) {
  const heads = useMemo(() => new Map(notes.map((n) => [n.id, n.revision])), [notes]);
  const version = useMemo(() => notes.reduce((sum, n) => sum + n.revision, 0), [notes]);
  const ids = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MOST_NOTES).map((n) => n.id).join(","), [notes]);
  const filters = useMemo<Filters>(() => (whole ? {} : { noteIds: ids.split(",") }), [whole, ids]);
  const empty = whole ? "Nothing has been written in this workspace yet." : "Nothing has been written in this folder yet.";
  if (!whole && !notes.length) return <p className="empty">{empty}</p>;
  return <ChangedNotes workspaceId={workspaceId} filters={filters} version={version} canEdit={canEdit} head={(noteId) => heads.get(noteId)} empty={empty} onChanged={onChanged} onOpenNote={onOpenNote} />;
}

/** The workspace's history: the notes that changed, filtered by author, date, and notes. */
export function HistoryMode({ workspaceId, notes, canEdit, onOpenNote, onChanged }: HistoryModeProps) {
  const [authors, setAuthors] = useState<Author[]>([]);
  const [byAuthors, setByAuthors] = useState<string[]>([]);
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const heads = useMemo(() => new Map(notes.map((n) => [n.id, n.revision])), [notes]);
  const version = useMemo(() => notes.reduce((sum, n) => sum + n.revision, 0), [notes]);

  useEffect(() => {
    let live = true;
    perform(workspaceId, { type: "history.authors" }).then((all) => live && setAuthors(all));
    return () => {
      live = false;
    };
  }, [workspaceId, version]);

  const chosen = authors.filter((a) => byAuthors.includes(authorKey(a)));
  const filters = useMemo<Filters>(
    () => ({
      ...(noteIds.length ? { noteIds } : {}),
      ...(chosen.length ? { authors: chosen.map(refOf) } : {}),
      ...(from ? { from: dayStart(from).getTime() } : {}),
      ...(to ? { to: dayStart(to).getTime() + DAY_MS } : {}),
    }),
    [noteIds, byAuthors, authors, from, to],
  );
  const one = chosen.length === 1 ? chosen[0]! : null;
  const filtered = noteIds.length > 0 || chosen.length > 0 || from !== "" || to !== "";

  return (
    <section className="history-mode" aria-label="History">
      <h1>History</h1>
      <div className="history-filters" role="group" aria-label="Filters">
        <div className="chips" role="group" aria-label="Authors">
          {authors.map((a) => {
            const key = authorKey(a);
            return (
              <button key={key} type="button" className="chip" aria-pressed={byAuthors.includes(key)} onClick={() => setByAuthors(byAuthors.includes(key) ? byAuthors.filter((k) => k !== key) : [...byAuthors, key])}>
                {a.name}
                {a.kind === "agent" && " (agent)"}
              </button>
            );
          })}
        </div>
        <NoteScope notes={notes} picked={noteIds} onPick={setNoteIds} />
        <label>
          From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {filtered && (
          <button
            type="button"
            className="link"
            onClick={() => {
              setByAuthors([]);
              setNoteIds([]);
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <ChangedNotes
        workspaceId={workspaceId}
        filters={filters}
        version={version}
        canEdit={canEdit}
        head={(noteId) => heads.get(noteId)}
        empty={filtered ? "No changes match these filters." : "Nothing has been written in this workspace yet."}
        onChanged={onChanged}
        onOpenNote={onOpenNote}
      />
    </section>
  );
}
