import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ago, useDismiss, useNow, type Author, type AuthorRef, type Diff, type HistoryEntry, type HistoryPage, type Note, type NoteSummary, type OpInput, type PluginHost } from "../../plugin-api.ts";
import { RevertAuthor } from "../lib/RevertAuthor.tsx";

type Query = Omit<Extract<OpInput, { type: "history.list" }>, "type" | "before">;

const refOf = (author: Author): AuthorRef => (author.kind === "agent" ? { kind: "agent", id: author.agentId } : { kind: "member", id: author.personId });
const authorKey = (author: Author) => `${author.kind}:${refOf(author).id}`;
const refOfKey = (key: string): AuthorRef => ({ kind: key.split(":")[0] as AuthorRef["kind"], id: key.split(":")[1]! });
const changeKey = (change: HistoryEntry) => `${change.noteId}/${change.revision}`;
const titleOf = (title: string) => title || "Untitled";
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const listed = (revisions: number[]) => (revisions.length === 1 ? `change ${revisions[0]}` : `changes ${revisions.slice(0, -1).join(", ")} and ${revisions.at(-1)}`);

/** What a change did when it wasn't an edit. */
function taken(change: HistoryEntry): string | null {
  const { reverts } = change;
  if (!reverts) return null;
  if (reverts.to !== undefined) return `Reverted to revision ${reverts.to}`;
  if (reverts.how === "redo") return `Redid what ${listed(reverts.revisions)} undid`;
  return `${reverts.how === "undo" ? "Undid" : "Reverted"} ${listed(reverts.revisions)}`;
}

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
            const Line = line.kind === "add" ? "ins" : line.kind === "del" ? "del" : "span";
            return (
              <Line key={i} className="diff-line">
                {line.text || " "}
              </Line>
            );
          })}
        </div>
      ))}
      {diff.omitted > 0 && <p className="diff-none">{count(diff.omitted, "more line")}</p>}
    </div>
  );
}

interface ChangesProps {
  host: PluginHost;
  query: Query;
  /** Changes when the notes do, so the list is read again. */
  version: number;
  /** Whether each change names its note, as it must when the list spans notes. */
  showNote: boolean;
  /** Whether the member may change a note, and so revert, put back, and label its changes. */
  canEdit: (noteId: string) => boolean;
  /** A note's latest revision, when known. */
  head: (noteId: string) => number | undefined;
  empty: string;
  /** A note this list reverted or put changes back into. The caller answers with a new `version`. */
  onChanged: (note: Note) => void;
  onOpenNote?: (noteId: string) => void;
  onLoaded?: (changes: HistoryEntry[]) => void;
}

/** A list of changes with their diffs, where a revision can be labeled or reverted to and a selection applied. */
function Changes({ host, query, version, showNote, canEdit, head, empty, onChanged, onOpenNote, onLoaded }: ChangesProps) {
  const now = useNow();
  const [changes, setChanges] = useState<HistoryEntry[] | null>(null);
  const [next, setNext] = useState<HistoryPage["next"]>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [labeling, setLabeling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloads, reload] = useState(0);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const asked = JSON.stringify(query);

  useEffect(() => {
    let live = true;
    host.perform({ type: "history.list", ...(JSON.parse(asked) as Query) }).then(
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
  }, [host, asked, version, reloads]);

  useEffect(() => setSelected(new Set()), [asked]);

  const more = async () => {
    if (!next) return;
    const page = await host.perform({ type: "history.list", ...query, before: next });
    setChanges((shown) => [...(shown ?? []), ...page.changes]);
    setNext(page.next);
  };

  /** Runs history operations one note at a time, and says which notes they couldn't change. */
  const act = async (ops: Extract<OpInput, { type: "note.revert" | "note.revertChanges" | "note.reapplyChanges" }>[]) => {
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    for (const op of ops) {
      try {
        onChanged(await host.perform(op));
      } catch (err) {
        failed.push((err as Error).message);
      }
    }
    setBusy(false);
    setSelected(new Set());
    setError(failed.join(" ") || null);
  };

  const label = async (change: HistoryEntry, name: string) => {
    setLabeling(null);
    setError(null);
    try {
      await host.perform({ type: "note.label", id: change.noteId, revision: change.revision, name: name.trim() || null });
      reload((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const picked = (changes ?? []).filter((c) => selected.has(changeKey(c)));
  const standing = picked.filter((c) => c.revertedBy === null);
  /** The picked changes as one operation per note. */
  const perNote = (type: "note.revertChanges" | "note.reapplyChanges") =>
    [...Map.groupBy(picked, (c) => c.noteId)].map(([id, mine]) => ({ type, id, revisions: mine.map((c) => c.revision) }));

  if (!changes) return error ? <p role="alert" className="error">{error}</p> : null;
  return (
    <div className="changes">
      {error && <p role="alert" className="error">{error}</p>}
      {picked.length > 0 && (
        <div className="selection" role="group" aria-label="Selected changes">
          <span>{count(picked.length, "change")} selected</span>
          <button type="button" className="button small" disabled={busy || standing.length !== picked.length} onClick={() => act(perNote("note.revertChanges"))}>
            Revert selected
          </button>
          <button type="button" className="button small" disabled={busy || standing.length !== 0} onClick={() => act(perNote("note.reapplyChanges"))}>
            Put back selected
          </button>
          <button type="button" className="link" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          {standing.length > 0 && standing.length < picked.length && <span className="selection-hint">Pick changes that still stand, or ones taken back out, not both.</span>}
        </div>
      )}
      {!changes.length && <p className="empty">{empty}</p>}
      <ol className="change-list" aria-label="Changes">
        {changes.map((change) => {
          const key = changeKey(change);
          const what = taken(change);
          const where = showNote ? ` to ${titleOf(change.noteTitle)}` : "";
          return (
            <li key={key} className="change" data-reverted={change.revertedBy !== null || undefined} aria-label={`Change ${change.revision}${where} by ${change.author.name}`}>
              <div className="change-head">
                {canEdit(change.noteId) && (
                  <input
                    type="checkbox"
                    aria-label={`Select change ${change.revision}${where}`}
                    checked={selected.has(key)}
                    onChange={(e) => {
                      const nextPicked = new Set(selected);
                      if (e.target.checked) nextPicked.add(key);
                      else nextPicked.delete(key);
                      setSelected(nextPicked);
                    }}
                  />
                )}
                <span className="change-author">{change.author.name}</span>
                {change.author.kind === "agent" && <span className="badge">agent</span>}
                <time dateTime={new Date(change.createdAt).toISOString()} title={new Date(change.createdAt).toLocaleString()}>
                  {ago(change.createdAt, now)}
                </time>
                {change.diff && (
                  <span className="change-stat">
                    <span className="added">+{change.diff.added}</span> <span className="removed">−{change.diff.removed}</span>
                  </span>
                )}
              </div>
              <div className="change-meta">
                {showNote && (
                  <button type="button" className="link" onClick={() => onOpenNote?.(change.noteId)}>
                    {titleOf(change.noteTitle)}
                  </button>
                )}
                <span>revision {change.revision}</span>
                {change.label && <span className="label-chip">{change.label}</span>}
              </div>
              {what && <p className="change-note">{what}</p>}
              {change.revertedBy !== null && <p className="change-note">Taken back out by change {change.revertedBy}</p>}
              {change.diff && <DiffView diff={change.diff} />}
              {canEdit(change.noteId) &&
                (labeling === key ? (
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
                      aria-label={`Label for revision ${change.revision}`}
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
                    <button type="button" className="link" onClick={() => setLabeling(key)}>
                      {change.label ? "Rename label" : "Label"}
                    </button>
                    {head(change.noteId) !== change.revision && (
                      <button type="button" className="link" disabled={busy} onClick={() => act([{ type: "note.revert", id: change.noteId, revision: change.revision }])}>
                        Revert note to here
                      </button>
                    )}
                  </div>
                ))}
            </li>
          );
        })}
      </ol>
      {next && (
        <button type="button" className="button small" onClick={more}>
          Show older changes
        </button>
      )}
    </div>
  );
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

/** The open note's changes, for the inspector. */
export function NoteHistory({ host, noteId, revision, canEdit, onChanged, onSeen }: NoteHistoryProps) {
  const query = useMemo(() => ({ noteIds: [noteId] }), [noteId]);
  return (
    <Changes
      host={host}
      query={query}
      version={revision}
      showNote={false}
      canEdit={() => canEdit}
      head={() => revision}
      empty="Nothing has been written in this note yet."
      onChanged={onChanged}
      onLoaded={(changes) => onSeen(noteId, changes[0]?.revision ?? 0)}
    />
  );
}

const WEEKS = 53;
const DAY_MS = 86_400_000;
const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayStart = (key: string) => new Date(`${key}T00:00:00`);
const longDate = (key: string) => dayStart(key).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const level = (n: number) => (n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4);

interface ActivityProps {
  host: PluginHost;
  author: AuthorRef;
  /** Who the author is, as a sentence names them: "you", or a name. */
  who: string;
  version: number;
  pickedDay: string | null;
  onPickDay: (day: string | null) => void;
}

/** How many changes one author made on each day of the last year, in this browser's time zone. */
function Activity({ host, author, who, version, pickedDay, onPickDay }: ActivityProps) {
  const [counts, setCounts] = useState<ReadonlyMap<string, number> | null>(null);
  const today = dateKey(new Date());
  const weeks = useMemo(() => {
    const end = dayStart(today);
    const first = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay() - (WEEKS - 1) * 7);
    const days: string[] = [];
    for (const d = first; d <= end; d.setDate(d.getDate() + 1)) days.push(dateKey(d));
    return Array.from({ length: WEEKS }, (_, w) => days.slice(w * 7, w * 7 + 7));
  }, [today]);
  const from = dayStart(weeks[0]![0]!).getTime();

  useEffect(() => {
    let live = true;
    host.perform({ type: "history.activity", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, author, from }).then(
      (activity) => live && setCounts(new Map(activity.days.map((d) => [d.date, d.count]))),
    );
    return () => {
      live = false;
    };
  }, [host, author.kind, author.id, from, version]);

  const total = [...(counts?.values() ?? [])].reduce((sum, n) => sum + n, 0);
  return (
    <section className="activity" aria-label="Activity">
      <p className="activity-total">{counts ? `${count(total, "change")} by ${who} in the last year` : " "}</p>
      <div className="activity-grid">
        {weeks.map((week) => (
          <div key={week[0]} className="activity-week">
            {week.map((day) => {
              const n = counts?.get(day) ?? 0;
              return (
                <button
                  key={day}
                  type="button"
                  className="activity-day"
                  data-level={level(n)}
                  tabIndex={day === (pickedDay ?? today) ? 0 : -1}
                  aria-label={`${count(n, "change")} on ${longDate(day)}`}
                  title={`${count(n, "change")} on ${longDate(day)}`}
                  aria-pressed={day === pickedDay}
                  onClick={() => onPickDay(day === pickedDay ? null : day)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

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
  personId: string;
  /** Every note in the workspace, for scoping history to some of them. */
  notes: readonly NoteSummary[];
  canEdit: boolean;
  /** An author, as `kind:id`, to show the changes of when the page opens. */
  showAuthor: string | null;
  onOpenNote: (noteId: string) => void;
  onChanged: (note: Note) => void;
  /** Called once an author's changes were reverted across notes, so the notes are read again. */
  onReverted: () => void;
}

/** The workspace's history: every change, filtered by author, date, and notes, with the member's activity above it. */
export function HistoryMode({ host, personId, notes, canEdit, showAuthor, onOpenNote, onChanged, onReverted }: HistoryModeProps) {
  const [authors, setAuthors] = useState<Author[]>([]);
  const [byAuthors, setByAuthors] = useState<string[]>(showAuthor ? [showAuthor] : []);
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [from, setFrom] = useState("");
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
  const query = useMemo<Query>(
    () => ({
      ...(noteIds.length ? { noteIds } : {}),
      ...(byAuthors.length ? { authors: byAuthors.map(refOfKey) } : {}),
      ...(from ? { from: dayStart(from).getTime() } : {}),
      ...(to ? { to: dayStart(to).getTime() + DAY_MS } : {}),
    }),
    [noteIds, byAuthors, from, to],
  );
  const me: AuthorRef = { kind: "member", id: personId };
  const one = chosen.length === 1 ? chosen[0]! : null;
  const pickedDay = from && from === to ? from : null;
  const filtered = noteIds.length > 0 || byAuthors.length > 0 || from !== "" || to !== "";

  return (
    <section className="history-mode" aria-label="History">
      <h1>History</h1>
      <Activity
        host={host}
        author={one ? refOf(one) : me}
        who={!one || authorKey(one) === authorKey({ kind: "member", personId, name: "" }) ? "you" : one.name}
        version={version}
        pickedDay={pickedDay}
        onPickDay={(day) => {
          setFrom(day ?? "");
          setTo(day ?? "");
        }}
      />
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
      <Changes
        host={host}
        query={query}
        version={version}
        showNote
        canEdit={(noteId) => editable.has(noteId)}
        head={(noteId) => heads.get(noteId)}
        empty={filtered ? "No changes match these filters." : "Nothing has been written in this workspace yet."}
        onChanged={onChanged}
        onOpenNote={onOpenNote}
      />
    </section>
  );
}
