import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Icon, changeTodo, nameKey, parseTodo, ruleLabel, tagsOn, useInspected, useNow, type App, type Folders, type Importance, type ListedTodo, type OpInput, type PluginHost, type Results, type TodoChange, type TodoCompletion } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { closePopover, openPopover } from "../lib/Popover.tsx";
import { ChipMenu, TagMenu } from "./ChipMenu.tsx";
import { completed, refused, takeBack } from "./completed.ts";
import { Completions } from "./Completions.tsx";
import { DUE_FILTERS, dayOf, dueLabel, dueRange, dueState, type DueFilter } from "./dates.ts";
import { CHIP_NAMES, IMPORTANCE, pickerLabel, picking, tagged, type Opened, type PickingEvent, type RowChip } from "./picking.ts";
import { doneLabel, doneName, everyName } from "./recurrence.ts";

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

/** The field a todo's words are edited in: v1's width, and the least it is made. */
const FIELD_PX = 420;
const MIN_FIELD_PX = 160;

/** How long a todo checked off stays in a list of open ones, struck through, as v1's did. */
const LINGER_MS = 1500;

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
  /** The tags in use, which Add tag offers. */
  tags: readonly string[];
  app: App;
  /** Which of its chips has its popover open, if one does. */
  picked: Opened | null;
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
 * A todo's row, as v1 drew it: its checkbox, its words, which are edited right there when pressed, and
 * a chip for each thing a todo can have, set or not, each opening a small popover under itself to be
 * set with; a tag's chip narrows the list. At its right end, its note's name, which opens the note.
 * The rest is in one menu: from the "…" button, a right-click, or the menu key on the row.
 */
function Row({ todo, now, tag, tags, app, picked, completing, onChange, onOpen, completions, onPicking, onTag }: RowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** How wide the field the words are edited in is, while they are. */
  const [editing, setEditing] = useState<number | null>(null);
  // Leaving the field after Enter or Escape has closed it saves nothing more.
  const ending = useRef(false);
  const more = useRef<HTMLButtonElement>(null);
  const said = useRef<HTMLSpanElement>(null);
  // A popover stays open while the list is read again: what is picked in it is made to the todo as the list has it then.
  const latest = useRef(todo);
  latest.current = todo;
  // A row is a line of a note. When the list is read again with another todo on that line, as when a line is written above it,
  // the popover opened for the todo that was there closes, so a pick never lands on the one that came.
  const openedOn = useRef<string | null>(null);
  useEffect(() => {
    if (picked && openedOn.current !== null && openedOn.current !== todo.text) closePopover();
  }, [picked, todo.text]);
  // So is the field its words are edited in, and nothing typed there is saved to the one that came.
  const editedOn = useRef<string | null>(null);
  const readOnly = todo.access !== "edit";
  const words = todo.words || "Nothing written";
  const { lead, trailing } = splitTags(todo.words);
  const row = keyOf(todo);
  // Listed under a tag its own line doesn't write: the tag is its note's, which is said beside the note's name.
  const ofNote = tag && !tagsOn(todo.text).some((own) => nameKey(own.name) === nameKey(tag)) ? (todo.tags.find((name) => nameKey(name) === nameKey(tag)) ?? null) : null;

  /** Opens a popover under one of the row's chips, with the row marked while it is open. */
  const show = (chip: Opened, anchor: HTMLElement, label: string, content: (close: () => void) => ReactNode) => {
    onPicking({ type: "open", row, chip });
    openedOn.current = todo.text;
    openPopover(anchor, label, content, () => onPicking({ type: "closed", row, chip }));
  };
  /** Opens a chip's popover under it. */
  const pick = (chip: RowChip, anchor: HTMLElement) =>
    show(chip, anchor, pickerLabel(chip, words), (close) => {
      const made = (to: TodoChange) => {
        close();
        if (latest.current.text !== todo.text) return;
        // Add tag is gone once the tag is written: the row's "…" has the keyboard.
        if (chip === "tag" && document.activeElement === anchor) more.current?.focus();
        onChange(latest.current, to);
      };
      return chip === "tag" ? (
        <TagMenu tags={tags} has={trailing} onPick={(name) => made({ words: tagged(latest.current.words, name) })} />
      ) : (
        <ChipMenu chip={chip} todo={todo} now={now} onPick={made} />
      );
    });
  // Listing them changes nothing, so someone who can only read may look.
  const listDone = (anchor: HTMLElement) =>
    show("done", anchor, "Completions", (close) => (
      <Completions
        ask={() => completions(latest.current)}
        done={todo.lastDone!}
        now={now}
        onOpen={(noteId) => {
          close();
          app.openNote(noteId);
        }}
      />
    ));
  const chipProps = (chip: RowChip, value: string | null) => ({
    type: "button" as const,
    "aria-label": `${CHIP_NAMES[chip]}: ${value ?? "none"}`,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": picked === chip,
    "data-unset": value === null || undefined,
    disabled: readOnly,
    onClick: (e: { currentTarget: HTMLElement }) => pick(chip, e.currentTarget),
  });

  /**
   * Turns the words into a field, as wide as v1's where the row has room for it beside the chips, and
   * otherwise as wide as the words were, so the chips stay where they are on the row.
   */
  const edit = () => {
    const text = said.current!.parentElement!;
    const chips = [...text.querySelectorAll<HTMLElement>(".todo-chip")].reduce((sum, chip) => sum + chip.getBoundingClientRect().width + 4, 0);
    const room = text.getBoundingClientRect().width - chips - 4;
    ending.current = false;
    editedOn.current = todo.text;
    setEditing(Math.min(FIELD_PX, Math.max(said.current!.getBoundingClientRect().width, room, MIN_FIELD_PX)));
  };

  /** Puts what was typed in place of the words, or the words back when Escape was pressed or nothing is left. */
  const finish = (typed: string | null) => {
    if (ending.current) return;
    ending.current = true;
    setEditing(null);
    const next = typed?.replace(/\s+/g, " ").trim();
    if (!next || next === lead || latest.current.text !== editedOn.current) return;
    // The tags after the words stay, but once: one typed again is not written twice.
    const typedTags = tagsOn(next).map((t) => nameKey(t.name));
    onChange(latest.current, { words: [next, ...trailing.filter((name) => !typedTags.includes(nameKey(name))).map((name) => `#${name}`)].join(" ") });
  };
  useEffect(() => {
    if (editing === null || editedOn.current === todo.text) return;
    ending.current = true;
    setEditing(null);
  }, [editing, todo.text]);

  const underMore = () => {
    const box = more.current!.getBoundingClientRect();
    return { x: box.left, y: box.bottom + 2 };
  };
  const closeMenu = useCallback(() => {
    setMenu(null);
    more.current?.focus();
  }, []);
  const { openBeside } = app;
  const items: MenuItem[] = [{ label: "Open the note", action: () => onOpen(todo) }, ...(openBeside ? [{ label: "Open to the side", action: () => openBeside({ kind: "note", id: todo.noteId }, "right") }] : [])];
  const due = todo.due && dueLabel(todo.due, now);
  // A todo that can't be changed shows only what is set on it.
  const unset = !readOnly;
  const title = todo.noteTitle || "Untitled";

  return (
    <li
      className="todo-row"
      data-done={todo.done || undefined}
      data-picking={picked ?? undefined}
      onContextMenu={(e) => {
        if (editing !== null) return;
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
      <input
        type="checkbox"
        className="todo-box"
        checked={todo.done}
        disabled={readOnly}
        // Not disabled while its completion is on its way: that would take the keyboard off it.
        aria-disabled={completing || undefined}
        aria-label={todo.done ? "Done" : "Not done"}
        onChange={(e) => !completing && onChange(todo, { done: e.target.checked })}
      />
      <span className="todo-text">
        {editing !== null ? (
          <input
            className="todo-edit"
            style={{ width: editing }}
            aria-label={`Words of ${words}`}
            defaultValue={lead}
            autoFocus
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              finish(e.key === "Enter" ? e.currentTarget.value : null);
              setTimeout(() => said.current?.focus());
            }}
            onBlur={(e) => finish(e.currentTarget.value)}
          />
        ) : (
          <span
            ref={said}
            className="todo-words"
            {...(!readOnly && { role: "button", tabIndex: 0, "aria-label": `Edit ${words}` })}
            onClick={(e) => {
              // With a key held it opens the note, as v1's did.
              if (e.metaKey || e.ctrlKey) return onOpen(todo);
              if (readOnly) return;
              edit();
            }}
            onKeyDown={(e) => {
              if (readOnly || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              edit();
            }}
          >
            <Words words={lead || words} />
          </span>
        )}
        {(todo.importance > 0 || unset) && (
          <button className="todo-chip todo-importance" data-level={todo.importance || undefined} {...chipProps("importance", todo.importance ? IMPORTANCE[todo.importance] : null)}>
            <Icon name="flag" />
            {todo.importance ? IMPORTANCE[todo.importance] : "Importance"}
          </button>
        )}
        {(due || unset) && (
          <button className="todo-chip todo-due" data-due={todo.due ? dueState(todo.due, now) : undefined} {...chipProps("due", due)}>
            <Icon name="calendar" />
            {due || "Add date"}
          </button>
        )}
        {(todo.every || unset) && (
          <button className="todo-chip todo-every" title={todo.every ? everyName(todo.every) : undefined} {...chipProps("every", todo.every && (todo.recurs ?? todo.every))}>
            <Icon name="repeat" />
            {todo.every ? (todo.recurs ?? todo.every) : "Repeat"}
          </button>
        )}
        {todo.lastDone && (
          <button type="button" className="todo-chip todo-done" aria-label={doneName(todo.lastDone, now)} aria-haspopup="dialog" aria-expanded={picked === "done"} onClick={(e) => listDone(e.currentTarget)}>
            {doneLabel(todo.lastDone, now)}
          </button>
        )}
        {trailing.map((name, i) => (
          <button key={`${i} ${name}`} type="button" className="todo-chip todo-tag" aria-pressed={!!tag && nameKey(tag) === nameKey(name)} title={`Todos tagged #${name}`} onClick={() => onTag(name)}>
            #{name}
          </button>
        ))}
        {!trailing.length && unset && (
          <button className="todo-chip todo-add-tag" {...chipProps("tag", null)} aria-label="Add tag">
            # Add tag
          </button>
        )}
      </span>
      <span className="todo-where">
        <button type="button" className="todo-note" title={`Open ${title}`} data-row-open onClick={() => onOpen(todo)}>
          {title}
        </button>
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
  /** Todos just checked off, by key, and where they were: each stays a moment, struck through, before the list lets it go. */
  const [lingering, setLingering] = useState<ReadonlyMap<string, { todo: ListedTodo; at: number }>>(new Map());
  const listed = useMemo(() => {
    const todos = [...(page?.todos ?? [])];
    for (const [key, { todo, at }] of lingering) if (!todos.some((t) => keyOf(t) === key)) todos.splice(Math.min(at, todos.length), 0, todo);
    return todos;
  }, [page, lingering]);
  /** The todos as the page shows them now, for an Undo pressed after more was changed. */
  const shown = useRef<readonly ListedTodo[]>([]);
  shown.current = listed;
  // The inspector is about the notes the listed todos are in: History is their history, and Info counts them.
  useInspected(app, page && { kind: "notes", label: "Todos", noteIds: [...new Set(page.todos.map((t) => t.noteId))].sort() });
  /** The changes on their way to the server, one at a time, how many there are, and the revision each note they changed is at now. */
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
      setLingering((had) => {
        const held = had.get(keyOf(todo));
        return held ? new Map(had).set(keyOf(todo), { ...held, todo: changed(held.todo, to, now) }) : had;
      });
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
      const rolls = done && comesAround(todo, now);
      if (rolls) setCompleting((keys) => new Set(keys).add(keyOf(todo)));
      const sent = send(todo, to);
      if (rolls) void sent.catch(() => {}).finally(() => setCompleting((keys) => new Set([...keys].filter((key) => key !== keyOf(todo)))));
      sent.then(
        (note) => {
          // A recurring todo's completion moved its due date, counted it and filed a line on the daily note: Undo reverts the change that did, which takes all of it back.
          if (done && note.filed) return completed(() => takeBack(host, todo.noteId, note.revision).finally(() => setAsked((n) => n + 1)));
          const left = changed(todo, to, now);
          if (!done || !left.done) return;
          const key = keyOf(todo);
          const at = shown.current.findIndex((t) => keyOf(t) === key);
          setLingering((had) => new Map(had).set(key, { todo: { ...left, revision: note.revision }, at }));
          setTimeout(() => setLingering((had) => (had.has(key) ? new Map([...had].filter(([k]) => k !== key)) : had)), LINGER_MS);
          // Undo is the same change the other way, made to the line this one left, at the revision it made.
          // It is made to the todo as the page has it by then, which may have been changed again since.
          completed(() => send(shown.current.find((t) => keyOf(t) === key && t.done) ?? { ...left, revision: note.revision }, { done: false }).then(() => undefined, refused));
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
      {page && listed.length === 0 && <p className="todo-none">{narrowed ? "No todos match." : "Nothing to do. A todo is a line that starts - [ ] in any note."}</p>}
      {listed.length > 0 && (
        <ul className="todo-list" aria-label="Todos">
          {listed.map((todo) => (
            <Row
              key={keyOf(todo)}
              todo={todo}
              now={now}
              tag={filters.tag}
              tags={tags}
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
