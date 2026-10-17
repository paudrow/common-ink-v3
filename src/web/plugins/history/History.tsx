import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon, MAX_NOTES_AT_ONCE, useNow, type AuthorRef, type DiffRun, type HistoryEntry, type HistoryPage, type NoteDiff, type NoteRevertPreview, type OpInput, type PluginHost, type RevertConflict } from "../../plugin-api.ts";
import { Avatar, DiffView, Stat, type Marked } from "../lib/HistoryDiff.tsx";
import { MOST_OF_A_NOTE, NOTHING, asked, byDay, clock, count, dayLabel, did, groupSaves, kept, keyOf, lists, notesOf, only, picked, pieces, sameSelection, sizeOf, titleOf, who as whoOf, within, withRows, type Narrowing, type NoteOfDay, type Row, type Selection } from "../lib/historyView.ts";
import { useKept } from "../lib/kept.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { later, useReverts, type RevertAsk } from "../lib/RevertDialog.tsx";

/** What the operation that lists changes is narrowed by. */
type Filters = Pick<Extract<OpInput, { type: "history.list" }>, "noteIds" | "authors" | "by">;

export type View = "time" | "note";
type Who = "everyone" | "people" | "agents";

/**
 * What History is narrowed to, under the name it goes by: some notes under a folder's name, one
 * note under its title, or one author's changes under the author's name. One note is listed by
 * time alone, as there is no other note to list it by.
 */
export type Scope = { label: string; noteIds: string[]; one?: true } | { label: string; author: AuthorRef };

/** Whether a page's state, which any plugin may hand over, is a scope. */
export const isScope = (v: unknown): v is Scope => typeof v === "object" && v !== null && typeof (v as Scope).label === "string" && (Array.isArray((v as { noteIds?: unknown }).noteIds) || typeof (v as { author?: unknown }).author === "object");

const CHANGES_A_PAGE = 100;
/** As many changes as Select all picks. */
const MOST_SELECTED = 2000;
/** As many changes as the list reads again when a note changes. */
const MOST_REREAD = 1000;
const DIFF_PAUSE_MS = 90;

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

interface Loaded {
  /** Every change that matches, newest first, as far as it has been read. */
  changes: HistoryEntry[] | null;
  next: HistoryPage["next"];
  error: string | null;
}

const NOT_LOADED: Loaded = { changes: null, next: null, error: null };

/**
 * The changes History lists, read a page at a time and again whenever `version` does. When the
 * narrowing changes, what was read and is still listed stays until the new reading arrives, so the
 * list is never emptied between two. The first reading goes as far as `atLeast` changes, which is
 * how far the list was read when it was last left.
 */
function useChanges(host: PluginHost, narrowing: Narrowing, version: number, atLeast: number) {
  const [loaded, setLoaded] = useState(NOT_LOADED);
  const key = JSON.stringify(narrowing);
  const latest = useRef({ loaded, key });
  latest.current = { loaded, key };

  const list = useCallback((page: { before?: NonNullable<HistoryPage["next"]>; limit: number }) => host.perform({ type: "history.list", ...(JSON.parse(key) as Filters), ...page, diffs: false }), [host, key]);

  useEffect(() => {
    let live = true;
    // As far as the list was read, so that reading it again takes nothing listed away, within reason.
    const upTo = Math.min(MOST_REREAD, latest.current.loaded.changes?.length ?? atLeast);
    (async () => {
      let [changes, next]: [HistoryEntry[], HistoryPage["next"]] = [[], null];
      do {
        const page = await list({ limit: CHANGES_A_PAGE, ...(next ? { before: next } : {}) });
        [changes, next] = [[...changes, ...page.changes], page.next];
      } while (next && changes.length < upTo);
      if (live) setLoaded({ changes, next, error: null });
    })().catch((err: Error) => live && setLoaded((was) => ({ ...was, error: err.message })));
    return () => {
      live = false;
    };
  }, [list, version]);

  const older = async () => {
    if (!loaded.next || !loaded.changes) return;
    const page = await list({ before: loaded.next, limit: CHANGES_A_PAGE });
    if (latest.current.key === key) setLoaded((was) => ({ ...was, changes: [...(was.changes ?? []), ...page.changes], next: page.next }));
  };
  const changes = useMemo(() => loaded.changes?.filter((c) => lists(JSON.parse(key) as Narrowing, c)) ?? null, [loaded.changes, key]);
  return { changes, next: loaded.next, error: loaded.error, older };
}

/** How many rows a page of the list is: what its scroller shows at once, less one so a row of the page before stays in view. */
function pageOf(list: HTMLElement, row: Element | null) {
  let scroller: HTMLElement | null = list;
  while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
  return Math.max(1, Math.floor((scroller?.clientHeight ?? innerHeight) / (row?.getBoundingClientRect().height || 40)) - 1);
}

/** One thing the list holds that the cursor stops at: a row of changes, or what a day did to a note, with its rows under it when it is open. */
type Item = { kind: "row"; id: string; row: Row } | { kind: "note"; id: string; key: string; note: NoteOfDay };

const rowsOf = (item: Item) => (item.kind === "row" ? [item.row] : item.note.rows);

interface RowProps {
  id: string;
  row: Row;
  me: string;
  /** The note's name is left out where every row is of one note. */
  named: boolean;
  role: "option" | "treeitem";
  /** Whether all its saves are picked, or only some: older saves of a sitting can be read after the row was picked. */
  on: "all" | "some" | "none";
  focused: boolean;
  onPress: (e: MouseEvent) => void;
}

function ChangeRow({ id, row, me, named, role, on, focused, onPress }: RowProps) {
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
            {clock(row.lastAt)}
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
  /** Where reverting the picked changes of this note would not line up, as the preview of that revert lists them. */
  conflicts: readonly RevertConflict[];
  /** When a change of this note was made, if the list has read it. */
  madeAt: (revision: number) => number | undefined;
  /** Opens the revert at one of the conflicts. */
  onConflict: (index: number) => void;
}

/** A conflict in a line: whose later change it is with, and when that was if the list knows. */
function saysOf(conflict: RevertConflict, madeAt: (revision: number) => number | undefined) {
  const at = conflict.later.length === 1 ? madeAt(conflict.later[0]!.revision) : undefined;
  return `Conflict: ${later(conflict)} changed ${conflict.now.length === 1 ? "this line" : "these lines"} later${at === undefined ? "" : `, at ${clock(at)}`}`;
}

const span = (run: DiffRun) => (clock(run.firstAt) === clock(run.lastAt) ? clock(run.lastAt) : `${clock(run.firstAt)}–${clock(run.lastAt)}`);

/** What the picked changes did to one note: each run of them as one diff, with the changes left out between two runs counted. */
function NoteCard({ host, note, canEdit, onOpenNote, onRevert, onLabeled, onWanted, conflicts, madeAt, onConflict }: CardProps) {
  const ids = useId();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const last = note.runs.at(-1)!;
  const title = titleOf(note.noteTitle);
  /** For each run, its conflicts as marks on its diff, and which of them the diff has lines for. */
  const marked = useMemo(
    () =>
      note.runs.map((run) => {
        const marks = conflicts.flatMap((conflict, index) => conflict.runs.filter((r) => r.revision === run.to).map((r) => ({ index, from: r.line - 1, to: r.line - 1 + r.lines })));
        const shown = new Set(run.diff ? pieces(run.diff, marks).flatMap((p) => ("mark" in p && p.mark !== undefined ? [marks[p.mark]!.index] : [])) : []);
        return { marks, shown };
      }),
    [note.runs, conflicts],
  );
  // A conflict no diff here has lines for is still said: nothing a revert would ask about is left out.
  const unplaced = conflicts.flatMap((conflict, index) => (marked.some((m) => m.shown.has(index)) ? [] : [{ conflict, index }]));

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
      {unplaced.map(({ conflict, index }) => (
        <button key={index} type="button" className="diff-conflict lone" title="Open the revert to settle this" onClick={() => onConflict(index)}>
          <span className="diff-conflict-says">{saysOf(conflict, madeAt)}</span>
        </button>
      ))}
      {note.runs.map((run, n) => (
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
              <DiffView
                diff={run.diff}
                marks={marked[n]!.marks.map(({ index, from, to }): Marked => ({ from, to, says: saysOf(conflicts[index]!, madeAt), onOpen: () => onConflict(index) }))}
                readBefore={async () => (await host.perform({ type: "note.read", id: note.noteId, revision: run.from - 1 })).text}
              />
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
  madeAt: (noteId: string, revision: number) => number | undefined;
  onOpenNote: (noteId: string) => void;
  onRevert: (asks: RevertAsk[], beyond?: string) => void;
  /** Opens the revert of everything picked at one conflict of one note. */
  onConflict: (noteId: string, index: number) => void;
  onLabeled: () => void;
  onBack: () => void;
}

const NO_CONFLICTS: readonly RevertConflict[] = [];

/**
 * What the selection did, note by note, under one line that counts it. Where reverting it would
 * not line up with a later change is marked on the diff and counted, from the preview of that
 * revert, for a member who can revert.
 */
function SelectionPane({ host, selection, counted, canEdit, version, madeAt, onOpenNote, onRevert, onConflict, onLabeled, onBack }: PaneProps) {
  const [notes, setNotes] = useState<NoteDiff[]>([]);
  /** The previews of reverting what was asked for, and what that was: a preview of another selection says nothing of this one. */
  const [previews, setPreviews] = useState<{ of: string; notes: ReadonlyMap<string, NoteRevertPreview> }>({ of: "", notes: new Map() });
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
        const previewed: NoteRevertPreview[] = [];
        // The diffs and the preview of their revert are read together and shown together, so no mark arrives on a diff already drawn.
        for (let i = 0; i < changes.length; i += MAX_NOTES_AT_ONCE) {
          const part = changes.slice(i, i + MAX_NOTES_AT_ONCE);
          const [diffs, previews] = await Promise.all([host.perform({ type: "history.diff", changes: part }), part.some((c) => canEdit(c.noteId)) ? host.perform({ type: "history.previewRevert", changes: part }) : []]);
          read.push(...diffs.notes);
          previewed.push(...previews);
        }
        if (!live) return;
        setNotes(read);
        setPreviews({ of: wanted, notes: new Map(previewed.map((p) => [p.noteId, p])) });
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
  }, [host, wanted, version, canEdit]);

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
  /** The preview is of the note as the diffs show it: one read at another revision says nothing here. */
  const conflictsOf = (note: NoteDiff) => {
    const preview = previews.of === wanted ? previews.notes.get(note.noteId) : undefined;
    return preview && preview.revision === note.revision ? preview.conflicts : NO_CONFLICTS;
  };
  const conflicted = notes.flatMap((note) => conflictsOf(note).map((_, index) => ({ noteId: note.noteId, index })));
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
              {conflicted.length > 0 && (
                <button type="button" className="link hist-conflicts" title="Later changes edited lines these changes wrote. Open the revert to settle them." onClick={() => onConflict(conflicted[0]!.noteId, conflicted[0]!.index)}>
                  {count(conflicted.length, "conflict")}
                </button>
              )}
            </>
          )}
        </p>
      </header>
      {error && <p role="alert" className="error">{error}</p>}
      {none ? (
        <p className="hist-hint">Tick changes to see what they did together, and where reverting them would not line up with later changes. Shift-click takes a range, and {MAC ? "⌘" : "Ctrl"}-click adds or skips one.</p>
      ) : (
        <div className={loading ? "hist-files loading" : "hist-files"} aria-busy={loading}>
          {notes.map((note) => (
            <NoteCard
              key={note.noteId}
              host={host}
              note={note}
              canEdit={canEdit(note.noteId)}
              onOpenNote={onOpenNote}
              onRevert={onRevert}
              onLabeled={onLabeled}
              onWanted={(noteId) => void fill(noteId)}
              conflicts={conflictsOf(note)}
              madeAt={(revision) => madeAt(note.noteId, revision)}
              onConflict={(index) => onConflict(note.noteId, index)}
            />
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

interface Props {
  host: PluginHost;
  /** The member, whose own changes read "You". */
  me: string;
  /** Whether the member may change a note. A selection can hold notes they may only read. */
  canEdit: (noteId: string) => boolean;
  /** What it is narrowed to. Null is every note and everyone. */
  scope: Scope | null;
  /** The page lays the list and what is picked side by side with room, and shows one at a time without. A panel is narrow: what is picked is under the list. */
  layout: "page" | "panel";
  /** Changes when any listed note does. */
  version: number;
  /** What it says where nothing was ever written. */
  empty: string;
  /** Widens or changes what the page is narrowed to. */
  onScope?: (scope: Scope | null) => void;
  /** Opens the page on what the panel lists. */
  onOpenHistory?: () => void;
  onOpenNote: (noteId: string) => void;
  /** Notes were reverted. The caller answers with a new `version`. */
  onChanged: () => void;
  /** Called with the latest changes each time they are read. */
  onLoaded?: (changes: HistoryEntry[]) => void;
  /** Called with the notes that have a change ticked, each time those change. */
  onTicked?: (noteIds: string[]) => void;
  /** What was ticked here when it was last left, for as long as the app is open. */
  left: Left;
  /** A change to show as if its row had been clicked, reading older changes until it is listed. `onPicked` is called once it is shown, or once there is none. */
  pick?: number | null;
  onPicked?: () => void;
  /** Controls of the panel's own, beside its link to the page. */
  tools?: ReactNode;
}

/** What History keeps of one place it is shown at, between leaving it and coming back: the ticks, and how far the list was read. */
export interface Kept {
  selection: Selection;
  read: number;
}

/** Where one History keeps that. */
export interface Left {
  get: () => Kept | undefined;
  set: (kept: Kept) => void;
}

const isView = (v: unknown): v is View => v === "time" || v === "note";
const WHO: readonly [Who, string][] = [
  ["everyone", "Everyone"],
  ["people", "People"],
  ["agents", "Agents"],
];

/**
 * History, wherever it is shown: the page, and the inspector's tab for a note or a folder. The
 * list has every change under its day with a tick: click one to see it, tick or ⌘-click to add or
 * skip, shift-click for a range, and a day's tick for the whole day. Nothing is ticked but by the
 * member, and what they ticked is there when they come back. What everything ticked did is beside
 * the list or under it, note by note, and at the list's foot is what to do with it: clear it, or
 * revert it.
 */
export function History({ host, me, canEdit, scope, layout, version, empty, onScope, onOpenHistory, onOpenNote, onChanged, onLoaded, onTicked, left, pick, onPicked, tools }: Props) {
  const ids = useId();
  const now = useNow();
  const [keptView, setView] = useKept<View>(host.storage, layout === "page" ? "view" : "view.panel", isView, layout === "page" ? "time" : "note");
  const [who, setWho] = useState<Who>("everyone");
  const author = scope && "author" in scope ? scope.author : null;
  const noteIds = scope && "noteIds" in scope ? scope.noteIds : null;
  const one = scope !== null && "one" in scope && scope.one === true;
  const view = one ? "time" : keptView;
  const narrowed = JSON.stringify(author ? { authors: [author] } : { ...(noteIds ? { noteIds } : {}), ...(who === "everyone" ? {} : { by: who }) });
  const narrowing = useMemo(() => JSON.parse(narrowed) as Narrowing, [narrowed]);

  const [reloads, reload] = useState(0);
  const [was] = useState(() => left.get());
  const data = useChanges(host, narrowing, version + reloads, was?.read ?? 0);
  const [selection, setPicked] = useState<Selection>(was?.selection ?? NOTHING);
  const [cut, setCut] = useState(false);
  /** Picks, with no more of one note than a request takes: the rest are left out, which the list says. */
  const setSelection = (next: Selection | ((was: Selection) => Selection)) =>
    setPicked((was) => {
      const made = within(typeof next === "function" ? next(was) : next);
      setCut(made.cut);
      return made.selection;
    });
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

  const tickedIn = [...selection].filter(([, revisions]) => revisions.size > 0).map(([noteId]) => noteId).sort().join();
  const tellTicked = useRef(onTicked);
  tellTicked.current = onTicked;
  useEffect(() => tellTicked.current?.(tickedIn ? tickedIn.split(",") : []), [tickedIn]);

  const timeline = useMemo(() => groupSaves(data.changes ?? []), [data.changes]);
  const known = useMemo(() => new Map((data.changes ?? []).map((c) => [keyOf(c.noteId, c.revision), c])), [data.changes]);

  // Whatever changes the list picks nothing: what is picked and still listed stays picked, and the rest is let go.
  useEffect(() => {
    if (data.changes) setSelection((was) => kept(was, (noteId, revision) => known.has(keyOf(noteId, revision))));
  }, [known]);

  const isTree = view === "note";
  const days = useMemo(
    () =>
      byDay(timeline).map((day) => ({
        ...day,
        id: `${ids}-day-${day.at}`,
        items: isTree
          ? notesOf(day.rows).flatMap((note): Item[] => {
              const key = `${day.at}/${note.noteId}`;
              return [{ kind: "note", id: `${ids}-${key}`, key, note }, ...(open.has(key) ? note.rows.map((row): Item => ({ kind: "row", id: `${ids}-${row.key}`, row })) : [])];
            })
          : day.rows.map((row): Item => ({ kind: "row", id: `${ids}-${row.key}`, row })),
      })),
    [timeline, isTree, open, ids],
  );
  const items = useMemo(() => days.flatMap((day) => day.items), [days]);
  const ready = data.changes !== null;

  const showOnly = (item: Item) => {
    setCursor(item.id);
    setAnchor(item.id);
    setCapped(false);
    if (item.kind === "note") setOpen((was) => new Set(was).add(item.key));
    setSelection(only(rowsOf(item)));
  };
  /** Adds the rows to what is picked, or takes them out when all of them are in it. */
  const tick = (rows: readonly Row[]) => {
    setCapped(false);
    setSelection((was) => withRows(was, rows, picked(was, rows) !== "all"));
  };
  const toggle = (item: Item) => {
    setCursor(item.id);
    setAnchor(item.id);
    tick(rowsOf(item));
  };
  const extendTo = (item: Item) => {
    const to = items.indexOf(item);
    // A range starts at the row itself when the one it was to start from is no longer listed.
    const anchored = items.findIndex((i) => i.id === anchor);
    const from = anchored < 0 ? to : anchored;
    const range = items.slice(Math.min(from, to), Math.max(from, to) + 1).flatMap(rowsOf);
    setCursor(item.id);
    setSelection((was) => withRows(was, range, true));
  };

  const leaving = useRef(left);
  leaving.current = left;
  const read = data.changes?.length;
  useEffect(() => {
    if (read !== undefined) leaving.current.set({ selection, read });
  }, [selection, read]);

  const everything = picked(selection, timeline);
  const selectAll = () => {
    if (everything === "all") {
      setCapped(false);
      return setSelection(NOTHING);
    }
    const taken: Row[] = [];
    let size = 0;
    for (const row of timeline) {
      if (size + row.revisions.length > MOST_SELECTED) break;
      taken.push(row);
      size += row.revisions.length;
    }
    setCapped(taken.length < timeline.length);
    setSelection(only(taken));
  };

  const unfold = (item: Item, on?: boolean) => {
    if (item.kind !== "note") return;
    setOpen((was) => {
      const next = new Set(was);
      if (on ?? !next.has(item.key)) next.add(item.key);
      else next.delete(item.key);
      return next;
    });
  };

  const press = (item: Item, e: MouseEvent) => {
    listbox.current?.focus({ preventScroll: true });
    if (e.shiftKey) return extendTo(item);
    if (e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest(".hist-check")) return toggle(item);
    if ((e.target as HTMLElement).closest(".hist-caret")) {
      setCursor(item.id);
      return unfold(item);
    }
    showOnly(item);
    setDetail(true);
  };

  // A change asked for from elsewhere, such as a run of lines in Blame mode: shown as a click on its row shows it, once the list has been read as far back as it.
  const shownPick = useRef(onPicked);
  shownPick.current = onPicked;
  const olderFor = useRef<HistoryPage["next"]>(null);
  useEffect(() => {
    if (pick == null || !ready) return;
    const item = items.find((i) => i.kind === "row" && i.row.revisions.includes(pick));
    if (item) {
      showOnly(item);
      setDetail(true);
      requestAnimationFrame(() => document.getElementById(item.id)?.scrollIntoView({ block: "nearest" }));
    } else if (data.next) {
      if (olderFor.current !== data.next) void data.older();
      olderFor.current = data.next;
      return;
    }
    shownPick.current?.();
  }, [pick, items, ready, data.next]);

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !items.length) return;
    // A day's tick is pressed with its own keys. Every other key is the list's from there too.
    if (e.target !== e.currentTarget && (e.key === " " || e.key === "Enter")) return;
    // With no row the cursor is on, the first key down goes to the first row.
    const at = items.findIndex((i) => i.id === cursor);
    const here = items[Math.max(0, at)]!;
    // Escape that would change nothing is left to where the list is, such as a panel over the page, which goes on it.
    if (e.key === "Escape" && (at < 0 || !sizeOf(selection) || sameSelection(selection, only(rowsOf(here))))) return;
    const go = (index: number) => {
      const to = items[Math.max(0, Math.min(items.length - 1, index))]!;
      if (e.shiftKey) extendTo(to);
      else showOnly(to);
      listbox.current?.focus({ preventScroll: true });
      requestAnimationFrame(() => document.getElementById(to.id)?.scrollIntoView({ block: "nearest" }));
    };
    const page = () => pageOf(e.currentTarget as HTMLElement, document.getElementById(here.id));
    const act: Record<string, () => void> = {
      j: () => go(at + 1),
      ArrowDown: () => go(at + 1),
      k: () => go(at - 1),
      ArrowUp: () => go(at - 1),
      Home: () => go(0),
      End: () => go(items.length - 1),
      PageDown: () => go(at + page()),
      PageUp: () => go(at - page()),
      x: () => toggle(here),
      " ": () => toggle(here),
      a: () => selectAll(),
      // Back from several to the one change the cursor is on. With nothing picked, or the cursor on no change, it picks nothing.
      Escape: () => at >= 0 && sizeOf(selection) > 0 && showOnly(here),
      Enter: () => onOpenNote(here.kind === "row" ? here.row.noteId : here.note.noteId),
      ArrowRight: () => unfold(here, true),
      ArrowLeft: () => unfold(here, false),
    };
    const fn = act[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  };

  const counted = useMemo(() => {
    let changes = 0;
    for (const [noteId, revisions] of selection) {
      const entries = [...revisions].sort((a, b) => b - a).map((r) => known.get(keyOf(noteId, r)));
      changes += groupSaves(entries.filter((c) => c !== undefined)).length + entries.filter((c) => c === undefined).length;
    }
    return { changes, saves: sizeOf(selection) };
  }, [selection, known]);
  const titleOfNote = (noteId: string) => data.changes?.find((c) => c.noteId === noteId)?.noteTitle ?? "";
  const asks = (): RevertAsk[] => asked(selection).map((c) => ({ noteId: c.noteId, title: titleOfNote(c.noteId), revisions: c.revisions }));
  /** The picked changes of notes the member may change, and what is said of the rest, which are left out of a revert. */
  const revertable = (): [RevertAsk[], string | undefined] => {
    const all = asks();
    const mine = all.filter((a) => canEdit(a.noteId));
    const out = all.length - mine.length;
    return [mine, out ? `${count(out, "note")} you can read and not change ${out === 1 ? "is" : "are"} left out.` : undefined];
  };

  const changed = () => {
    reload((n) => n + 1);
    onChanged();
  };
  const reverts = useReverts({ host, version, onChanged: changed });

  const switcher = !one && (
    <div className="segmented" role="radiogroup" aria-label="List">
      {(["time", "note"] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}>
          {v === "time" ? "By time" : "By note"}
        </button>
      ))}
    </div>
  );
  const head =
    layout === "page" ? (
      <div className="hist-head">
        <h1>History</h1>
        <p className="hist-sub">
          Click to see a change · {MAC ? "⌘" : "Ctrl"}-click to add or skip · shift-click for a range
        </p>
        <div className="hist-filters">
          {switcher}
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
              <button type="button" aria-label={author ? "Show everyone's changes" : "Show every note"} title={author ? "Show everyone's changes" : "Show every note"} onClick={() => onScope?.(null)}>
                <Icon name="close" />
              </button>
            </span>
          )}
        </div>
      </div>
    ) : (
      <div className="hist-filters">
        {switcher}
        {tools}
        <button type="button" className="link hist-open-page" onClick={onOpenHistory}>
          Open in History
        </button>
      </div>
    );

  const panes = (
    <div className={`history-panes ${layout}${detail ? " detail" : ""}`}>
      <div className="hist-side">
        {head}
        {data.error && <p role="alert" className="error">{data.error}</p>}
        {ready && items.length > 0 && (
          <div className="hist-all">
            <button type="button" role="checkbox" aria-checked={everything === "all" ? true : everything === "some" ? "mixed" : false} className="hist-all-tick" onClick={selectAll}>
              <span className={`hist-check ${everything}`} aria-hidden="true" />
              Select all
            </button>
            <span className="hist-all-count">
              {cut
                ? `The latest ${MOST_OF_A_NOTE} changes of a note are picked, no more`
                : capped
                  ? `The first ${MOST_SELECTED.toLocaleString()} changes are picked`
                  : `${count(data.changes?.length ?? 0, "change")}${data.next ? " so far" : ""}`}
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
          {ready && !items.length && <p className="empty">{who !== "everyone" || (layout === "page" && scope) ? "No changes match these filters." : empty}</p>}
          {days.map((day) => {
            const ticked = picked(selection, day.rows);
            return (
              <div key={day.at} role="group" aria-labelledby={day.id}>
                <div className="hist-day">
                  <button type="button" id={day.id} role="checkbox" aria-checked={ticked === "all" ? true : ticked === "some" ? "mixed" : false} className="hist-day-tick" onClick={() => tick(day.rows)}>
                    <span className={`hist-check ${ticked}`} aria-hidden="true" />
                    {dayLabel(day.at, now)}
                  </button>
                </div>
                {day.items.map((item) => {
                  if (item.kind === "row")
                    return (
                      <ChangeRow
                        key={item.id}
                        id={item.id}
                        row={item.row}
                        me={me}
                        named={!isTree && noteIds?.length !== 1}
                        role={isTree ? "treeitem" : "option"}
                        on={picked(selection, [item.row])}
                        focused={cursor === item.id}
                        onPress={(e) => press(item, e)}
                      />
                    );
                  const { note } = item;
                  const state = picked(selection, note.rows);
                  return (
                    <div
                      key={item.id}
                      id={item.id}
                      role="treeitem"
                      aria-level={1}
                      aria-expanded={open.has(item.key)}
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
                          <span>{count(note.saves, "change")}</span>
                          <span>{note.authors.map((a) => whoOf(a, me)).join(", ")}</span>
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {data.next && (
          <div className="hist-more">
            <button type="button" className="link" onClick={() => void data.older()}>
              Load older changes
            </button>
          </div>
        )}
        {sizeOf(selection) > 0 && (
          <div className="hist-picked" role="group" aria-label="Selection">
            <span className="hist-picked-count" role="status">
              {count(counted.changes, "change")} selected{selection.size > 1 && ` in ${count(selection.size, "note")}`}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="link"
              onClick={() => {
                setCapped(false);
                setSelection(NOTHING);
              }}
            >
              Clear
            </button>
            <button type="button" className="link hist-open" onClick={() => setDetail(true)}>
              See
            </button>
            {asked(selection).some((c) => canEdit(c.noteId)) && (
              <button type="button" className="button small" onClick={() => reverts.ask(...revertable())}>
                Revert…
              </button>
            )}
          </div>
        )}
      </div>
      <SelectionPane
        host={host}
        selection={selection}
        counted={counted}
        canEdit={canEdit}
        version={version + reloads}
        madeAt={(noteId, revision) => known.get(keyOf(noteId, revision))?.createdAt}
        onOpenNote={onOpenNote}
        onRevert={reverts.ask}
        onConflict={(noteId, conflict) => reverts.ask(...revertable(), { noteId, conflict })}
        onLabeled={() => reload((n) => n + 1)}
        onBack={() => setDetail(false)}
      />
      {reverts.shown}
    </div>
  );
  return layout === "page" ? (
    <section className="history-mode" aria-label="History">
      {panes}
    </section>
  ) : (
    panes
  );
}
