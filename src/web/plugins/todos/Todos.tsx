import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Icon, MAX_SEARCH_LENGTH, changeTodo, isNoteId, isPersonId, linksOn, mentionKey, mentionName, nameKey, parseQuery, parseTodo, ruleLabel, tagsOn, useInspected, useNow, type App, type ListedTodo, type Mentioned, type PluginHost, type Results, type TodoChange, type TodoCompletion, type WrittenLink } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { closePopover, openPopover } from "../lib/Popover.tsx";
import { QueryBar } from "../lib/QueryBar.tsx";
import { EMPTY, keyOf, left, listing, pending, type Hold, type Listing, type ListingEvent } from "./arranged.ts";
import { Assignees, sameWho, whoOf } from "./Assignees.tsx";
import { ChipMenu, TagMenu } from "./ChipMenu.tsx";
import { completed, refused, takeBack } from "./completed.ts";
import { Completions } from "./Completions.tsx";
import { dayOf, dueLabel, dueState, savedQuery } from "./dates.ts";
import { CHIP_NAMES, PRIORITY, pickerLabel, picking, tagged, type Opened, type PickingEvent, type RowChip } from "./picking.ts";
import { doneLabel, doneName, everyName } from "./recurrence.ts";
import { narrowedTo, toggledTag } from "./tagged.ts";

/** How long typing rests before the list is asked for, so a word is one ask and not one a letter. */
const PAUSE_MS = 200;

/** How long a todo checked off stays in a list of open ones, struck through, as v1's did. */
const LINGER_MS = 1500;

/** How many todos a read lists, and the most one can, after Show more. */
const PAGE = 100;
const MOST = 200;

/** How long after a read of the list fails, as a request can under load, it is read again. */
const AGAIN_MS = 3000;

/** Whether a failure is the server's or the network's, which asking again may mend, and not a refusal. */
const fault = (err: unknown) => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== "number" || status >= 500 || status === 408 || status === 429;
};

/** What a row changes about its todo: as the todo's line is changed, with whoever is assigned or taken off named as the listing names them. */
export type RowChange = Omit<TodoChange, "assign" | "unassign"> & { assign?: Mentioned; unassign?: Mentioned };

const lineChange = ({ assign, unassign, ...rest }: RowChange): TodoChange => ({ ...rest, ...(assign && { assign: { id: assign.id, name: assign.name } }), ...(unassign && { unassign: whoOf(unassign) }) });
const opChange = ({ assign, unassign, ...rest }: RowChange) => ({ ...rest, ...(assign && { assign: whoOf(assign) }), ...(unassign && { unassign: whoOf(unassign) }) });

/** The todo as it reads once `change` is made on the day `on`, by the function the server makes it with: a recurring todo checked off stays open, due next. */
function changed(todo: ListedTodo, change: RowChange, on: string): ListedTodo {
  let text: string;
  try {
    text = changeTodo(todo.text, lineChange(change), on).line;
  } catch {
    // A change the line no longer takes, such as a skip of a todo someone else just stopped: the server says why, and the row stays.
    return todo;
  }
  const read = parseTodo(text);
  if (!read) return todo;
  const lastDone = read.lastDone && { on: read.lastDone.on, times: read.lastDone.times };
  const known = [...todo.assignees, ...(change.assign ? [change.assign] : [])];
  const assignees = new Map(read.assignees.map((a) => [mentionKey(a), known.find((person) => sameWho(person, mentionKey(a))) ?? { id: isPersonId(a.target) ? a.target : null, name: mentionName(a), member: false }]));
  return { ...todo, text, done: read.done, importance: read.importance, due: read.due?.date ?? null, every: read.every?.written ?? null, recurs: read.every ? ruleLabel(read.every.rule) : null, lastDone, assignees: [...assignees.values()], words: read.words };
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
  /** Which of its chips has its popover open, if one does. */
  picked: Opened | null;
  /** Who a todo can be assigned to from here: the members, and everyone a todo the member can see is assigned to. */
  people: readonly Mentioned[];
  /** Whether its completion is on its way to the server. */
  completing: boolean;
  /** Whether a change the member made took it out of the list, which it stays in, dimmed, until the list is refreshed. */
  gone: boolean;
  onChange: (todo: ListedTodo, change: RowChange) => void;
  onOpen: (todo: ListedTodo, beside?: boolean) => void;
  /** Reads each time it was checked off. */
  completions: (todo: ListedTodo) => Promise<TodoCompletion[]>;
  onPicking: (event: PickingEvent) => void;
  /** Narrows the list to a tag through the query, or takes it off the query when the list is narrowed to it. */
  onTag: (name: string) => void;
}

/**
 * A todo's row, in two lines. The first is the todo: its checkbox, its words, which are edited right
 * there when pressed, and at the right its note's name, which opens the note at the todo's line. The
 * second, under the words, has a chip for each thing a todo has, each in its one place whether it is set
 * or not: the due date, the repeat, the last time it was done, the priority, the tags, and Add tag. Set,
 * a chip says what it is; not set, it is a quiet word. Each opens a small popover under itself, and a
 * tag's chip narrows the list through its query. The row's menu, a right-click, Shift+F10 or the menu key, opens the note,
 * in front or beside the list.
 */
function Row({ todo, now, narrowedTo, tags, app, titleOf, people, picked, completing, gone, onChange, onOpen, completions, onPicking, onTag }: RowProps) {
  /** While the words are edited, how tall they were, which their line keeps so that nothing under it moves. */
  const [editing, setEditing] = useState<number | null>(null);
  /** Where the row's menu is open, if it is. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Leaving the field after Enter or Escape has closed it saves nothing more.
  const ending = useRef(false);
  const said = useRef<HTMLSpanElement>(null);
  /** What had the keyboard when the menu was opened, which has it again when the menu closes. */
  const before = useRef<Element | null>(null);
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
        if (latest.current.text === todo.text) onChange(latest.current, to as RowChange);
      };
      return chip === "tag" ? (
        <TagMenu tags={tags} has={trailing} onPick={(name) => made({ words: tagged(latest.current.words, name) })} />
      ) : (
        <ChipMenu chip={chip} todo={todo} now={now} onPick={made} onClose={close} />
      );
    });
  /** Opens the list of who it can be assigned to under `anchor`: an assignee's chip, or Assign when it has nobody. */
  const pickWho = (anchor: HTMLElement) =>
    show("who", anchor, `Assignees of ${words}`, (close) => (
      <Assignees
        assigned={todo.assignees}
        people={people}
        onPick={(to) => {
          close();
          if (latest.current.text === todo.text) onChange(latest.current, to);
        }}
      />
    ));
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
    "data-chip": chip,
    "data-unset": value === null || undefined,
    disabled: readOnly,
    onClick: (e: { currentTarget: HTMLElement }) => pick(chip, e.currentTarget),
  });

  const edit = () => {
    ending.current = false;
    editedOn.current = todo.text;
    setEditing(said.current!.parentElement!.getBoundingClientRect().height);
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

  /** Opens the row's menu at a point, or under what has the keyboard when the keys asked for it. */
  const openMenu = (at: { x: number; y: number } | null, from: Element) => {
    before.current = document.activeElement;
    const box = from.getBoundingClientRect();
    setMenu(at ?? { x: box.left, y: box.bottom + 2 });
  };
  const closeMenu = useCallback(() => {
    setMenu(null);
    const had = before.current;
    if (had instanceof HTMLElement && had !== document.body && had.isConnected) had.focus();
  }, []);
  const due = todo.due && dueLabel(todo.due, now);
  const repeat = todo.every && (todo.recurs ?? todo.every);
  const level = todo.importance ? PRIORITY[todo.importance] : null;
  // A todo that can't be changed shows only what is set on it, and so does one that is done.
  const offers = !readOnly && !todo.done;
  // The note's name and nothing after it: not the tags its title ends in, nor the one the list may be narrowed to.
  const title = splitTags(todo.noteTitle).lead || "Untitled";
  const items: MenuItem[] = [{ label: "Open note", action: () => onOpen(todo) }, ...(app.openBeside ? [{ label: "Open to the side", action: () => onOpen(todo, true) }] : [])];

  return (
    <li
      className="todo-row"
      data-row={row}
      data-done={todo.done || undefined}
      data-gone={gone || undefined}
      data-picking={picked ?? (menu ? "menu" : undefined)}
      onContextMenu={(e) => {
        if (editing !== null) return;
        e.preventDefault();
        // Asked for by the keyboard, it has no place of its own.
        openMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null, e.target as Element);
      }}
      onKeyDown={(e) => {
        if (editing !== null || menu || (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey))) return;
        e.preventDefault();
        openMenu(null, e.target as Element);
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
      <span className="todo-text" style={editing === null ? undefined : { minHeight: editing }}>
        {editing !== null ? (
          <input
            className="todo-edit"
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
      </span>
      <span className="todo-chips">
        {(due || offers) && (
          <button className="todo-chip todo-due" data-due={todo.due ? dueState(todo.due, now) : undefined} title={due ? undefined : "Add date"} {...chipProps("due", due)}>
            <Icon name="calendar" />
            {due || <span className="todo-chip-word">Add date</span>}
          </button>
        )}
        {(repeat || offers) && (
          <button className="todo-chip todo-every" title={repeat ? everyName(todo.every!) : "Repeat"} {...chipProps("every", repeat)}>
            <Icon name="repeat" />
            {repeat || <span className="todo-chip-word">Repeat</span>}
          </button>
        )}
        {todo.lastDone && (
          <button type="button" className="todo-chip todo-done" aria-label={doneName(todo.lastDone, now)} aria-haspopup="dialog" aria-expanded={picked === "done"} onClick={(e) => listDone(e.currentTarget)}>
            {doneLabel(todo.lastDone, now)}
          </button>
        )}
        {(level || offers) && (
          <button className="todo-chip todo-importance" data-level={todo.importance || undefined} title={level ? undefined : "Priority"} {...chipProps("importance", level)}>
            <Icon name="flag" />
            {level || <span className="todo-chip-word">Priority</span>}
          </button>
        )}
        {todo.assignees.map((person) => (
          <button
            key={whoOf(person)}
            type="button"
            className="todo-chip todo-assignee"
            data-chip="who"
            data-member={person.member || undefined}
            title={person.member ? `Assigned to ${person.name}, a member of this workspace` : `Assigned to ${person.name}, mentioned by name`}
            aria-label={`Assigned to ${person.name}`}
            aria-haspopup="dialog"
            aria-expanded={picked === "who"}
            disabled={readOnly}
            onClick={(e) => pickWho(e.currentTarget)}
          >
            @{person.name}
          </button>
        ))}
        {/* Only where there is someone to assign it to besides the member: a workspace of one has no Assign chip. */}
        {offers && !todo.assignees.length && people.length > 1 && (
          <button type="button" className="todo-chip todo-assign" data-chip="who" data-unset title="Assign" aria-label="Assign: nobody" aria-haspopup="dialog" aria-expanded={picked === "who"} onClick={(e) => pickWho(e.currentTarget)}>
            <span className="chip-at" aria-hidden="true">@</span>
            <span className="todo-chip-word">Assign</span>
          </button>
        )}
        {trailing.map((name, i) => (
          <button key={`${i} ${name}`} type="button" className="todo-chip todo-tag" aria-pressed={narrowed(name)} title={`Todos tagged #${name}`} onClick={() => onTag(name)}>
            #{name}
          </button>
        ))}
        {offers && (
          <button className="todo-chip todo-add-tag" title="Add tag" {...chipProps("tag", null)} aria-label="Add tag">
            <span className="chip-hash" aria-hidden="true" />
            <span className="todo-chip-word">Add tag</span>
          </button>
        )}
      </span>
      <button type="button" className="todo-note" title={`Open ${title}`} data-row-open onClick={() => onOpen(todo)}>
        <span className="todo-note-title">{title}</span>
      </button>
      {menu && <ContextMenu label={`More for ${words}`} x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
    </li>
  );
}

interface Props {
  host: PluginHost;
  app: App;
  /** Opens a todo's note with the cursor on its line, in a split beside what is in front when `beside`. */
  onOpen: (todo: ListedTodo, beside?: boolean) => void;
}

/** Stands in for the inspector where a list of todos is part of a page that tells the inspector itself. */
const NO_INSPECTOR = { inspect: () => {} };

interface ListProps extends Props {
  /** The query the list is of, as the Todos page's bar takes it. */
  query: string;
  /** What the list is called, to the inspector and to a screen reader. With `inspected`, the inspector is about the notes its todos are in. */
  label: string;
  inspected?: boolean;
  /** The tags the list is narrowed to, whose chips read as pressed. */
  narrowedTo?: readonly string[];
  onTag: (name: string) => void;
  /** Told what the server said of a query that reads and can't be answered, and null once one is answered. */
  onUnanswered?: (message: string | null, query: string) => void;
  /** What the list says when it has no todo, or null to say nothing. */
  none: string | null;
}

/**
 * Todos as rows, read for a query and read again whenever a note changes: each row changed in place,
 * one change after another, a checked one lingering struck through, and a row a change took out of the
 * query staying, dimmed, until Refresh. The Todos page is its bar over one of these, and a person's page has one of their open todos.
 */
export function TodoList({ host, app, onOpen, query, label, inspected = false, narrowedTo: narrowedTags = [], onTag, onUnanswered, none }: ListProps) {
  /** Whether the list was read yet, and where more of it starts when there is more. */
  const [page, setPage] = useState<Pick<Results["todo.list"], "next"> | null>(null);
  const [list, arrange] = useReducer(listing<ListedTodo>, EMPTY as Listing<ListedTodo>);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  /** Why the list couldn't be read, until it is. */
  const [unread, setUnread] = useState<string | null>(null);
  const unanswered = useRef(onUnanswered);
  unanswered.current = onUnanswered;
  const [asked, setAsked] = useState(0);
  const [picked, onPicking] = useReducer(picking, null);
  /** The recurring todos whose completion is on its way. Checked again before it lands, one would be completed twice. */
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const listed = list.shown;
  const gone = useMemo(() => left(list), [list]);
  /** The todos as the page shows them now, for an Undo pressed after more was changed. */
  const shown = useRef<readonly ListedTodo[]>([]);
  shown.current = listed;
  // The inspector is about the notes the listed todos are in: History is their history, and Info counts them.
  useInspected(inspected ? app : NO_INSPECTOR, page && { kind: "notes", label, noteIds: [...new Set(list.fresh.map((t) => t.noteId))].sort() });
  /** The changes on their way to the server, one at a time, how many there are, and the revision each note they changed is at now. */
  const sending = useRef({ last: Promise.resolve(), count: 0, revisions: new Map<string, number>() });
  // Today is the member's own: the day it is in this browser, looked at again each minute.
  const now = dayOf(new Date(useNow()));
  const read = useMemo(() => parseQuery(query, "todos"), [query]);
  const ask = useMemo(() => ({ query, today: now, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }), [query, now]);
  useEffect(() => setProblem(null), [query]);
  // The list is read again whenever a note the member can see changes, by anyone, or is archived, trashed, or brought back.
  const version = useMemo(() => (app.notes ?? []).map((n) => `${n.id}:${n.revision}:${n.state}`).join(","), [app.notes]);
  const titles = useMemo(() => app.notes && new Map(app.notes.map((n) => [n.id, n.title])), [app.notes]);
  const titleOf = useCallback((noteId: string) => (titles ? (titles.get(noteId) ?? null) : undefined), [titles]);

  /** The list as the page has it now, and the query it was read for: a list read for another query is shown as read, so a new query is a refresh. */
  const had = useRef({ list, readFor: "" });
  had.current.list = list;
  /** Whether a change the member made, other than checking a todo off or on, is waiting to be read back: one that leaves the list in another order says so. */
  const announce = useRef(false);
  /** Whether the member checked a todo off or on, which is said otherwise: the list going out of order for it says nothing. */
  const quiet = useRef(false);
  /** Takes down the notice that the order changed, when it is still up. */
  const notice = useRef<(() => void) | null>(null);
  const take = (event: ListingEvent<ListedTodo>) => {
    const next = listing(had.current.list, event);
    // Said after the member's own change that leaves the list out of order, and when anyone's change first does, a teammate's or one in a note.
    if (event.type === "read" && pending(next) && (announce.current || (!pending(had.current.list) && !quiet.current))) {
      notice.current?.();
      notice.current = app.notify({ message: "Order changed", icon: "list", action: { label: "Refresh", run: () => arrange({ type: "refresh" }) }, stays: true });
    }
    if (event.type === "read") announce.current = quiet.current = false;
    arrange(event);
  };
  const out = pending(list);
  useEffect(() => {
    if (out) return;
    notice.current?.();
    notice.current = null;
  }, [out]);
  useEffect(() => () => notice.current?.(), []);

  useEffect(() => {
    // A query that can't be read is said so under the bar, and the list stays as it was.
    if (!read.ok) return;
    let stale = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    const readFor = JSON.stringify(ask);
    // Read again, the list is read as far as Show more had read it, so the rows it brought stay; a list read for other filters starts again.
    const limit = had.current.readFor === readFor ? Math.min(MOST, Math.max(PAGE, had.current.list.fresh.length)) : PAGE;
    Promise.all([host.perform({ type: "todo.list", ...ask, limit }), host.perform({ type: "todo.filters" })]).then(
      ([listed, narrowing]) => {
        // A list read while changes are on their way doesn't have them yet. It is read again when they have landed.
        if (stale || sending.current.count) return;
        sending.current.revisions.clear();
        setUnread(null);
        unanswered.current?.(null, ask.query);
        take({ type: "read", rows: listed.todos, refresh: had.current.readFor !== readFor });
        had.current.readFor = readFor;
        setPage({ next: listed.next });
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
        arrange({ type: "read", rows: [], refresh: true });
        had.current.readFor = "";
        unanswered.current?.(message, ask.query);
      },
    );
    return () => {
      stale = true;
      clearTimeout(again);
    };
  }, [host, ask, read.ok, version, asked]);

  /** The row that had the keyboard, so the keyboard goes to the row in its place when it leaves the list. */
  const focused = useRef<string | null>(null);
  const ul = useRef<HTMLUListElement>(null);
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
    if (next) ul.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(next)}"] .todo-box`)?.focus();
  }, [listed]);

  /** Makes a change to a todo, after the ones before it. It answers with the todo's note as the change left it, or with why it was refused. */
  const send = useCallback(
    (todo: ListedTodo, to: RowChange, hold: Hold = "changed") => {
      // The row reads as changed at once, so the next change to it is made to the line as it will be.
      arrange({ type: "change", key: keyOf(todo), to: (t) => changed(t, to, now), hold });
      const queue = sending.current;
      queue.count++;
      // One at a time: each change names the line as the one before it left it, at the revision that one made.
      const sent = queue.last.then(() => host.perform({ type: "todo.set", id: todo.noteId, revision: queue.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text, ...opChange(to), on: now }));
      queue.last = sent
        .then(
          (note) => {
            queue.revisions.set(keyOf(todo), note.revision);
            // A row the list no longer has keeps the revision its line was written at, for the next change made to it there.
            arrange({ type: "change", key: keyOf(todo), to: (t) => ({ ...t, revision: note.revision }) });
            app.noteChanged(note);
          },
          () => arrange({ type: "refused", key: keyOf(todo) }),
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
    (todo: ListedTodo, to: RowChange) => {
      setProblem(null);
      const done = to.done === true && !todo.done;
      const rolls = done && comesAround(todo, now);
      if (rolls) setCompleting((keys) => new Set(keys).add(keyOf(todo)));
      // Checking one off says Task completed instead, and opening one again says nothing; either stays where it is until the list is refreshed.
      if (to.done === undefined) announce.current = true;
      else quiet.current = true;
      const sent = send(todo, to, done ? "done" : "changed");
      if (rolls) void sent.catch(() => {}).finally(() => setCompleting((keys) => new Set([...keys].filter((key) => key !== keyOf(todo)))));
      sent.then(
        (note) => {
          if (!done) return;
          // A todo checked off stays its moment, and then goes when the list no longer has it, as the last time of a repeating one doesn't.
          const key = keyOf(todo);
          setTimeout(() => arrange({ type: "let go", key }), LINGER_MS);
          // A recurring todo's completion moved its due date, counted it and filed a line on the daily note: Undo reverts the change that did, which takes all of it back.
          if (note.filed) return completed(host, () => takeBack(host, todo.noteId, note.revision).finally(() => setAsked((n) => n + 1)));
          const left = changed(todo, to, now);
          if (!left.done) return;
          // Undo is the same change the other way, made to the line this one left, at the revision it made.
          // It is made to the todo as the page has it by then, which may have been changed again since.
          completed(host, () => send(shown.current.find((t) => keyOf(t) === key && t.done) ?? { ...left, revision: note.revision }, { done: false }).then(() => undefined, refused));
        },
        (err: unknown) => setProblem(err instanceof Error ? err.message : "The todo couldn't be changed."),
      );
    },
    [send, now, host],
  );

  /** Who a todo can be assigned to: the members, when the member may list them, and whoever todos are assigned to now. */
  const [people, setPeople] = useState<readonly Mentioned[]>([]);
  useEffect(() => {
    let stale = false;
    const members = host.perform({ type: "member.list" }).then((list) => list.map((m): Mentioned => ({ id: m.personId, name: m.name, member: true })), () => []);
    const assigned = host.perform({ type: "todo.filters", includeArchived: true }).then((filters) => filters.assignees, () => []);
    void Promise.all([members, assigned]).then(([m, a]) => {
      if (stale) return;
      const all = new Map<string, Mentioned>();
      for (const person of [...m, ...a]) if (!all.has(mentionKey({ target: whoOf(person) }))) all.set(mentionKey({ target: whoOf(person) }), person);
      setPeople([...all.values()].sort((x, y) => Number(y.member) - Number(x.member) || x.name.localeCompare(y.name, undefined, { sensitivity: "base" })));
    });
    return () => {
      stale = true;
    };
  }, [host, version]);

  const completions = useCallback(
    (todo: ListedTodo) => host.perform({ type: "todo.history", id: todo.noteId, revision: sending.current.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text }).then((history) => history.completions),
    [host],
  );

  const more = () => {
    if (page?.next == null) return;
    void host.perform({ type: "todo.list", ...ask, offset: page.next }).then(
      (next) => {
        take({ type: "more", rows: next.todos });
        setPage({ next: next.next });
      },
      (err: unknown) => setUnread(err instanceof Error ? err.message : "The todos couldn't be read."),
    );
  };

  return (
    <>
      {(problem ?? unread) && (
        <p className="notice" role="alert">
          {problem ?? unread}
        </p>
      )}
      {page && listed.length === 0 && none && <p className="todo-none">{none}</p>}
      {listed.length > 0 && (
        <ul
          ref={ul}
          className="todo-list"
          aria-label={label}
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
              people={people}
              titleOf={titleOf}
              picked={picked?.row === keyOf(todo) ? picked.chip : null}
              completing={completing.has(keyOf(todo))}
              gone={gone.has(keyOf(todo)) && list.held.get(keyOf(todo)) === "changed"}
              onChange={change}
              onOpen={onOpen}
              completions={completions}
              onPicking={onPicking}
              onTag={onTag}
            />
          ))}
        </ul>
      )}
      {page?.next != null && (
        <button type="button" className="todo-next" onClick={more}>
          Show more
        </button>
      )}
    </>
  );
}

export function TodosPage({ host, app, onOpen }: Props) {
  /** The query the page's address names with `?q=`, as a link to the page does. */
  const linked = useMemo(() => new URLSearchParams(app.query).get("q")?.trim() ?? null, [app.query]);
  /** What is in the bar, and the query the list is of: the same once typing rests. It is kept in this browser, so the page opens the way it was left. */
  const [typed, setTyped] = useState(() => (linked ?? savedQuery(host.storage.get("query"), host.storage.get("filters"))).slice(0, MAX_SEARCH_LENGTH));
  const [query, setQuery] = useState(typed);
  /** What the server said of a query that reads and can't be answered, and the query it said it of. */
  const [unanswered, setUnanswered] = useState<{ query: string; message: string } | null>(null);
  /** The tags the list is narrowed to: their chips read as pressed. */
  const narrowedTags = useMemo(() => narrowedTo(query), [query]);

  const run = (text: string) => {
    setQuery(text);
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

  return (
    <section className="todos-page" aria-label="Todos">
      <h1>Todos</h1>
      <QueryBar
        host={host}
        app={app}
        scope="todos"
        value={typed}
        label="Filter todos"
        placeholder="Filter todos: words, #tag, due:<today, assignee:@me"
        problem={unanswered?.query === query ? unanswered.message : null}
        onChange={(text, how) => {
          setTyped(text);
          if (how === "set" || !text.trim()) run(text.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && wanted !== query) run(wanted);
        }}
      />
      <TodoList
        host={host}
        app={app}
        onOpen={onOpen}
        query={query}
        label="Todos"
        inspected
        narrowedTo={narrowedTags}
        onUnanswered={(message, of) => setUnanswered(message === null ? null : { query: of, message })}
        none={query ? "No todos match." : "Nothing to do. A todo is a line that starts - [ ] in any note."}
        onTag={(name) => {
          // The chip does what it shows: a tag already typed and not yet run is not taken off by a chip that reads unpressed.
          const typedHas = narrowedTo(typed).some((tag) => nameKey(tag) === nameKey(name));
          const shownHas = narrowedTags.some((tag) => nameKey(tag) === nameKey(name));
          const next = typedHas === shownHas ? toggledTag(typed, name) : typed.trim();
          setTyped(next);
          run(next);
        }}
      />
    </section>
  );
}
