import { useCallback, useEffect, useMemo, useState } from "react";
import { today, type CalendarEvent, type PluginHost, type Source, type ViewProps } from "../../plugin-api.ts";
import { forgetReferences } from "../lib/references.tsx";
import { Sources, useSources, withFresher } from "../lib/Sources.tsx";
import { VIEWS, cellsOf, dayLabel, daysOf, spanOf, step, timeLabel, titleOf, weekdayLabel, type Cell, type Day, type View } from "./dates.ts";
import { EventDetails } from "./EventDetails.tsx";

/** The zone the member's browser is in, which is the one every day and time here is said in. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Span = ReturnType<typeof spanOf>;

/** What the page has read. `span` is what was asked for: events are only ever shown on the days they were listed for. */
type Listing = { status: "reading" } | { status: "listed"; span: Span; events: readonly CalendarEvent[]; sources: readonly Source[] } | { status: "failed"; span: Span; message: string };

const keyOf = (event: Pick<CalendarEvent, "sourceId" | "id">) => `${event.sourceId} ${event.id}`;
const swatch = (color: string | null) => (color && /^#[0-9a-f]{6}$/i.test(color) ? { background: color } : undefined);

function EventButton({ event, timeZone, onOpen }: { event: CalendarEvent; timeZone: string; onOpen: (event: CalendarEvent) => void }) {
  return (
    <button type="button" className="cal-event" data-all-day={event.when.allDay || undefined} title={`${event.title} · ${event.calendar}`} onClick={() => onOpen(event)}>
      <span className="cal-swatch" style={swatch(event.color)} aria-hidden="true" />
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

/** The Calendar: the member's events from every calendar they connected, by week, month or as a list, in their own time zone. */
export function CalendarPage({ host, app }: ViewProps & { host: PluginHost }) {
  const timeZone = useMemo(zone, []);
  const [view, setView] = useState<View>(() => {
    const kept = host.storage.get("view");
    return typeof kept === "string" && kept in VIEWS ? (kept as View) : "week";
  });
  const [anchor, setAnchor] = useState<Day>(today);
  const [read, setListing] = useState<Listing>({ status: "reading" });
  const [asked, setAsked] = useState(0);
  const [opened, setOpened] = useState<string | null>(null);
  const { sources, setSources, problem } = useSources(host);

  const days = useMemo(() => daysOf(view, anchor), [view, anchor]);
  const span = useMemo(() => spanOf(days, timeZone), [days, timeZone]);

  useEffect(() => {
    let live = true;
    host.perform({ type: "event.list", ...span }).then(
      (answer) => live && setListing({ status: "listed", span, ...answer }),
      (err: Error) => live && setListing({ status: "failed", span, message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [host, span, asked]);

  // The listing asked each calendar just now, so it knows before `source.list` is asked again that one stopped answering.
  useEffect(() => {
    if (read.status === "listed") setSources((known) => withFresher(known, read.sources));
  }, [read, setSources]);

  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const show = (next: View) => {
    host.storage.set("view", next);
    setView(next);
  };

  const now = today();
  const listing: Listing = read.status !== "reading" && read.span === span ? read : { status: "reading" };
  const events = useMemo(() => (listing.status === "listed" ? listing.events : []), [listing]);
  const cells = useMemo(() => cellsOf(days, events, timeZone), [days, events, timeZone]);
  const connected = (sources ?? []).some((s) => s.kind === "calendar" && s.state === "connected");
  const open = opened === null ? undefined : events.find((e) => keyOf(e) === opened);

  return (
    <section className="calendar-page" aria-label="Calendar">
      <h1>Calendar</h1>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      {connected && (
        <>
          <div className="cal-tools">
            <div className="cal-nav" role="group" aria-label="Days on show">
              <button type="button" className="button small" onClick={() => setAnchor(step(view, anchor, -1))} aria-label="Previous">
                ‹
              </button>
              <button type="button" className="button small" onClick={() => setAnchor(now)}>
                Today
              </button>
              <button type="button" className="button small" onClick={() => setAnchor(step(view, anchor, 1))} aria-label="Next">
                ›
              </button>
            </div>
            <h2 aria-live="polite">{titleOf(view, anchor)}</h2>
            <div className="cal-views" role="group" aria-label="View">
              {(Object.keys(VIEWS) as View[]).map((each) => (
                <button key={each} type="button" className="button small" aria-pressed={view === each} onClick={() => show(each)}>
                  {VIEWS[each]}
                </button>
              ))}
            </div>
          </div>
          <p className="cal-zone">Times are in your time zone, {timeZone.replace(/_/g, " ")}.</p>
          {listing.status === "failed" && (
            <p role="alert" className="said failed">
              {listing.message}
            </p>
          )}
          {listing.status !== "failed" && view !== "agenda" && (
            <div className={`cal-grid cal-${view}`} role="grid" aria-label={titleOf(view, anchor)} aria-busy={listing.status === "reading"}>
              {view === "month" && (
                <div className="cal-weekdays" role="row">
                  {days.slice(0, 7).map((day) => (
                    <span key={day} role="columnheader">
                      {weekdayLabel(day)}
                    </span>
                  ))}
                </div>
              )}
              {Array.from({ length: cells.length / 7 }, (_, week) => (
                <div key={cells[week * 7]!.day} className="cal-row" role="row">
                  {cells.slice(week * 7, week * 7 + 7).map((cell) => (
                    <div key={cell.day} className="cal-day" role="gridcell" aria-label={dayLabel(cell.day, "heading")} data-day={cell.day} data-today={cell.day === now || undefined} data-outside={(view === "month" && cell.day.slice(0, 7) !== anchor.slice(0, 7)) || undefined}>
                      <span className="cal-date">
                        {view === "week" && <span className="cal-weekday">{weekdayLabel(cell.day)}</span>}
                        <span className="cal-number">{Number(cell.day.slice(8))}</span>
                      </span>
                      <DayEvents cell={cell} timeZone={timeZone} onOpen={(event) => setOpened(keyOf(event))} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {listing.status !== "failed" && view === "agenda" && (
            <div className="cal-agenda" aria-label={titleOf(view, anchor)} aria-busy={listing.status === "reading"}>
              {cells
                .filter((cell) => cell.allDay.length + cell.timed.length > 0)
                .map((cell) => (
                  <section key={cell.day} className="cal-day" aria-label={dayLabel(cell.day, "heading")} data-day={cell.day} data-today={cell.day === now || undefined}>
                    <h3>{dayLabel(cell.day, "heading")}</h3>
                    <DayEvents cell={cell} timeZone={timeZone} onOpen={(event) => setOpened(keyOf(event))} />
                  </section>
                ))}
              {listing.status === "listed" && !events.length && <p className="cal-none">Nothing on these days.</p>}
            </div>
          )}
        </>
      )}
      {open && (
        <EventDetails
          host={host}
          event={open}
          source={(sources ?? []).find((s) => s.id === open.sourceId)}
          timeZone={timeZone}
          close={() => setOpened(null)}
          onChanged={() => {
            forgetReferences();
            reload();
          }}
        />
      )}
      <Sources
        host={host}
        app={app}
        kind="calendar"
        sources={sources}
        onChange={(next) => {
          setSources(next);
          setOpened(null);
          setListing({ status: "reading" });
          reload();
        }}
      />
    </section>
  );
}
