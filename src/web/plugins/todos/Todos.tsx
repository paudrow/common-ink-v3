import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Icon, MAX_SEARCH_LENGTH, changeTodo, isNoteId, linksOn, nameKey, parseQuery, parseTodo, ruleLabel, tagsOn, useInspected, useNow, type App, type ListedTodo, type PluginHost, type Results, type TodoChange, type TodoCompletion, type WrittenLink } from "../../plugin-api.ts";
import { closePopover, openFrom, openPopover } from "../lib/Popover.tsx";
import { QueryBar } from "../lib/QueryBar.tsx";
import { ChipMenu, FieldsMenu, TagMenu } from "./ChipMenu.tsx";
import { completed, refused, takeBack } from "./completed.ts";
import { Completions } from "./Completions.tsx";
import { dayOf, dueLabel, dueState, savedQuery } from "./dates.ts";
import { CHIP_NAMES, IMPORTANCE, fieldsOf, pickerLabel, picking, tagged, type Opened, type PickingEvent, type RowChip } from "./picking.ts";
import { doneLabel, doneName, everyName } from "./recurrence.ts";
import { narrowedTo, toggledTag } from "./tagged.ts";

/** How long typing rests before the list is asked for, so a word is one ask and not one a letter. */
const PAUSE_MS = 200;

/** The field a todo's words are edited in: v1's width, and the least it is made. */
const FIELD_PX = 420;
const MIN_FIELD_PX = 160;

/** How long a todo checked off stays in a list of open ones, struck through, as v1's did. */
const LINGER_MS = 1500;

/** How long after a read of the list fails, as a request can under load, it is read again. */
const AGAIN_MS = 3000;

/** Whether a failure is the server's or the network's, which asking again may mend, and not a refusal. */
const fault = (err: unknown) => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 408 || status === 429;
};

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

/** A linked note's title; null when there is no such note the member can see; undefined while the notes are still being listed. */
type TitleOf = (noteId: string) => string | null | undefined;

/** What a link in a todo's words says, as a note draws it: its display text, or its note's title. */
function linkText(link: WrittenLink, titleOf: TitleOf): string {
  if (link.display) return link.display;
  const title = titleOf(link.target);
  if (title === undefined) return "…";
  if (title === null) return isNoteId(link.target) ? "Unavailable note" : link.target;
  return title || "Untitled";
}

/** A todo's words as they read, each link as the words it shows: what the row is called by. */
const plainly = (words: string, titleOf: TitleOf) => {
  let said = "";
  let at = 0;
  for (const link of linksOn(words)) {
    said += words.slice(at, link.from) + linkText(link, titleOf);
    at = link.to;
  }
  return said + words.slice(at);
};

/** A todo's words with the tags written in them drawn as tags, and its links as the words they show. */
function Words({ words, titleOf }: { words: string; titleOf: TitleOf }) {
  const marks = [...linksOn(words).map((link) => ({ ...link, link })), ...tagsOn(words).map((tag) => ({ ...tag, link: null }))].sort((a, b) => a.from - b.from);
  const parts: (string | { tag: string } | { link: WrittenLink })[] = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.from < at) continue;
    parts.push(words.slice(at, mark.from), mark.link ? { link: mark.link } : { tag: words.slice(mark.from, mark.to) });
    at = mark.to;
  }
  parts.push(words.slice(at));
  return (
    <span>
      {parts.map((part, i) =>
        typeof part === "string" ? (
          <Fragment key={i}>{part}</Fragment>
        ) : "tag" in part ? (
          <span key={i} className="todo-tag">
            {part.tag}
          </span>
        ) : (
          <span key={i} className="todo-link">
            {linkText(part.link, titleOf)}
          </span>
        ),
      )}
    </span>
  );
}

interface RowProps {
  todo: ListedTodo;
  now: string;
  /** The tags the list is narrowed to, as the query names them. */
  narrowedTo: readonly string[];
  /** The tags in use, which Add tag offers. */
  tags: readonly string[];
  app: App;
  titleOf: TitleOf;
  /** Which of its chips, or its fields button, has its popover open, if one does. */
  picked: Opened | null;
  /** Whether its completion is on its way to the server. */
  completing: boolean;
  onChange: (todo: ListedTodo, change: TodoChange) => void;
  onOpen: (todo: ListedTodo, beside?: boolean) => void;
  /** Reads each time it was checked off. */
  completions: (todo: ListedTodo) => Promise<TodoCompletion[]>;
  onPicking: (event: PickingEvent) => void;
  /** Narrows the list to a tag through the query, or takes it off the query when the list is narrowed to it. */
  onTag: (name: string) => void;
}

/**
 * A todo's row, as v1 drew it: its checkbox, its words, which are edited right there when pressed, and
 * a chip for each thing a todo can have, set or not, each opening a small popover under itself to be
 * set with; a tag's chip narrows the list through its query. At its right end, its note's name, which opens the note, and
 * v1's three buttons, shown while the row is pointed at or has the keyboard: its fields, which lists
 * what its chips set (also from a right-click or the menu key), go to the note, and open it in a split.
 */
function Row({ todo, now, narrowedTo, tags, app, titleOf, picked, completing, onChange, onOpen, completions, onPicking, onTag }: RowProps) {
  /** How wide the field the words are edited in is, while they are. */
  const [editing, setEditing] = useState<number | null>(null);
  // Leaving the field after Enter or Escape has closed it saves nothing more.
  const ending = useRef(false);
  const fields = useRef<HTMLButtonElement>(null);
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
  // A note in Trash takes no change until it is restored, so its todos are shown as one the member can only view.
  const readOnly = todo.access !== "edit" || app.trashed.some((n) => n.id === todo.noteId);
  const words = plainly(todo.words, titleOf) || "Nothing written";
  const { lead, trailing } = splitTags(todo.words);
  const row = keyOf(todo);
  // Listed under a tag its own line doesn't write: the tag is its note's, which is said beside the note's name.
  const ownTags = new Set(tagsOn(todo.text).map((own) => nameKey(own.name)));
  const ofNote = narrowedTo.filter((tag) => !ownTags.has(nameKey(tag))).flatMap((tag) => todo.tags.filter((name) => nameKey(name) === nameKey(tag)));
  const narrowed = (name: string) => narrowedTo.some((tag) => nameKey(tag) === nameKey(name));

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
        // Add tag is gone once the tag is written: the row's fields button has the keyboard.
        if (chip === "tag" && document.activeElement === anchor) fields.current?.focus();
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

  /** Opens the list of its fields under its fields button; a field picked there opens its chip's popover in its place. */
  const listFields = () => {
    const anchor = fields.current;
    if (!anchor) return;
    // Pressed again while what it opened hangs from it, the list or a field picked there, it closes that, as a chip pressed again does.
    if (openFrom(anchor)) return closePopover();
    show("fields", anchor, pickerLabel("fields", words), (close) => (
      <FieldsMenu
        fields={fieldsOf(todo, now)}
        onPick={(chip) => {
          close();
          pick(chip, anchor);
        }}
      />
    ));
  };
  const due = todo.due && dueLabel(todo.due, now);
  // A todo that can't be changed shows only what is set on it.
  const unset = !readOnly;
  const title = todo.noteTitle || "Untitled";

  return (
    <li
      className="todo-row"
      data-row={row}
      data-done={todo.done || undefined}
      data-picking={picked ?? undefined}
      onContextMenu={(e) => {
        if (editing !== null || readOnly) return;
        e.preventDefault();
        listFields();
      }}
      onKeyDown={(e) => {
        if (editing !== null || readOnly || (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey))) return;
        e.preventDefault();
        listFields();
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
            <Words words={lead || words} titleOf={titleOf} />
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
          <button key={`${i} ${name}`} type="button" className="todo-chip todo-tag" aria-pressed={narrowed(name)} title={`Todos tagged #${name}`} onClick={() => onTag(name)}>
            #{name}
          </button>
        ))}
        {!trailing.length && unset && (
          <button className="todo-chip todo-add-tag" {...chipProps("tag", null)} aria-label="Add tag">
            # Add tag
          </button>
        )}
      </span>
      <span className="todo-end">
        <span className="todo-where">
          <button type="button" className="todo-note" title={`Open ${title}`} data-row-open onClick={() => onOpen(todo)}>
            {title}
          </button>
          {ofNote.map((name) => (
            <span key={name} className="todo-chip todo-tag">
              #{name}
            </span>
          ))}
        </span>
        <span className="todo-acts">
          {readOnly ? (
            <span className="todo-act" aria-hidden="true" />
          ) : (
            <button ref={fields} type="button" className="todo-act" aria-label={`Fields of ${words}`} title="Importance, due date, repeat, tags…" aria-haspopup="dialog" aria-expanded={picked === "fields"} onClick={listFields}>
              <Icon name="sliders" />
            </button>
          )}
          <button type="button" className="todo-act" aria-label={`Go to ${title}`} title="Go to note" onClick={() => onOpen(todo)}>
            <Icon name="open" />
          </button>
          {app.openBeside && (
            <button type="button" className="todo-act" aria-label={`Open ${title} in split view`} title="Open in split view" onClick={() => onOpen(todo, true)}>
              <Icon name="split" />
            </button>
          )}
        </span>
      </span>
    </li>
  );
}

interface Props {
  host: PluginHost;
  app: App;
  /** Opens a todo's note with the cursor on its line, in a split beside what is in front when `beside`. */
  onOpen: (todo: ListedTodo, beside?: boolean) => void;
}

export function TodosPage({ host, app, onOpen }: Props) {
  /** The query the page's address names with `?q=`, as a link to the page does. */
  const linked = useMemo(() => new URLSearchParams(app.query).get("q")?.trim() ?? null, [app.query]);
  /** What is in the bar, and the query the list is of: the same once typing rests. It is kept in this browser, so the page opens the way it was left. */
  const [typed, setTyped] = useState(() => (linked ?? savedQuery(host.storage.get("query"), host.storage.get("filters"))).slice(0, MAX_SEARCH_LENGTH));
  const [query, setQuery] = useState(typed);
  const [page, setPage] = useState<Results["todo.list"] | null>(null);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  /** Why the list couldn't be read, until it is. */
  const [unread, setUnread] = useState<string | null>(null);
  /** What the server said of a query that reads and can't be answered, and the query it said it of. */
  const [unanswered, setUnanswered] = useState<{ query: string; message: string } | null>(null);
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
  const read = useMemo(() => parseQuery(query, "todos"), [query]);
  const ask = useMemo(() => ({ query, today: now, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }), [query, now]);
  /** The tags the list is narrowed to: their chips read as pressed, and a todo listed for its note's tag says it beside the note. */
  const narrowedTags = useMemo(() => narrowedTo(query), [query]);
  // The list is read again whenever a note the member can see changes, by anyone, or is archived, trashed, or brought back.
  const version = useMemo(() => (app.notes ?? []).map((n) => `${n.id}:${n.revision}:${n.state}`).join(","), [app.notes]);
  const titles = useMemo(() => app.notes && new Map(app.notes.map((n) => [n.id, n.title])), [app.notes]);
  const titleOf = useCallback((noteId: string) => (titles ? (titles.get(noteId) ?? null) : undefined), [titles]);

  const run = (text: string) => {
    setQuery(text);
    setProblem(null);
    host.storage.set("query", text);
    // A link's query stays in the address only while it is the page's: a reload then opens the query the member left.
    if (linked !== null && text !== linked) app.go(app.path, { replace: true });
  };
  // A link's query is the one the page is left at, whether the link opened the page or was followed while it was open.
  const followed = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (linked === followed.current) return;
    followed.current = linked;
    if (linked === null) return;
    setTyped(linked.slice(0, MAX_SEARCH_LENGTH));
    run(linked.slice(0, MAX_SEARCH_LENGTH));
  }, [linked]);
  const wanted = typed.trim();
  useEffect(() => {
    if (wanted === query) return;
    const timer = setTimeout(() => run(wanted), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [wanted, query]);

  useEffect(() => {
    // A query that can't be read is said so under the bar, and the list stays as it was.
    if (!read.ok) return;
    let stale = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    Promise.all([host.perform({ type: "todo.list", ...ask }), host.perform({ type: "todo.filters" })]).then(
      ([listed, narrowing]) => {
        // A list read while changes are on their way doesn't have them yet. It is read again when they have landed.
        if (stale || sending.current.count) return;
        sending.current.revisions.clear();
        setUnread(null);
        setUnanswered(null);
        setPage(listed);
        setTags(narrowing.tags);
      },
      (err: unknown) => {
        if (stale) return;
        const message = err instanceof Error ? err.message : "The todos couldn't be read.";
        if (fault(err)) {
          setUnread(message);
          // Nothing else asks again until a note changes, so a list that failed to be read would stay as it was.
          again = setTimeout(() => setAsked((n) => n + 1), AGAIN_MS);
          return;
        }
        // What was listed answered another query, so it is not left under why this one wasn't answered.
        setUnread(null);
        setPage(null);
        setUnanswered({ query: ask.query, message });
      },
    );
    return () => {
      stale = true;
      clearTimeout(again);
    };
  }, [host, ask, read.ok, version, asked]);

  /** The row that had the keyboard, so the keyboard goes to the row in its place when it leaves the list. */
  const focused = useRef<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  /** The rows as they were shown before, in order, to find the row in a leaving one's place. */
  const before = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    const was = before.current;
    const now = listed.map(keyOf);
    before.current = now;
    const had = focused.current;
    if (!had || now.includes(had)) return;
    focused.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    // The first row after it that is still listed, or else the last one before it.
    const at = was.indexOf(had);
    const next = [...was.slice(at + 1), ...was.slice(0, Math.max(at, 0)).reverse()].find((key) => now.includes(key));
    if (next) list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next)}"] .todo-box`)?.focus();
  }, [listed]);

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
    void host.perform({ type: "todo.list", ...ask, offset: page.next }).then(
      (next) => setPage((had) => (had ? { todos: [...had.todos, ...next.todos], next: next.next } : next)),
      (err: unknown) => setUnread(err instanceof Error ? err.message : "The todos couldn't be read."),
    );
  };

  return (
    <section className="todos-page" aria-label="Todos">
      <h1>Todos</h1>
      <QueryBar
        host={host}
        app={app}
        scope="todos"
        value={typed}
        label="Filter todos"
        placeholder="Filter todos: words, #tag, due:<today, is:done"
        problem={unanswered?.query === query ? unanswered.message : null}
        onChange={(text, how) => {
          setTyped(text);
          if (how === "set" || !text.trim()) run(text.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && wanted !== query) run(wanted);
        }}
      />
      {(problem ?? unread) && (
        <p className="notice" role="alert">
          {problem ?? unread}
        </p>
      )}
      {page && listed.length === 0 && <p className="todo-none">{query ? "No todos match." : "Nothing to do. A todo is a line that starts - [ ] in any note."}</p>}
      {listed.length > 0 && (
        <ul
          ref={list}
          className="todo-list"
          aria-label="Todos"
          onFocus={(e) => {
            const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
            focused.current = row?.dataset.row ?? null;
          }}
          onBlur={(e) => {
            const left = e.target;
            // A row taken out of the list takes the keyboard with it; one the member moved away from is forgotten.
            if (!e.currentTarget.contains(e.relatedTarget)) setTimeout(() => left.isConnected && (focused.current = null));
          }}
        >
          {listed.map((todo) => (
            <Row
              key={keyOf(todo)}
              todo={todo}
              now={now}
              narrowedTo={narrowedTags}
              tags={tags}
              app={app}
              titleOf={titleOf}
              picked={picked?.row === keyOf(todo) ? picked.chip : null}
              completing={completing.has(keyOf(todo))}
              onChange={change}
              onOpen={onOpen}
              completions={completions}
              onPicking={onPicking}
              onTag={(name) => {
                // The chip does what it shows: a tag already typed and not yet run is not taken off by a chip that reads unpressed.
                const typedHas = narrowedTo(typed).some((tag) => nameKey(tag) === nameKey(name));
                const shownHas = narrowedTags.some((tag) => nameKey(tag) === nameKey(name));
                const next = typedHas === shownHas ? toggledTag(typed, name) : typed.trim();
                setTyped(next);
                run(next);
              }}
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
