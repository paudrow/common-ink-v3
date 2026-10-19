import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Icon, today as todayIs, useNow, type Calendar, type CalendarEvent, type EventWhen, type PluginHost, type Source, type ViewProps } from "../../plugin-api.ts";
import { forgetReferences } from "../lib/references.tsx";
import { Sources, useSources, withFresher } from "../lib/Sources.tsx";
import { CalendarsDialog } from "./CalendarsDialog.tsx";
import { LAST, startOf } from "./choosing.ts";
import { VIEWS, WEEKDAY_NAMES, cellsOf, dayLabel, daysOf, isDay, isGrid, isWeekend, minutesIn, shiftDay, startOfWeek, step, timeLabel, titleOf, titleOfDays, weekdayLabel, type Cell, type Day, type View, type WhenForm } from "./dates.ts";
import { EventDetails } from "./EventDetails.tsx";
import { calendarKey, dayAt, indexOf, keyOf, useListing } from "./listing.ts";
import { NewEvent } from "./NewEvent.tsx";
import { forgetEventsToFind } from "./finding.ts";
import { opened as lastOpened } from "./referring.ts";
import { SPARE, TimeGrid, type Goal } from "./TimeGrid.tsx";

/** The zone the member's browser is in, which is the one every day and time here is said in. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Days read beyond those drawn, either side, so a fast slide still finds them read. */
const AHEAD = 7;
const KEYS = Object.fromEntries(Object.entries(VIEWS).map(([view, { key }]) => [key, view as View]));
const timeOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The form's start and end for a span of minutes on a day; an end at midnight is the next day's 00:00. */
const formFor = (day: Day, start: number, end: number): WhenForm => ({ allDay: false, fromDay: day, fromTime: timeOf(start), toDay: end >= 1440 ? shiftDay(day, 1) : day, toTime: timeOf(end % 1440) });

function EventButton({ event, timeZone, onOpen }: { event: CalendarEvent; timeZone: string; onOpen: (event: CalendarEvent) => void }) {
  return (
    <button type="button" className="cal-event" data-all-day={event.when.allDay || undefined} title={`${event.title} · ${event.calendar}`} style={{ "--c": event.color ?? "var(--accent)" } as CSSProperties} onClick={() => onOpen(event)}>
      <span className="cal-swatch" aria-hidden="true" />
      {!event.when.allDay && <span className="cal-time">{timeLabel(event.when.from, timeZone)}</span>}
      <span className="cal-title">{event.title || "Untitled"}</span>
    </button>
  );
}

function DayEvents({ cell, timeZone, onOpen }: { cell: Cell; timeZone: string; onOpen: (event: CalendarEvent) => void }) {
  return (
    <>
      {cell.allDay.length > 0 && (
        <ul className="cal-all-day" aria-label="All day">
          {cell.allDay.map((event) => (
            <li key={keyOf(event)}>
              <EventButton event={event} timeZone={timeZone} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {cell.timed.length > 0 && (
        <ul className="cal-timed">
          {cell.timed.map((event) => (
            <li key={keyOf(event)}>
              <EventButton event={event} timeZone={timeZone} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** How long the Calendar stays on a view and a day before its address says them. */
const SETTLED_MS = 500;

/** An event shown somewhere other than where its calendar has it, until a reading at or after `reading` says where it is. */
type Placed = { when: EventWhen; reading: number };

/** The Calendar: the member's events from every calendar they connected, by month, week, day or as a list, in their own time zone. */
export function CalendarPage({ host, app }: ViewProps & { host: PluginHost }) {
  const timeZone = useMemo(zone, []);
  const now = useNow();
  const today = todayIs();
  const firstDay = Math.max(0, WEEKDAY_NAMES.indexOf(host.settings.get<string>("weekStarts") as (typeof WEEKDAY_NAMES)[number]));
  const weekends = host.settings.get<boolean>("weekends");
  const weekOf = (day: Day) => startOfWeek(day, firstDay);
  const keptView = (): View => {
    const kept = host.storage.get("view");
    return typeof kept === "string" && Object.hasOwn(VIEWS, kept) ? (kept as View) : "week";
  };
  /** The view and day the address names, as a step back through the member's history comes to: `?view=month&day=2026-11-03`. */
  const named = useMemo(() => {
    const asked = new URLSearchParams(app.query);
    const [view, day] = [asked.get("view"), asked.get("day")];
    return !asked.has("event") && view && Object.hasOwn(VIEWS, view) && day && isDay(day) ? { view: view as View, day } : null;
  }, [app.query]);
  const [view, setView] = useState<View>(() => named?.view ?? keptView());
  /** The first day in view in a grid of hours; any day of the month, or the agenda's first day, otherwise. Counted from EPOCH. */
  const [focus, setFocus] = useState(() => indexOf(named ? named.day : view === "week" ? weekOf(today) : today));
  const [goal, setGoal] = useState<Goal | null>(null);
  const [drawnFrom, setDrawnFrom] = useState(focus - SPARE[7]);
  const [reading, setReading] = useState(0);
  /** The last reading asked for: each new one is later, so a reading asked for after a change is never taken for one asked before it. */
  const asked = useRef(0);
  const page = useRef<HTMLElement>(null);
  const [placed, setPlaced] = useState<ReadonlyMap<string, Placed>>(new Map());
  const hiddenList = host.settings.get<readonly string[]>("hidden");
  const hidden = useMemo<ReadonlySet<string>>(() => new Set(hiddenList), [hiddenList]);
  const [opened, setOpened] = useState<string | null>(null);
  const [adding, setAdding] = useState<WhenForm | null>(null);
  const [choosing, setChoosing] = useState(false);
  const { sources, setSources, problem } = useSources(host);

  const [fit, setFit] = useState(7);
  const visible = isGrid(view) ? Math.min(VIEWS[view].days, fit) : fit;
  const anchor = dayAt(focus);
  const listedDays = useMemo(() => (isGrid(view) ? null : daysOf(view, anchor, firstDay)), [view, anchor, firstDay]);
  const [from, to] = !isGrid(view) ? [indexOf(listedDays![0]!), indexOf(listedDays!.at(-1)!) + 1] : [drawnFrom - AHEAD, drawnFrom + visible + 2 * SPARE[VIEWS[view].days] + AHEAD];
  const listing = useListing(host, timeZone, from, to, reading);

  useEffect(() => {
    if (listing.sources) setSources((known) => withFresher(known, listing.sources!));
  }, [listing.sources, setSources]);

  useEffect(() => {
    if ([...placed.values()].some((p) => p.reading <= listing.reading)) setPlaced((was) => new Map([...was].filter(([, p]) => p.reading > listing.reading)));
  }, [listing.reading, placed]);

  const events = useMemo(
    () =>
      listing.events.flatMap((event) => {
        if (hidden.has(calendarKey(event))) return [];
        const moved = placed.get(keyOf(event));
        return [moved ? { ...event, when: moved.when } : event];
      }),
    [listing.events, hidden, placed],
  );
  const connected = (sources ?? []).some((s) => s.kind === "calendar" && s.state === "connected");
  const targets = useMemo(() => listing.calendars.filter((c) => c.writable && !hidden.has(calendarKey(c))), [listing.calendars, hidden]);
  const chosen = host.settings.get<string>("default");
  const start = startOf(targets, listing.calendars, chosen, host.storage.get(LAST));
  // One on a calendar the member hid opens all the same when it is asked for by its address.
  const open = opened === null ? undefined : (events.find((e) => keyOf(e) === opened) ?? listing.events.find((e) => keyOf(e) === opened));

  const reread = useCallback(() => {
    forgetEventsToFind();
    setReading((asked.current += 1));
  }, []);

  /** Whether today is among the days on show: the grid's, the month's, or the agenda's. */
  const todayShown = isGrid(view) ? today >= anchor && today <= shiftDay(anchor, visible - 1) : view === "month" ? today.slice(0, 7) === anchor.slice(0, 7) : today >= anchor && today <= listedDays!.at(-1)!;

  const show = (next: View) => {
    if (next === view) return;
    host.storage.set("view", next);
    const inView = todayShown;
    setGoal(null);
    setFocus(indexOf(next === "week" ? weekOf(inView ? today : anchor) : isGrid(next) && inView ? today : anchor));
    setView(next);
  };

  const glide = (where: { to: number } | { by: number }) => setGoal((was) => ({ ...where, seq: (was?.seq ?? 0) + 1 }));
  const go = (by: 1 | -1 | 0) => {
    if (isGrid(view)) return glide(by === 0 ? { to: indexOf(view === "week" && visible === 7 ? weekOf(today) : today) } : { by });
    setFocus(by === 0 ? indexOf(today) : indexOf(step(view, anchor, by)));
  };

  // An address that names an event, as quick open's does, shows its day with the event open, and is then the page's own address again.
  const linked = useMemo(() => {
    const asked = new URLSearchParams(app.query);
    const [sourceId, id, day] = [asked.get("source"), asked.get("event"), asked.get("day")];
    return sourceId && id && day && isDay(day) ? { key: keyOf({ sourceId, id }), day } : null;
  }, [app.query]);
  useEffect(() => {
    if (!linked) return;
    if (isGrid(view)) glide({ to: indexOf(view === "week" && visible === 7 ? weekOf(linked.day) : linked.day) });
    else setFocus(indexOf(linked.day));
    setOpened(linked.key);
    app.go(app.path, { replace: true });
    // Only when the address names another event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);
  useEffect(() => () => lastOpened(null), []);
  /** The address the Calendar last wrote of itself, which says where it was and is no reason to move. */
  const wrote = useRef<string | null>(null);
  // Brought back to another view or day, as by a step back, the Calendar shows it. Not by its own address: written half a second after a
  // press, it can name the day the press before went to, after the member has pressed again.
  useEffect(() => {
    if (!named || app.query === wrote.current || (named.view === view && named.day === anchor)) return;
    if (named.view === view && isGrid(view)) return glide({ to: indexOf(named.day) });
    setGoal(null);
    setView(named.view);
    setFocus(indexOf(named.day));
    // Only when the address names another view or day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [named]);
  // Once the member has settled on a view and a day, the address says them, so going back and forward comes to the Calendar as it was.
  // The view they keep, on show today, is the bare address. It is the app's address only while the Calendar is the page in front.
  useEffect(() => {
    const timer = setTimeout(() => {
      const front = host.app().opened;
      if (front?.kind !== "page" || front.id !== "calendar" || new URLSearchParams(app.query).has("event")) return;
      const query = todayShown && view === keptView() ? "" : `?${new URLSearchParams({ view, day: anchor })}`;
      if (query === app.query) return;
      wrote.current = query;
      app.go(`${app.path}${query}`, { replace: true });
    }, SETTLED_MS);
    return () => clearTimeout(timer);
    // Only when what is on show changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, anchor]);

  // A window too narrow for the whole week opens on today rather than on days before it.
  useEffect(() => {
    const t = indexOf(today);
    if (view === "week" && fit < 7 && t >= focus && t < focus + 7 && t >= focus + fit) glide({ to: t });
    // Only when the number of days that fit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit]);

  const onFirst = useCallback((first: number) => setFocus(first), []);

  // A week shown from the first day it had starts on the new one when the member changes it.
  const weekStarted = useRef(firstDay);
  useEffect(() => {
    if (weekStarted.current === firstDay) return;
    weekStarted.current = firstDay;
    // The week that holds today when it was on show, and otherwise the one that holds the middle of what was.
    if (view === "week" && visible === 7) glide({ to: indexOf(weekOf(todayShown ? today : shiftDay(anchor, 3))) });
    // Only when the first day changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay]);

  // Calendars hidden in this browser before they were kept on the server join those hidden there, once: as soon as the member's settings are read.
  useEffect(() => {
    const move = () => {
      const kept = host.storage.get("hidden");
      if (!Array.isArray(kept)) return true;
      const was = kept.filter((k): k is string => typeof k === "string");
      if (!host.settings.set("hidden", [...new Set([...host.settings.get<readonly string[]>("hidden"), ...was])])) return false;
      host.storage.set("hidden", null);
      return true;
    };
    if (move()) return;
    const stop = host.settings.subscribe(() => void (move() && stop()));
    return stop;
  }, [host]);

  const setShown = (calendar: Calendar, shown: boolean) => {
    const next = new Set(hidden);
    if (shown) next.delete(calendarKey(calendar));
    else next.add(calendarKey(calendar));
    if (!host.settings.set("hidden", [...next])) app.notify({ message: "Which calendars are shown couldn't be kept: your settings aren't read yet, or too many calendars are hidden. Try again in a moment." });
  };

  const setDefault = (calendar: Calendar) => {
    const kept = host.settings.set("default", calendarKey(calendar));
    if (!kept) app.notify({ message: "The default calendar couldn't be kept: your settings aren't read yet. Try again in a moment." });
    return kept;
  };

  /** Opens the form for a span the grid asked for, or for the next half hour today, or 9:00 on the first day in view when today isn't. */
  const startAdding = (form?: WhenForm) => {
    if (!start) return;
    if (form) return setAdding(form);
    const day = !isGrid(view) || todayShown ? today : anchor;
    const at = day === today ? Math.min(23 * 60, Math.floor(minutesIn(Date.now(), timeZone) / 30) * 30 + 30) : 9 * 60;
    setAdding(formFor(day, at, at + 30));
  };

  /**
   * Shows an event at `when` at once and changes it there. It stays shown there until a reading asked
   * for after the change landed answers; if the change is refused, it goes back to where it is kept.
   */
  const place = async (event: Pick<CalendarEvent, "sourceId" | "id" | "etag">, when: EventWhen): Promise<CalendarEvent | null> => {
    const key = keyOf(event);
    setPlaced((m) => new Map(m).set(key, { when, reading: Infinity }));
    try {
      const changed = await host.perform({ type: "event.update", sourceId: event.sourceId, id: event.id, etag: event.etag, when });
      forgetReferences();
      forgetEventsToFind();
      const at = (asked.current += 1);
      setPlaced((m) => new Map(m).set(key, { when, reading: at }));
      setReading(at);
      return changed;
    } catch (err) {
      setPlaced((m) => new Map([...m].filter(([k]) => k !== key)));
      app.notify({ message: (err as Error).message });
      reread();
      return null;
    }
  };

  /** Puts an event where it was dropped, and offers to put it back. */
  const move = async (event: CalendarEvent, when: { from: number; to: number }, verb: "Moved" | "Resized") => {
    const was = event.when;
    const changed = await place(event, { allDay: false, ...when });
    if (changed) app.notify({ message: `${verb} ${event.title || "Untitled"}`, icon: "calendar", action: { label: "Undo", run: () => void place(changed, was) } });
  };

  // The calendar's own keys, as v1 had them, while nothing else has the keyboard.
  useEffect(() => {
    const press = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // Only for the Calendar: with nothing focused, or focus in it. Another page beside it in a split keeps its own keys.
      if (!target || !(target === document.body || page.current?.contains(target))) return;
      if (target.closest("input, textarea, select, [contenteditable], [role=dialog]") || document.querySelector(".event-scrim")) return;
      const key = e.key.toLowerCase();
      if (key === "t") go(0);
      else if (key === "j" || key === "n") go(1);
      else if (key === "k" || key === "p") go(-1);
      else if (KEYS[key]) show(KEYS[key]);
      else if (key === "c") startAdding();
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", press);
    return () => document.removeEventListener("keydown", press);
  });

  const title = isGrid(view) ? titleOfDays(Array.from({ length: visible }, (_, i) => dayAt(focus + i))) : titleOf(view, anchor);
  const cells = useMemo(() => (listedDays ? cellsOf(listedDays, events, timeZone) : []), [listedDays, events, timeZone]);
  const busy = !(listedDays ?? Array.from({ length: visible }, (_, i) => dayAt(focus + i))).every((day) => listing.listed(indexOf(day)));

  return (
    <section ref={page} className="calendar-page" aria-label="Calendar" data-view={view} data-weekends={weekends || undefined}>
      <header className="cal-head">
        <h1>Calendar</h1>
        <span className="cal-zone">Times are in your time zone, {timeZone.replace(/_/g, " ")}.</span>
        <span className="cal-actions">
          <button type="button" className="button cal-choose" aria-haspopup="dialog" onClick={() => setChoosing(true)}>
            <Icon name="calendar" />
            Calendars
          </button>
          {targets.length > 0 && (
            <button type="button" className="button primary cal-add" onClick={() => startAdding()} title="New event (C)">
              <Icon name="plus" />
              New event
            </button>
          )}
        </span>
      </header>
      <div className="cal-toolbar">
          {(connected || !sources) && (
            <>
              <button type="button" className="button small" onClick={() => go(0)} title="Today (T)">
                Today
              </button>
              <div className="cal-nav" role="group" aria-label="Days on show">
                <button type="button" className="button small" onClick={() => go(-1)} aria-label="Previous" title="Previous (K)">
                  ‹
                </button>
                <button type="button" className="button small" onClick={() => go(1)} aria-label="Next" title="Next (J)">
                  ›
                </button>
              </div>
            </>
          )}
          <h2 aria-live="polite">{title}</h2>
          {(connected || !sources) && (
            <div className="cal-views" role="group" aria-label="View">
              {(Object.keys(VIEWS) as View[]).map((each) => (
                <button key={each} type="button" className="button small" aria-pressed={view === each} onClick={() => show(each)} title={`${VIEWS[each].label} (${VIEWS[each].key.toUpperCase()})`}>
                  {VIEWS[each].label}
                </button>
              ))}
            </div>
          )}
        </div>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      {/* With nothing connected, connecting is the first thing the page offers, in place of days with nothing in them. The dialog holds the same list, so this steps aside while it is open. */}
      {sources && !connected && !choosing && (
        <section className="cal-connect" aria-label="Connect a calendar">
          <p className="cal-notice">
            <strong>Connect a calendar to see your events here.</strong>
            <span>Only you see them, and new events you or your agents add go in it.</span>
          </p>
          <Sources host={host} app={app} kind="calendar" sources={sources} heading={false} onChange={(next) => (setSources(next), reread())} />
        </section>
      )}
      {listing.failed && (
        <p role="alert" className="said failed">
          {listing.failed}
        </p>
      )}
      {isGrid(view) && (connected || !sources) && (
        <TimeGrid
          key={view}
          most={VIEWS[view].days}
          onFit={setFit}
          opensAt={focus}
          goal={goal}
          onFirst={onFirst}
          onWindow={setDrawnFrom}
          events={events}
          listed={listing.listed}
          timeZone={timeZone}
          now={now}
          canAdd={targets.length > 0}
          title={title}
          busy={busy}
          onOpen={(event) => setOpened(keyOf(event))}
          onAdd={(day, start, end) => startAdding(formFor(day, start, end))}
          onMove={(event, when, verb) => void move(event, when, verb)}
          onRefused={(event) => app.notify({ message: `You can only read the calendar ${event.calendar}.` })}
        />
      )}
      {view === "month" && listedDays && connected && (
        <div className="cal-grid cal-month" role="grid" aria-label={title} aria-busy={busy}>
          <div className="cal-weekdays" role="row">
            {listedDays.slice(0, 7).map((day) => (
              <span key={day} role="columnheader">
                {weekdayLabel(day)}
              </span>
            ))}
          </div>
          {Array.from({ length: cells.length / 7 }, (_, week) => (
            <div key={cells[week * 7]!.day} className="cal-row" role="row">
              {cells.slice(week * 7, week * 7 + 7).map((cell) => (
                <div key={cell.day} className="cal-day" role="gridcell" aria-label={dayLabel(cell.day, "heading")} data-day={cell.day} data-today={cell.day === today || undefined} data-weekend={isWeekend(cell.day) || undefined} data-outside={cell.day.slice(0, 7) !== anchor.slice(0, 7) || undefined}>
                  <span className="cal-date">
                    <span className="cal-number">{Number(cell.day.slice(8))}</span>
                  </span>
                  <DayEvents cell={cell} timeZone={timeZone} onOpen={(event) => setOpened(keyOf(event))} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {view === "agenda" && connected && (
        <div className="cal-agenda" aria-label={title} aria-busy={busy}>
          {cells
            .filter((cell) => cell.allDay.length + cell.timed.length > 0)
            .map((cell) => (
              <section key={cell.day} className="cal-day" aria-label={dayLabel(cell.day, "heading")} data-day={cell.day} data-today={cell.day === today || undefined}>
                <h3>{dayLabel(cell.day, "heading")}</h3>
                <DayEvents cell={cell} timeZone={timeZone} onOpen={(event) => setOpened(keyOf(event))} />
              </section>
            ))}
          {!busy && !cells.some((cell) => cell.allDay.length + cell.timed.length > 0) && <p className="cal-none">Nothing on these days.</p>}
        </div>
      )}
      {open && (
        <EventDetails
          host={host}
          app={app}
          event={open}
          source={(sources ?? []).find((s) => s.id === open.sourceId)}
          timeZone={timeZone}
          close={() => setOpened(null)}
          onChanged={() => {
            forgetReferences();
            reread();
          }}
        />
      )}
      {adding && start && (
        <NewEvent
          host={host}
          calendars={targets}
          start={start}
          chosen={chosen}
          setDefault={setDefault}
          when={adding}
          timeZone={timeZone}
          close={() => setAdding(null)}
          onAdded={(event) => {
            setAdding(null);
            reread();
            app.notify({ message: `Added ${event.title || "Untitled"}`, icon: "calendar" });
          }}
        />
      )}
      {choosing && (
        <CalendarsDialog
          host={host}
          app={app}
          sources={sources}
          calendars={listing.calendars}
          start={start}
          chosen={chosen}
          setDefault={setDefault}
          hidden={hidden}
          setShown={setShown}
          close={() => setChoosing(false)}
          onSources={(next: readonly Source[]) => {
            setSources(next);
            setOpened(null);
            reread();
          }}
        />
      )}
    </section>
  );
}
