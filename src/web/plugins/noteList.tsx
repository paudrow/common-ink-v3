import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ALL_NOTES, Icon, NOTE_DRAG, SHARED_WITH_ME, ago, dayOf, folderTitle, parseQuery, queryNames, useInspected, useNow, type App, type Showing, type FolderProps, type NoteSummary, type Plugin, type PluginHost, type SearchMatch } from "../plugin-api.ts";
import { reasonOf } from "./lib/FoundNote.tsx";
import { lifecycle } from "./lib/lifecycle.ts";
import { ContextMenu } from "./lib/Menu.tsx";
import { QueryBar } from "./lib/QueryBar.tsx";
import { INITIAL_VIEW, ORDERS, SHOWS, SORTS, fits, includeArchivedOf, listReducer, listed, notesIn, titleOf, type ListAction, type ListView, type Sort } from "./noteListView.ts";
import { pieces } from "./search/marks.ts";
import { IDLE, againLimit, queryOf, reduce, type Ask } from "./search/request.ts";

/** How long typing rests before the search is asked, so a word is one search and not one a letter. */
const PAUSE_MS = 200;
/** How long the list waits before asking again a search the server answered while still indexing. Each ask indexes more. */
const INDEXING_PAUSE_MS = 1500;
const STILL_INDEXING = "Still indexing notes. Results may be missing some.";
const SYNTAX = 'words, "a phrase", #tag, is:archived';

/** How far below the top of the list a card's head is put when its note is collapsed from further down. */
const HEAD_GAP = 10;

const withModifier = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey;

export interface FinderProps extends FolderProps {
  host: PluginHost;
  /** Whether each collapsed card shows the first lines of its note. */
  snippets: boolean;
  /** How the list is set, and what sets it. Whoever draws the list says where that is kept: a folder's tab for as long as the app is open, the Search page in its address. */
  view: ListView;
  act: (action: ListAction) => void;
  /** Where the list was scrolled to the last time it was drawn, and where to keep how it is left now. */
  kept: { scrollTop: number };
  /** What the list is called in place of its folder's name, as the Search page's is. */
  heading?: string;
  /** Whether the query is the list's one control, with no Open/Archived/All, Has todos or Sort beside it, as on the Search page. */
  queryOnly?: boolean;
  /** Whether the search field takes the keyboard when the list is drawn. */
  autoFocus?: boolean;
  /** Whether the inspector is about the notes listed, called by the heading and the query, as on the Search page. */
  inspected?: boolean;
  /** Takes the search out of this folder to every note, for a list that is of one folder. */
  onWiden?: () => void;
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

/** How tall an expanded card's note is drawn before the rest is asked for. */
const EXCERPT_HEIGHT = 300;

/**
 * An expanded card's note, and what is under it. An excerpt is cut off at a height and fades out
 * there; a note shorter than that is all there already, so it doesn't fade and there is no more to ask for.
 */
function CardBody({ whole, children, foot }: { whole: boolean; children: ReactNode; foot: (more: boolean) => ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = inner.current!;
    const measure = () => setTall(el.offsetHeight > EXCERPT_HEIGHT);
    measure();
    const watching = new ResizeObserver(measure);
    watching.observe(el);
    return () => watching.disconnect();
  }, []);
  return (
    <>
      <div className="card-body" data-cut={(tall && !whole) || undefined} style={whole ? undefined : { maxHeight: EXCERPT_HEIGHT }}>
        <div ref={inner}>{children}</div>
      </div>
      <footer className="card-foot">{foot(tall)}</footer>
    </>
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
export function NoteFinder({ app, host, folderId, readNote, snippets, view, act, kept, heading, queryOnly, autoFocus, inspected, onWiden }: FinderProps) {
  const ids = useId();
  const now = useNow();
  const { setArchived, items: menuFor } = useMemo(() => lifecycle(host), [host]);
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(view.query);
  /** The query this list last set. Any other one in its view came from outside, as from the address, and is shown in the field. */
  const written = useRef(view.query);
  const [search, dispatch] = useReducer(reduce, IDLE);
  const [menu, setMenu] = useState<{ noteId: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The card the arrow keys last came to, which is the one Tab comes back to. */
  const [atId, setAtId] = useState<string | null>(null);
  const scroller = useRef<HTMLElement>(null);
  /** A card just made shorter, whose head is brought back into sight if that left it above the list. */
  const shortened = useRef<string | null>(null);

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
  };
  useEffect(() => {
    if (wanted === view.query) return;
    const timer = setTimeout(() => setQuery(wanted), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [wanted, view.query]);

  const sort = view.sort ?? (view.query ? "match" : "recent");
  // A query that can't be read yet is not asked, and one that names no word and no filter, such as a sort: alone, is the folder's own notes.
  const read = useMemo(() => parseQuery(view.query, "notes"), [view.query]);
  const asked = read.ok && read.query.where ? view.query : "";
  const order = read.ok && !read.query.where ? read.query.sort : null;
  /** The states the query itself asks for, which are then listed whatever Open, Archived or All is set to. */
  const namesArchived = read.ok && queryNames(read.query.where, "archived");
  const namesTrashed = read.ok && queryNames(read.query.where, "trashed");
  /** The notes a search is of, which a query naming archived notes widens to them. */
  const count = inFolder ? listed(inFolder, { ...INITIAL_VIEW, show: namesArchived && view.show === "open" ? "all" : view.show }).length : 0;
  const days = { today: dayOf(new Date(now)), zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const ask = useMemo<Ask>(
    () => ({ query: ready ? asked : "", ...(scoped && { folderId }), includeArchived: includeArchivedOf(view.show), hasTodos: view.hasTodos, sort: view.sort ?? "match" }),
    [ready, asked, scoped, folderId, view.show, view.hasTodos, view.sort],
  );
  const find = (asked: Ask, offset = 0) => {
    dispatch(offset ? { type: "moreAsked" } : { type: "asked", ask: asked });
    if (!asked.query) return;
    host.perform({ type: "search", ...asked, ...days, offset }).then(
      ({ results, next, indexing }) => dispatch({ type: "answered", ask: asked, offset, results, next, indexing }),
      (err: unknown) => dispatch({ type: "refused", ask: asked, offset, message: reasonOf(err) }),
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
        host.perform({ type: "search", ...partialAsk, ...days, offset: 0, limit: againLimit(partialResults.length) }).then(
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
      const stated = (namesArchived && current.state === "archived") || (namesTrashed && current.state === "trashed");
      const fitting = fits(view, current) || (stated && (!view.hasTodos || current.openTodos > 0));
      // What was shared with a guest is of no folder the server can be asked for, so it is picked out of every note found.
      return fitting && (folderId !== SHARED_WITH_ME || current.folderId === null) ? [{ note: current, matches }] : [];
    });
  }, [inFolder, search, view.show, view.hasTodos, view.sort, order, namesArchived, namesTrashed, app.notes, app.trashed, folderId]);
  const notes = items.map((item) => item.note);
  // History is then the history of the notes found, and Info counts them, each following the query.
  // Told only once the list answers its query: while a search is on its way it says what it said before.
  const told = useRef<Showing | null>(null);
  if (inFolder && (!asked || (search.status === "listed" && search.ask.query === asked))) {
    told.current = { kind: "notes", label: [heading ?? "Notes", view.query.trim()].filter(Boolean).join(": "), noteIds: notes.map((n) => n.id).sort() };
  }
  useInspected(app, inspected ? told.current : null);

  /**
   * Where the list was scrolled to when it was last drawn. It goes back there as its expanded
   * cards read their notes and grow, until it is there or the member scrolls it themself.
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
    return () => watching.disconnect();
  }, [ready]);
  const takeOver = () => void (returning.current = null);

  useLayoutEffect(() => {
    const card = shortened.current && scroller.current?.querySelector<HTMLElement>(`[data-note="${shortened.current}"]`);
    shortened.current = null;
    if (!card || !scroller.current) return;
    const above = card.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top;
    if (above < 0) scroller.current.scrollTop += above - HEAD_GAP;
  });

  if (!app.folders || !app.notes) return null;
  if (!title) return <p className="notice">This folder doesn't exist, or you can't see it.</p>;

  const newIn = folderForNew(app, folderId);
  const open = (note: NoteSummary, how: "preview" | "keep" | "behind") =>
    how === "behind" ? app.openNote(note.id, { background: true }) : app.openNote(note.id, { preview: how === "preview", focus: true });
  const collapse = (noteId: string) => {
    shortened.current = noteId;
    act({ type: "collapse", noteId });
  };
  const wholeOrExcerpt = (noteId: string) => {
    shortened.current = noteId;
    act({ type: "wholeOrExcerpt", noteId });
  };
  const card = (noteId: string) => scroller.current?.querySelector<HTMLElement>(`[data-note="${noteId}"]`);
  /** Archives a note, or brings an archived one back. From the keyboard, the card after it takes the focus when this one leaves the list, so the next press is for the next note. */
  const archiveOrNot = (note: NoteSummary, at?: number) => {
    const archived = note.state !== "archived";
    const next = at === undefined || view.show === "all" ? null : (notes[at + 1] ?? notes[at - 1]);
    if (next) {
      setAtId(next.id);
      card(next.id)?.focus();
    }
    void setArchived(note.id, archived);
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
      if (withModifier(e)) open(note, "preview");
      else if (view.expanded[note.id]) collapse(note.id);
      else act({ type: "expandOrCollapse", noteId: note.id });
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
  const leftOut = view.show !== "open" || namesArchived || namesTrashed ? "" : queryOnly ? " Archived notes are left out: add is:archived to search them." : " Archived notes are left out: choose All to search them too.";
  const nothing = found
    ? `No notes match “${found.ask.query}”${scoped ? ` in ${title}` : ""}.${leftOut}`
    : count
      ? "No notes match."
      : view.show === "archived"
        ? "No archived notes here."
        : "No notes in this folder.";

  const details = (note: NoteSummary): ReactNode[] => [
    ...(folderId === ALL_NOTES ? [<span key="folder">{app.folders!.pathName(note.folderId)}</span>] : []),
    <span key="author">{note.updatedBy.name}</span>,
    <span key="edited">{ago(note.updatedAt, now)}</span>,
    ...(note.openTodos > 0 ? [<span key="todos">{note.openTodos} open</span>] : []),
    ...(note.state === "archived"
      ? [
          <span key="state" className="state-label">
            Archived
          </span>,
        ]
      : []),
  ];

  const menuNote = menu && notes.find((n) => n.id === menu.noteId);
  const tabStop = notes.some((n) => n.id === atId) ? atId : notes[0]?.id;

  return (
    <section
      className="folder-list"
      aria-labelledby={`${ids}-heading`}
      ref={scroller}
      onWheel={takeOver}
      onPointerDown={takeOver}
      onKeyDown={takeOver}
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
        {!queryOnly && (
          <div className="finder-tools">
            <div role="radiogroup" aria-label="Show" className="segmented">
              {SHOWS.map((s) => (
                <label key={s.id}>
                  <input type="radio" name={`${ids}-show`} checked={view.show === s.id} onChange={() => act({ type: "show", show: s.id })} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
            <button type="button" className="chip" aria-pressed={view.hasTodos} onClick={() => act({ type: "hasTodos" })}>
              Has todos
            </button>
            <label className="finder-sort">
              Sort
              <select
                aria-label="Sort by"
                value={sort}
                onChange={(e) => {
                  const picked = e.target.value as Sort | "match";
                  // The order a list has until one is picked is left unpicked, so a search made later is by its best match.
                  act({ type: "sort", sort: picked === "match" || (picked === "recent" && !view.query) ? null : picked });
                }}
              >
                {view.query && <option value="match">Best match</option>}
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
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
              const expanded = view.expanded[note.id];
              const name = titleOf(note);
              return (
                <li key={note.id}>
                  <article
                    className="card"
                    data-note={note.id}
                    data-expanded={expanded}
                    data-state={note.state === "archived" ? "archived" : undefined}
                    aria-labelledby={`${ids}-${note.id}`}
                    tabIndex={note.id === tabStop ? 0 : -1}
                    draggable={!expanded}
                    onFocus={(e) => e.target === e.currentTarget && setAtId(note.id)}
                    onKeyDown={(e) => onCardKey(e, note, at)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(NOTE_DRAG, note.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={(e) => {
                      if (expanded || e.button !== 0) return;
                      if (withModifier(e)) open(note, "behind");
                      else act({ type: "expandOrCollapse", noteId: note.id });
                    }}
                    onMouseDown={(e) => e.button === 1 && !expanded && e.preventDefault()}
                    onAuxClick={(e) => e.button === 1 && !expanded && open(note, "behind")}
                    onContextMenu={(e) => {
                      // The note's own text keeps the browser's menu, to copy from it or open a link in it.
                      if ((e.target as Element).closest(".card-body")) return;
                      e.preventDefault();
                      setMenu({ noteId: note.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <header className="card-head" onClick={() => expanded && collapse(note.id)}>
                      <div className="card-top">
                        <a
                          href={app.notePath(note.id)}
                          className="card-title"
                          id={`${ids}-${note.id}`}
                          title="Open to edit. ⌘-click, Ctrl-click or middle-click opens it in a background tab."
                          draggable={false}
                          aria-current={note.id === app.noteId ? "page" : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (e.shiftKey || e.button !== 0) return;
                            e.preventDefault();
                            open(note, withModifier(e) ? "behind" : "preview");
                          }}
                          onAuxClick={(e) => {
                            if (e.button !== 1) return;
                            e.preventDefault();
                            e.stopPropagation();
                            open(note, "behind");
                          }}
                        >
                          {note.private && (
                            <span className="private-mark" title="Private">
                              <Icon name="lock" />
                            </span>
                          )}
                          {name}
                        </a>
                        {note.access === "edit" && (
                          <button
                            type="button"
                            className="icon-button card-archive"
                            tabIndex={-1}
                            aria-label={`${note.state === "archived" ? "Unarchive" : "Archive"} ${name}`}
                            title={`${note.state === "archived" ? "Unarchive" : "Archive"} (E)`}
                            onClick={(e) => {
                              e.stopPropagation();
                              archiveOrNot(note);
                            }}
                          >
                            <Icon name={note.state === "archived" ? "unarchive" : "archive"} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-button card-edit"
                          tabIndex={-1}
                          aria-label={`Edit ${name}`}
                          title="Open to edit"
                          onClick={(e) => {
                            e.stopPropagation();
                            open(note, "keep");
                          }}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          type="button"
                          className="icon-button card-chevron"
                          tabIndex={-1}
                          aria-expanded={!!expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (expanded) collapse(note.id);
                            else act({ type: "expandOrCollapse", noteId: note.id });
                          }}
                        >
                          <Icon name="chevron" />
                        </button>
                      </div>
                      <div className="card-details">{details(note)}</div>
                    </header>
                    {!expanded &&
                      (matches.length ? (
                        <p className="card-matches">
                          {matches.map((match) => (
                            <Line key={match.line} match={match} />
                          ))}
                        </p>
                      ) : (
                        snippets && note.snippet && <p className="card-preview">{note.snippet}</p>
                      ))}
                    {expanded && (
                      <CardBody
                        whole={expanded === "whole"}
                        foot={(more) => (
                          <>
                            <button type="button" className="button primary small" onClick={() => open(note, "keep")}>
                              <Icon name="edit" />
                              Edit
                            </button>
                            {more && (
                              <button type="button" className="button small" onClick={() => wholeOrExcerpt(note.id)}>
                                {expanded === "whole" ? "Show less" : "Show whole note"}
                              </button>
                            )}
                            <button type="button" className="button small" onClick={() => collapse(note.id)}>
                              Collapse
                            </button>
                          </>
                        )}
                      >
                        {readNote(note.id)}
                      </CardBody>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        </nav>
        {found && found.next !== null && (
          <div className="search-more">
            <button type="button" className="found-more" disabled={found.more === "asking"} onClick={() => find(found.ask, found.next!)}>
              {found.more === "asking" ? "Reading more…" : "More results"}
            </button>
            {typeof found.more === "object" && <span role="alert">{found.more.refused}</span>}
          </div>
        )}
      </div>
      {menu && menuNote && <ContextMenu label={`${titleOf(menuNote)} note`} x={menu.x} y={menu.y} items={menuFor(menuNote)} onClose={() => setMenu(null)} />}
    </section>
  );
}

interface Kept {
  view: ListView;
  scrollTop: number;
}

/** How each folder's list was left, for as long as the app is open. A list drawn for a folder follows what is kept for it, whoever changed it. */
function keeping() {
  const kept = new Map<string, Kept>();
  const listeners = new Set<() => void>();
  const of = (folderId: string) => {
    if (!kept.has(folderId)) kept.set(folderId, { view: INITIAL_VIEW, scrollTop: 0 });
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

export const noteList: Plugin = {
  id: "note-list",
  name: "Note list",
  description: "A folder's notes as cards, each with its details and its first lines, to sort and to filter.",
  icon: "list",
  settings: {
    snippets: { type: "boolean", default: true, title: "Show snippets", description: "Show the first lines of each note under its title." },
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
  },
};
