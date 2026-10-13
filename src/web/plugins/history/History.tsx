import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon, MAX_NOTES_AT_ONCE, useNow, type AuthorRef, type ChangedNote, type DiffRun, type HistoryEntry, type HistoryPage, type HistorySummary, type NoteDiff, type NoteSummary, type OpInput, type PluginHost } from "../../plugin-api.ts";
import { Avatar, DiffView, Stat } from "../lib/HistoryDiff.tsx";
import { MOST_OF_A_NOTE, NOTHING, asked, clock, count, dayLabel, did, groupSaves, keyOf, only, picked, sameSelection, sizeOf, titleOf, who as whoOf, within, withRows, type Row, type Selection } from "../lib/historyView.ts";
import { useKept } from "../lib/kept.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { useReverts, type RevertAsk } from "../lib/RevertDialog.tsx";

/** What narrows history: to some notes, to some authors, and to people's changes or agents'. */
type Filters = Pick<Extract<OpInput, { type: "history.list" }>, "noteIds" | "authors" | "by">;

export type View = "time" | "note";
type Who = "everyone" | "people" | "agents";

/** What History is narrowed to, under the name it goes by: some notes under a note's title or a folder's name, or one author's changes under the author's name. */
export type Scope = { label: string; noteIds: string[] } | { label: string; author: AuthorRef };

/** Whether a page's state, which any plugin may hand over, is a scope. */
export const isScope = (v: unknown): v is Scope => typeof v === "object" && v !== null && typeof (v as Scope).label === "string" && (Array.isArray((v as { noteIds?: unknown }).noteIds) || typeof (v as { author?: unknown }).author === "object");

const CHANGES_A_PAGE = 100;
const NOTES_A_PAGE = 30;
/** As many changes as Select all picks. */
const MOST_SELECTED = 2000;
/** As many changes as the timeline reads again when a note changes. */
const MOST_REREAD = 1000;
const DIFF_PAUSE_MS = 90;

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

interface Loaded {
  /** The timeline: every change that matches, newest first, as far as it has been read. */
  changes: HistoryEntry[] | null;
  next: HistoryPage["next"];
  /** The notes that changed, when they are listed by note. */
  notes: ChangedNote[] | null;
  nextNotes: HistorySummary["next"];
  /** Notes whose changes were all read, beyond what the timeline holds of them. */
  whole: ReadonlyMap<string, HistoryEntry[]>;
  error: string | null;
}

const NOT_LOADED: Loaded = { changes: null, next: null, notes: null, nextNotes: null, whole: new Map(), error: null };

/** The changes History lists and the notes they are in, read a page at a time and again whenever `version` does. */
function useChanges(host: PluginHost, filters: Filters, byNote: boolean, version: number) {
  const [loaded, setLoaded] = useState(NOT_LOADED);
  const key = JSON.stringify(filters);
  const latest = useRef(loaded);
  latest.current = loaded;

  const list = useCallback(
    (page: { before?: NonNullable<HistoryPage["next"]>; limit: number; noteIds?: string[] }) => host.perform({ type: "history.list", ...(JSON.parse(key) as Filters), ...page, diffs: false }),
    [host, key],
  );

  /** Every listed change of one note, the latest of them when it has more than a row lists. */
  const wholeOf = useCallback(
    async (noteId: string) => {
      let read: HistoryEntry[] = [];
      let before: HistoryPage["next"] | undefined;
      do {
        const page = await list({ noteIds: [noteId], limit: CHANGES_A_PAGE, ...(before ? { before } : {}) });
        read = [...read, ...page.changes];
        before = page.next;
      } while (before && read.length < MOST_OF_A_NOTE);
      return read;
    },
    [list],
  );

  useEffect(() => {
    let live = true;
    const fail = (err: Error) => live && setLoaded((was) => ({ ...was, error: err.message }));
    // As far as the timeline was read, so that reading it again takes nothing listed away, within reason.
    const upTo = Math.min(MOST_REREAD, latest.current.changes?.length ?? 0);
    (async () => {
      let [changes, next]: [HistoryEntry[], HistoryPage["next"]] = [[], null];
      do {
        const page = await list({ limit: CHANGES_A_PAGE, ...(next ? { before: next } : {}) });
        [changes, next] = [[...changes, ...page.changes], page.next];
      } while (next && changes.length < upTo);
      if (live) setLoaded((was) => ({ ...was, changes, next, error: null }));
    })().catch(fail);
    if (byNote) {
      host.perform({ type: "history.summary", ...(JSON.parse(key) as Filters), limit: Math.min(100, Math.max(NOTES_A_PAGE, latest.current.notes?.length ?? 0)) }).then(
        (summary) => live && setLoaded((was) => ({ ...was, notes: summary.notes, nextNotes: summary.next })),
        fail,
      );
    }
    // A note read whole is read whole again, or its rows would stop at what the timeline holds of it.
    for (const noteId of latest.current.whole.keys()) wholeOf(noteId).then((read) => live && setLoaded((was) => ({ ...was, whole: new Map(was.whole).set(noteId, read) })), fail);
    return () => {
      live = false;
    };
  }, [host, key, list, wholeOf, byNote, version]);

  const older = async () => {
    if (!loaded.next || !loaded.changes) return;
    const page = await list({ before: loaded.next, limit: CHANGES_A_PAGE });
    setLoaded((was) => ({ ...was, changes: [...(was.changes ?? []), ...page.changes], next: page.next }));
  };
  const moreNotes = async () => {
    if (!loaded.nextNotes) return;
    const summary = await host.perform({ type: "history.summary", ...filters, before: loaded.nextNotes, limit: NOTES_A_PAGE });
    setLoaded((was) => ({ ...was, notes: [...(was.notes ?? []), ...summary.notes], nextNotes: summary.next }));
  };

  /** The changes of a note that are listed: the timeline's when it holds them all, and otherwise read now. */
  const ofNote = useCallback(
    async (noteId: string): Promise<HistoryEntry[]> => {
      const { changes, notes, whole } = latest.current;
      const known = whole.get(noteId);
      if (known) return known;
      const listed = (changes ?? []).filter((c) => c.noteId === noteId);
      const all = notes?.find((n) => n.noteId === noteId)?.changes;
      if (all !== undefined && listed.length >= all) return listed;
      const read = await wholeOf(noteId);
      setLoaded((was) => ({ ...was, whole: new Map(was.whole).set(noteId, read) }));
      return read;
    },
    [wholeOf],
  );
  return { ...loaded, older, moreNotes, ofNote };
}

/** One thing the list holds that the cursor stops at: a row of changes, or a note with its rows under it. */
type Item = { kind: "row"; id: string; row: Row } | { kind: "note"; id: string; note: ChangedNote };

interface RowProps {
  id: string;
  row: Row;
  me: string;
  /** The note's name is left out where every row is of one note. */
  named: boolean;
  /** The day is said with the time where no heading says it. */
  dated: boolean;
  role: "option" | "treeitem";
  /** Whether all its saves are picked, or only some: older saves of a sitting can be read after the row was picked. */
  on: "all" | "some" | "none";
  focused: boolean;
  onPress: (e: MouseEvent) => void;
}

function ChangeRow({ id, row, me, named, dated, role, on, focused, onPress }: RowProps) {
  const time = dated ? `${new Date(row.lastAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock(row.lastAt)}` : clock(row.lastAt);
  return (
    <div
      id={id}
      role={role}
      aria-selected={on === "all"}
      aria-level={role === "treeitem" ? 2 : undefined}
      className={`hist-row${on === "all" ? " selected" : ""}${focused ? " focused" : ""}${row.reverted ? " reverted" : ""}`}
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={onPress}
    >
      <span className={`hist-check ${on}`} aria-hidden="true" />
      <Avatar author={row.author} />
      <span className="hist-body">
        <span className="hist-line">
          <b>{whoOf(row.author, me)}</b> {did(row, named)}
          {named && <span className="hist-note"> {titleOf(row.noteTitle)}</span>}
        </span>
        <span className="hist-meta">
          <Stat added={row.added} removed={row.removed} />
          {row.revisions.length > 1 && <span>{row.revisions.length} saves</span>}
          <time dateTime={new Date(row.lastAt).toISOString()} title={new Date(row.lastAt).toLocaleString()}>
            {time}
          </time>
          {row.reverted && <span className="hist-reverted">reverted</span>}
          {row.labels.map((label) => (
            <span key={label} className="label-chip">
              {label}
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}

interface CardProps {
  host: PluginHost;
  note: NoteDiff;
  canEdit: boolean;
  onOpenNote: (noteId: string) => void;
  onRevert: (asks: RevertAsk[]) => void;
  /** A revision was named, or its name taken away. */
  onLabeled: () => void;
  /** Reads the diffs this note came without. */
  onWanted: (noteId: string) => void;
}

const span = (run: DiffRun) => (clock(run.firstAt) === clock(run.lastAt) ? clock(run.lastAt) : `${clock(run.firstAt)}–${clock(run.lastAt)}`);

/** What the picked changes did to one note: each run of them as one diff, with the changes left out between two runs counted. */
function NoteCard({ host, note, canEdit, onOpenNote, onRevert, onLabeled, onWanted }: CardProps) {
  const ids = useId();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const last = note.runs.at(-1)!;
  const title = titleOf(note.noteTitle);

  const label = async (name: string | null) => {
    setNaming(false);
    setError(null);
    try {
      await host.perform({ type: "note.label", id: note.noteId, revision: last.to, name: name?.trim() || null });
      onLabeled();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const items: MenuItem[] = [
    { label: last.label ? "Rename this revision's label…" : "Label this revision…", action: () => setNaming(true) },
    ...(last.label ? [{ label: "Remove its label", action: () => void label(null) }] : []),
    { label: "Revert the note to this revision…", disabled: last.to === note.revision, action: () => onRevert([{ noteId: note.noteId, title: note.noteTitle, to: last.to }]) },
  ];
  return (
    <section className="hist-file" aria-labelledby={`${ids}-name`}>
      <header className="hist-file-head">
        <button type="button" className="hist-file-name" id={`${ids}-name`} title="Open this note" onClick={() => onOpenNote(note.noteId)}>
          {title}
        </button>
        <Stat added={note.added} removed={note.removed} />
        <span className="spacer" />
        {canEdit && (
          <button
            type="button"
            className="icon-button"
            aria-label={`More for ${title}`}
            title="Label this revision, or revert the note to it"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setMenu(menu ? null : { x: Math.max(8, box.right - 250), y: box.bottom + 4 });
            }}
          >
            <Icon name="more" />
          </button>
        )}
      </header>
      {menu && <ContextMenu label={`More for ${title}`} x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
      {naming && (
        <form
          className="hist-naming"
          onSubmit={(e) => {
            e.preventDefault();
            void label(new FormData(e.currentTarget).get("name") as string);
          }}
        >
          <input name="name" autoFocus maxLength={60} aria-label={`Label for this revision of ${title}`} placeholder="Label this revision" defaultValue={last.label ?? ""} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setNaming(false))} />
          <button type="submit" className="button small">
            Save
          </button>
        </form>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {note.runs.map((run) => (
        <div key={run.from} className="hist-run">
          {(note.runs.length > 1 || run.skipped > 0 || run.label) && (
            <div className="hist-run-head">
              {run.skipped > 0 && (
                <span className="hist-skip" title="Changes to this note that are not picked">
                  {count(run.skipped, "save")} skipped
                </span>
              )}
              {note.runs.length > 1 && (
                <span>
                  {count(run.saves, "save")} · {span(run)}
                </span>
              )}
              {run.label && <span className="label-chip">{run.label}</span>}
            </div>
          )}
          {run.diff ? (
            run.diff.hunks.length ? (
              <DiffView diff={run.diff} readBefore={async () => (await host.perform({ type: "note.read", id: note.noteId, revision: run.from - 1 })).text} />
            ) : (
              <p className="diff-none">No text changed overall.</p>
            )
          ) : (
            <p className="diff-none">
              This diff is left out, as the selection is long.{" "}
              <button type="button" className="link" onClick={() => onWanted(note.noteId)}>
                Show it
              </button>
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

interface PaneProps {
  host: PluginHost;
  selection: Selection;
  /** The picked changes as the list counts them: rows, and the saves in them. */
  counted: { changes: number; saves: number };
  /** Whether the member may change a note. A selection can hold notes they may only read. */
  canEdit: (noteId: string) => boolean;
  /** Changes when a note does, or a label, so the diffs are read again. */
  version: number;
  titleOfNote: (noteId: string) => string;
  onOpenNote: (noteId: string) => void;
  onRevert: (asks: RevertAsk[], beyond?: string) => void;
  onLabeled: () => void;
  onBack: () => void;
}

/** What the selection did, note by note, under one line that counts it and holds the one thing to do with it: revert. */
function SelectionPane({ host, selection, counted, canEdit, version, titleOfNote, onOpenNote, onRevert, onLabeled, onBack }: PaneProps) {
  const [notes, setNotes] = useState<NoteDiff[]>([]);
  const [parts, setParts] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = useMemo(() => asked(selection), [selection]);
  const mine = all.filter((c) => canEdit(c.noteId));
  const wanted = JSON.stringify(all.slice(0, parts * MAX_NOTES_AT_ONCE));
  const shownFor = useRef(selection);
  if (!sameSelection(shownFor.current, selection)) {
    shownFor.current = selection;
    if (parts !== 1) setParts(1);
  }

  useEffect(() => {
    const changes = JSON.parse(wanted) as ReturnType<typeof asked>;
    if (!changes.length) {
      setNotes([]);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const read: NoteDiff[] = [];
        for (let i = 0; i < changes.length; i += MAX_NOTES_AT_ONCE) read.push(...(await host.perform({ type: "history.diff", changes: changes.slice(i, i + MAX_NOTES_AT_ONCE) })).notes);
        if (!live) return;
        setNotes(read);
        setError(null);
      } catch (err) {
        if (live) setError((err as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    }, DIFF_PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host, wanted, version]);

  const fill = async (noteId: string) => {
    const one = all.find((c) => c.noteId === noteId);
    if (!one) return;
    try {
      const [read] = (await host.perform({ type: "history.diff", changes: [one] })).notes;
      setNotes((was) => was.map((n) => (n.noteId === noteId && read ? read : n)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const none = !all.length;
  const left = all.length - notes.length;
  const [added, removed] = [notes.reduce((sum, n) => sum + n.added, 0), notes.reduce((sum, n) => sum + n.removed, 0)];
  return (
    <section className="hist-main" aria-label="What the selection did">
      <header className="hist-summary">
        <button type="button" className="hist-back" onClick={onBack}>
          <Icon name="back" />
          Changes
        </button>
        <p className="hist-sum-text" role="status">
          {none ? (
            <b>Nothing selected</b>
          ) : (
            <>
              <b>{count(counted.changes, "change")}</b>
              {counted.saves > counted.changes && <span>{counted.saves} saves</span>}
              <span>{count(all.length, "note")}</span>
              {notes.length > 0 && <Stat added={added} removed={removed} />}
              {notes.length > 0 && left > 0 && <span>in the first {notes.length}</span>}
            </>
          )}
        </p>
        <span className="spacer" />
        {mine.length > 0 && (
          <button
            type="button"
            className="button small"
            onClick={() =>
              onRevert(
                mine.map((c) => ({ noteId: c.noteId, title: notes.find((n) => n.noteId === c.noteId)?.noteTitle ?? titleOfNote(c.noteId), revisions: c.revisions })),
                mine.length < all.length ? `${count(all.length - mine.length, "note")} you can read and not change ${all.length - mine.length === 1 ? "is" : "are"} left out.` : undefined,
              )
            }
          >
            Revert…
          </button>
        )}
      </header>
      {error && <p role="alert" className="error">{error}</p>}
      {none ? (
        <p className="hist-hint">Select changes to see what they did. Shift-click takes a range, and {MAC ? "⌘" : "Ctrl"}-click adds or skips one.</p>
      ) : (
        <div className={loading ? "hist-files loading" : "hist-files"} aria-busy={loading}>
          {notes.map((note) => (
            <NoteCard key={note.noteId} host={host} note={note} canEdit={canEdit(note.noteId)} onOpenNote={onOpenNote} onRevert={onRevert} onLabeled={onLabeled} onWanted={(noteId) => void fill(noteId)} />
          ))}
          {notes.length > 0 && left > 0 && (
            <button type="button" className="button small" onClick={() => setParts(parts + 1)}>
              Show {Math.min(left, MAX_NOTES_AT_ONCE)} more of {count(left, "note")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface PanesProps {
  host: PluginHost;
  /** The member, whose own changes read "You". */
  me: string;
  canEdit: (noteId: string) => boolean;
  view: View;
  filters: Filters;
  /** The page lays its panes side by side with room, and shows one at a time without; a panel always stacks them. */
  layout: "page" | "panel";
  /** Changes when any listed note does. */
  version: number;
  /** What stands over the list. */
  head: ReactNode;
  empty: string;
  onOpenNote: (noteId: string) => void;
  /** Notes were reverted. The caller answers with a new `version`. */
  onChanged: () => void;
  /** Called with the latest changes each time they are read. */
  onLoaded?: (changes: HistoryEntry[]) => void;
}

/**
 * History's two panes. The list has every change with a tick: click one to see it, tick or
 * ⌘-click to add or skip, shift-click for a range. The other pane shows what everything picked
 * did, note by note, and reverts it.
 */
function HistoryPanes({ host, me, canEdit, view, filters, layout, version, head, empty, onOpenNote, onChanged, onLoaded }: PanesProps) {
  const ids = useId();
  const now = useNow();
  const [reloads, reload] = useState(0);
  const data = useChanges(host, filters, view === "note", version + reloads);
  const [selection, setPicked] = useState<Selection>(NOTHING);
  const [cut, setCut] = useState(false);
  /** Picks, with no more of one note than a request takes: the rest are left out, which the list says. */
  const setSelection = (next: Selection | ((was: Selection) => Selection)) =>
    setPicked((was) => {
      const made = within(typeof next === "function" ? next(was) : next);
      setCut(made.cut);
      return made.selection;
    });
  /** Counts the presses that wait on a read, so that only the last of them picks. */
  const presses = useRef(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const [capped, setCapped] = useState(false);
  const listbox = useRef<HTMLDivElement>(null);

  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    if (data.changes) loaded.current?.(data.changes);
  }, [data.changes]);

  const timeline = useMemo(() => groupSaves(data.changes ?? []), [data.changes]);
  const dated = view === "note" || layout === "panel";
  /** The rows of a note as far as they are read: all of them once it was opened or picked. */
  const rowsOf = useCallback((noteId: string) => groupSaves(data.whole.get(noteId) ?? (data.changes ?? []).filter((c) => c.noteId === noteId)), [data.whole, data.changes]);

  const items = useMemo<Item[]>(() => {
    if (view === "time") return timeline.map((row) => ({ kind: "row", id: `${ids}-${row.key}`, row }));
    return (data.notes ?? []).flatMap((note): Item[] => [
      { kind: "note", id: `${ids}-${note.noteId}`, note },
      ...(open.has(note.noteId) ? rowsOf(note.noteId).map((row): Item => ({ kind: "row", id: `${ids}-${row.key}`, row })) : []),
    ]);
  }, [view, timeline, data.notes, open, rowsOf, ids]);
  const ready = view === "time" ? data.changes !== null : data.notes !== null && data.changes !== null;

  /** Every row of a note, read if it wasn't yet. */
  const allRowsOf = async (noteId: string) => groupSaves(await data.ofNote(noteId));
  const rowsFor = async (item: Item) => (item.kind === "row" ? [item.row] : allRowsOf(item.note.noteId));

  const showOnly = async (item: Item) => {
    setCursor(item.id);
    setAnchor(item.id);
    setCapped(false);
    if (item.kind === "note") setOpen((was) => new Set(was).add(item.note.noteId));
    const press = ++presses.current;
    const rows = await rowsFor(item);
    if (press === presses.current) setSelection(only(rows));
  };
  const toggle = async (item: Item) => {
    setCursor(item.id);
    setAnchor(item.id);
    setCapped(false);
    const press = ++presses.current;
    const rows = await rowsFor(item);
    if (press === presses.current) setSelection((was) => withRows(was, rows, picked(was, rows) !== "all"));
  };
  const extendTo = (item: Item) => {
    const [from, to] = [items.findIndex((i) => i.id === (anchor ?? item.id)), items.indexOf(item)];
    const range = items.slice(Math.min(from, to), Math.max(from, to) + 1).flatMap((i) => (i.kind === "row" ? [i.row] : []));
    setCursor(item.id);
    presses.current++;
    setSelection((was) => withRows(was, range, true));
  };

  // The first row is picked on arriving, so the other pane is never empty.
  const arrived = useRef(false);
  useEffect(() => {
    if (!ready || arrived.current || !items[0]) return;
    arrived.current = true;
    void showOnly(items[0]);
  }, [ready, items]);

  const listedRows = view === "time" ? timeline : (data.notes ?? []).flatMap((n) => rowsOf(n.noteId));
  const listedCount = view === "time" ? (data.changes?.length ?? 0) : (data.notes ?? []).reduce((sum, n) => sum + n.changes, 0);
  const selectedHere = view === "time" ? sizeOf(selection) : (data.notes ?? []).reduce((sum, n) => sum + (selection.get(n.noteId)?.size ?? 0), 0);
  const everything = view === "time" ? picked(selection, timeline) : selectedHere === 0 ? "none" : selectedHere >= Math.min(listedCount, MOST_SELECTED) ? "all" : "some";

  const selectAll = async () => {
    const press = ++presses.current;
    if (everything === "all") {
      setCapped(false);
      return setSelection(NOTHING);
    }
    let rows = listedRows;
    if (view === "note") {
      rows = [];
      const notes = data.notes ?? [];
      for (let i = 0; i < notes.length && rows.reduce((sum, r) => sum + r.revisions.length, 0) < MOST_SELECTED; i += 4) rows.push(...(await Promise.all(notes.slice(i, i + 4).map((n) => allRowsOf(n.noteId)))).flat());
    }
    const taken: Row[] = [];
    let size = 0;
    for (const row of rows) {
      if (size + row.revisions.length > MOST_SELECTED) break;
      taken.push(row);
      size += row.revisions.length;
    }
    if (press !== presses.current) return;
    setCapped(taken.length < rows.length);
    setSelection(only(taken));
  };

  const press = (item: Item, e: MouseEvent) => {
    listbox.current?.focus({ preventScroll: true });
    if (e.shiftKey) return extendTo(item);
    if (e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest(".hist-check")) return void toggle(item);
    if ((e.target as HTMLElement).closest(".hist-caret") && item.kind === "note") {
      setCursor(item.id);
      return setOpen((was) => {
        const next = new Set(was);
        if (!next.delete(item.note.noteId)) next.add(item.note.noteId);
        return next;
      });
    }
    void showOnly(item);
    setDetail(true);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !items.length) return;
    const at = Math.max(0, items.findIndex((i) => i.id === cursor));
    const here = items[at]!;
    const move = (by: number) => {
      const to = items[Math.max(0, Math.min(items.length - 1, at + by))]!;
      if (e.shiftKey) extendTo(to);
      else void showOnly(to);
      requestAnimationFrame(() => document.getElementById(to.id)?.scrollIntoView({ block: "nearest" }));
    };
    const unfold = (on: boolean) => {
      if (here.kind !== "note") return;
      setOpen((was) => {
        const next = new Set(was);
        if (on) next.add(here.note.noteId);
        else next.delete(here.note.noteId);
        return next;
      });
    };
    const act: Record<string, () => void> = {
      j: () => move(1),
      ArrowDown: () => move(1),
      k: () => move(-1),
      ArrowUp: () => move(-1),
      x: () => void toggle(here),
      " ": () => void toggle(here),
      a: () => void selectAll(),
      Escape: () => void showOnly(here),
      Enter: () => onOpenNote(here.kind === "row" ? here.row.noteId : here.note.noteId),
      ArrowRight: () => unfold(true),
      ArrowLeft: () => unfold(false),
    };
    const fn = act[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const known = useMemo(() => {
    const all = new Map<string, HistoryEntry>();
    for (const c of [...(data.changes ?? []), ...[...data.whole.values()].flat()]) all.set(keyOf(c.noteId, c.revision), c);
    return all;
  }, [data.changes, data.whole]);
  const counted = useMemo(() => {
    let changes = 0;
    for (const [noteId, revisions] of selection) {
      const entries = [...revisions].sort((a, b) => b - a).map((r) => known.get(keyOf(noteId, r)));
      changes += groupSaves(entries.filter((c) => c !== undefined)).length + entries.filter((c) => c === undefined).length;
    }
    return { changes, saves: sizeOf(selection) };
  }, [selection, known]);
  const titleOfNote = (noteId: string) => data.notes?.find((n) => n.noteId === noteId)?.noteTitle ?? data.changes?.find((c) => c.noteId === noteId)?.noteTitle ?? "";

  const changed = () => {
    reload((n) => n + 1);
    onChanged();
  };
  const reverts = useReverts({ host, version, onChanged: changed });

  const isTree = view === "note";
  let day = "";
  return (
    <div className={`history-panes ${layout}${detail ? " detail" : ""}`}>
      <div className="hist-side">
        {head}
        {data.error && <p role="alert" className="error">{data.error}</p>}
        {ready && items.length > 0 && (
          <div className="hist-all">
            <button type="button" role="checkbox" aria-checked={everything === "all" ? true : everything === "some" ? "mixed" : false} className="hist-all-tick" onClick={() => void selectAll()}>
              <span className={`hist-check ${everything}`} aria-hidden="true" />
              Select all
            </button>
            <span className="hist-all-count">
              {cut
                ? `The latest ${MOST_OF_A_NOTE} changes of a note are picked, no more`
                : capped
                  ? `The first ${MOST_SELECTED.toLocaleString()} changes are picked`
                  : `${count(listedCount, "change")}${(view === "time" ? data.next : data.nextNotes) ? " so far" : ""}`}
            </span>
          </div>
        )}
        <div
          ref={listbox}
          className="hist-list"
          role={isTree ? "tree" : "listbox"}
          aria-label={isTree ? "Notes that changed" : "Changes"}
          aria-multiselectable="true"
          aria-activedescendant={cursor && items.some((i) => i.id === cursor) ? cursor : undefined}
          tabIndex={0}
          onKeyDown={onKey}
        >
          {ready && !items.length && <p className="empty">{empty}</p>}
          {items.map((item) => {
            if (item.kind === "note") {
              const { note } = item;
              const rows = rowsOf(note.noteId);
              const has = selection.get(note.noteId)?.size ?? 0;
              const state = has === 0 ? "none" : has >= Math.min(note.changes, MOST_OF_A_NOTE) && picked(selection, rows) === "all" ? "all" : "some";
              return (
                <div
                  key={item.id}
                  id={item.id}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={open.has(note.noteId)}
                  aria-selected={state === "all"}
                  className={`hist-row hist-note-row${state === "all" ? " selected" : ""}${cursor === item.id ? " focused" : ""}`}
                  onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                  onClick={(e) => press(item, e)}
                >
                  <span className={`hist-check ${state}`} aria-hidden="true" />
                  <span className="hist-caret caret" aria-hidden="true" />
                  <span className="hist-body">
                    <span className="hist-line">
                      <Stat added={note.added} removed={note.removed} /> <span className="hist-note">{titleOf(note.noteTitle)}</span>
                    </span>
                    <span className="hist-meta">
                      <span>{count(note.changes, "change")}</span>
                      <span>{note.authors.map((a) => whoOf(a, me)).join(", ")}</span>
                    </span>
                  </span>
                </div>
              );
            }
            const ofNote = isTree ? data.notes?.find((n) => n.noteId === item.row.noteId) : undefined;
            const cut = ofNote && data.whole.has(ofNote.noteId) && ofNote.changes > data.whole.get(ofNote.noteId)!.length && rowsOf(ofNote.noteId).at(-1) === item.row;
            const heading = isTree || dated ? null : dayLabel(item.row.lastAt, now);
            const starts = heading !== null && heading !== day;
            if (heading !== null) day = heading;
            return (
              <div key={item.id} role="presentation">
                {starts && (
                  <div className="hist-day" role="presentation">
                    {heading}
                  </div>
                )}
                <ChangeRow
                  id={item.id}
                  row={item.row}
                  me={me}
                  named={!isTree && filters.noteIds?.length !== 1}
                  dated={dated}
                  role={isTree ? "treeitem" : "option"}
                  on={picked(selection, [item.row])}
                  focused={cursor === item.id}
                  onPress={(e) => press(item, e)}
                />
                {cut && (
                  <p className="hist-cut">
                    These are its latest {data.whole.get(ofNote.noteId)!.length} changes of {ofNote.changes}. The list by time reaches the older ones.
                  </p>
                )}
              </div>
            );
          })}
        </div>
        {view === "time" && data.next && (
          <div className="hist-more">
            <button type="button" className="link" onClick={() => void data.older()}>
              Load older changes
            </button>
          </div>
        )}
        {view === "note" && data.nextNotes && (
          <div className="hist-more">
            <button type="button" className="link" onClick={() => void data.moreNotes()}>
              Show more notes
            </button>
          </div>
        )}
        {sizeOf(selection) > 0 && (
          <div className="hist-open">
            <button type="button" className="button small primary" onClick={() => setDetail(true)}>
              See {count(counted.changes, "change")}
            </button>
          </div>
        )}
      </div>
      <SelectionPane
        host={host}
        selection={selection}
        counted={counted}
        canEdit={canEdit}
        version={version + reloads}
        titleOfNote={titleOfNote}
        onOpenNote={onOpenNote}
        onRevert={reverts.ask}
        onLabeled={() => reload((n) => n + 1)}
        onBack={() => setDetail(false)}
      />
      {reverts.shown}
    </div>
  );
}

interface OpenInHistoryProps {
  onOpen: () => void;
}

function OpenInHistory({ onOpen }: OpenInHistoryProps) {
  return (
    <button type="button" className="link hist-open-page" onClick={onOpen}>
      Open in History
    </button>
  );
}

interface NoteHistoryProps {
  host: PluginHost;
  me: string;
  note: NoteSummary;
  canEdit: boolean;
  onChanged: () => void;
  onOpenNote: (noteId: string) => void;
  onOpenHistory: (scope: Scope) => void;
  /** Called with the latest revision each time the member is shown the note's changes. */
  onSeen: (noteId: string, revision: number) => void;
}

/** The open note's history, for the inspector: History's list and what the picked changes did, one over the other. */
export function NoteHistory({ host, me, note, canEdit, onChanged, onOpenNote, onOpenHistory, onSeen }: NoteHistoryProps) {
  const filters = useMemo<Filters>(() => ({ noteIds: [note.id] }), [note.id]);
  return (
    <HistoryPanes
      key={note.id}
      host={host}
      me={me}
      canEdit={() => canEdit}
      view="time"
      filters={filters}
      layout="panel"
      version={note.revision}
      head={<OpenInHistory onOpen={() => onOpenHistory({ label: titleOf(note.title), noteIds: [note.id] })} />}
      empty="Nothing has been written in this note yet."
      onOpenNote={onOpenNote}
      onChanged={onChanged}
      onLoaded={(changes) => onSeen(note.id, changes[0]?.revision ?? 0)}
    />
  );
}

interface FolderHistoryProps {
  host: PluginHost;
  me: string;
  name: string;
  /** The folder's notes. */
  notes: readonly NoteSummary[];
  /** Whether they are every note of the workspace, as All notes lists. */
  whole: boolean;
  onOpenNote: (noteId: string) => void;
  onOpenHistory: (scope: Scope | null) => void;
  onChanged: () => void;
}

/** Which of the notes the member may change: each note says so of itself, since a grant or a private note can differ from the member's role. */
function useEditable(notes: readonly NoteSummary[]): (noteId: string) => boolean {
  const editable = useMemo(() => new Set(notes.filter((n) => n.access === "edit").map((n) => n.id)), [notes]);
  return useCallback((noteId: string) => editable.has(noteId), [editable]);
}

/** As many notes as history can be narrowed to at once. A folder with more shows the ones changed last. */
const MOST_NOTES = 200;

/** A folder's history, for the inspector: its notes that changed, each opening to its changes. */
export function FolderHistory({ host, me, name, notes, whole, onOpenNote, onOpenHistory, onChanged }: FolderHistoryProps) {
  const canEdit = useEditable(notes);
  const version = useMemo(() => notes.reduce((sum, n) => sum + n.revision, 0), [notes]);
  const ids = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MOST_NOTES).map((n) => n.id).join(","), [notes]);
  const filters = useMemo<Filters>(() => (whole ? {} : { noteIds: ids.split(",") }), [whole, ids]);
  const empty = whole ? "Nothing has been written in this workspace yet." : "Nothing has been written in this folder yet.";
  if (!whole && !notes.length) return <p className="empty">{empty}</p>;
  return (
    <HistoryPanes
      host={host}
      me={me}
      canEdit={canEdit}
      view="note"
      filters={filters}
      layout="panel"
      version={version}
      head={<OpenInHistory onOpen={() => onOpenHistory(whole ? null : { label: name, noteIds: ids.split(",") })} />}
      empty={empty}
      onOpenNote={onOpenNote}
      onChanged={onChanged}
    />
  );
}

interface HistoryModeProps {
  host: PluginHost;
  me: string;
  /** Every note in the workspace. */
  notes: readonly NoteSummary[];
  /** The notes History was opened on, from a note's or a folder's History tab. */
  scope: Scope | null;
  onScope: (scope: Scope | null) => void;
  onOpenNote: (noteId: string) => void;
  onChanged: () => void;
}

const isView = (v: unknown): v is View => v === "time" || v === "note";
const WHO: readonly [Who, string][] = [
  ["everyone", "Everyone"],
  ["people", "People"],
  ["agents", "Agents"],
];

/** The workspace's history: every change by time or by note, and what any selection of them did. */
export function HistoryMode({ host, me, notes, scope, onScope, onOpenNote, onChanged }: HistoryModeProps) {
  const canEdit = useEditable(notes);
  const [view, setView] = useKept<View>(host.storage, "view", isView, "time");
  const [who, setWho] = useState<Who>("everyone");
  const version = useMemo(() => notes.reduce((sum, n) => sum + n.revision, 0), [notes]);
  const author = scope && "author" in scope ? scope.author : null;
  const scoped = scope && "noteIds" in scope ? scope.noteIds.join(",") : "";
  const one = author && `${author.kind}:${author.id}`;
  const filters = useMemo<Filters>(() => {
    if (one) return { authors: [{ kind: one.split(":")[0] as AuthorRef["kind"], id: one.split(":")[1]! }] };
    return { ...(scoped ? { noteIds: scoped.split(",") } : {}), ...(who === "everyone" ? {} : { by: who }) };
  }, [one, scoped, who]);
  const filtered = who !== "everyone" || scope !== null;

  const head = (
    <div className="hist-head">
      <h1>History</h1>
      <p className="hist-sub">
        Click to see a change · {MAC ? "⌘" : "Ctrl"}-click to add or skip · shift-click for a range
      </p>
      <div className="hist-filters">
        <div className="segmented" role="radiogroup" aria-label="List">
          {(["time", "note"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}>
              {v === "time" ? "By time" : "By note"}
            </button>
          ))}
        </div>
        {!author && (
          <div className="segmented" role="radiogroup" aria-label="Whose changes">
            {WHO.map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={who === value} onClick={() => setWho(value)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {scope && (
          <span className="chip hist-scope">
            {scope.label}
            <button type="button" aria-label={author ? "Show everyone's changes" : "Show every note"} title={author ? "Show everyone's changes" : "Show every note"} onClick={() => onScope(null)}>
              <Icon name="close" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
  return (
    <section className="history-mode" aria-label="History">
      <HistoryPanes
        key={JSON.stringify(filters)}
        host={host}
        me={me}
        canEdit={canEdit}
        view={view}
        filters={filters}
        layout="page"
        version={version}
        head={head}
        empty={filtered ? "No changes match these filters." : "Nothing has been written in this workspace yet."}
        onOpenNote={onOpenNote}
        onChanged={onChanged}
      />
    </section>
  );
}
