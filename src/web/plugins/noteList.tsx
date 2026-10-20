import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ALL_NOTES, Icon, NOTE_DRAG, SHARED_WITH_ME, ago, dayOf, folderTitle, parseQuery, queryNames, useDismiss, useInspected, useNow, type App, type Author, type Showing, type FolderProps, type NoteSummary, type Plugin, type PluginHost, type SearchMatch, type ViewProps } from "../plugin-api.ts";
import { reasonOf } from "./lib/FoundNote.tsx";
import { lifecycle } from "./lib/lifecycle.ts";
import { ContextMenu, type MenuItem } from "./lib/Menu.tsx";
import { QueryBar } from "./lib/QueryBar.tsx";
import { EXCERPT_HEIGHT, ITEM_ICONS, ITEM_LABELS, NEAR_PX, cardItems, editorLabel, editorsOf, estimatedHeight, shownHeight, type CardItem } from "./noteCard.ts";
import { NoteCrumbs } from "./NoteCrumbs.tsx";
import { INITIAL_VIEW, LIVES, ORDERS, fits, includeArchivedOf, lifeOf, listReducer, listed, notesIn, showOf, titleOf, withLife, type Life, type ListAction, type ListView } from "./noteListView.ts";
import { pieces } from "./search/marks.ts";
import { IDLE, againLimit, queryOf, reduce, type Ask } from "./search/request.ts";

/** How long typing rests before the search is asked, so a word is one search and not one a letter. */
const PAUSE_MS = 200;
/** How long the list waits before asking again a search the server answered while still indexing. Each ask indexes more. */
const INDEXING_PAUSE_MS = 1500;
const STILL_INDEXING = "Still indexing notes. Results may be missing some.";
const SYNTAX = 'words, "a phrase", #tag, is:archived';

/** How far below the top of the list a card's head is put when its note is cut back from further down. */
const HEAD_GAP = 10;
/** How long the list waits for more cards to come near before it asks who edited them, so a page of cards is one question. */
const EDITORS_PAUSE_MS = 80;
/** The most notes `history.summary` answers for at once. */
const EDITORS_AT_ONCE = 100;
/** How many cards past the ones drawn are asked about with them, so scrolling on slowly is not a question a card. */
const EDITORS_AHEAD = 20;
/** How long a card the member grew or cut back is left out of the list's scrolling to make up for a change of height. */
/** How long the list goes on returning to where it was left. One that has become shorter since never gets there. */
const RETURNING_MS = 1500;
const INFO_OVERLAY = "note-card-info";
/** The Sharing plugin's dialog, which is there while that plugin is on. */
const SHARE_OVERLAY = "share";
const SHARE_COMMAND = "sharing.share";
/** Roughly what a menu's row and its edges take, to keep a menu opened from a button inside the window. */
const MENU_ROW = 30;
const MENU_WIDTH = 190;

const withModifier = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey;

export interface FinderProps extends FolderProps {
  host: PluginHost;
  /** Whether each card shows the first part of its note. Without it a card is its title and what is under it, until the whole note is asked for. */
  snippets: boolean;
  /** How the list is set, and what sets it. Whoever draws the list says where that is kept: a folder's tab for as long as the app is open, the Search page in its address. */
  view: ListView;
  act: (action: ListAction) => void;
  /** Where the list was scrolled to the last time it was drawn and how tall each note it drew was, and where to keep how it is left now. */
  kept: Kept;
  /** What the list is called in place of its folder's name, as the Search page's is. */
  heading?: string;
  /** Whether the search field takes the keyboard when the list is drawn. */
  autoFocus?: boolean;
  /** Whether the inspector is about the notes listed, called by the heading and the query, as on the Search page. */
  inspected?: boolean;
  /** Takes the search out of this folder to every note, for a list that is of one folder. */
  onWiden?: () => void;
  /**
   * Whether Active, Archived and All sit under the search. A folder's list has them. The Search page
   * leaves them out. There the query is the one control, and those choices are written in it.
   */
  whichNotes?: boolean;
}

/** A matched line, as the characters it is: each match in a `<mark>`, and nothing in it read as markdown or HTML. */
function Line({ match }: { match: SearchMatch }) {
  return (
    <span className="found-line">
      {pieces(match.text, match.marks).map((piece, i) => (piece.marked ? <mark key={i}>{piece.text}</mark> : piece.text))}
    </span>
  );
}

/** A note in the list, and when it was found by a search, the lines of it that matched. */
interface Item {
  note: NoteSummary;
  matches: readonly SearchMatch[];
}

/** What is remembered of a list between drawings of it. A note's height is the whole of it as it was last drawn. */
export interface Kept {
  scrollTop: number;
  heights: Map<string, number>;
}

/**
 * A card's note, and what is under it. Until the card comes near the list's window there is no
 * note in it, only room of the height it is expected to take, so a long list costs what is on
 * screen and its scrollbar doesn't jump as notes arrive. A note is cut off at a height and fades
 * out there. One shorter than that is all there already: it doesn't fade and there is no more to ask for.
 */
function CardBody({ shown, whole, near, expected, onHeight, children, foot }: { shown: boolean; whole: boolean; near: boolean; expected: number; onHeight: (full: number) => void; children: () => ReactNode; foot: (more: boolean) => ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState<number | null>(null);
  const drawn = shown && near;
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => {
      // Nothing is there until the note has been read.
      if (!el.offsetHeight) return;
      setFull(el.offsetHeight);
      onHeight(el.offsetHeight);
    };
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, [drawn]);
  const height = drawn && full !== null ? full : expected;
  return (
    <>
      {shown && (
        <div
          className="card-body"
          data-cut={(drawn && height > EXCERPT_HEIGHT && !whole) || undefined}
          data-pending={!drawn || full === null || undefined}
          style={{ maxHeight: whole ? undefined : EXCERPT_HEIGHT, minHeight: drawn && full !== null ? undefined : shownHeight(expected, whole) }}
        >
          {drawn && <div ref={inner}>{children()}</div>}
        </div>
      )}
      <footer className="card-foot">{foot(!shown || height > EXCERPT_HEIGHT)}</footer>
    </>
  );
}

/** Copies text, as a press on a button may. A preview served over plain http has no Clipboard API, and copies from a field made for the moment. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.body.appendChild(document.createElement("textarea"));
    field.value = text;
    field.select();
    document.execCommand("copy");
    field.remove();
  }
}

/** What a card's menu says of its note beyond the card: where it is, when it was made and changed, and everyone who has edited it. */
function CardInfo({ host, app, close, state }: ViewProps & { host: PluginHost; close: () => void; state: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow();
  useDismiss(close, ref);
  const noteId = typeof state === "object" && state && "noteId" in state && typeof state.noteId === "string" ? state.noteId : null;
  const note = app.notes?.find((n) => n.id === noteId);
  const [authors, setAuthors] = useState<readonly Author[] | null>(null);
  const revision = note?.revision;
  useEffect(() => {
    if (!noteId) return;
    let live = true;
    host.perform({ type: "history.summary", noteIds: [noteId], limit: 1 }).then(
      ({ notes }) => live && setAuthors(notes[0]?.authors ?? []),
      () => live && setAuthors([]),
    );
    return () => {
      live = false;
    };
  }, [host, noteId, revision]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    // The keyboard goes back to the menu's button the dialog was opened from.
    return () => document.querySelector<HTMLElement>(`[data-note="${noteId}"] .card-menu`)?.focus();
  }, [noteId]);
  if (!note) return null;
  const name = titleOf(note);
  return (
    <div ref={ref} className="share-dialog card-info" role="dialog" aria-label={`Info for ${name}`}>
      <header className="share-head">
        <h2>{name}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </header>
      <dl className="info share-body">
        <dt>Folder</dt>
        <dd>{app.folders?.pathName(note.folderId)}</dd>
        <dt>Created</dt>
        <dd>{ago(note.createdAt, now)}</dd>
        <dt>Last edited</dt>
        <dd>
          {ago(note.updatedAt, now)} by {note.updatedBy.name}
        </dd>
        <dt>Edited by</dt>
        <dd>
          <ul className="card-info-editors" aria-label="Edited by">
            {editorsOf(note, authors ?? undefined).all.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </dd>
        {note.state === "archived" && (
          <>
            <dt>State</dt>
            <dd>Archived: left out of listings unless they include archived notes.</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** Where a new note made from a folder's list goes, or null where the member can't make one there. */
function folderForNew(app: App, folderId: string) {
  const target = folderId === ALL_NOTES ? app.folders?.unsortedId : folderId === SHARED_WITH_ME ? null : folderId;
  return target && app.folders?.byId.get(target)?.access === "edit" ? target : null;
}

/**
 * The app's list of notes with its search bar: a folder's notes, or every note, as cards. With
 * nothing typed it is the notes the app already holds, and nothing is asked of the server. With
 * something typed it is what the server's search finds in the folder, each card with the lines that matched.
 */
export function NoteFinder({ app, host, folderId, readNote, snippets, view, act, kept, heading, autoFocus, inspected, onWiden, whichNotes = true }: FinderProps) {
  const ids = useId();
  const now = useNow();
  const { setArchived, trash } = useMemo(() => lifecycle(host), [host]);
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(view.query);
  /** The query this list last set. Any other one in its view came from outside, as from the address, and is shown in the field. */
  const written = useRef(view.query);
  const [search, dispatch] = useReducer(reduce, IDLE);
  /** The menu that is open: a card's, or the folders one of its notes can be moved to. */
  const [menu, setMenu] = useState<{ noteId: string; x: number; y: number; of: "note" | "folders" } | null>(null);
  /** What had the keyboard when the menu was opened, which gets it back when the menu closes. */
  const menuFrom = useRef<HTMLElement | null>(null);
  /** The cards that have come near the list's window, whose notes are drawn. One that has been drawn stays drawn, so nothing running in it stops as it is scrolled away. */
  /** For each private note whose menu was opened, whether the server lets this person share it. */
  const [mayShare, setMayShare] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
  /** Everyone who has edited each note that is drawn, as of the revision it was asked at. */
  const [editors, setEditors] = useState<ReadonlyMap<string, readonly Author[]>>(() => new Map());
  const askedAt = useRef(new Map<string, number>());
  const [error, setError] = useState<string | null>(null);
  /** The card the arrow keys last came to, which is the one Tab comes back to. */
  const [atId, setAtId] = useState<string | null>(null);
  const scroller = useRef<HTMLElement>(null);
  /** A card just made shorter, whose head is brought back into sight if that left it above the list. */
  const shortened = useRef<string | null>(null);
  /**
   * The card the member last grew or cut back, which the list doesn't scroll to make up for until the
   * member next scrolls, clicks or types: the note it grows by can be read seconds after the click.
   */
  const toggled = useRef<string | null>(null);

  const title = app.folders && folderTitle(app.folders, folderId);
  const inFolder = app.notes && notesIn(app.notes, folderId);
  const ready = !!inFolder && !!title;
  /** A list of one folder says so in its search field. Every note, and what was shared with a guest, are of no one folder. */
  const scoped = folderId !== ALL_NOTES && folderId !== SHARED_WITH_ME;

  useEffect(() => {
    if (autoFocus && ready) field.current?.focus();
  }, [autoFocus, ready]);
  useEffect(() => {
    if (view.query === written.current) return;
    written.current = view.query;
    setTyped(view.query);
  }, [view.query]);
  const wanted = queryOf(typed);
  const setQuery = (text: string) => {
    written.current = text;
    act({ type: "query", text });
    act({ type: "show", show: showOf(lifeOf(text)) });
  };
  const chooseLife = (life: Life) => {
    const next = withLife(typed, life);
    setTyped(next);
    setQuery(next);
  };
  useEffect(() => {
    if (wanted === view.query) return;
    const timer = setTimeout(() => setQuery(wanted), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [wanted, view.query]);

  // A query that can't be read yet is not asked, and one that names no word and no filter, such as a sort: alone, is the folder's own notes.
  const read = useMemo(() => parseQuery(view.query, "notes"), [view.query]);
  const asked = read.ok && read.query.where ? view.query : "";
  const order = read.ok && !read.query.where ? read.query.sort : null;
  /** The states the query itself asks for, which are then listed whatever Open, Archived or All is set to. */
  const namesArchived = read.ok && queryNames(read.query.where, "archived");
  const namesTrashed = read.ok && queryNames(read.query.where, "trashed");
  const namesOpen = read.ok && queryNames(read.query.where, "open");
  /** The notes a search is of, which a query naming archived notes widens to them. */
  const count = inFolder ? listed(inFolder, { ...INITIAL_VIEW, show: namesArchived && view.show === "open" ? "all" : view.show }).length : 0;
  const days = { today: dayOf(new Date(now)), zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const ask = useMemo<Ask>(
    () => ({ query: ready ? asked : "", ...(scoped && { folderId }), includeArchived: includeArchivedOf(view.show), hasTodos: view.hasTodos, sort: view.sort ?? "match" }),
    [ready, asked, scoped, folderId, view.show, view.hasTodos, view.sort],
  );
  const find = (asked: Ask, after: string | null = null) => {
    dispatch(after ? { type: "moreAsked" } : { type: "asked", ask: asked });
    if (!asked.query) return;
    host.perform({ type: "search", ...asked, ...days, ...(after && { after }) }).then(
      ({ results, next, indexing }) => dispatch({ type: "answered", ask: asked, after, results, next, indexing }),
      (err: unknown) => dispatch({ type: "refused", ask: asked, after, message: reasonOf(err) }),
    );
  };
  useEffect(() => find(ask), [host, ask]);

  const found = search.status === "listed" ? search : null;
  const partial = found?.indexing && found.more !== "asking" ? found : null;
  const partialAsk = partial?.ask;
  const partialResults = partial?.results;
  useEffect(() => {
    if (!partialAsk || !partialResults) return;
    let left = false;
    let timer: ReturnType<typeof setTimeout>;
    const again = () => {
      timer = setTimeout(() => {
        host.perform({ type: "search", ...partialAsk, ...days, limit: againLimit(partialResults.length) }).then(
          ({ results, next, indexing }) => !left && dispatch({ type: "reanswered", ask: partialAsk, results, next, indexing }),
          // The results on show stay, and the server is asked once more after the same pause.
          () => !left && again(),
        );
      }, INDEXING_PAUSE_MS);
    };
    again();
    return () => {
      left = true;
      clearTimeout(timer);
    };
  }, [host, partialAsk, partialResults]);

  /**
   * What is listed. A search's results are the server's, each shown as the app holds the note now,
   * so one archived or trashed since leaves the list at once. While the first answer is on its way
   * the folder's notes stay on show.
   */
  const items = useMemo<Item[]>(() => {
    if (!inFolder) return [];
    if (search.status === "failed") return [];
    const results = search.status === "listed" ? search.results : search.status === "searching" ? search.before : null;
    if (!results) {
      const own = listed(inFolder, view);
      return (order && ORDERS[order] ? own.sort(ORDERS[order]) : own).map((note) => ({ note, matches: [] }));
    }
    const held = new Map(app.notes!.map((n) => [n.id, n]));
    const gone = new Set(app.trashed.map((n) => n.id));
    return results.flatMap(({ note, matches }) => {
      const current = held.get(note.id) ?? (gone.has(note.id) && !namesTrashed ? null : note);
      if (!current) return [];
      // A query that names where notes are in their life is the server's word on each, until one is moved on since: then it stays only where the query names its new place.
      const named = namesArchived || namesTrashed;
      const stated = current.state === note.state || (namesArchived && current.state === "archived") || (namesTrashed && current.state === "trashed") || (namesOpen && current.state === "live");
      const fitting = named ? stated && (!view.hasTodos || current.openTodos > 0) : fits(view, current);
      // What was shared with a guest is of no folder the server can be asked for, so it is picked out of every note found.
      return fitting && (folderId !== SHARED_WITH_ME || current.folderId === null) ? [{ note: current, matches }] : [];
    });
  }, [inFolder, search, view.show, view.hasTodos, view.sort, order, namesArchived, namesTrashed, namesOpen, app.notes, app.trashed, folderId]);
  const notes = items.map((item) => item.note);
  // History is then the history of the notes found, and Info counts them, each following the query.
  // Told only once the list answers its query: while a search is on its way it says what it said before.
  const told = useRef<Showing | null>(null);
  if (inFolder && (!asked || (search.status === "listed" && search.ask.query === asked))) {
    told.current = { kind: "notes", label: [heading ?? "Notes", view.query.trim()].filter(Boolean).join(": "), noteIds: notes.map((n) => n.id).sort() };
  }
  useInspected(app, inspected ? told.current : null);

  const listedIds = notes.map((n) => n.id).join();
  /**
   * Which cards are near the window, and what a card does to the list when its height changes, as
   * when its note arrives. A card above the window scrolls the list by as much, so what is being
   * read stays where it is. The card with the keyboard keeps its bottom on screen.
   */
  useEffect(() => {
    const el = scroller.current;
    if (!ready || !el) return;
    const near = new IntersectionObserver(
      (entries) => {
        const came = entries.filter((entry) => entry.isIntersecting).map((entry) => (entry.target as HTMLElement).dataset.card!);
        if (came.length) setDrawn((was) => (came.every((id) => was.has(id)) ? was : new Set([...was, ...came])));
      },
      { root: el, rootMargin: `${NEAR_PX}px 0px` },
    );
    const heights = new Map<Element, number>();
    const sized = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // A card that has left the list is told of once more, with no height and no place.
        if (!entry.target.isConnected) continue;
        const height = entry.borderBoxSize[0]!.blockSize;
        const was = heights.get(entry.target);
        heights.set(entry.target, height);
        if (was === undefined || was === height || returning.current !== null || (entry.target as HTMLElement).dataset.card === toggled.current) continue;
        const box = entry.target.getBoundingClientRect();
        const listBox = el.getBoundingClientRect();
        if (box.top < listBox.top) el.scrollTop += height - was;
        else if (entry.target.contains(document.activeElement) && box.bottom > listBox.bottom) el.scrollTop += box.bottom - listBox.bottom;
      }
    });
    for (const item of el.querySelectorAll("li[data-card]")) {
      near.observe(item);
      sized.observe(item);
    }
    return () => {
      near.disconnect();
      sized.disconnect();
    };
  }, [ready, listedIds]);

  const owed = (n: NoteSummary) => askedAt.current.get(n.id) !== n.revision;
  const lastDrawn = notes.findLastIndex((n) => drawn.has(n.id));
  const due = notes.filter((n) => drawn.has(n.id) && owed(n));
  /** Who is asked about: the drawn cards not yet asked about, and with them the next few down the list. */
  const unasked = due.length ? [...due, ...notes.slice(lastDrawn + 1).filter(owed).slice(0, EDITORS_AHEAD)] : [];
  const unaskedKey = unasked.map((n) => `${n.id}:${n.revision}`).join();
  useEffect(() => {
    if (!unasked.length) return;
    const timer = setTimeout(() => {
      for (const n of unasked) askedAt.current.set(n.id, n.revision);
      for (let from = 0; from < unasked.length; from += EDITORS_AT_ONCE) {
        const some = unasked.slice(from, from + EDITORS_AT_ONCE);
        /** The notes this answer is still the latest question about. */
        const current = () => some.filter((n) => askedAt.current.get(n.id) === n.revision);
        host.perform({ type: "history.summary", noteIds: some.map((n) => n.id), limit: EDITORS_AT_ONCE }).then(
          ({ notes: changed }) => {
            const found = new Map(changed.map((c) => [c.noteId, c.authors]));
            setEditors((was) => new Map([...was, ...current().map((n) => [n.id, found.get(n.id) ?? []] as const)]));
          },
          // The card goes on naming who the listing says changed the note last, and is asked about again with the next cards.
          () => current().forEach((n) => askedAt.current.delete(n.id)),
        );
      }
    }, EDITORS_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [host, unaskedKey]);

  /**
   * Where the list was scrolled to when it was last drawn. It goes back there as its cards
   * read their notes, until it is there or the member scrolls it themself.
   */
  const returning = useRef<number | null>(kept.scrollTop || null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!ready || !el || returning.current === null) return;
    const settle = () => {
      if (returning.current === null) return;
      el.scrollTop = returning.current;
      if (Math.abs(el.scrollTop - returning.current) < 1) returning.current = null;
    };
    settle();
    const watching = new ResizeObserver(settle);
    watching.observe(el.firstElementChild!);
    const givingUp = setTimeout(takeOver, RETURNING_MS);
    return () => {
      watching.disconnect();
      clearTimeout(givingUp);
    };
  }, [ready]);
  const takeOver = () => void (returning.current = null);
  const memberMoves = () => {
    takeOver();
    toggled.current = null;
  };

  useLayoutEffect(() => {
    const card = shortened.current && scroller.current?.querySelector<HTMLElement>(`[data-note="${shortened.current}"]`);
    shortened.current = null;
    if (!card || !scroller.current) return;
    const above = card.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top;
    if (above < 0) scroller.current.scrollTop += above - HEAD_GAP;
  });

  if (!app.folders || !app.notes)
    return app.listingFailed ? (
      <div className="notice" role="alert">
        <p>Couldn't load your notes.</p>
        <button type="button" className="button small" onClick={app.refresh}>
          Try again
        </button>
      </div>
    ) : null;
  if (!title) return <p className="notice">This folder doesn't exist, or you can't see it.</p>;

  const newIn = folderForNew(app, folderId);
  const open = (note: NoteSummary, how: "preview" | "keep" | "behind") =>
    how === "behind" ? app.openNote(note.id, { background: true }) : app.openNote(note.id, { preview: how === "preview", focus: true });
  const wholeOrLess = (noteId: string) => {
    toggled.current = noteId;
    if (view.whole[noteId]) shortened.current = noteId;
    act({ type: "wholeOrLess", noteId });
  };
  const card = (noteId: string) => scroller.current?.querySelector<HTMLElement>(`[data-note="${noteId}"]`);
  /** Gives the keyboard to the card after one that is about to leave the list, so the next press is for the next note. */
  const toNext = (at: number) => {
    const next = notes[at + 1] ?? notes[at - 1];
    if (!next) return;
    setAtId(next.id);
    // It is about to be where the card that leaves is now, so the list is not scrolled to it where it is.
    card(next.id)?.focus({ preventScroll: true });
  };
  /** Archives a note, or brings an archived one back. */
  const archiveOrNot = (note: NoteSummary, at: number) => {
    // The card stays where the query names the place the note goes to: an unarchived note is open, which a query naming no place lists.
    const stays = note.state === "archived" ? namesOpen || !(namesArchived || namesTrashed) : namesArchived;
    if (!stays) toNext(at);
    void setArchived(note.id, note.state !== "archived");
  };

  const onCardKey = (e: KeyboardEvent, note: NoteSummary, at: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = notes[at + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      setAtId(next.id);
      card(next.id)?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(note, withModifier(e) ? "behind" : "preview");
    } else if (e.key === "e" && !e.metaKey && !e.ctrlKey && !e.altKey && note.access === "edit") {
      e.preventDefault();
      archiveOrNot(note, at);
    }
  };

  const status =
    search.status === "searching"
      ? "Searching…"
      : found
        ? `${notes.length}${found.next === null ? "" : "+"} of ${count} ${count === 1 ? "note" : "notes"}`
        : `${count} ${count === 1 ? "note" : "notes"}`;
  /** How a search that left archived notes out has them: by its query on the Search page, by All on a folder's list. */
  const leftOut = view.show !== "open" || namesArchived || namesTrashed ? "" : " Archived notes are left out: add is:archived to search them.";
  const nothing = found
    ? `No notes match “${found.ask.query}”${scoped ? ` in ${title}` : ""}.${leftOut}`
    : count
      ? "No notes match."
      : view.show === "archived"
        ? "No archived notes here."
        : "No notes in this folder.";

  const details = (note: NoteSummary) => {
    const by = editorsOf(note, editors.get(note.id));
    return (
      <div className="card-details">
        {folderId === ALL_NOTES && <span className="card-folder">{app.folders!.pathName(note.folderId)}</span>}
        <span>edited {ago(note.updatedAt, now)}</span>
        <span className="card-editors" title={`Edited by ${by.all.join(", ")}`}>
          {by.shown.join(", ")}
          {by.more > 0 && ` +${by.more}`}
        </span>
      </div>
    );
  };

  const targets = [...app.folders.byId.values()].filter((f) => f.access === "edit").map((f) => ({ id: f.id, name: app.folders!.pathName(f.id) })).sort((a, b) => a.name.localeCompare(b.name));
  const itemsOf = (note: NoteSummary) =>
    cardItems(note, {
      standing: host.workspace.role,
      sharing: host.commands.list().some((c) => c.id === SHARE_COMMAND),
      splits: !!app.openBeside,
      targets: targets.filter((t) => t.id !== note.folderId).length,
      mayShare: mayShare.get(note.id),
    });
  const runs = (note: NoteSummary, at: { x: number; y: number }): Record<CardItem, () => void> => ({
    share: () => app.toggleOverlay(SHARE_OVERLAY, { noteId: note.id }),
    move: () => setMenu({ noteId: note.id, ...at, of: "folders" }),
    copyLink: () => void copyText(`${location.origin}${app.notePath(note.id)}`).then(() => app.notify({ message: "Link copied" })),
    splitRight: () => app.openBeside?.({ kind: "note", id: note.id }, "right"),
    splitDown: () => app.openBeside?.({ kind: "note", id: note.id }, "down"),
    info: () => app.toggleOverlay(INFO_OVERLAY, { noteId: note.id }),
    archive: () => archiveOrNot(note, notes.indexOf(note)),
    unarchive: () => archiveOrNot(note, notes.indexOf(note)),
    trash: () => {
      toNext(notes.indexOf(note));
      void trash(note.id);
    },
  });
  const menuItems = (note: NoteSummary, at: { x: number; y: number }, of: "note" | "folders"): MenuItem[] =>
    of === "note"
      ? itemsOf(note).map((item) => ({ label: ITEM_LABELS[item], icon: ITEM_ICONS[item], action: runs(note, at)[item] }))
      : targets
          .filter((t) => t.id !== note.folderId)
          .map((t) => ({
            label: t.name,
            icon: "folders" as const,
            action: () => {
              if (folderId !== ALL_NOTES) toNext(notes.indexOf(note));
              void app.moveNote(note.id, t.id).catch((err: unknown) => app.notify({ message: reasonOf(err) }));
            },
          }));
  /**
   * Opens a card's menu. For a private note the server is asked first whether this person may share it,
   * so the menu opens with every item it will have and none arrives under the pointer.
   */
  const openMenu = (note: NoteSummary, at: { x: number; y: number }, from: HTMLElement) => {
    const show = () => {
      menuFrom.current = from;
      setMenu({ noteId: note.id, ...at, of: "note" });
    };
    if (!note.private || !host.commands.list().some((c) => c.id === SHARE_COMMAND)) return show();
    host.sharing
      .of({ noteId: note.id })
      .then(
        (sharing) => sharing.canShare || !!sharing.note?.canSetPrivate,
        () => false,
      )
      .then((may) => {
        setMayShare((was) => new Map(was).set(note.id, may));
        show();
      });
  };
  /** Opens a card's menu under its button, kept inside the window. */
  const menuUnder = (note: NoteSummary, button: HTMLElement) => {
    const at = button.getBoundingClientRect();
    const tall = (itemsOf(note).length + 1) * MENU_ROW;
    openMenu(note, { x: Math.max(8, at.right - MENU_WIDTH), y: at.bottom + 4 + tall > innerHeight ? Math.max(8, at.top - 4 - tall) : at.bottom + 4 }, button);
  };

  const menuNote = menu && notes.find((n) => n.id === menu.noteId);
  const tabStop = notes.some((n) => n.id === atId) ? atId : notes[0]?.id;

  return (
    <section
      className="folder-list"
      aria-labelledby={`${ids}-heading`}
      ref={scroller}
      onWheel={memberMoves}
      onPointerDown={memberMoves}
      onKeyDown={memberMoves}
      onScroll={(e) => {
        if (e.target === e.currentTarget && returning.current === null) kept.scrollTop = e.currentTarget.scrollTop;
      }}
    >
      <div className="folder-column">
        <header className="folder-head">
          <h1 id={`${ids}-heading`}>{heading ?? title}</h1>
          <span className="folder-count" aria-live="polite">
            {status}
          </span>
          {newIn && (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                setError(null);
                app.createNote(newIn).catch((err: Error) => setError(err.message));
              }}
            >
              <Icon name="plus" />
              New note
            </button>
          )}
        </header>
        <QueryBar
          host={host}
          app={app}
          scope="notes"
          value={typed}
          fieldRef={field}
          label="Search notes"
          placeholder={`${scoped ? "Search this folder" : "Search all notes"}: ${SYNTAX}`}
          lead={
            scoped && (
              <span className="finder-scope" title={`Searching the notes in ${title}, not those of the folders inside it`}>
                <span>{title}</span>
                {onWiden && (
                  <button type="button" aria-label={`Search all notes, not only ${title}`} title="Search all notes" onClick={onWiden}>
                    <Icon name="close" />
                  </button>
                )}
              </span>
            )
          }
          onChange={(text, how) => {
            setTyped(text);
            // A field emptied is the folder's notes again at once: they are here, and there is nothing to wait for. So is a query put there whole.
            if (!queryOf(text) || how === "set") setQuery(queryOf(text));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && notes[0]) {
              e.preventDefault();
              card(notes[0].id)?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              // Enter before the pause is over asks for what is typed. It never opens a result of the search before.
              if (wanted !== view.query) setQuery(wanted);
              else if (found && notes[0]) open(notes[0], "keep");
            }
          }}
        />
        {whichNotes && (
          <div className="segmented note-life" role="radiogroup" aria-label="Which notes">
            {LIVES.map((life) => (
              <label key={life.id}>
                <input
                  type="radio"
                  name={`${ids}-life`}
                  checked={lifeOf(typed) === life.id}
                  onClick={() => chooseLife(life.id)}
                  onChange={() => chooseLife(life.id)}
                />
                <span>{life.label}</span>
              </label>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {search.status === "failed" && (
          <p className="search-status" role="alert">
            {search.message}{" "}
            <button type="button" className="found-more" onClick={() => find(search.ask)}>
              Try again
            </button>
          </p>
        )}
        {found?.indexing && <p className="search-status">{STILL_INDEXING}</p>}
        <nav aria-label="Notes">
          {!notes.length && search.status !== "failed" && search.status !== "searching" && <p className="empty">{nothing}</p>}
          <ul className="cards" data-list aria-busy={search.status === "searching"}>
            {items.map(({ note, matches }, at) => {
              const whole = !!view.whole[note.id];
              const name = titleOf(note);
              const archived = note.state === "archived";
              const here = note.id === tabStop ? 0 : -1;
              return (
                <li key={note.id} data-card={note.id}>
                  <article
                    className={snippets || whole ? "card" : "card titled"}
                    data-note={note.id}
                    data-state={note.state === "archived" ? "archived" : undefined}
                    aria-labelledby={`${ids}-${note.id}`}
                    aria-current={note.id === app.noteId ? "page" : undefined}
                    tabIndex={here}
                    onFocus={(e) => e.target === e.currentTarget && setAtId(note.id)}
                    onKeyDown={(e) => onCardKey(e, note, at)}
                    onContextMenu={(e) => {
                      // The note's own text keeps the browser's menu, to copy from it or open a link in it.
                      if ((e.target as Element).closest(".card-body")) return;
                      e.preventDefault();
                      openMenu(note, { x: e.clientX, y: e.clientY }, e.currentTarget);
                    }}
                  >
                    <header
                      className="card-head"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(NOTE_DRAG, note.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      {/* The note under it is the card's title. This names the card for a screen reader and for the keyboard, and is not drawn, unless there is no note under it to say it. */}
                      <h2 className="card-title" id={`${ids}-${note.id}`}>
                        {name}
                      </h2>
                      {note.private && (
                        <span className="private-mark" title="Private">
                          <Icon name="lock" />
                        </span>
                      )}
                      {note.state === "archived" && <span className="state-label">Archived</span>}
                      {itemsOf(note).includes(archived ? "unarchive" : "archive") && (
                        <button
                          type="button"
                          className="icon-button card-quick-archive"
                          tabIndex={here}
                          aria-label={`${archived ? "Unarchive" : "Archive"} ${name}`}
                          title={archived ? "Unarchive (E)" : "Archive (E)"}
                          onClick={() => archiveOrNot(note, at)}
                        >
                          <Icon name={archived ? "unarchive" : "archive"} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button card-menu"
                        tabIndex={here}
                        aria-haspopup="menu"
                        aria-label={`More for ${name}`}
                        title="More"
                        onClick={(e) => (menu?.noteId === note.id ? setMenu(null) : menuUnder(note, e.currentTarget))}
                      >
                        <Icon name="more" />
                      </button>
                    </header>
                    {matches.length > 0 && (
                      <p className="card-matches">
                        {matches.map((match) => (
                          <Line key={match.line} match={match} />
                        ))}
                      </p>
                    )}
                    <CardBody
                      shown={snippets || whole}
                      whole={whole}
                      near={drawn.has(note.id)}
                      expected={kept.heights.get(note.id) ?? estimatedHeight(note)}
                      onHeight={(full) => void kept.heights.set(note.id, full)}
                      foot={(more) => (
                        <>
                          <a
                            href={app.notePath(note.id)}
                            className="button primary small"
                            data-row-open
                            tabIndex={here}
                            draggable={false}
                            aria-label={`Edit ${name}`}
                            title="Open to edit. ⌘-click, Ctrl-click or middle-click opens it in a background tab."
                            onClick={(e) => {
                              if (e.shiftKey || e.button !== 0) return;
                              e.preventDefault();
                              open(note, withModifier(e) ? "behind" : "preview");
                            }}
                            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                            onAuxClick={(e) => {
                              if (e.button !== 1) return;
                              e.preventDefault();
                              open(note, "behind");
                            }}
                          >
                            <Icon name="edit" />
                            Edit
                          </a>
                          {more && (
                            <button type="button" className="button small" data-row-toggle tabIndex={here} aria-expanded={whole} onClick={() => wholeOrLess(note.id)}>
                              {whole ? "Show less" : "Show whole note"}
                            </button>
                          )}
                          {details(note)}
                        </>
                      )}
                    >
                      {() => readNote(note.id)}
                    </CardBody>
                  </article>
                </li>
              );
            })}
          </ul>
        </nav>
        {found && found.next !== null && (
          <div className="search-more">
            <button type="button" className="found-more" disabled={found.more === "asking"} onClick={() => find(found.ask, found.next)}>
              {found.more === "asking" ? "Reading more…" : "More results"}
            </button>
            {typeof found.more === "object" && <span role="alert">{found.more.refused}</span>}
          </div>
        )}
      </div>
      {menu && menuNote && (
        <ContextMenu
          key={menu.of}
          label={menu.of === "note" ? `${titleOf(menuNote)} note` : `Move ${titleOf(menuNote)} to`}
          x={menu.x}
          y={menu.y}
          items={menuItems(menuNote, menu, menu.of)}
          onClose={() => {
            // An item that opens something takes the keyboard there after this.
            if (menuFrom.current?.isConnected) menuFrom.current.focus();
            setMenu((was) => (was === menu ? null : was));
          }}
        />
      )}
    </section>
  );
}

interface KeptList extends Kept {
  view: ListView;
}

/** How each folder's list was left, for as long as the app is open. A list drawn for a folder follows what is kept for it, whoever changed it. */
function keeping() {
  const kept = new Map<string, KeptList>();
  const listeners = new Set<() => void>();
  const of = (folderId: string) => {
    if (!kept.has(folderId)) kept.set(folderId, { view: INITIAL_VIEW, scrollTop: 0, heights: new Map() });
    return kept.get(folderId)!;
  };
  return {
    of,
    set(folderId: string, view: ListView) {
      if (of(folderId).view === view) return;
      of(folderId).view = view;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * The "…" at an open note's top right: what the note's card offers in a folder's list, but opening it
 * in a split, which the note already is wherever it is open. Gives the keyboard back to itself as it closes.
 */
function NoteMenu({ app, host, note }: ViewProps & { host: PluginHost; note: NoteSummary }) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; of: "note" | "folders"; mayShare?: boolean } | null>(null);
  const { setArchived, trash } = lifecycle(host);
  const sharing = host.commands.list().some((c) => c.id === SHARE_COMMAND);
  const targets = app.folders ? [...app.folders.byId.values()].filter((f) => f.access === "edit" && f.id !== note.folderId).map((f) => ({ id: f.id, name: app.folders!.pathName(f.id) })).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const close = () => {
    setMenu(null);
    button.current?.focus();
  };
  const open = () => {
    const box = button.current!.getBoundingClientRect();
    const at = { x: Math.max(8, box.right - MENU_WIDTH), y: box.bottom + 4, of: "note" as const };
    if (!note.private || !sharing) return setMenu(at);
    // A private note is its owner's to share, which only the server knows.
    host.sharing
      .of({ noteId: note.id })
      .then(
        (said) => said.canShare || !!said.note?.canSetPrivate,
        () => false,
      )
      .then((mayShare) => setMenu({ ...at, mayShare }));
  };
  const runs = (at: { x: number; y: number }): Record<CardItem, () => void> => ({
    share: () => app.toggleOverlay(SHARE_OVERLAY, { noteId: note.id }),
    move: () => setMenu({ ...at, of: "folders" }),
    copyLink: () => void copyText(`${location.origin}${app.notePath(note.id)}`).then(() => app.notify({ message: "Link copied" })),
    splitRight: () => {},
    splitDown: () => {},
    info: () => app.toggleOverlay(INFO_OVERLAY, { noteId: note.id }),
    archive: () => void setArchived(note.id, true),
    unarchive: () => void setArchived(note.id, false),
    trash: () => void trash(note.id),
  });
  const items: MenuItem[] = !menu
    ? []
    : menu.of === "note"
      ? cardItems(note, { standing: host.workspace.role, sharing, splits: false, targets: targets.length, mayShare: menu.mayShare }).map((item) => ({ label: ITEM_LABELS[item], icon: ITEM_ICONS[item], action: runs(menu)[item] }))
      : targets.map((t) => ({ label: t.name, icon: "folders" as const, action: () => void app.moveNote(note.id, t.id).catch((err: unknown) => app.notify({ message: reasonOf(err) })) }));
  return (
    <>
      <button ref={button} type="button" className="icon-button" aria-label="Note menu" title="More" aria-haspopup="menu" aria-expanded={menu !== null} onClick={() => (menu ? close() : open())}>
        <Icon name="more" />
      </button>
      {menu && <ContextMenu key={menu.of} label={menu.of === "note" ? "Note menu" : `Move ${titleOf(note)} to`} x={menu.x} y={menu.y} items={items} onClose={close} />}
    </>
  );
}

export const noteList: Plugin = {
  id: "note-list",
  name: "Note list",
  description: "A folder's notes as cards, each with the first part of its note drawn to be read, to sort and to filter, and the breadcrumbs above an open note.",
  icon: "list",
  settings: {
    snippets: { type: "boolean", default: true, title: "Show snippets", description: "Show the first part of each note on its card; with it off, a card shows the note's title." },
  },
  activate(host) {
    const kept = keeping();
    function FolderList(props: FolderProps) {
      const { folderId, app } = props;
      const view = useSyncExternalStore(kept.subscribe, () => kept.of(folderId).view);
      return (
        <NoteFinder
          {...props}
          host={host}
          snippets={host.settings.get<boolean>("snippets")}
          view={view}
          act={(action) => kept.set(folderId, listReducer(kept.of(folderId).view, action))}
          kept={kept.of(folderId)}
          onWiden={() => {
            // The search goes to every note as it is set here, and this folder's list is left as it is.
            const { query, show, sort, hasTodos } = kept.of(folderId).view;
            kept.set(ALL_NOTES, { ...kept.of(ALL_NOTES).view, query, show, sort, hasTodos });
            app.openFolder(ALL_NOTES);
          }}
        />
      );
    }
    host.views.register("folder", { id: "notes", component: FolderList });
    host.views.register("tool", { id: "menu", order: 1, component: (props) => <NoteMenu host={host} {...props} /> });
    host.views.register("notice", { id: "crumbs", component: (props) => <NoteCrumbs host={host} {...props} /> });
    host.views.register("overlay", { id: INFO_OVERLAY, component: (props) => <CardInfo host={host} {...props} /> });
  },
};
