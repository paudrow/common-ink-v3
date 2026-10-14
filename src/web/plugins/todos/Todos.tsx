import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Icon, MAX_SEARCH_LENGTH, changeTodo, nameKey, parseQuery, parseTodo, ruleLabel, tagsOn, useNow, type App, type ListedTodo, type PluginHost, type Results, type TodoChange, type TodoCompletion } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { closePopover, openPopover } from "../lib/Popover.tsx";
import { QueryBar } from "../lib/QueryBar.tsx";
import { ChipMenu } from "./ChipMenu.tsx";
import { completed, refused, takeBack } from "./completed.ts";
import { Completions } from "./Completions.tsx";
import { dayOf, dueLabel, dueState, savedQuery } from "./dates.ts";
import { CHIP_NAMES, IMPORTANCE, pickerLabel, picking, type ChipKind, type Opened, type PickingEvent } from "./picking.ts";
import { narrowedTo, toggledTag } from "./tagged.ts";
import { doneLabel, doneName, everyName } from "./recurrence.ts";

/** How long typing rests before the list is asked for, so a word is one ask and not one a letter. */
const PAUSE_MS = 200;

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
  /** The tags the list is narrowed to, as the query names them. */
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
  /** Narrows the list to a tag through the query, or takes it off the query when the list is narrowed to it. */
  onTag: (name: string) => void;
}

/**
 * A todo's card: its checkbox, its words, which open its note, and what is set on it as chips straight
 * after the words, each opening a small popover under itself to be set with. What has no chip is in one
 * menu: from the "…" button, a right-click, or the menu key on the row.
 */
function Row({ todo, now, tags, app, picked, completing, onChange, onOpen, completions, onPicking, onTag }: RowProps) {
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
  const ownTags = new Set(tagsOn(todo.text).map((own) => nameKey(own.name)));
  const ofNote = tags.filter((tag) => !ownTags.has(nameKey(tag))).flatMap((tag) => todo.tags.filter((name) => nameKey(name) === nameKey(tag)));
  const narrowed = (name: string) => tags.some((tag) => nameKey(tag) === nameKey(name));

  /** Opens a popover under `anchor` for one of the card's chips, with the card marked while it is open. */
  const show = (chip: Opened, anchor: HTMLElement, label: string, content: (close: () => void) => ReactNode) => {
    onPicking({ type: "open", row, chip });
    openedOn.current = todo.text;
    openPopover(anchor, label, content, () => onPicking({ type: "closed", row, chip }));
  };
  /** Opens a chip's popover under `anchor`: the chip, or the "…" button for what has no chip yet. */
  const pick = (chip: ChipKind, anchor: HTMLElement) =>
    show(chip, anchor, pickerLabel(chip, words), (close) => (
      <ChipMenu
        chip={chip}
        todo={todo}
        now={now}
        onPick={(to) => {
          close();
          if (latest.current.text !== todo.text) return;
          // A chip the pick takes away can't have the keyboard back: the card's "…" has it.
          if (document.activeElement === anchor && (to.due === null || to.importance === 0 || to.every === null)) more.current?.focus();
          onChange(latest.current, to);
        }}
      />
    ));
  const chipProps = (chip: ChipKind, said: string) => ({
    type: "button" as const,
    "aria-label": `${CHIP_NAMES[chip]}: ${said}`,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": picked === chip,
    disabled: readOnly,
    onClick: (e: { currentTarget: HTMLElement }) => pick(chip, e.currentTarget),
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
          ...(todo.importance ? [] : [{ label: "Importance…", action: () => pick("importance", more.current!) }]),
          ...(todo.due ? [] : [{ label: "Due date…", action: () => pick("due", more.current!) }]),
          ...(todo.every ? [] : [{ label: "Recurrence…", action: () => pick("every", more.current!) }]),
        ]),
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
          <button className="todo-chip todo-every" title={everyName(todo.every)} {...chipProps("every", todo.recurs ?? todo.every)}>
            <Icon name="repeat" />
            {todo.recurs ?? todo.every}
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
      </span>
      <span className="todo-where">
        <span className="todo-note">{todo.noteTitle || "Untitled"}</span>
        {ofNote.map((name) => (
          <span key={name} className="todo-chip todo-tag">
            #{name}
          </span>
        ))}
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
  /** The query the page's address names with `?q=`, as a link to the page does. */
  const linked = useMemo(() => new URLSearchParams(app.query).get("q")?.trim() ?? null, [app.query]);
  /** What is in the bar, and the query the list is of: the same once typing rests. It is kept in this browser, so the page opens the way it was left. */
  const [typed, setTyped] = useState(() => (linked ?? savedQuery(host.storage.get("query"), host.storage.get("filters"))).slice(0, MAX_SEARCH_LENGTH));
  const [query, setQuery] = useState(typed);
  const [page, setPage] = useState<Results["todo.list"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** What the server said of a query that reads and can't be answered, and the query it said it of. */
  const [unanswered, setUnanswered] = useState<{ query: string; message: string } | null>(null);
  const [asked, setAsked] = useState(0);
  const [picked, onPicking] = useReducer(picking, null);
  /** The recurring todos whose completion is on its way. Checked again before it lands, one would be completed twice. */
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  /** The todos as the page shows them now, for an Undo pressed after more was changed. */
  const shown = useRef<readonly ListedTodo[]>([]);
  shown.current = page?.todos ?? [];
  /** The changes on their way to the server, one at a time, how many there are, and the revision each note they changed is at now. */
  const sending = useRef({ last: Promise.resolve(), count: 0, revisions: new Map<string, number>() });
  // Today is the member's own: the day it is in this browser, looked at again each minute.
  const now = dayOf(new Date(useNow()));
  const read = useMemo(() => parseQuery(query, "todos"), [query]);
  const ask = useMemo(() => ({ query, today: now, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }), [query, now]);
  /** The tags the list is narrowed to: their chips read as pressed, and a todo listed for its note's tag says it beside the note. */
  const tags = useMemo(() => narrowedTo(query), [query]);
  // The list is read again whenever a note the member can see changes, by anyone, or is archived, trashed, or brought back.
  const version = useMemo(() => (app.notes ?? []).map((n) => `${n.id}:${n.revision}:${n.state}`).join(","), [app.notes]);

  const run = (text: string) => {
    setQuery(text);
    setProblem(null);
    host.storage.set("query", text);
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
    host.perform({ type: "todo.list", ...ask }).then(
      (listed) => {
        // A list read while changes are on their way doesn't have them yet. It is read again when they have landed.
        if (stale || sending.current.count) return;
        sending.current.revisions.clear();
        setPage(listed);
        setUnanswered(null);
      },
      (err: unknown) => {
        if (stale) return;
        // What was listed answered another query, so it is not left under why this one wasn't answered.
        setPage(null);
        setUnanswered({ query: ask.query, message: err instanceof Error ? err.message : "The todos couldn't be read." });
      },
    );
    return () => {
      stale = true;
    };
  }, [host, ask, read.ok, version, asked]);

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
    void host.perform({ type: "todo.list", ...ask, offset: page.next }).then((next) => setPage((had) => (had ? { todos: [...had.todos, ...next.todos], next: next.next } : next)));
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
      {problem && (
        <p className="notice" role="alert">
          {problem}
        </p>
      )}
      {page && page.todos.length === 0 && <p className="todo-none">{query ? "No todos match." : "Nothing to do. A todo is a line that starts - [ ] in any note."}</p>}
      {page && page.todos.length > 0 && (
        <ul className="cards" aria-label="Todos">
          {page.todos.map((todo) => (
            <Row
              key={keyOf(todo)}
              todo={todo}
              now={now}
              tags={tags}
              app={app}
              picked={picked?.row === keyOf(todo) ? picked.chip : null}
              completing={completing.has(keyOf(todo))}
              onChange={change}
              onOpen={onOpen}
              completions={completions}
              onPicking={onPicking}
              onTag={(name) => {
                const next = toggledTag(typed, name);
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
