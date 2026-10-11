import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ALL_NOTES, Icon, NOTE_DRAG, SHARED_WITH_ME, ago, folderTitle, useNow, type App, type FolderProps, type NoteSummary, type Plugin } from "../plugin-api.ts";
import { INITIAL_VIEW, SORTS, listReducer, listed, notesIn, titleOf, type ListAction, type ListView, type Sort } from "./noteListView.ts";

/** How far below the top of the list a card's head is put when its note is collapsed from further down. */
const HEAD_GAP = 10;

const withModifier = (e: MouseEvent | KeyboardEvent) => e.metaKey || e.ctrlKey;

interface Kept {
  view: ListView;
  scrollTop: number;
}

interface Props extends FolderProps {
  /** Whether each collapsed card shows the first lines of its note. */
  snippets: boolean;
  /** How the list was left the last time it was drawn for this folder, and where to keep how it is left now. */
  kept: Kept;
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

function FolderList({ app, folderId, readNote, snippets, kept }: Props) {
  const ids = useId();
  const now = useNow();
  const [view, setView] = useState(kept.view);
  const act = (action: ListAction) => setView((v) => (kept.view = listReducer(v, action)));
  const [error, setError] = useState<string | null>(null);
  /** The card the arrow keys last came to, which is the one Tab comes back to. */
  const [atId, setAtId] = useState<string | null>(null);
  const scroller = useRef<HTMLElement>(null);
  /** A card just made shorter, whose head is brought back into sight if that left it above the list. */
  const shortened = useRef<string | null>(null);

  const title = app.folders && folderTitle(app.folders, folderId);
  const inFolder = app.notes && notesIn(app.notes, folderId);
  const notes = inFolder ? listed(inFolder, view) : [];
  const count = inFolder ? inFolder.length : 0;
  const ready = !!inFolder && !!title;

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
    }
  };

  const details = (note: NoteSummary): ReactNode[] => [
    ...(folderId === ALL_NOTES ? [<span key="folder">{app.folders!.pathName(note.folderId)}</span>] : []),
    <span key="author">{note.updatedBy.name}</span>,
    <span key="edited">{ago(note.updatedAt, now)}</span>,
    ...(note.openTodos > 0 ? [<span key="todos">{note.openTodos} open</span>] : []),
  ];
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
          <h1 id={`${ids}-heading`}>{title}</h1>
          <span className="folder-count">
            {count} {count === 1 ? "note" : "notes"}
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
        <input
          type="search"
          className="filter"
          aria-label="Filter notes"
          placeholder={`Filter ${count} ${count === 1 ? "note" : "notes"}`}
          value={view.filter}
          onChange={(e) => act({ type: "filter", text: e.target.value })}
        />
        <div className="chips">
          <button type="button" className="chip" aria-pressed={view.hasTodos} onClick={() => act({ type: "toggle", option: "hasTodos" })}>
            Has todos
          </button>
          <label className="finder-sort">
            Sort
            <select aria-label="Sort by" value={view.sort} onChange={(e) => act({ type: "sort", sort: e.target.value as Sort })}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <nav aria-label="Notes">
          {!notes.length && <p className="empty">{count ? "No notes match." : "No notes in this folder."}</p>}
          <ul className="cards" data-list>
            {notes.map((note, at) => {
              const expanded = view.expanded[note.id];
              const name = titleOf(note);
              return (
                <li key={note.id}>
                  <article
                    className="card"
                    data-note={note.id}
                    data-expanded={expanded}
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
                    {!expanded && snippets && note.snippet && <p className="card-preview">{note.snippet}</p>}
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
      </div>
    </section>
  );
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
    /** How each folder's list was left, for as long as the app is open. */
    const kept = new Map<string, Kept>();
    const keptFor = (folderId: string) => {
      if (!kept.has(folderId)) kept.set(folderId, { view: INITIAL_VIEW, scrollTop: 0 });
      return kept.get(folderId)!;
    };
    host.views.register("folder", {
      id: "notes",
      component: (props) => <FolderList {...props} snippets={host.settings.get<boolean>("snippets")} kept={keptFor(props.folderId)} />,
    });
  },
};
