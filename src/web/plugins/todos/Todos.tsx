import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { changeTodo, parseTodo, useNow, type App, type Importance, type ListedTodo, type OpInput, type PluginHost, type Results, type TodoChange, type TodoCompletion } from "../../plugin-api.ts";
import { openPopover } from "../lib/Popover.tsx";
import { IMPORTANCE } from "./chips.ts";
import { Completions } from "./Completions.tsx";
import { DUE_FILTERS, dayOf, dueLabel, dueRange, dueState, type DueFilter } from "./dates.ts";
import { doneLabel, doneName, everyLabel, everyName } from "./recurrence.ts";
import { RuleForm } from "./RuleForm.tsx";

/** What the list is narrowed to. Kept in this browser, so the page opens the way it was left. */
interface Filters {
  project: string;
  tag: string;
  due: DueFilter;
  /** A level, or "" for any. */
  importance: string;
  completed: boolean;
  /** Whether todos in archived notes are listed too. */
  archived: boolean;
}

const EVERYTHING: Filters = { project: "", tag: "", due: "any", importance: "", completed: false, archived: false };

const stored = (value: unknown): Filters => {
  const kept = typeof value === "object" && value !== null ? (value as Partial<Record<keyof Filters, unknown>>) : {};
  return {
    project: typeof kept.project === "string" ? kept.project : "",
    tag: typeof kept.tag === "string" ? kept.tag : "",
    due: typeof kept.due === "string" && kept.due in DUE_FILTERS ? (kept.due as DueFilter) : "any",
    importance: typeof kept.importance === "string" && /^[0-3]?$/.test(kept.importance) ? kept.importance : "",
    completed: kept.completed === true,
    archived: kept.archived === true,
  };
};

type Query = Omit<Extract<OpInput, { type: "todo.list" }>, "type">;

const queryOf = (filters: Filters, now: string): Query => ({
  ...(filters.project && { project: filters.project }),
  ...(filters.tag && { tag: filters.tag }),
  ...(filters.importance && { importance: [Number(filters.importance) as Importance] }),
  ...dueRange(filters.due, now),
  includeCompleted: filters.completed,
  includeArchived: filters.archived,
});

const keyOf = (todo: ListedTodo) => `${todo.noteId}/${todo.line}`;

/** The todo as it reads once `change` is made on the day `on`, by the function the server makes it with: a recurring todo checked off stays open, due next. */
function changed(todo: ListedTodo, change: TodoChange, on: string): ListedTodo {
  const text = changeTodo(todo.text, change, on).line;
  const read = parseTodo(text);
  if (!read) return todo;
  const lastDone = read.lastDone && { on: read.lastDone.on, times: read.lastDone.times };
  return { ...todo, text, done: read.done, importance: read.importance, due: read.due?.date ?? null, every: read.every?.written ?? null, lastDone, projects: read.projects.map((p) => p.name), words: read.words };
}

/** Whether checking the todo off leaves it open, as a recurring one's completion does. */
const comesAround = (todo: ListedTodo, on: string) => !todo.done && changeTodo(todo.text, { done: true }, on).filed !== null;

interface RowProps {
  todo: ListedTodo;
  now: string;
  projects: readonly string[];
  /** Whether its completion is on its way to the server. */
  completing: boolean;
  onChange: (todo: ListedTodo, change: TodoChange) => void;
  onOpen: (todo: ListedTodo) => void;
  /** Reads each time it was checked off. */
  completions: (todo: ListedTodo) => Promise<TodoCompletion[]>;
  onOpenNote: (noteId: string) => void;
}

function Row({ todo, now, projects, completing, onChange, onOpen, completions, onOpenNote }: RowProps) {
  const readOnly = todo.access !== "edit";
  // A panel stays open while the list is read again, and what it does is done to the row as it reads by then.
  const row = useRef(todo);
  row.current = todo;
  const setEvery = (e: MouseEvent<HTMLButtonElement>) =>
    openPopover(e.currentTarget, "Recurrence", (close) => (
      <RuleForm
        every={todo.every}
        onSet={(every) => {
          close();
          onChange(row.current, { every });
        }}
      />
    ));
  const listDone = (e: MouseEvent<HTMLButtonElement>) => {
    const ask = () => completions(row.current);
    openPopover(e.currentTarget, "Completions", (close) => (
      <Completions
        ask={ask}
        done={todo.lastDone!}
        now={now}
        onOpen={(noteId) => {
          close();
          onOpenNote(noteId);
        }}
      />
    ));
  };
  const others = projects.filter((name) => !todo.projects.some((mine) => mine.toLowerCase() === name.toLowerCase()));
  return (
    <li className="todo-row" data-done={todo.done || undefined}>
      <input type="checkbox" checked={todo.done} disabled={readOnly || completing} aria-label={todo.done ? "Done" : "Not done"} onChange={(e) => onChange(todo, { done: e.target.checked })} />
      <span className="todo-chip todo-importance" data-level={todo.importance}>
        {todo.importance ? IMPORTANCE[todo.importance] : "!"}
        <select aria-label="Importance" value={todo.importance} disabled={readOnly} onChange={(e) => onChange(todo, { importance: Number(e.target.value) as Importance })}>
          {IMPORTANCE.map((label, level) => (
            <option key={label} value={level}>
              {label}
            </option>
          ))}
        </select>
      </span>
      <button type="button" className="todo-words" onClick={() => onOpen(todo)}>
        <span>{todo.words || "Nothing written"}</span>
        <span className="todo-note">{todo.noteTitle || "Untitled"}</span>
      </button>
      <span className="todo-chips">
        {todo.projects.map((name) => (
          <span key={name} className="todo-chip todo-project">
            +{name}
            <select
              aria-label={`Project ${name}`}
              value={name}
              disabled={readOnly}
              onChange={(e) => onChange(todo, e.target.value ? { removeProject: name, addProject: e.target.value } : { removeProject: name })}
            >
              <option value={name}>{name}</option>
              {others.map((other) => (
                <option key={other} value={other}>
                  {other}
                </option>
              ))}
              <option value="">No project</option>
            </select>
          </span>
        ))}
        {!readOnly && others.length > 0 && (
          <span className="todo-chip todo-add">
            + Project
            <select aria-label="Add to a project" value="" onChange={(e) => e.target.value && onChange(todo, { addProject: e.target.value })}>
              <option value="">Add to a project</option>
              {others.map((other) => (
                <option key={other} value={other}>
                  {other}
                </option>
              ))}
            </select>
          </span>
        )}
        {(todo.every || !readOnly) && (
          <span className="todo-chip todo-every" data-set={todo.every ? true : undefined}>
            {todo.every ? everyLabel(todo.every) : "↻ Recur"}
            <button type="button" aria-label={everyName(todo.every)} title={everyName(todo.every)} aria-haspopup="dialog" disabled={readOnly} onClick={setEvery} />
          </span>
        )}
        {todo.lastDone && (
          <span className="todo-chip todo-done">
            {doneLabel(todo.lastDone, now)}
            <button type="button" aria-label={doneName(todo.lastDone, now)} title={doneName(todo.lastDone, now)} aria-haspopup="dialog" onClick={listDone} />
          </span>
        )}
        {(todo.due || !readOnly) && (
          <span className="todo-chip todo-due" data-due={todo.due ? dueState(todo.due, now) : "none"}>
            {todo.due ? dueLabel(todo.due, now) : "No date"}
            <input
              type="date"
              aria-label="Due date"
              value={todo.due ?? ""}
              disabled={readOnly}
              onClick={(e) => {
                try {
                  e.currentTarget.showPicker();
                } catch {
                  // A browser that won't open its calendar from here still takes the date typed into the field.
                }
              }}
              onChange={(e) => onChange(todo, { due: e.target.value || null })}
            />
          </span>
        )}
      </span>
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
  const [options, setOptions] = useState<Results["todo.filters"]>({ projects: [], tags: [] });
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  /** The recurring todos whose completion is on its way. Checked again before it lands, one would be completed twice. */
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  /** The changes on their way to the server, one at a time, how many there are, and the revision each note they changed is at now. */
  const sending = useRef({ last: Promise.resolve(), count: 0, revisions: new Map<string, number>() });
  // Today is the member's own: the day it is in this browser, looked at again each minute.
  const now = dayOf(new Date(useNow()));
  const query = useMemo(() => queryOf(filters, now), [filters, now]);
  // The list is read again whenever a note the member can see changes, by anyone, or is archived, trashed, or brought back.
  const version = useMemo(() => (app.notes ?? []).map((n) => `${n.id}:${n.revision}:${n.state}`).join(","), [app.notes]);

  useEffect(() => {
    let stale = false;
    Promise.all([host.perform({ type: "todo.list", ...query }), host.perform({ type: "todo.filters", includeArchived: query.includeArchived })]).then(
      ([listed, narrowing]) => {
        // A list read while changes are on their way doesn't have them yet. It is read again when they have landed.
        if (stale || sending.current.count) return;
        sending.current.revisions.clear();
        setPage(listed);
        setOptions(narrowing);
      },
      (err: unknown) => !stale && setProblem(err instanceof Error ? err.message : "The todos couldn't be read."),
    );
    return () => {
      stale = true;
    };
  }, [host, query, version, asked]);

  const narrow = (change: Partial<Filters>) => {
    const next = { ...filters, ...change };
    setFilters(next);
    setProblem(null);
    host.storage.set("filters", next);
  };

  const change = useCallback(
    (todo: ListedTodo, to: TodoChange) => {
      setProblem(null);
      const rolls = to.done === true && comesAround(todo, now);
      if (rolls) setCompleting((keys) => new Set(keys).add(keyOf(todo)));
      // The row reads as changed at once, so the next change to it is made to the line as it will be.
      setPage((had) => had && { ...had, todos: had.todos.map((t) => (keyOf(t) === keyOf(todo) ? changed(t, to, now) : t)) });
      const queue = sending.current;
      queue.count++;
      // One at a time: each change names the line as the one before it left it, at the revision that one made.
      queue.last = queue.last
        .then(() => host.perform({ type: "todo.set", id: todo.noteId, revision: queue.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text, ...to, on: now }))
        .then(
          (note) => {
            queue.revisions.set(keyOf(todo), note.revision);
            app.noteChanged(note);
          },
          (err: unknown) => setProblem(err instanceof Error ? err.message : "The todo couldn't be changed."),
        )
        // Read again either way: after a change for what it left, and after a refusal for what is there now.
        .finally(() => {
          if (rolls) setCompleting((keys) => new Set([...keys].filter((key) => key !== keyOf(todo))));
          if (--queue.count === 0) setAsked((n) => n + 1);
        });
    },
    [host, app.noteChanged, now],
  );

  const completions = useCallback(
    (todo: ListedTodo) => host.perform({ type: "todo.history", id: todo.noteId, revision: sending.current.revisions.get(keyOf(todo)) ?? todo.revision, line: todo.line, text: todo.text }).then((history) => history.completions),
    [host],
  );
  const openNote = useCallback((noteId: string) => app.openNote(noteId), [app.openNote]);

  const more = () => {
    if (page?.next == null) return;
    void host.perform({ type: "todo.list", ...query, offset: page.next }).then((next) => setPage((had) => (had ? { todos: [...had.todos, ...next.todos], next: next.next } : next)));
  };

  // A filter the member left on names something that may be gone since; it stays choosable so it can be seen and taken off.
  const offered = (names: readonly string[], chosen: string) => (chosen && !names.some((n) => n.toLowerCase() === chosen.toLowerCase()) ? [...names, chosen] : names);
  const narrowed = JSON.stringify(filters) !== JSON.stringify(EVERYTHING);

  return (
    <section className="todos-page" aria-label="Todos">
      <h1>Todos</h1>
      <div className="todo-filters" role="group" aria-label="Filters">
        <label>
          Project
          <select value={filters.project} onChange={(e) => narrow({ project: e.target.value })}>
            <option value="">All projects</option>
            {offered(options.projects, filters.project).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tag
          <select value={filters.tag} onChange={(e) => narrow({ tag: e.target.value })}>
            <option value="">All tags</option>
            {offered(options.tags, filters.tag).map((name) => (
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
        <label className="todo-completed">
          <input type="checkbox" checked={filters.archived} onChange={(e) => narrow({ archived: e.target.checked })} />
          Include archived
        </label>
      </div>
      {problem && (
        <p className="notice" role="alert">
          {problem}
        </p>
      )}
      {page && page.todos.length === 0 && <p className="todo-none">{narrowed ? "No todos match." : "Nothing to do. A todo is a line that starts - [ ] in any note."}</p>}
      {page && page.todos.length > 0 && (
        <ul className="todo-list" aria-label="Todos">
          {page.todos.map((todo) => (
            <Row key={keyOf(todo)} todo={todo} now={now} projects={options.projects} completing={completing.has(keyOf(todo))} onChange={change} onOpen={onOpen} completions={completions} onOpenNote={openNote} />
          ))}
        </ul>
      )}
      {page?.next != null && (
        <button type="button" className="todo-more" onClick={more}>
          Show more
        </button>
      )}
    </section>
  );
}
