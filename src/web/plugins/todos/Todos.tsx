import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon, MAX_SEARCH_LENGTH, TODO_SORT_WORDS, changeTodo, isNoteId, isPersonId, linkedEvent, linksOn, mentionKey, mentionName, nameKey, parseQuery, parseTodo, ruleLabel, tagsOn, useInspected, useNow, type App, type InheritedTag, type ListedTodo, type Mentioned, type PluginHost, type Results, type SortKey, type TodoChange, type TodoCompletion, type TodoSort, type WrittenLink } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { closePopover, openPopover } from "../lib/Popover.tsx";
import { QueryBar } from "../lib/QueryBar.tsx";
import { Segmented } from "../lib/Segmented.tsx";
import { EMPTY, keyOf, left, listing, pending, type Hold, type Listing, type ListingEvent } from "./arranged.ts";
import { Assignees, sameWho, whoOf } from "./Assignees.tsx";
import { ChipMenu, MoreTags, TagMenu, type PlacedTag } from "./ChipMenu.tsx";
import { putAway, refused, takeBack } from "./completed.ts";
import { QuickAdd } from "./QuickAdd.tsx";
import { Completions } from "./Completions.tsx";
import { dayOf, dueLabel, dueState, savedQuery, tickedLabel } from "./dates.ts";
import { leaving, narrowingOf } from "./leaving.ts";
import { linksOut, type LinkOut } from "./linksOut.ts";
import { ALT, SHIFT, openPage } from "../lib/opening.ts";
import type { ListedAt } from "../lib/openTodo.ts";
import { CHIP_NAMES, PRIORITY, PUTTING, STATE_NAMES, boxHint, clicked, pickerLabel, picking, pressed, pressedWith, splitTags, tagged, type Opened, type PickingEvent, type PutAway, type RowChip } from "./picking.ts";
import { doneLabel, doneName, everyName } from "./recurrence.ts";
import { STATE_CHOICES, stateOf, withState, type StateChoice } from "./states.ts";
import { narrowedTo, toggledTag, withSort } from "./tagged.ts";
import { tagPath } from "../tags/path.ts";

/** How long typing rests before the list is asked for, so a word is one ask and not one a letter. */
const PAUSE_MS = 200;

/** The orders the Sort menu offers, the member's remembered setting `todos.sort`. Each is a `sort:` word of the query (`TODO_SORT_WORDS`), so the menu, the query and the setting are one choice; Due date is the order with no `sort:`. */
export const SORTS: Record<TodoSort, string> = { due: "Due date", priority: "Priority", changed: "Recently changed", note: "Note", text: "A–Z" };

/** The Sort menu's choice for a query's `sort:`, or the word itself when the menu has no name for it. */
const sortChoice = (sort: SortKey | null): string => (sort === null ? "due" : ((Object.keys(SORTS) as TodoSort[]).find((choice) => TODO_SORT_WORDS[choice] === sort) ?? sort));

/** The menu's choice a query says, or null when its `sort:` is a word the menu has no name for or it can't be read. */
const choiceIn = (text: string): TodoSort | null => {
  const read = parseQuery(text, "todos");
  const choice = read.ok ? sortChoice(read.query.sort) : null;
  return choice !== null && choice in SORTS ? (choice as TodoSort) : null;
};

/** The query with the account's order as its `sort:`, unless it has a `sort:` the menu has no name for, which it keeps. */
const sortedAs = (text: string, sort: TodoSort): string => (choiceIn(text) === null && /(^|\s)sort:/iu.test(text) ? text : withSort(text, sort === "due" ? null : TODO_SORT_WORDS[sort]));

/** How many of a todo's tags its row shows before a "+N" that lists the rest. */
const SHOWN_TAGS = 3;

/** How much of a heading's or an item's words a tag's chip says it is from. */
const FROM_LENGTH = 40;

/** Where a tag a todo has from another line of its note is written, as its chip says after "From". */
function whereFrom(tag: InheritedTag, titleOf: TitleOf): string {
  if (tag.under === null) return "the note";
  const said = plainly(tag.under, titleOf);
  const words = said.length > FROM_LENGTH ? `${said.slice(0, FROM_LENGTH - 1).trimEnd()}…` : said;
  const kind = tag.by === "item" ? "item" : tag.by === "section" ? "section" : "heading";
  return words ? `the ${kind} “${words}”` : `a ${kind}`;
}

/** The tags a todo has from other lines and not on its own, which its row shows after its own, quieter. */
const inheritedOnly = (todo: ListedTodo): InheritedTag[] => {
  const own = new Set(tagsOn(todo.words).map((tag) => nameKey(tag.name)));
  return todo.tagsElsewhere.filter((tag) => !own.has(nameKey(tag.name)));
};

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
  const assignees = new Map(read.assignees.map((a) => [mentionKey(a), known.find((person) => sameWho(person, mentionKey(a))) ?? { id: isPersonId(a.target) ? a.target : null, name: mentionName(a) ?? "Someone", member: false }]));
  return { ...todo, text, state: read.state, importance: read.importance, due: read.due?.date ?? null, every: read.every?.written ?? null, recurs: read.every ? ruleLabel(read.every.rule) : null, lastDone, completed: read.state === "done" ? todo.completed : null, tags: todo.tags.filter((name) => [...todo.tagsElsewhere, ...tagsOn(text)].map((tag) => tag.name).some((kept) => nameKey(kept) === nameKey(name))), assignees: [...assignees.values()], words: read.words };
}

/** Whether checking the todo off leaves it open, as a recurring one's completion does. */
const comesAround = (todo: ListedTodo, on: string) => todo.state !== "done" && changeTodo(todo.text, { state: "done" }, on).filed !== null;

/** A linked note's title; null when there is no such note the member can see; undefined while the notes are still being listed. */
type TitleOf = (noteId: string) => string | null | undefined;

/** What a link in a todo's words says, as a note draws it: its display text, or its note's title. */
function linkText(link: WrittenLink, titleOf: TitleOf): string {
  if (link.display) return link.display;
  const title = titleOf(link.target);
  if (title === undefined) return "…";
  if (title === null) return isNoteId(link.target) ? "Unavailable note" : linkedEvent(link.target) ? "Event" : link.target;
  return title || "Untitled";
}

/** Every link in a todo's words, to a note or out of the app, in the order they are written; one written inside another is left out. */
type Marked = { from: number; to: number } & ({ kind: "note"; link: WrittenLink } | { kind: "out"; out: LinkOut } | { kind: "tag" });

function linksIn(words: string): Marked[] {
  const all: Marked[] = [...linksOn(words).map((link) => ({ from: link.from, to: link.to, kind: "note" as const, link })), ...linksOut(words).map((out) => ({ from: out.from, to: out.to, kind: "out" as const, out }))].sort((a, b) => a.from - b.from);
  let at = 0;
  return all.filter((each) => each.from >= at && ((at = each.to), true));
}

/** A todo's words as they read, each link as the words it shows: what the row is called by. */
const plainly = (words: string, titleOf: TitleOf) => {
  let said = "";
  let at = 0;
  for (const each of linksIn(words)) {
    said += words.slice(at, each.from) + (each.kind === "note" ? linkText(each.link, titleOf) : each.kind === "out" ? each.out.text : "");
    at = each.to;
  }
  return said + words.slice(at);
};

/** A todo's words with the tags written in them drawn as tags, and its links as the words they show. With `onLink`, a link to a note the member can see opens it when pressed, ⌘-pressed in a tab behind, and a link out opens its page in a new tab, as a note's links do. */
function Words({ words, titleOf, onLink }: { words: string; titleOf: TitleOf; onLink?: (noteId: string, background: boolean) => void }) {
  const marks: Marked[] = [...linksIn(words), ...tagsOn(words).map((tag) => ({ from: tag.from, to: tag.to, kind: "tag" as const }))].sort((a, b) => a.from - b.from);
  const parts: (string | { tag: string } | { link: WrittenLink } | { out: LinkOut })[] = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.from < at) continue;
    parts.push(words.slice(at, mark.from), mark.kind === "note" ? { link: mark.link } : mark.kind === "out" ? { out: mark.out } : { tag: words.slice(mark.from, mark.to) });
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
        ) : "out" in part ? (
          <span
            key={i}
            className="todo-link"
            data-opens={onLink ? true : undefined}
            data-href={part.out.url}
            title={onLink ? `${part.out.url}\nClick to open` : part.out.url}
            onClick={(e) => {
              if (!onLink) return;
              // As a link out in a note does, it opens in a tab of the browser's own, and the words around it are still pressed to edit them.
              e.stopPropagation();
              openPage(part.out.url);
            }}
          >
            {part.out.text}
          </span>
        ) : onLink && titleOf(part.link.target) != null ? (
          <span
            key={i}
            className="todo-link"
            data-opens
            title={`Open ${titleOf(part.link.target) || "Untitled"}`}
            onClick={(e) => {
              // Pressing a link follows it; the words around it are still pressed to edit them.
              e.stopPropagation();
              onLink(part.link.target, e.metaKey || e.ctrlKey);
            }}
          >
            {linkText(part.link, titleOf)}
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

/** How each row of a list of todos that can be changed is put away, by the row's element: what the Todos page's keys do to the row they are on. */
const putters = new WeakMap<Element, (to: PutAway) => void>();

/**
 * What puts the todo the keyboard is on in a state, or null where the keyboard is on none: on a row of
 * a list of todos, and not in the field its words are edited in or in its menu. A chip's popover is
 * over the page, and not in the row.
 */
export function putterHere(): ((to: PutAway) => void) | null {
  const at = document.activeElement;
  const row = at && !at.closest(".todo-edit, [role='menu']") ? at.closest(".todo-list > .todo-row") : null;
  return (row && putters.get(row)) ?? null;
}

/**
 * Gives the keyboard to a row of a list of todos, the whole row, as vim's j and k select a row: the
 * keys for a todo work on it, and Tab goes on to its checkbox.
 */
const selectRow = (row: Element | null | undefined) => {
  if (!(row instanceof HTMLElement)) return;
  row.focus();
  row.scrollIntoView({ block: "nearest" });
};

/** The keys for the selected row, as a screen reader names them: those that put it away, then Space and Enter. */
const ROW_KEYS = [...Object.values(PUTTING).map(({ keys }) => keys.find((key) => !key.includes("+"))), "Space", "Enter"].join(" ");

/** Each state a row's buttons put a todo in. Done is its checkbox. */
const BUTTONS = ["abandoned", "backlog"] as const satisfies readonly PutAway[];

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
  /** Whether a change the member made took it out of the list, which it stays in, greyed, until the list is refreshed. */
  gone: boolean;
  /** What is said under a row that is gone: what changed and why it will leave, or nothing. */
  why: string | null;
  onChange: (todo: ListedTodo, change: RowChange) => void;
  /** Takes one of the tags after its words off the todo's line; false when the line no longer has that tag there. */
  onUntag: (todo: ListedTodo, tag: PlacedTag) => boolean;
  /** Opens the todo's note at its line, or at the line a tag it has from elsewhere is written on. */
  onOpen: (at: ListedAt, beside?: boolean) => void;
  /** Reads each time it was checked off. */
  completions: (todo: ListedTodo) => Promise<TodoCompletion[]>;
  onPicking: (event: PickingEvent) => void;
  /** Narrows the list to a tag through the query, or takes it off the query when the list is narrowed to it. */
  onTag: (name: string) => void;
}

/**
 * A todo's row, in two lines. The first is the todo: its checkbox, its words, which are edited right
 * there when pressed, and at the right its note's name, which opens the note at the todo's line. The
 * second, under the words, has a chip for each thing set on the todo, side by side: the due date, the
 * repeat, the last time it was done, the priority, its assignees, the first three tags and a "+N" for
 * the rest, and the tags it has from other lines of its note, which open the line each is written on. After them, shown while the row is pointed at or has the keyboard, are Abandon and Move to
 * backlog, a quiet icon for the date and for Assign when they aren't set, and Add tag, which keep
 * their room after what is set, so nothing moves when they show; and last Repeat and Priority when
 * they aren't set, which take room only while they show. Each chip opens a small popover under itself, and a tag's chip narrows the list
 * through its query; its cross, or Delete on it, takes the tag off. A link in the words opens its note.
 * The row's menu, a right-click, Shift+F10 or the menu key, opens the note, in front or beside the
 * list, and puts the todo in each state.
 */
function Row({ todo, now, narrowedTo, tags, app, titleOf, people, picked, completing, gone, why, onChange, onUntag, onOpen, completions, onPicking, onTag }: RowProps) {
  /** While the words are edited, how tall they were, which their line keeps so that nothing under it moves. */
  const [editing, setEditing] = useState<number | null>(null);
  /** Where the row's menu is open, if it is. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Leaving the field after Enter or Escape has closed it saves nothing more.
  const ending = useRef(false);
  const said = useRef<HTMLSpanElement>(null);
  /** What had the keyboard when the menu was opened, which has it again when the menu closes. */
  const before = useRef<Element | null>(null);
  /** The row, by which the page's keys find how to put its todo away. */
  const li = useRef<HTMLLIElement>(null);
  // A popover stays open while the list is read again: what is picked in it is made to the todo as the list has it then.
  const latest = useRef(todo);
  latest.current = todo;
  // A row is a line of a note. When the list is read again with another todo on that line, as when a line is written above it,
  // the popover opened for the todo that was there closes, so a pick never lands on the one that came.
  // A change made in the popover itself, a tag taken off in the list "+N" opens, leaves it open on the todo as it then reads.
  const openedOn = useRef<string | null>(null);
  const ownChange = useRef(false);
  useEffect(() => {
    if (!picked || openedOn.current === todo.text) return;
    if (ownChange.current) openedOn.current = todo.text;
    else if (openedOn.current !== null) closePopover();
    ownChange.current = false;
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
        if (latest.current.text !== todo.text) return;
        keepOn(chip, anchor);
        onChange(latest.current, to as RowChange);
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
          if (latest.current.text !== todo.text) return;
          keepOn("who", anchor);
          onChange(latest.current, to);
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
  /** The tags past the first ones, listed with a cross each, and Add tag. */
  const listTags = (anchor: HTMLElement) =>
    show("tags", anchor, `Tags of ${words}`, (close) => (
      <MoreTags
        rest={trailing.slice(SHOWN_TAGS).map((name, i) => ({ name, at: SHOWN_TAGS + i }))}
        pressed={narrowed}
        onTag={(name) => {
          close();
          onTag(name);
        }}
        onOpenTag={(name) => {
          close();
          app.go(tagPath(name));
        }}
        tags={tags}
        has={trailing}
        onPick={(name) => {
          close();
          if (latest.current.text === openedOn.current) onChange(latest.current, { words: tagged(latest.current.words, name) });
        }}
        {...(offers && {
          onRemove: (placed: PlacedTag) => {
            // The last tag past the first three takes "+N" with it: the keyboard goes to what comes in its place, Add tag.
            if (trailingNow().length - 1 <= SHOWN_TAGS) refocus.current = (all) => all.find((el) => el.classList.contains("todo-add-tag"));
            ownChange.current = onUntag(latest.current, placed);
            return ownChange.current;
          },
        })}
      />
    ));
  /**
   * Which of the line's buttons has the keyboard once the todo's line is written again: after a tag is
   * taken off from the keyboard, the one that took its place; after a pick in a chip's popover, the chip,
   * which a value set or cleared moves between what is set and what isn't.
   */
  const refocus = useRef<((all: HTMLElement[]) => HTMLElement | undefined) | null>(null);
  const chipsLine = useRef<HTMLSpanElement>(null);
  const focusable = () => [...chipsLine.current!.querySelectorAll<HTMLElement>("button:not([tabindex='-1'])")];
  useLayoutEffect(() => {
    const find = refocus.current;
    refocus.current = null;
    find?.(focusable())?.focus();
  }, [todo.text]);
  const keepOn = (chip: Opened, anchor: HTMLElement) => {
    if (document.activeElement !== anchor) return;
    // Only when the chip was moved and so lost the keyboard: a pick that changed nothing, or a later change, takes it from nothing.
    // The last assignee taken off in a workspace of one leaves no Assign chip, and Add tag has it.
    refocus.current = (all) => (document.activeElement === document.body ? (all.find((el) => el.dataset.chip === chip) ?? all.find((el) => el.matches(".todo-add-tag"))) : undefined);
  };
  const trailingNow = () => splitTags(latest.current.words).trailing;
  const untag = (placed: PlacedTag, from?: HTMLElement) => {
    if (from) {
      const at = focusable().indexOf(from);
      // Past the last tag are Abandon and Move to backlog, which the keyboard doesn't land on: Add tag has it.
      refocus.current = (all) => {
        const next = all[Math.min(at, all.length - 1)];
        return next?.matches(".todo-state") ? (all.find((el) => el.matches(".todo-add-tag")) ?? next) : next;
      };
    }
    onUntag(latest.current, placed);
  };
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

  /** Whether the words take the keyboard back when their field closes, as Enter and Escape close it. */
  const toWords = useRef(false);
  // In the commit that puts the words back, so nothing pressed after Enter or Escape is beaten to the keyboard.
  useLayoutEffect(() => {
    if (editing !== null || !toWords.current) return;
    toWords.current = false;
    said.current?.focus();
  }, [editing]);

  const edit = () => {
    ending.current = false;
    toWords.current = false;
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
  // A todo that can't be changed shows only what is set on it, and so does one that isn't open.
  const offers = !readOnly && todo.state === "open";
  // Each drawn with what is set when it is, and with what the row reveals when it isn't.
  const dueChip = (
    <button className="todo-chip todo-due" data-due={todo.due ? dueState(todo.due, now) : undefined} title={due ? undefined : "Add date"} {...chipProps("due", due)}>
      <Icon name="calendar" />
      {due || <span className="todo-chip-word">Add date</span>}
    </button>
  );
  const repeatChip = (
    <button className="todo-chip todo-every" title={repeat ? everyName(todo.every!) : "Repeat"} {...chipProps("every", repeat)}>
      <Icon name="repeat" />
      {repeat || <span className="todo-chip-word">Repeat</span>}
    </button>
  );
  const levelChip = (
    <button className="todo-chip todo-importance" data-level={todo.importance || undefined} title={level ? undefined : "Priority"} {...chipProps("importance", level)}>
      <Icon name="flag" />
      {level || <span className="todo-chip-word">Priority</span>}
    </button>
  );
  // The note's name and nothing after it: not the tags its title ends in, nor the one the list may be narrowed to.
  const title = splitTags(todo.noteTitle).lead || "Untitled";
  /** Puts the todo in a state, or opens it again when it is in that state. */
  const put = (to: PutAway) => !completing && onChange(latest.current, { state: pressed(latest.current.state, to) });
  useLayoutEffect(() => {
    const row = li.current!;
    if (readOnly) return;
    putters.set(row, put);
    return () => void putters.delete(row);
  });
  const items: MenuItem[] = [
    { label: "Open note", action: () => onOpen(todo) },
    ...(app.openBeside ? [{ label: "Open to the side", action: () => onOpen(todo, true) }] : []),
    ...(readOnly ? [] : (Object.keys(PUTTING) as PutAway[]).map((to, i) => ({ label: todo.state === to ? "Open again" : PUTTING[to].label, icon: todo.state === to ? ("restore" as const) : PUTTING[to].icon, action: () => put(to), separated: i === 0 }))),
  ];

  return (
    <li
      ref={li}
      className="todo-row"
      data-row={row}
      data-state={todo.state === "open" ? undefined : todo.state}
      data-gone={gone || undefined}
      // A row the Todos page's keys put in a state, which is where vim's gx, g- and g> run them.
      data-row-puts={readOnly ? undefined : ""}
      data-picking={picked ?? (menu ? "menu" : undefined)}
      // Selected by the keys, not a stop of its own for Tab.
      tabIndex={-1}
      aria-label={`${words}, ${STATE_NAMES[todo.state]}`}
      aria-keyshortcuts={readOnly ? "Enter" : ROW_KEYS}
      onContextMenu={(e) => {
        if (editing !== null) return;
        e.preventDefault();
        // Asked for by the keyboard, it has no place of its own.
        openMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null, e.target as Element);
      }}
      onKeyDown={(e) => {
        if (editing !== null || menu) return;
        // On the selected row, Space checks the todo off or opens it again, as its checkbox does, and Enter opens its note.
        if (e.target === e.currentTarget && (e.key === " " || e.key === "Enter")) {
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          // A key held down does it once.
          if (e.repeat) return;
          if (e.key === "Enter") onOpen(todo);
          else if (!readOnly && !completing) onChange(todo, { state: clicked(todo.state) });
          return;
        }
        if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
        e.preventDefault();
        openMenu(null, e.target as Element);
      }}
    >
      <input
        type="checkbox"
        className="todo-box"
        checked={todo.state === "done"}
        data-state={todo.state}
        disabled={readOnly}
        // Not disabled while its completion is on its way: that would take the keyboard off it.
        aria-disabled={completing || undefined}
        aria-label={STATE_NAMES[todo.state]}
        title={readOnly ? undefined : boxHint(todo.state, SHIFT, ALT)}
        // An open todo is checked off, and any other opened again. With ⇧ held it is abandoned and with ⌥ moved to the backlog, as the row's
        // buttons do, or opened again from there. It is told of the click that changed it, which holds no keys when it came from the keyboard.
        onChange={(e) => !completing && onChange(latest.current, { state: pressedWith(latest.current.state, e.nativeEvent as MouseEvent) })}
      />
      <i className="todo-box-mark" aria-hidden="true" />
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
              toWords.current = true;
              finish(e.key === "Enter" ? e.currentTarget.value : null);
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
            <Words words={lead || words} titleOf={titleOf} onLink={(noteId, background) => app.openNote(noteId, background ? { background: true } : { preview: true, focus: true })} />
          </span>
        )}
      </span>
      <span className="todo-chips" ref={chipsLine}>
        {due && dueChip}
        {repeat && repeatChip}
        {todo.lastDone && (
          <button type="button" className="todo-chip todo-done" aria-label={doneName(todo.lastDone, now)} aria-haspopup="dialog" aria-expanded={picked === "done"} onClick={(e) => listDone(e.currentTarget)}>
            {doneLabel(todo.lastDone, now)}
          </button>
        )}
        {level && levelChip}
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
        {trailing.slice(0, SHOWN_TAGS).map((name, at) => (
          <span key={`${at} ${name}`} className="todo-tag-chip">
            {/* A click narrows the list to the tag. With the modifier it opens the tag's page, as its card's name does. */}
            <button
              type="button"
              className="todo-chip todo-tag"
              data-tag={name}
              aria-pressed={narrowed(name)}
              aria-keyshortcuts={offers ? "Delete" : undefined}
              onClick={(e) => (e.metaKey || e.ctrlKey ? app.go(tagPath(name)) : onTag(name))}
              onKeyDown={(e) => {
                if (!offers || (e.key !== "Delete" && e.key !== "Backspace")) return;
                e.preventDefault();
                untag({ name, at }, e.currentTarget);
              }}
            >
              <span className="todo-tag-name">#{name}</span>
            </button>
            {offers && (
              // Not a stop of its own for Tab: Delete on the tag does the same.
              <button type="button" className="todo-tag-remove" tabIndex={-1} aria-label={`Remove #${name}`} title={`Remove #${name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => untag({ name, at })}>
                <Icon name="close" />
              </button>
            )}
          </span>
        ))}
        {trailing.length > SHOWN_TAGS && (
          <button
            type="button"
            className="todo-chip todo-more-tags"
            aria-label={`${trailing.length - SHOWN_TAGS} more tags`}
            title={trailing.slice(SHOWN_TAGS).map((name) => `#${name}`).join(" ")}
            aria-haspopup="dialog"
            aria-expanded={picked === "tags"}
            onClick={(e) => listTags(e.currentTarget)}
          >
            +{trailing.length - SHOWN_TAGS}
          </button>
        )}
        {inheritedOnly(todo).map((tag) => (
          // Not on this line, so there is nothing here to take off: it opens the line that writes it. No data-tag, so the tag's card doesn't cover the tooltip saying where it is from.
          <button
            key={`from ${tag.line} ${tag.name}`}
            type="button"
            className="todo-chip todo-tag-from"
            title={`From ${whereFrom(tag, titleOf)}`}
            aria-label={`#${tag.name}, from ${whereFrom(tag, titleOf)}. Opens the line it is written on`}
            onClick={() => onOpen({ noteId: todo.noteId, line: tag.line, tag: tag.name })}
          >
            <span className="todo-tag-name">#{tag.name}</span>
          </button>
        ))}
        {todo.completed && <span className="todo-ticked">{tickedLabel(todo.completed.at, now)}</span>}
        {/* After what is set, what the row reveals while it is pointed at or has the keyboard, so that showing it moves nothing. */}
        {!readOnly && (
          <span className="todo-states">
            {BUTTONS.map((to) => (
              <button
                key={to}
                type="button"
                className="todo-state"
                // What vim's dd presses on a row.
                data-row-delete={to === "abandoned" ? "" : undefined}
                aria-label={PUTTING[to].label}
                aria-pressed={todo.state === to}
                title={todo.state === to ? "Open again" : PUTTING[to].label}
                onClick={() => put(to)}
              >
                <Icon name={PUTTING[to].icon} />
              </button>
            ))}
          </span>
        )}
        {offers && !due && dueChip}
        {/* Only where there is someone to assign it to besides the member: a workspace of one has no Assign chip. */}
        {offers && !todo.assignees.length && people.length > 1 && (
          <button type="button" className="todo-chip todo-assign" data-chip="who" data-unset title="Assign" aria-label="Assign: nobody" aria-haspopup="dialog" aria-expanded={picked === "who"} onClick={(e) => pickWho(e.currentTarget)}>
            <span className="chip-at" aria-hidden="true">@</span>
            <span className="todo-chip-word">Assign</span>
          </button>
        )}
        {offers && (
          <button className="todo-chip todo-add-tag" title="Add tag" {...chipProps("tag", null)} aria-label="Add tag">
            <span className="chip-hash" aria-hidden="true" />
            <span className="todo-chip-word">Add tag</span>
          </button>
        )}
        {/* Last, as they take no room until they show: showing them moves nothing that was there. */}
        {offers && !repeat && repeatChip}
        {offers && !level && levelChip}
      </span>
      <button type="button" className="todo-note" title={`Open ${title}`} data-row-open onClick={() => onOpen(todo)}>
        <span className="todo-note-title">{title}</span>
      </button>
      {gone && why && <p className="todo-why">{why}</p>}
      {menu && <ContextMenu label={`More for ${words}`} x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
    </li>
  );
}

/**
 * A todo's row as {@link Row} draws it, to be read where todos are listed but not changed, as on the
 * Dashboard: its box, its words, its note's name, and what is set on it, in the same two lines and
 * the same chips. The whole row is one button, which opens the todo at its line.
 */
export function TodoGlance({ todo, now, titleOf, onOpen }: { todo: ListedTodo; now: string; titleOf: TitleOf; onOpen: (todo: ListedTodo) => void }) {
  const { lead, trailing } = splitTags(todo.words);
  const due = todo.due && dueLabel(todo.due, now);
  const repeat = todo.every && (todo.recurs ?? todo.every);
  const level = todo.importance ? PRIORITY[todo.importance] : null;
  const title = splitTags(todo.noteTitle).lead || "Untitled";
  return (
    <li className="todo-glance">
      <button type="button" className="todo-row" data-state={todo.state === "open" ? undefined : todo.state} title={`Open ${title} at this todo`} onClick={() => onOpen(todo)}>
        <span className="todo-box" data-state={todo.state} aria-hidden="true" />
        <i className="todo-box-mark" aria-hidden="true" />
        <span className="todo-text">
          <span className="todo-words">
            <Words words={lead || todo.words || "Nothing written"} titleOf={titleOf} />
          </span>
        </span>
        <span className="todo-chips">
          {due && (
            <span className="todo-chip todo-due" data-due={dueState(todo.due!, now)}>
              <Icon name="calendar" />
              {due}
            </span>
          )}
          {repeat && (
            <span className="todo-chip todo-every" title={everyName(todo.every!)}>
              <Icon name="repeat" />
              {repeat}
            </span>
          )}
          {todo.lastDone && <span className="todo-chip todo-done">{doneLabel(todo.lastDone, now)}</span>}
          {level && (
            <span className="todo-chip todo-importance" data-level={todo.importance}>
              <Icon name="flag" />
              {level}
            </span>
          )}
          {todo.assignees.map((person) => (
            <span key={whoOf(person)} className="todo-chip todo-assignee" data-member={person.member || undefined}>
              @{person.name}
            </span>
          ))}
          {trailing.map((name, i) => (
            <span key={`${i} ${name}`} className="todo-chip todo-tag" data-tag={name}>
              #{name}
            </span>
          ))}
          {inheritedOnly(todo).map((tag) => (
            <span key={`from ${tag.line} ${tag.name}`} className="todo-chip todo-tag-from" title={`From ${whereFrom(tag, titleOf)}`}>
              #{tag.name}
            </span>
          ))}
        </span>
        <span className="todo-note">
          <span className="todo-note-title">{title}</span>
        </span>
      </button>
    </li>
  );
}

interface Props {
  host: PluginHost;
  app: App;
  /** Opens a todo's note with the cursor on its line, or on another line of it, in a split beside what is in front when `beside`. */
  onOpen: (at: ListedAt, beside?: boolean) => void;
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
  /** Whether a row a change took out of the list says why under itself: the Todos page's setting, which another plugin's page can't read. */
  sayWhy?: boolean;
  /** Where the keyboard goes when the row it was in leaves the list and no row is left: the Todos page's bar. */
  home?: RefObject<HTMLElement | null>;
  /** Whether a todo put away stays in its place, in its new state, until the list is refreshed, instead of going after its moment: the Todos page's setting too. */
  keepPutAway?: boolean;
}

/**
 * Todos as rows, read for a query and read again whenever a note changes: each row changed in place,
 * one change after another, a checked one lingering struck through, and a row a change took out of the
 * query staying, dimmed, until Refresh. With `keepPutAway`, a todo put away stays until Refresh as well. The Todos page is its bar over one of these, and a person's page has one of their open todos.
 */
export function TodoList({ host, app, onOpen, query, label, inspected = false, narrowedTo: narrowedTags = [], onTag, onUnanswered, none, sayWhy = false, home, keepPutAway = false }: ListProps) {
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
  /** Whether the bar at the top of the list says the order has changed: up until the list is in order again, or it is sent away. */
  const [told, setTold] = useState(false);
  const take = (event: ListingEvent<ListedTodo>) => {
    const next = listing(had.current.list, event);
    // Said after the member's own change that leaves the list out of order, and when anyone's change first does, a teammate's or one in a note.
    if (event.type === "read" && pending(next) && (announce.current || (!pending(had.current.list) && !quiet.current))) setTold(true);
    if (event.type === "read") announce.current = quiet.current = false;
    arrange(event);
  };
  const out = pending(list);
  useEffect(() => {
    if (!out) setTold(false);
  }, [out]);

  useEffect(() => {
    // A query that can't be read is said so under the bar, and the list stays as it was.
    if (!read.ok) return;
    let stale = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    const readFor = JSON.stringify(ask);
    // Read again, the list is read as far as Show more had read it, so the rows it brought stay; a list read for another query starts again.
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
    if (next) selectRow(ul.current?.querySelector(`[data-row="${CSS.escape(next)}"]`));
    else home?.current?.focus();
  }, [listed]);

  /** A button of the order bar pressed from the keys gives the keyboard to the list's first row as the bar goes. */
  const keepKeyboard = (button: HTMLElement) => {
    if (button.matches(":focus-visible")) requestAnimationFrame(() => selectRow(ul.current?.firstElementChild));
  };

  const narrowing = useMemo(() => narrowingOf(query), [query]);
  const whyGone = (todo: ListedTodo) => leaving(todo, narrowing, now)?.says ?? null;

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
            // One this change ticked says so now, as the list read again will: the change is the note's latest.
            arrange({ type: "change", key: keyOf(todo), to: (t) => ({ ...t, revision: note.revision, ...(t.state === "done" && !t.completed && { completed: { at: note.updatedAt, by: note.updatedBy } }) }) });
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

  /**
   * When the keyboard is in a row that a change takes out of the list, gives it to the next row that
   * stays, or else the one before, so that the member can go on down the list with the keys.
   */
  const onward = useCallback(
    (todo: ListedTodo, after: ListedTodo) => {
      const { states } = narrowing;
      const key = keyOf(todo);
      const rowOf = (of: string) => ul.current?.querySelector(`[data-row="${CSS.escape(of)}"]`);
      if (!states || states.includes(after.state) || !rowOf(key)?.contains(document.activeElement)) return;
      const rows = had.current.list.shown;
      const going = left(had.current.list);
      const at = rows.findIndex((t) => keyOf(t) === key);
      const next = [...rows.slice(at + 1), ...rows.slice(0, Math.max(at, 0)).reverse()].find((t) => !going.has(keyOf(t)) && states.includes(t.state));
      if (next) selectRow(rowOf(keyOf(next)));
    },
    [narrowing],
  );

  const change = useCallback(
    (todo: ListedTodo, to: RowChange) => {
      setProblem(null);
      const after = changed(todo, to, now);
      // Checking a todo off, abandoning it or moving it to the backlog puts it away: it says so with an Undo, and goes after its moment or is kept.
      const away = to.state !== undefined && to.state !== "open" && to.state !== todo.state ? to.state : null;
      const rolls = away === "done" && comesAround(todo, now);
      if (rolls) setCompleting((keys) => new Set(keys).add(keyOf(todo)));
      // Putting one away says so instead, and opening one again says nothing; either stays where it is until the list is refreshed.
      if (to.state === undefined) announce.current = true;
      else quiet.current = true;
      onward(todo, after);
      const hold: Hold = away ? (keepPutAway ? "kept" : "put away") : "changed";
      const sent = send(todo, to, hold);
      if (rolls) void sent.catch(() => {}).finally(() => setCompleting((keys) => new Set([...keys].filter((key) => key !== keyOf(todo)))));
      sent.then(
        (note) => {
          if (!away) return;
          // A todo put away stays its moment, and then goes when the list no longer has it, as the last time of a repeating one doesn't. One kept stays until Refresh.
          const key = keyOf(todo);
          if (hold === "put away") setTimeout(() => arrange({ type: "let go", key }), LINGER_MS);
          // A recurring todo's completion moved its due date, counted it and filed a line on the daily note: Undo reverts the change that did, which takes all of it back.
          if (note.filed) return putAway(host, "done", () => takeBack(host, todo.noteId, note.revision).finally(() => setAsked((n) => n + 1)));
          if (after.state !== away) return;
          // Undo is the same change the other way, made to the line this one left, at the revision it made.
          // It is made to the todo as the page has it by then, which may have been changed again since.
          putAway(host, away, () => send(shown.current.find((t) => keyOf(t) === key && t.state === away) ?? { ...after, revision: note.revision }, { state: todo.state }).then(() => undefined, (err: unknown) => refused(err, away)));
        },
        (err: unknown) => setProblem(err instanceof Error ? err.message : "The todo couldn't be changed."),
      );
      return sent;
    },
    [send, now, host, onward, keepPutAway],
  );

  /** Takes a tag off a todo's line, with an Undo that puts it back where it was, or after its words when they were changed since. */
  const untag = useCallback(
    (todo: ListedTodo, { name, at }: PlacedTag) => {
      const { lead, trailing } = splitTags(todo.words);
      if (nameKey(trailing[at] ?? "") !== nameKey(name)) return false;
      const left = [lead, ...trailing.filter((_, i) => i !== at).map((t) => `#${t}`)].join(" ");
      const key = keyOf(todo);
      change(todo, { words: left }).then(
        () =>
          app.notify({
            message: `Removed #${name}`,
            icon: "tag",
            action: {
              label: "Undo",
              run: async () => {
                const now = shown.current.find((t) => keyOf(t) === key);
                if (!now) return { message: "That todo is no longer listed, so the tag was left off." };
                return send(now, { words: now.words === left ? todo.words : tagged(now.words, name) }).then(
                  () => undefined,
                  (err: unknown) => ({ message: err instanceof Error ? err.message : "The tag couldn't be put back." }),
                );
              },
            },
          }),
        // Said by the page already.
        () => {},
      );
      return true;
    },
    [app, change, send],
  );

  /** Who a todo can be assigned to: the members, when the member may list them, and whoever todos are assigned to now. */
  const [people, setPeople] = useState<readonly Mentioned[]>([]);
  useEffect(() => {
    let stale = false;
    let again: ReturnType<typeof setTimeout> | undefined;
    // A refusal, such as a guest's, means nobody to list. A fault leaves who was listed, and they are asked for again as the list is.
    const nobodyIfRefused = (err: unknown) => {
      if (fault(err)) throw err;
      return [];
    };
    const members = host.perform({ type: "member.list" }).then((list) => list.map((m): Mentioned => ({ id: m.personId, name: m.name, member: true })), nobodyIfRefused);
    const assigned = host.perform({ type: "todo.filters", includeArchived: true }).then((filters) => filters.assignees, nobodyIfRefused);
    void Promise.all([members, assigned]).then(
      ([m, a]) => {
        if (stale) return;
        const all = new Map<string, Mentioned>();
        for (const person of [...m, ...a]) if (!all.has(mentionKey({ target: whoOf(person) }))) all.set(mentionKey({ target: whoOf(person) }), person);
        setPeople([...all.values()].sort((x, y) => Number(y.member) - Number(x.member) || x.name.localeCompare(y.name, undefined, { sensitivity: "base" })));
      },
      () => {
        if (!stale) again = setTimeout(() => setAsked((n) => n + 1), AGAIN_MS);
      },
    );
    return () => {
      stale = true;
      clearTimeout(again);
    };
  }, [host, version, asked]);

  const completions = useCallback(
    (todo: ListedTodo) => host.perform({ type: "todo.history", id: todo.noteId, revision: sending.current.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text }).then((history) => history.completions),
    [host],
  );

  const more = () => {
    if (page?.next == null) return;
    void host.perform({ type: "todo.list", ...ask, after: page.next }).then(
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
        <div className="todo-card">
          <div className="todo-order-slot" role="status">
            {told && (
              <div className="todo-order">
                <Icon name="list" />
                <span className="todo-order-text">The order has changed.</span>
                <button
                  type="button"
                  className="todo-order-refresh"
                  onClick={(e) => {
                    keepKeyboard(e.currentTarget);
                    arrange({ type: "refresh" });
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="todo-order-dismiss"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={(e) => {
                    keepKeyboard(e.currentTarget);
                    setTold(false);
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
          </div>
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
            onKeyDown={(e) => {
              // The arrows select the row above or below, from anywhere in a row but the field its words are edited in and its menu.
              if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
              const at = e.target as HTMLElement;
              if (!e.currentTarget.contains(at) || at.closest(".todo-edit, [role='menu']")) return;
              const rows = [...e.currentTarget.children];
              const next = rows[rows.findIndex((row) => row.contains(at)) + (e.key === "ArrowDown" ? 1 : -1)];
              if (!next) return;
              e.preventDefault();
              selectRow(next);
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
                gone={gone.has(keyOf(todo)) && list.held.get(keyOf(todo)) !== "put away"}
                why={sayWhy && gone.has(keyOf(todo)) ? whyGone(todo) : null}
                onChange={change}
                onUntag={untag}
                onOpen={onOpen}
                completions={completions}
                onPicking={onPicking}
                onTag={onTag}
              />
            ))}
          </ul>
        </div>
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
  /** The member's order, kept with the account: the bar's `sort:` follows it, and the member's own `sort:` changes it. */
  const sort = host.settings.get<TodoSort>("sort");
  const [typed, setTyped] = useState(() => (linked ?? sortedAs(savedQuery(host.storage.get("query"), host.storage.get("filters")), sort)).slice(0, MAX_SEARCH_LENGTH));
  const [query, setQuery] = useState(typed);
  /** What the server said of a query that reads and can't be answered, and the query it said it of. */
  const [unanswered, setUnanswered] = useState<{ query: string; message: string } | null>(null);
  /** The tags the list is narrowed to: their chips read as pressed. */
  const narrowedTags = useMemo(() => narrowedTo(query), [query]);
  const read = useMemo(() => parseQuery(query, "todos"), [query]);
  const field = useRef<HTMLInputElement>(null);
  const ids = useId();

  const run = (text: string) => {
    setQuery(text);
    host.storage.set("query", text);
    // A link's query stays in the address only while it is the page's: a reload then opens the query the member left.
    if (linked !== null && text !== linked) app.go(app.path, { replace: true });
  };
  /** Runs a query the member asked for: its `sort:`, or none, is their order from now on, kept with the account. */
  const askFor = (text: string) => {
    run(text);
    const choice = choiceIn(text);
    if (choice !== null && choice !== host.settings.get<TodoSort>("sort") && !host.settings.set("sort", choice))
      app.notify({ message: "The order couldn't be kept: your settings aren't read yet. Try again in a moment.", icon: "list" });
  };
  // The account's order is the bar's `sort:`: once the member's settings are read, and when it is reset or changed in another tab.
  const lastSort = useRef(sort);
  useEffect(() => {
    if (lastSort.current === sort) return;
    lastSort.current = sort;
    // A link that names its order opens in that order.
    if (typed === linked && /(^|\s)sort:/iu.test(typed)) return;
    const next = sortedAs(typed, sort);
    if (next === typed) return;
    setTyped(next);
    run(next);
  }, [sort]);
  // A Sort chosen in this browser before it was kept with the account moves there once, as soon as the member's settings are read, unless the account has one already.
  useEffect(() => {
    const move = () => {
      const kept: unknown = host.storage.get("sort");
      if (kept === undefined || kept === null) return true;
      if (typeof kept === "string" && kept in SORTS && host.settings.get("sort") === "due" && !host.settings.set("sort", kept)) return false;
      host.storage.set("sort", null);
      return true;
    };
    if (move()) return;
    const stop = host.settings.subscribe(() => void (move() && stop()));
    return stop;
  }, [host]);
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
    const timer = setTimeout(() => askFor(wanted), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [wanted, query]);

  /** The order the list is in, as the Sort menu shows it: the query's `sort:`, which picking one writes in the bar. */
  const sorted = sortChoice(read.ok ? read.query.sort : null);
  const sortBy = (choice: string) => {
    const next = withSort(typed, choice === "due" ? null : choice in SORTS ? TODO_SORT_WORDS[choice as TodoSort] : (choice as SortKey));
    setTyped(next);
    askFor(next);
  };
  const chooseState = (choice: StateChoice) => {
    const next = withState(typed, choice);
    setTyped(next);
    askFor(next);
  };

  return (
    <section className="todos-page" aria-label="Todos">
      <h1>Todos</h1>
      <div className="todo-tools">
        <QueryBar
          host={host}
          app={app}
          scope="todos"
          value={typed}
          label="Filter todos"
          fieldRef={field}
          placeholder="Filter todos: words, #tag, due:<today, assignee:@me"
          problem={unanswered?.query === query ? unanswered.message : null}
          onChange={(text, how) => {
            setTyped(text);
            if (how === "set" || !text.trim()) askFor(text.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && wanted !== query) askFor(wanted);
            // With nothing offered under it, ArrowDown selects the list's first row.
            if (e.key !== "ArrowDown" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            const first = e.currentTarget.closest(".todos-page")?.querySelector(".todo-list > .todo-row");
            if (!first) return;
            e.preventDefault();
            selectRow(first);
          }}
        />
        <label className="todo-sort">
          Sort
          {/* Named by its label alone: the options it holds, Due date and Priority, are the names of filters. */}
          <select aria-label="Sort" value={sorted} onChange={(e) => sortBy(e.target.value)}>
            {Object.entries(SORTS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {!(sorted in SORTS) && <option value={sorted}>sort:{sorted}</option>}
          </select>
        </label>
      </div>
      <Segmented className="todo-state-choices" name={`${ids}-state`} label="Todos by state" choices={STATE_CHOICES} chosen={stateOf(typed)} onChoose={chooseState} />
      <QuickAdd host={host} />
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
        sayWhy={host.settings.get<boolean>("sayWhyLeaving")}
        home={field}
        keepPutAway={host.settings.get<boolean>("keepPutAway")}
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
