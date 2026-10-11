import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ago, useDismiss, useNow, type Author, type AuthorRef, type ChangedNote, type Diff, type HistoryEntry, type HistoryPage, type HistorySummary, type Note, type NoteSummary, type OpInput, type PluginHost } from "../../plugin-api.ts";
import { RevertAuthor } from "../lib/RevertAuthor.tsx";

/** What narrows history: to some notes, some authors, a span of time. */
type Filters = Omit<Extract<OpInput, { type: "history.summary" }>, "type" | "before" | "limit">;

const NOTES_A_PAGE = 30;
const CHANGES_A_PAGE = 30;
/** As many as one request answers with, so a list that grew is read again whole up to here. */
const MOST_A_PAGE = 100;

const refOf = (author: Author): AuthorRef => (author.kind === "agent" ? { kind: "agent", id: author.agentId } : { kind: "member", id: author.personId });
const authorKey = (author: Author) => `${author.kind}:${refOf(author).id}`;
const refOfKey = (key: string): AuthorRef => ({ kind: key.split(":")[0] as AuthorRef["kind"], id: key.split(":")[1]! });
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
function ChangeDiff({ host, noteId, revision }: { host: PluginHost; noteId: string; revision: number }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    host.perform({ type: "note.diff", id: noteId, revision }).then(
      (read) => live && setDiff(read),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [host, noteId, revision]);
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

interface NoteChangesProps {
  host: PluginHost;
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

/** One note's changes, newest first and each closed: opening one shows its diff. A change can be reverted, labeled, or the note reverted to it. */
function NoteChanges({ host, noteId, where, filters, version, canEdit, head, onChanged, onLoaded }: NoteChangesProps) {
  const now = useNow();
  const list = useRef<HTMLOListElement>(null);
  const [changes, setChanges] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<HistoryPage["next"]>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [labeling, setLabeling] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloads, reload] = useState(0);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const shown = useRef(0);
  shown.current = changes?.length ?? 0;
  const asked = JSON.stringify({ ...filters, noteIds: [noteId] });

  const read = useCallback(
    (page: { before?: NonNullable<HistoryPage["next"]>; limit: number }) => host.perform({ type: "history.list", ...(JSON.parse(asked) as Filters), diffs: false, ...page }),
    [host, asked],
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

  const act = async (op: Extract<OpInput, { type: "note.revert" | "note.revertChanges" }>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await host.perform(op));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const label = async (change: HistoryEntry, name: string) => {
    setLabeling(null);
    setError(null);
    try {
      await host.perform({ type: "note.label", id: noteId, revision: change.revision, name: name.trim() || null });
      reload((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!changes) return error ? <p role="alert" className="error">{error}</p> : null;
  return (
    <div className="note-changes">
      {error && <p role="alert" className="error">{error}</p>}
      <ol className="change-list" aria-label={`Changes${where}`} ref={list}>
        {changes.map((change) => {
          const { revision } = change;
          const did = whatItDid(change, show);
          const isOpen = open.has(revision);
          return (
            <li key={revision} className="change" data-revision={revision} aria-label={`Change ${revision}${where} by ${change.author.name}`}>
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
                  <button type="button" className="link change-revert" disabled={busy} aria-label={`Revert change ${revision}${where}`} onClick={() => act({ type: "note.revertChanges", id: noteId, revisions: [revision] })}>
                    Revert
                  </button>
                )}
              </div>
              {isOpen && (
                <div className="change-body">
                  <ChangeDiff host={host} noteId={noteId} revision={revision} />
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
                          <button type="button" className="link" disabled={busy} onClick={() => act({ type: "note.revert", id: noteId, revision })}>
                            Revert note to here
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
function useSummary(host: PluginHost, filters: Filters, version: number) {
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(0);
  shown.current = summary?.notes.length ?? 0;
  const asked = JSON.stringify(filters);

  useEffect(() => {
    let live = true;
    host.perform({ type: "history.summary", ...(JSON.parse(asked) as Filters), limit: Math.min(MOST_A_PAGE, Math.max(NOTES_A_PAGE, shown.current)) }).then(
      (read) => live && (setSummary(read), setError(null)),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [host, asked, version]);

  const more = async () => {
    if (!summary?.next) return;
    const page = await host.perform({ type: "history.summary", ...filters, before: summary.next, limit: NOTES_A_PAGE });
    setSummary({ notes: [...summary.notes, ...page.notes], next: page.next });
  };
  return { summary, error, more };
}

interface NoteHistoryProps {
  host: PluginHost;
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
export function NoteHistory({ host, noteId, revision, canEdit, onChanged, onSeen }: NoteHistoryProps) {
  const now = useNow();
  const filters = useMemo<Filters>(() => ({ noteIds: [noteId] }), [noteId]);
  const { summary, error } = useSummary(host, filters, revision);
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
        host={host}
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
  host: PluginHost;
  filters: Filters;
  version: number;
  canEdit: (noteId: string) => boolean;
  head: (noteId: string) => number | undefined;
  empty: string;
  onChanged: (note: Note) => void;
  onOpenNote: (noteId: string) => void;
}

/** The notes that changed, one closed row each: opening a note lists its changes. */
function ChangedNotes({ host, filters, version, canEdit, head, empty, onChanged, onOpenNote }: ChangedNotesProps) {
  const now = useNow();
  const ids = useId();
  const { summary, error, more } = useSummary(host, filters, version);
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
                    host={host}
                    noteId={note.noteId}
                    where={` to ${titleOf(note.noteTitle)}`}
                    filters={filters}
                    version={head(note.noteId) ?? note.changes}
                    canEdit={canEdit(note.noteId)}
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
  host: PluginHost;
  /** Every note in the workspace, for scoping history to some of them. */
  notes: readonly NoteSummary[];
  canEdit: boolean;
  /** An author, as `kind:id`, to show the changes of when the page opens. */
  showAuthor: string | null;
  /** A day to list changes from, when the page was opened for that. */
  showFrom?: string | null;
  onOpenNote: (noteId: string) => void;
  onChanged: (note: Note) => void;
  /** Called once an author's changes were reverted across notes, so the notes are read again. */
  onReverted: () => void;
}

/** The workspace's history: the notes that changed, filtered by author, date, and notes. */
export function HistoryMode({ host, notes, canEdit, showAuthor, showFrom, onOpenNote, onChanged, onReverted }: HistoryModeProps) {
  const [authors, setAuthors] = useState<Author[]>([]);
  const [byAuthors, setByAuthors] = useState<string[]>(showAuthor ? [showAuthor] : []);
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [from, setFrom] = useState(showFrom ?? "");
  const [to, setTo] = useState("");
  const heads = useMemo(() => new Map(notes.map((n) => [n.id, n.revision])), [notes]);
  const editable = useMemo(() => new Set(notes.filter((n) => n.access === "edit").map((n) => n.id)), [notes]);
  const version = useMemo(() => notes.reduce((sum, n) => sum + n.revision, 0), [notes]);

  useEffect(() => {
    let live = true;
    host.perform({ type: "history.authors" }).then((all) => live && setAuthors(all));
    return () => {
      live = false;
    };
  }, [host, version]);

  const chosen = authors.filter((a) => byAuthors.includes(authorKey(a)));
  const filters = useMemo<Filters>(
    () => ({
      ...(noteIds.length ? { noteIds } : {}),
      ...(byAuthors.length ? { authors: byAuthors.map(refOfKey) } : {}),
      ...(from ? { from: dayStart(from).getTime() } : {}),
      ...(to ? { to: dayStart(to).getTime() + DAY_MS } : {}),
    }),
    [noteIds, byAuthors, from, to],
  );
  const one = chosen.length === 1 ? chosen[0]! : null;
  const filtered = noteIds.length > 0 || byAuthors.length > 0 || from !== "" || to !== "";

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
      {canEdit && one?.kind === "agent" && !from && !to && (
        <div className="revert-author">
          <RevertAuthor
            key={authorKey(one)}
            host={host}
            author={refOf(one)}
            name={one.name}
            where={noteIds.length ? `in the ${count(noteIds.length, "note")} chosen` : "in this workspace"}
            noteIds={noteIds.length ? noteIds : undefined}
            onReverted={onReverted}
          />
        </div>
      )}
      <ChangedNotes
        host={host}
        filters={filters}
        version={version}
        canEdit={(noteId) => editable.has(noteId)}
        head={(noteId) => heads.get(noteId)}
        empty={filtered ? "No changes match these filters." : "Nothing has been written in this workspace yet."}
        onChanged={onChanged}
        onOpenNote={onOpenNote}
      />
    </section>
  );
}
