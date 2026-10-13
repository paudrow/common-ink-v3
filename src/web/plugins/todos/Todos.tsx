import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, changeTodo, nameKey, parseTodo, tagsOn, useNow, type App, type Folders, type Importance, type ListedTodo, type OpInput, type PluginHost, type Results, type TodoChange } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { IMPORTANCE } from "./chips.ts";
import { completed, refused } from "./completed.ts";
import { DUE_FILTERS, addDays, dayOf, dueLabel, dueRange, dueState, type DueFilter } from "./dates.ts";

/** What the list is narrowed to. Kept in this browser, so the page opens the way it was left. */
interface Filters {
  /** A folder's id, for its notes and those of every folder under it, or "" for every folder. */
  folder: string;
  tag: string;
  due: DueFilter;
  /** A level, or "" for any. */
  importance: string;
  completed: boolean;
}

const EVERYTHING: Filters = { folder: "", tag: "", due: "any", importance: "", completed: false };

const stored = (value: unknown): Filters => {
  const kept = typeof value === "object" && value !== null ? (value as Partial<Record<keyof Filters, unknown>>) : {};
  return {
    folder: typeof kept.folder === "string" ? kept.folder : "",
    tag: typeof kept.tag === "string" ? kept.tag : "",
    due: typeof kept.due === "string" && kept.due in DUE_FILTERS ? (kept.due as DueFilter) : "any",
    importance: typeof kept.importance === "string" && /^[0-3]?$/.test(kept.importance) ? kept.importance : "",
    completed: kept.completed === true,
  };
};

type Query = Omit<Extract<OpInput, { type: "todo.list" }>, "type">;

const queryOf = (filters: Filters, now: string): Query => ({
  ...(filters.folder && { folderId: filters.folder }),
  ...(filters.tag && { tag: filters.tag }),
  ...(filters.importance && { importance: [Number(filters.importance) as Importance] }),
  ...dueRange(filters.due, now),
  includeCompleted: filters.completed,
});

const keyOf = (todo: Pick<ListedTodo, "noteId" | "line">) => `${todo.noteId}/${todo.line}`;

/** The todo as it reads once `change` is made, by the function the server makes it with. */
function changed(todo: ListedTodo, change: TodoChange): ListedTodo {
  const text = changeTodo(todo.text, change);
  const read = parseTodo(text);
  return read ? { ...todo, text, done: read.done, importance: read.importance, due: read.due?.date ?? null, words: read.words } : todo;
}

/** Every folder the member sees, outermost first and each before the folders under it, by its path. */
function folderChoices(folders: Folders | null): { id: string; path: string }[] {
  const found: { id: string; path: string }[] = [];
  const visit = (parentId: string | null) => {
    for (const folder of folders?.childrenOf(parentId) ?? []) {
      found.push({ id: folder.id, path: folders!.pathName(folder.id) });
      visit(folder.id);
    }
  };
  visit(null);
  return found;
}

/** A todo's words with the tags written on its line drawn as tags. */
function Words({ words }: { words: string }) {
  const parts: (string | { tag: string })[] = [];
  let at = 0;
  for (const tag of tagsOn(words)) {
    parts.push(words.slice(at, tag.from), { tag: words.slice(tag.from, tag.to) });
    at = tag.to;
  }
  parts.push(words.slice(at));
  return (
    <span>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <span key={i} className="todo-tag">
            {part.tag}
          </span>
        ),
      )}
    </span>
  );
}

/** Opens a date field's calendar as the field arrives. One function, so it is asked once and not again each time the row is drawn. */
const openCalendar = (input: HTMLInputElement | null) => {
  try {
    input?.showPicker();
  } catch {
    // A browser that won't open its calendar from here still takes the date typed into the field.
  }
};

interface RowProps {
  todo: ListedTodo;
  now: string;
  /** The tag the list is narrowed to, if any. */
  tag: string;
  app: App;
  onChange: (todo: ListedTodo, change: TodoChange) => void;
  onOpen: (todo: ListedTodo) => void;
}

/**
 * A todo's card. Its checkbox and its words, which open its note, are the two things to press, and
 * everything else is in one menu: from the "…" button, a right-click, or the menu key on the row.
 */
function Row({ todo, now, tag, app, onChange, onOpen }: RowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const readOnly = todo.access !== "edit";
  const words = todo.words || "Nothing written";
  // Listed under a tag its own line doesn't write: the tag is its note's, which is said beside the note's name.
  const ofNote = tag && !tagsOn(todo.text).some((own) => nameKey(own.name) === nameKey(tag)) ? (todo.tags.find((name) => nameKey(name) === nameKey(tag)) ?? null) : null;

  const underMore = () => {
    const box = more.current!.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 2 };
  };
  const closeMenu = useCallback(() => {
    setMenu(null);
    more.current?.focus();
  }, []);
  const { openBeside } = app;
  const items: MenuItem[] = [
    { label: "Open the note", action: () => onOpen(todo) },
    ...(openBeside ? [{ label: "Open to the side", action: () => openBeside({ kind: "note", id: todo.noteId }, "right") }] : []),
    ...(readOnly
      ? []
      : [
          ...([3, 2, 1, 0] as const).map((level) => ({ label: `Importance: ${IMPORTANCE[level]}`, disabled: level === todo.importance, action: () => onChange(todo, { importance: level }) })),
          { label: "Due today", disabled: todo.due === now, action: () => onChange(todo, { due: now }) },
          { label: "Due tomorrow", disabled: todo.due === addDays(now, 1), action: () => onChange(todo, { due: addDays(now, 1) }) },
          { label: "Pick a due date…", action: () => setPicking(true) },
          { label: "No due date", disabled: !todo.due, action: () => onChange(todo, { due: null }) },
        ]),
  ];

  return (
    <li
      className="todo-card"
      data-done={todo.done || undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        // Asked for by the keyboard, it has no place of its own.
        setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : underMore());
      }}
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
        e.preventDefault();
        setMenu(underMore());
      }}
    >
      <input type="checkbox" checked={todo.done} disabled={readOnly} aria-label={todo.done ? "Done" : "Not done"} onChange={(e) => onChange(todo, { done: e.target.checked })} />
      <div className="todo-text">
        <button type="button" className="todo-words" data-row-open onClick={() => onOpen(todo)}>
          <Words words={words} />
        </button>
        <div className="todo-meta">
          {todo.importance > 0 && (
            <span className="todo-chip todo-importance" data-level={todo.importance} title="Importance">
              {IMPORTANCE[todo.importance]}
            </span>
          )}
          {picking ? (
            <input
              type="date"
              className="todo-pick"
              aria-label={`Due date for ${words}`}
              defaultValue={todo.due ?? ""}
              autoFocus
              ref={openCalendar}
              // A date half typed has no value: taking the date away is the menu's to do.
              onChange={(e) => e.target.value && onChange(todo, { due: e.target.value })}
              onBlur={() => setPicking(false)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && more.current?.focus()}
            />
          ) : (
            todo.due && (
              <span className="todo-chip todo-due" data-due={dueState(todo.due, now)} title="Due">
                {dueLabel(todo.due, now)}
              </span>
            )
          )}
          <span className="todo-note">{todo.noteTitle || "Untitled"}</span>
          {ofNote && <span className="todo-chip todo-tag">#{ofNote}</span>}
        </div>
      </div>
      <button ref={more} type="button" className="icon-button todo-more" aria-label={`More for ${words}`} aria-haspopup="menu" aria-expanded={menu !== null} onClick={() => setMenu(underMore())}>
        <Icon name="more" />
      </button>
      {menu && <ContextMenu label={`More for ${words}`} x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
    </li>
  );
}

interface Props {
  host: PluginHost;
  app: App;
  /** Opens a todo's note with the cursor on its line. */
  onOpen: (todo: ListedTodo) => void;
}

export function TodosPage({ host, app, onOpen }: Props) {
  const [filters, setFilters] = useState(() => stored(host.storage.get("filters")));
  const [page, setPage] = useState<Results["todo.list"] | null>(null);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  /** The changes on their way to the server, one at a time, how many there are, and the revision each note they changed is at now. */
  /** The todos as the page shows them now, for an Undo pressed after more was changed. */
  const shown = useRef<readonly ListedTodo[]>([]);
  shown.current = page?.todos ?? [];
  const sending = useRef({ last: Promise.resolve(), count: 0, revisions: new Map<string, number>() });
  // Today is the member's own: the day it is in this browser, looked at again each minute.
  const now = dayOf(new Date(useNow()));
  const folders = useMemo(() => folderChoices(app.folders), [app.folders]);
  // A folder the member left the list narrowed to may be gone since, or theirs to see no longer: the list is then of every folder.
  const folder = app.folders && !app.folders.byId.has(filters.folder) ? "" : filters.folder;
  const query = useMemo(() => queryOf({ ...filters, folder }, now), [filters, folder, now]);
  // Whether the folder the list was left narrowed to is still there isn't known until the folders are.
  const waiting = filters.folder !== "" && !app.folders;
  // The list is read again whenever a note the member can see changes, by anyone.
  const version = useMemo(() => (app.notes ?? []).map((n) => `${n.id}:${n.revision}`).join(","), [app.notes]);

  useEffect(() => {
    if (waiting) return;
    let stale = false;
    Promise.all([host.perform({ type: "todo.list", ...query }), host.perform({ type: "todo.filters" })]).then(
      ([listed, narrowing]) => {
        // A list read while changes are on their way doesn't have them yet. It is read again when they have landed.
        if (stale || sending.current.count) return;
        sending.current.revisions.clear();
        setPage(listed);
        setTags(narrowing.tags);
      },
      (err: unknown) => !stale && setProblem(err instanceof Error ? err.message : "The todos couldn't be read."),
    );
    return () => {
      stale = true;
    };
  }, [host, query, version, asked, waiting]);

  const narrow = (change: Partial<Filters>) => {
    const next = { ...filters, ...change };
    setFilters(next);
    setProblem(null);
    host.storage.set("filters", next);
  };

  /** Makes a change to a todo, after the ones before it. It answers with the todo's note as the change left it, or with why it was refused. */
  const send = useCallback(
    (todo: ListedTodo, to: TodoChange) => {
      // The row reads as changed at once, so the next change to it is made to the line as it will be.
      setPage((had) => had && { ...had, todos: had.todos.map((t) => (keyOf(t) === keyOf(todo) ? changed(t, to) : t)) });
      const queue = sending.current;
      queue.count++;
      // One at a time: each change names the line as the one before it left it, at the revision that one made.
      const sent = queue.last.then(() => host.perform({ type: "todo.set", id: todo.noteId, revision: queue.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text, ...to }));
      queue.last = sent
        .then(
          (note) => {
            queue.revisions.set(keyOf(todo), note.revision);
            app.noteChanged(note);
          },
          () => {},
        )
        // Read again either way: after a change for what it left, and after a refusal for what is there now.
        .finally(() => {
          if (--queue.count === 0) setAsked((n) => n + 1);
        });
      return sent;
    },
    [host, app.noteChanged],
  );

  const change = useCallback(
    (todo: ListedTodo, to: TodoChange) => {
      setProblem(null);
      const done = to.done === true && !todo.done;
      send(todo, to).then(
        (note) => {
          const left = changed(todo, to);
          // Undo is the same change the other way, made to the line this one left, at the revision it made.
          // It is made to the todo as the page has it by then, which may have been changed again since.
          if (done && left.done) completed(left.words, () => send(shown.current.find((t) => keyOf(t) === keyOf(todo) && t.done) ?? { ...left, revision: note.revision }, { done: false }).then(() => undefined, refused));
        },
        (err: unknown) => setProblem(err instanceof Error ? err.message : "The todo couldn't be changed."),
      );
    },
    [send],
  );

  const more = () => {
    if (page?.next == null) return;
    void host.perform({ type: "todo.list", ...query, offset: page.next }).then((next) => setPage((had) => (had ? { todos: [...had.todos, ...next.todos], next: next.next } : next)));
  };

  // A filter the member left on names something that may be gone since; it stays choosable so it can be seen and taken off.
  const offered = (names: readonly string[], chosen: string) => (chosen && !names.some((n) => n.toLowerCase() === chosen.toLowerCase()) ? [...names, chosen] : names);
  const narrowed = JSON.stringify({ ...filters, folder }) !== JSON.stringify(EVERYTHING);

  return (
    <section className="todos-page" aria-label="Todos">
      <h1>Todos</h1>
      <div className="todo-filters" role="group" aria-label="Filters">
        <label>
          Folder
          <select value={folder} onChange={(e) => narrow({ folder: e.target.value })}>
            <option value="">All folders</option>
            {folders.map(({ id, path }) => (
              <option key={id} value={id}>
                {path}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <select value={filters.tag} onChange={(e) => narrow({ tag: e.target.value })}>
            <option value="">All tags</option>
            {offered(tags, filters.tag).map((name) => (
              <option key={name} value={name}>
                #{name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due
          <select value={filters.due} onChange={(e) => narrow({ due: e.target.value as DueFilter })}>
            {Object.entries(DUE_FILTERS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Importance
          <select value={filters.importance} onChange={(e) => narrow({ importance: e.target.value })}>
            <option value="">Any</option>
            {[3, 2, 1, 0].map((level) => (
              <option key={level} value={level}>
                {IMPORTANCE[level]}
              </option>
            ))}
          </select>
        </label>
        <label className="todo-completed">
          <input type="checkbox" checked={filters.completed} onChange={(e) => narrow({ completed: e.target.checked })} />
          Include completed
        </label>
      </div>
      {problem && (
        <p className="notice" role="alert">
          {problem}
        </p>
      )}
      {page && page.todos.length === 0 && <p className="todo-none">{narrowed ? "No todos match." : "Nothing to do. A todo is a line that starts - [ ] in any note."}</p>}
      {page && page.todos.length > 0 && (
        <ul className="cards" aria-label="Todos">
          {page.todos.map((todo) => (
            <Row key={keyOf(todo)} todo={todo} now={now} tag={filters.tag} app={app} onChange={change} onOpen={onOpen} />
          ))}
        </ul>
      )}
      {page?.next != null && (
        <button type="button" className="todo-next" onClick={more}>
          Show more
        </button>
      )}
    </section>
  );
}
