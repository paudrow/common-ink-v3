import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Icon, changeTodo, nameKey, parseTodo, ruleLabel, tagsOn, useNow, type App, type Folders, type Importance, type ListedTodo, type OpInput, type PluginHost, type Results, type TodoChange, type TodoCompletion } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { closePopover, openPopover } from "../lib/Popover.tsx";
import { ChipMenu } from "./ChipMenu.tsx";
import { completed, refused, takeBack } from "./completed.ts";
import { Completions } from "./Completions.tsx";
import { DUE_FILTERS, dayOf, dueLabel, dueRange, dueState, type DueFilter } from "./dates.ts";
import { IMPORTANCE, pickerLabel, picking, type ChipKind, type PickingEvent } from "./picking.ts";
import { doneLabel, doneName, everyName } from "./recurrence.ts";
import { RuleEditor } from "./RuleEditor.tsx";

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

/** The todo as it reads once `change` is made on the day `on`, by the function the server makes it with: a recurring todo checked off stays open, due next. */
function changed(todo: ListedTodo, change: TodoChange, on: string): ListedTodo {
  let text: string;
  try {
    text = changeTodo(todo.text, change, on).line;
  } catch {
    // A change the line no longer takes, such as a skip of a todo someone else just stopped: the server says why, and the row stays.
    return todo;
  }
  const read = parseTodo(text);
  if (!read) return todo;
  const lastDone = read.lastDone && { on: read.lastDone.on, times: read.lastDone.times };
  return { ...todo, text, done: read.done, importance: read.importance, due: read.due?.date ?? null, every: read.every?.written ?? null, recurs: read.every ? ruleLabel(read.every.rule) : null, lastDone, words: read.words };
}

/** Whether checking the todo off leaves it open, as a recurring one's completion does. */
const comesAround = (todo: ListedTodo, on: string) => !todo.done && changeTodo(todo.text, { done: true }, on).filed !== null;

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

/**
 * A todo's words, and the tags written at their end, which are drawn as chips after them. A tag inside the
 * sentence stays where it is written. Words that are nothing but tags keep them.
 */
function splitTags(words: string): { lead: string; trailing: string[] } {
  const tags = tagsOn(words);
  let from = words.trimEnd().length;
  const trailing: string[] = [];
  for (let i = tags.length - 1; i >= 0 && !words.slice(tags[i]!.to, from).trim(); i--) {
    trailing.unshift(tags[i]!.name);
    from = tags[i]!.from;
  }
  return words.slice(0, from).trim() ? { lead: words.slice(0, from).trimEnd(), trailing } : { lead: words, trailing: [] };
}

/** A todo's words with the tags written in them drawn as tags. */
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

interface RowProps {
  todo: ListedTodo;
  now: string;
  /** The tag the list is narrowed to, if any. */
  tag: string;
  app: App;
  /** Which of its chips has its popover open, if one does. */
  picked: ChipKind | null;
  /** Whether its completion is on its way to the server. */
  completing: boolean;
  onChange: (todo: ListedTodo, change: TodoChange) => void;
  onOpen: (todo: ListedTodo) => void;
  /** Reads each time it was checked off. */
  completions: (todo: ListedTodo) => Promise<TodoCompletion[]>;
  onPicking: (event: PickingEvent) => void;
  /** Narrows the list to a tag, or takes that off when it is the tag the list is narrowed to. */
  onTag: (name: string) => void;
}

/**
 * A todo's card: its checkbox, its words, which open its note, and what is set on it as chips straight
 * after the words, each opening a small popover under itself to be set with. What has no chip is in one
 * menu: from the "…" button, a right-click, or the menu key on the row.
 */
function Row({ todo, now, tag, app, picked, completing, onChange, onOpen, completions, onPicking, onTag }: RowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const more = useRef<HTMLButtonElement>(null);
  // A popover stays open while the list is read again: what is picked in it is made to the todo as the list has it then.
  const latest = useRef(todo);
  latest.current = todo;
  // A card is a line of a note. When the list is read again with another todo on that line, as when a line is written above it,
  // the popover opened for the todo that was there closes, so a pick never lands on the one that came.
  const openedOn = useRef<string | null>(null);
  useEffect(() => {
    if (picked && openedOn.current !== null && openedOn.current !== todo.text) closePopover();
  }, [picked, todo.text]);
  const readOnly = todo.access !== "edit";
  const words = todo.words || "Nothing written";
  const { lead, trailing } = splitTags(words);
  const row = keyOf(todo);
  // Listed under a tag its own line doesn't write: the tag is its note's, which is said beside the note's name.
  const ofNote = tag && !tagsOn(todo.text).some((own) => nameKey(own.name) === nameKey(tag)) ? (todo.tags.find((name) => nameKey(name) === nameKey(tag)) ?? null) : null;

  /** Opens a chip's popover under `anchor`: the chip, or the "…" button for what has no chip yet. */
  const pick = (chip: ChipKind, anchor: HTMLElement) => {
    onPicking({ type: "open", row, chip });
    openedOn.current = todo.text;
    openPopover(
      anchor,
      pickerLabel(chip, words),
      (close) => (
        <ChipMenu
          chip={chip}
          todo={todo}
          now={now}
          onPick={(to) => {
            close();
            if (latest.current.text !== todo.text) return;
            // A chip the pick takes away can't have the keyboard back: the card's "…" has it.
            if (document.activeElement === anchor && (to.due === null || to.importance === 0)) more.current?.focus();
            onChange(latest.current, to);
          }}
        />
      ),
      () => onPicking({ type: "closed", row, chip }),
    );
  };
  const chipProps = (chip: ChipKind, said: string) => ({
    type: "button" as const,
    "aria-label": `${chip === "due" ? "Due date" : "Importance"}: ${said}`,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": picked === chip,
    disabled: readOnly,
    onClick: (e: { currentTarget: HTMLElement }) => pick(chip, e.currentTarget),
  });

  const underMore = () => {
    const box = more.current!.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 2 };
  };
  const closeMenu = useCallback(() => {
    setMenu(null);
    more.current?.focus();
  }, []);
  /** Opens a panel under the "…" button, in place of any that is open. */
  const panel = (label: string, content: (close: () => void) => ReactNode) => {
    closePopover();
    openPopover(more.current!, label, content);
  };
  const setEvery = () =>
    panel("Recurrence", (close) => {
      const set = (change: TodoChange) => {
        close();
        onChange(latest.current, change);
      };
      return <RuleEditor every={todo.every} due={todo.due} now={now} onSet={(every) => set({ every })} onSkip={() => set({ skip: true })} />;
    });
  const listDone = () => {
    const ask = () => completions(latest.current);
    panel("Completions", (close) => (
      <Completions
        ask={ask}
        done={todo.lastDone!}
        now={now}
        onOpen={(noteId) => {
          close();
          app.openNote(noteId);
        }}
      />
    ));
  };
  const { openBeside } = app;
  const items: MenuItem[] = [
    { label: "Open the note", action: () => onOpen(todo) },
    ...(openBeside ? [{ label: "Open to the side", action: () => openBeside({ kind: "note", id: todo.noteId }, "right") }] : []),
    ...(readOnly
      ? []
      : [
          ...(todo.importance ? [] : [{ label: "Importance…", action: () => pick("importance", more.current!) }]),
          ...(todo.due ? [] : [{ label: "Due date…", action: () => pick("due", more.current!) }]),
          { label: "Recurrence…", action: setEvery },
        ]),
    // Listing them changes nothing, so someone who can only read may look.
    ...(todo.lastDone ? [{ label: "Completions", action: listDone }] : []),
  ];
  const due = todo.due && dueLabel(todo.due, now);

  return (
    <li
      className="todo-card"
      data-done={todo.done || undefined}
      data-picking={picked ?? undefined}
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
      <input type="checkbox" checked={todo.done} disabled={readOnly || completing} aria-label={todo.done ? "Done" : "Not done"} onChange={(e) => onChange(todo, { done: e.target.checked })} />
      <span className="todo-text">
        <a
          className="todo-words"
          href={`/note/${todo.noteId}`}
          onClick={(e) => {
            // With a key held, the browser opens it elsewhere, as any link.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onOpen(todo);
          }}
        >
          <Words words={lead} />
        </a>
        {todo.importance > 0 && (
          <button className="todo-chip todo-importance" {...chipProps("importance", IMPORTANCE[todo.importance])}>
            {IMPORTANCE[todo.importance]}
          </button>
        )}
        {due && (
          <button className="todo-chip todo-due" data-due={dueState(todo.due!, now)} {...chipProps("due", due)}>
            <Icon name="calendar" />
            {due}
          </button>
        )}
        {todo.every && (
          <span className="todo-chip todo-every" title={everyName(todo.every)}>
            {todo.recurs ?? todo.every}
          </span>
        )}
        {todo.lastDone && (
          <span className="todo-chip todo-done" title={doneName(todo.lastDone, now)}>
            {doneLabel(todo.lastDone, now)}
          </span>
        )}
        {trailing.map((name, i) => (
          <button key={`${i} ${name}`} type="button" className="todo-chip todo-tag" aria-pressed={!!tag && nameKey(tag) === nameKey(name)} title={`Todos tagged #${name}`} onClick={() => onTag(name)}>
            #{name}
          </button>
        ))}
      </span>
      <span className="todo-where">
        <span className="todo-note">{todo.noteTitle || "Untitled"}</span>
        {ofNote && <span className="todo-chip todo-tag">#{ofNote}</span>}
      </span>
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
  const [picked, onPicking] = useReducer(picking, null);
  /** The recurring todos whose completion is on its way. Checked again before it lands, one would be completed twice. */
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
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
      setPage((had) => had && { ...had, todos: had.todos.map((t) => (keyOf(t) === keyOf(todo) ? changed(t, to, now) : t)) });
      const queue = sending.current;
      queue.count++;
      // One at a time: each change names the line as the one before it left it, at the revision that one made.
      const sent = queue.last.then(() => host.perform({ type: "todo.set", id: todo.noteId, revision: queue.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text, ...to, on: now }));
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
    [host, app.noteChanged, now],
  );

  const change = useCallback(
    (todo: ListedTodo, to: TodoChange) => {
      setProblem(null);
      const done = to.done === true && !todo.done;
      const rolls = to.done === true && comesAround(todo, now);
      if (rolls) setCompleting((keys) => new Set(keys).add(keyOf(todo)));
      const sent = send(todo, to);
      if (rolls) void sent.catch(() => {}).finally(() => setCompleting((keys) => new Set([...keys].filter((key) => key !== keyOf(todo)))));
      sent.then(
        (note) => {
          const left = changed(todo, to, now);
          // A recurring todo's completion moved its due date, counted it and filed a line on the daily note: Undo reverts the change that did, which takes all of it back.
          if (done && note.filed) completed(todo.words, () => takeBack(host, todo.noteId, note.revision).finally(() => setAsked((n) => n + 1)));
          // Undo is the same change the other way, made to the line this one left, at the revision it made.
          // It is made to the todo as the page has it by then, which may have been changed again since.
          else if (done && left.done) completed(left.words, () => send(shown.current.find((t) => keyOf(t) === keyOf(todo) && t.done) ?? { ...left, revision: note.revision }, { done: false }).then(() => undefined, refused));
        },
        (err: unknown) => setProblem(err instanceof Error ? err.message : "The todo couldn't be changed."),
      );
    },
    [send, now, host],
  );

  const completions = useCallback(
    (todo: ListedTodo) => host.perform({ type: "todo.history", id: todo.noteId, revision: sending.current.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text }).then((history) => history.completions),
    [host],
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
            <Row
              key={keyOf(todo)}
              todo={todo}
              now={now}
              tag={filters.tag}
              app={app}
              picked={picked?.row === keyOf(todo) ? picked.chip : null}
              completing={completing.has(keyOf(todo))}
              onChange={change}
              onOpen={onOpen}
              completions={completions}
              onPicking={onPicking}
              onTag={(name) => narrow({ tag: filters.tag && nameKey(filters.tag) === nameKey(name) ? "" : name })}
            />
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
