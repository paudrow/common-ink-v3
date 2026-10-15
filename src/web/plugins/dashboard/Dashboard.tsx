import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { ago, dayOf, useNow, type App, type Author, type CalendarEvent, type HistoryEntry, type HistoryPage, type ListedTodo, type NoteSummary, type PluginHost, type Source, type ViewProps } from "../../plugin-api.ts";
import { dayLabel, timeLabel } from "../calendar/dates.ts";
import type { ListedAt } from "../lib/openTodo.ts";
import { TodoGlance } from "../todos/Todos.tsx";
import type { Pins } from "./pins.ts";
import { FIRST_SUMMARY_MS, aheadToday, editedToday, membersStamp, othersMarks, rose, summarize, todayAt, todoStamp, type Today } from "./today.ts";

/** As many todos as the dashboard lists. The rest are on the Todos page. */
const TODOS_SHOWN = 50;
/** As many changes as the summary reads. With more than that since the last visit it says so and points at the History page. */
const CHANGES_READ = 100;
/** How long a section waits before it reads again because a note changed, so that someone's steady typing costs one reading and not one a save. */
const SETTLE_MS = 30_000;
/** How long after the member comes back to the window a change that the app then hears of is read at once. */
const BACK_MS = 10_000;

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const titleOf = (note: { title: string }) => note.title || "Untitled";

/** What one section has of what it shows. Each reads on its own, and one that fails says so where it is. */
type Read<T> = { status: "reading" } | { status: "read"; value: T } | { status: "failed"; message: string };

/**
 * Reads once `ready`, and again at once whenever `key` changes. A change of `stamp` says a note
 * changed under what was read: that is read again too, but no more than once in {@link SETTLE_MS},
 * or at once when the member has just come back to the window. What was read before stays on show
 * until the new answer is there, so a section that reads again never empties and fills.
 */
function useRead<T>(read: () => Promise<T>, { key, stamp = "", ready = true }: { key: string; stamp?: string | number; ready?: boolean }): Read<T> {
  const [state, setState] = useState<Read<T>>({ status: "reading" });
  const now = useRef({ read, stamp });
  now.current = { read, stamp };
  const last = useRef<{ at: number; stamp: string | number; run: number; back: number }>({ at: 0, stamp, run: 0, back: 0 });
  const start = useCallback(() => {
    const run = ++last.current.run;
    last.current.at = Date.now();
    last.current.stamp = now.current.stamp;
    now.current.read().then(
      (value) => run === last.current.run && setState({ status: "read", value }),
      (err: Error) => run === last.current.run && setState((was) => (was.status === "read" ? was : { status: "failed", message: err.message })),
    );
  }, []);
  // Not in the effect itself: an effect that is run, undone and run again, as in development, then reads once.
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(start, 0);
    return () => clearTimeout(timer);
  }, [key, ready]);
  useEffect(() => {
    // Before the first reading there is nothing to read again: that reading takes the stamp as it is then.
    if (!ready || last.current.at === 0 || stamp === last.current.stamp) return;
    const back = Date.now() - last.current.back < BACK_MS;
    last.current.back = 0;
    const timer = setTimeout(start, back ? 0 : Math.max(0, last.current.at + SETTLE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [stamp, ready]);
  useEffect(() => {
    const cameBack = () => {
      if (document.visibilityState !== "visible") return;
      // The app lists its notes again when the member comes back, and what that finds is read without the wait.
      last.current.back = Date.now();
      if (last.current.at !== 0 && now.current.stamp !== last.current.stamp) start();
    };
    addEventListener("focus", cameBack);
    document.addEventListener("visibilitychange", cameBack);
    return () => {
      removeEventListener("focus", cameBack);
      document.removeEventListener("visibilitychange", cameBack);
      last.current.run++;
    };
  }, []);
  return state;
}

export function PinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2.5h4l-.5 4 2 2.25h-7l2-2.25zM8 8.75v4.75" />
    </svg>
  );
}

/**
 * One section of the dashboard. It is the size it will be from the first, with bars where its rows
 * will be, and what it lists scrolls inside it: so nothing on the page moves as each section's
 * answer arrives, however many rows that is.
 */
function Card({ title, wide, reading, problem, action, children }: { title: string; wide?: boolean; reading: boolean; problem?: string | null; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="dash-card" data-wide={wide || undefined} aria-label={title} aria-busy={reading}>
      <header className="dash-head">
        <h3>{title}</h3>
        {action}
      </header>
      <div className="dash-body">
        {reading ? (
          <ul className="dash-list" aria-hidden="true">
            {[60, 45, 70].map((width) => (
              <li key={width} className="dash-row dash-wait">
                <span style={{ width: `${width}%` }} />
              </li>
            ))}
          </ul>
        ) : problem ? (
          <p role="alert" className="dash-none failed">
            {problem}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/** A link to a note that opens it in a preview tab, as a single click on a note does anywhere. */
function NoteLink({ app, noteId, className, children }: { app: App; noteId: string; className?: string; children: ReactNode }) {
  const open = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    app.openNote(noteId, { preview: true });
  };
  return (
    <a href={app.notePath(noteId)} className={className} onClick={open}>
      {children}
    </a>
  );
}

const swatch = (color: string | null) => (color && /^#[0-9a-f]{6}$/i.test(color) ? { background: color } : undefined);

function whenOf(event: CalendarEvent, started: boolean, timeZone: string): string {
  if (event.when.allDay) return "All day";
  return started ? `Now, until ${timeLabel(event.when.to, timeZone)}` : `${timeLabel(event.when.from, timeZone)} – ${timeLabel(event.when.to, timeZone)}`;
}

function Events({ host, app, today, now }: { host: PluginHost; app: App; today: Today; now: number }) {
  const listed = useRead(() => host.perform({ type: "event.list", from: today.from, to: today.to, timeZone: today.timeZone }), { key: today.day });
  const ahead = listed.status === "read" ? aheadToday(listed.value.events, today, now) : [];
  const calendars: readonly Source[] = listed.status === "read" ? listed.value.sources : [];
  const toCalendar = (
    <button type="button" className="link" onClick={() => app.go("/calendar")}>
      Calendar
    </button>
  );
  return (
    <Card title="Today's events" reading={listed.status === "reading"} problem={listed.status === "failed" ? listed.message : null}>
      {ahead.length > 0 ? (
        <ul className="dash-list" aria-label="Events still ahead today">
          {ahead.map(({ event, started }) => (
            <li key={`${event.sourceId} ${event.id}`}>
              <button type="button" className="dash-row" data-started={(started && !event.when.allDay) || undefined} title={`${event.title} · ${event.calendar}`} onClick={() => app.go("/calendar")}>
                <span className="cal-swatch" style={swatch(event.color)} aria-hidden="true" />
                <span className="dash-what">{event.title || "Untitled"}</span>
                <span className="dash-meta">{whenOf(event, started, today.timeZone)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : calendars.some((s) => s.state === "connected") ? (
        <p className="dash-none">Nothing more today.</p>
      ) : calendars.some((s) => s.state === "needs_reconnect") ? (
        <p className="dash-none">Your calendar stopped answering. Reconnect it on the {toCalendar} page.</p>
      ) : (
        <p className="dash-none">No calendar is connected. Connect one on the {toCalendar} page to see today's events here.</p>
      )}
    </Card>
  );
}

/** What the Todos page lists of the same todos, by its query. */
const DUE_QUERY = "due:<=today";

function Todos({ host, app, today, onOpen }: { host: PluginHost; app: App; today: Today; onOpen: (todo: ListedAt) => void }) {
  const stamp = useMemo(() => todoStamp(app.notes ?? []), [app.notes]);
  const titles = useMemo(() => app.notes && new Map(app.notes.map((n) => [n.id, n.title])), [app.notes]);
  const titleOf = useCallback((noteId: string) => (titles ? (titles.get(noteId) ?? null) : undefined), [titles]);
  const listed = useRead(() => host.perform({ type: "todo.list", dueTo: today.day, limit: TODOS_SHOWN }), { key: today.day, stamp, ready: app.notes !== null });
  const todos: readonly ListedTodo[] = listed.status === "read" ? listed.value.todos : [];
  return (
    <Card title="Due today or earlier" reading={listed.status === "reading"} problem={listed.status === "failed" ? listed.message : null}>
      {todos.length > 0 ? (
        <ul className="dash-list dash-todos" aria-label="Todos due today or earlier">
          {todos.map((todo) => (
            <TodoGlance key={`${todo.noteId}/${todo.line}`} todo={todo} now={today.day} titleOf={titleOf} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <p className="dash-none">Nothing is due.</p>
      )}
      {listed.status === "read" && listed.value.next !== null && (
        <p className="dash-more">
          <button type="button" className="link" onClick={() => app.go(`/todos?q=${encodeURIComponent(DUE_QUERY)}`)}>
            More on the Todos page
          </button>
        </p>
      )}
    </Card>
  );
}

function NoteRow({ app, note, meta, action }: { app: App; note: NoteSummary; meta: string; action?: ReactNode }) {
  return (
    <li className="dash-item">
      <NoteLink app={app} noteId={note.id} className="dash-row">
        <span className="dash-what">{titleOf(note)}</span>
        <span className="dash-meta">{meta}</span>
      </NoteLink>
      {action}
    </li>
  );
}

function TodaysNotes({ host, app, today, members, now }: { host: PluginHost; app: App; today: Today; members: string; now: number }) {
  const role = app.workspace.role;
  // A guest has no daily notes, and the server says so by refusing: they are not asked.
  const found = useRead(() => (role === "guest" ? Promise.resolve({ note: null }) : host.perform({ type: "daily.find", on: today.day })), { key: today.day, stamp: members, ready: app.notes !== null });
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dailyId = found.status === "read" ? (found.value.note?.id ?? null) : null;
  const daily = (dailyId && app.notes?.find((n) => n.id === dailyId && n.state === "live")) || null;
  const notes = app.notes ? editedToday(app.notes, today, dailyId) : [];

  const start = () => {
    setStarting(true);
    host.perform({ type: "daily.open", on: today.day }).then(
      (note) => {
        // It was just made, perhaps in a folder that was just made.
        app.noteChanged(note);
        app.refresh();
        app.openNote(note.id, { focus: true });
      },
      (err: Error) => {
        setStarting(false);
        setProblem(err.message);
      },
    );
  };

  return (
    <Card title="Today's notes" reading={found.status === "reading" || app.notes === null} problem={found.status === "failed" ? found.message : null}>
      <ul className="dash-list" aria-label="Today's notes">
        {daily && <NoteRow app={app} note={daily} meta="Your daily note" />}
        {!daily && (role === "admin" || role === "editor") && (
          <li className="dash-item">
            <span className="dash-row dash-quiet">
              <span className="dash-what">No daily note yet for {dayLabel(today.day, "short")}</span>
            </span>
            <button type="button" className="button small" disabled={starting} onClick={start}>
              Start today's note
            </button>
          </li>
        )}
        {notes.map(({ note, made }) => (
          <NoteRow key={note.id} app={app} note={note} meta={`${made ? "Created today, edited" : "Edited"} ${ago(note.updatedAt, now)} by ${note.updatedBy.name}`} />
        ))}
      </ul>
      {problem && (
        <p role="alert" className="dash-none failed">
          {problem}
        </p>
      )}
      {!daily && notes.length === 0 && <p className="dash-none">No notes were created or edited today.</p>}
    </Card>
  );
}

function Pinned({ app, pins, now }: { app: App; pins: Pins; now: number }) {
  const ids = useSyncExternalStore(pins.subscribe, pins.ids);
  // Each time the member comes to the dashboard: a pin made in another browser is here then.
  useEffect(() => {
    const timer = setTimeout(pins.read, 0);
    return () => clearTimeout(timer);
  }, [pins]);
  const byId = useMemo(() => new Map((app.notes ?? []).map((n) => [n.id, n])), [app.notes]);
  // What the server listed, less what is archived, and what the app has since learned is in Trash or out of the member's sight.
  const notes = (ids ?? []).flatMap((id) => {
    const note = byId.get(id);
    return note?.state === "live" ? [note] : [];
  });
  return (
    <Card title="Pinned" reading={ids === null || app.notes === null}>
      {notes.length > 0 ? (
        <ul className="dash-list" aria-label="Pinned notes">
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              app={app}
              note={note}
              meta={`Edited ${ago(note.updatedAt, now)}`}
              action={
                <button type="button" className="icon-button dash-unpin" aria-label={`Unpin ${titleOf(note)}`} title="Unpin from dashboard" onClick={() => pins.set(note.id, false)}>
                  <PinIcon />
                </button>
              }
            />
          ))}
        </ul>
      ) : (
        <p className="dash-none">Nothing is pinned. Pin a note with the pin in the bar above its text, and it stays here for you alone.</p>
      )}
    </Card>
  );
}

/** What the summary was made from: how far the member had read, the moment it was read as of, and the changes between. */
interface Summary {
  readUntil: number | null;
  asOf: number;
  changes: HistoryEntry[];
  /** Whether there are changes further back than were read, so that what is listed is not all of it. */
  more: boolean;
}

const names = (authors: readonly { author: Author }[]) => authors.map(({ author }) => (author.kind === "agent" ? `${author.name} (agent)` : author.name)).join(", ");

const since = (time: number) => new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/[\u202f\u00a0]/g, " ");

/**
 * The changes by anyone but the member since they last marked them read. The boundary is the
 * server's and moves only when the member presses the button, to the moment this summary was read as
 * of: opening the dashboard, reloading it, or having it open in two tabs moves nothing, and a change
 * that arrived after the summary was drawn is still there next time.
 *
 * It reads the latest {@link CHANGES_READ} changes and no more. With more than that, each count is
 * the least it can be and says so, and the card says there are more, where they are, and that
 * marking read covers those too.
 */
function Changes({ host, app, now }: { host: PluginHost; app: App; now: number }) {
  const [marked, setMarked] = useState(0);
  const [marking, setMarking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const me = app.me.id;

  // Counts up each time someone other than the member changed a note, which is all that can add to the summary.
  const marks = useMemo(() => (app.notes ? othersMarks(app.notes, me) : null), [app.notes, me]);
  const known = useRef<{ marks: ReadonlyMap<string, number> | null; others: number }>({ marks: null, others: 0 });
  if (marks && marks !== known.current.marks) {
    if (known.current.marks && rose(known.current.marks, marks)) known.current.others++;
    known.current.marks = marks;
  }

  const read = async (): Promise<Summary> => {
    const { readUntil, now: asOf } = await host.perform({ type: "visit.read" });
    const { changes, next } = await host.perform({ type: "history.list", from: readUntil ?? asOf - FIRST_SUMMARY_MS, to: asOf, notAuthors: [{ kind: "member", id: me }], diffs: false, limit: CHANGES_READ });
    return { readUntil, asOf, changes, more: next !== null };
  };
  const summary = useRead(read, { key: String(marked), stamp: known.current.others, ready: app.notes !== null });

  const value = summary.status === "read" ? summary.value : null;
  const notes = value ? summarize(value.changes) : [];
  const from = value ? (value.readUntil ?? value.asOf - FIRST_SUMMARY_MS) : 0;
  const markRead = () => {
    if (!value) return;
    setMarking(true);
    setProblem(null);
    host
      .perform({ type: "visit.mark", until: value.asOf })
      .then(
        () => setMarked((n) => n + 1),
        (err: Error) => setProblem(err.message),
      )
      .finally(() => setMarking(false));
  };

  return (
    <Card
      title="Changes since your last visit"
      wide
      reading={summary.status === "reading"}
      problem={summary.status === "failed" ? summary.message : null}
      action={
        <button type="button" className="button small" disabled={marking || notes.length === 0} onClick={markRead}>
          {value?.more ? "Mark all as read" : "Mark as read"}
        </button>
      }
    >
      {value && <p className="dash-since">{value.readUntil === null ? "By others in the last 7 days. Mark them read, and from then on this lists what changed since." : `By others since you marked changes read on ${since(value.readUntil)}.`}</p>}
      {value?.more && (
        <p className="dash-more" role="note">
          There are more changes than the latest {CHANGES_READ}, which is what is counted here, so each count is at least that many and other notes changed too.{" "}
          <button type="button" className="link" onClick={() => app.go("/history")}>
            See them all on the History page
          </button>
          . Mark all as read covers the ones not listed.
        </p>
      )}
      {notes.length > 0 ? (
        <ul className="dash-list" aria-label="Changed notes">
          {notes.map((note) => (
            <li key={note.noteId} className="dash-item">
              <NoteLink app={app} noteId={note.noteId} className="dash-row">
                <span className="dash-what">{titleOf(note)}</span>
                <span className="dash-meta">
                  {note.changes === 1 && !value?.more ? "1 change" : `${note.changes}${value?.more ? "+" : ""} changes`} by {names(note.authors)} · {ago(note.latest, now)}
                </span>
              </NoteLink>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dash-none">Nothing has changed.</p>
      )}
      {problem && (
        <p role="alert" className="dash-none failed">
          {problem}
        </p>
      )}
    </Card>
  );
}

interface Props extends ViewProps {
  host: PluginHost;
  pins: Pins;
  onOpenTodo: (todo: ListedAt) => void;
}

/** The Dashboard: one member's day. Every section is that member's own view, read through the operations any other view uses. */
export function Dashboard({ host, app, pins, onOpenTodo }: Props) {
  const now = useNow();
  const timeZone = useMemo(zone, []);
  const today = useMemo(() => todayAt(now, timeZone), [now, timeZone]);
  // One value for the day, so a section reads again at midnight and not each minute.
  const day = useMemo(() => today, [today.day]);
  const members = useMemo(() => membersStamp(app.notes ?? []), [app.notes]);
  return (
    <section className="mode-view dashboard" aria-label="Dashboard">
      <h1>Dashboard</h1>
      <p className="dash-date">{dayLabel(day.day, "heading")}</p>
      <div className="dash-grid">
        <Events host={host} app={app} today={day} now={now} />
        <Todos host={host} app={app} today={day} onOpen={onOpenTodo} />
        <TodaysNotes host={host} app={app} today={day} members={members} now={now} />
        <Pinned app={app} pins={pins} now={now} />
        <Changes host={host} app={app} now={now} />
      </div>
    </section>
  );
}
