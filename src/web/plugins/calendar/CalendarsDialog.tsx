import { useEffect, useId, useRef, type CSSProperties } from "react";
import { useDismiss, type App, type Calendar, type PluginHost, type Source } from "../../plugin-api.ts";
import { Sources } from "../lib/Sources.tsx";
import { startWords, type Start } from "./choosing.ts";
import { calendarKey } from "./listing.ts";

interface Props {
  host: PluginHost;
  app: App;
  sources: readonly Source[] | null;
  calendars: readonly Calendar[];
  /** The calendar a new event starts in, and why; null when there is none to add to. */
  start: Start;
  /** The member's default calendar, by `calendarKey`, or "" for none. */
  chosen: string;
  setDefault: (calendar: Calendar) => boolean;
  /** The calendars the member chose not to see here, by `calendarKey`. */
  hidden: ReadonlySet<string>;
  setShown: (calendar: Calendar, shown: boolean) => void;
  onSources: (sources: readonly Source[]) => void;
  close: () => void;
}

/**
 * Everything about where the Calendar's events come from, behind its one button: each calendar data
 * source with its way to connect and disconnect, and under a connected one, its calendars, each
 * shown here or not; and which of them new events go in.
 */
export function CalendarsDialog({ host, app, sources, calendars, start, chosen, setDefault, hidden, setShown, onSources, close }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(close, ref);
  // Focus goes into the dialog, and back to what opened it when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => before?.focus();
  }, []);
  return (
    <div className="event-scrim">
      <div ref={ref} className="event-dialog cal-sources" role="dialog" aria-modal="true" aria-label="Calendars" tabIndex={-1}>
        <header className="event-head">
          <h2>Calendars</h2>
          <button type="button" className="link" onClick={close}>
            Close
          </button>
        </header>
        <div className="event-body">
          <Sources
            host={host}
            app={app}
            kind="calendar"
            sources={sources}
            heading={false}
            onChange={onSources}
            below={(source) => {
              const mine = calendars.filter((c) => c.sourceId === source.id);
              return (
                mine.length > 0 && (
                  <ul className="cal-shown" aria-label={`Calendars in ${source.name}`}>
                    {mine.map((calendar) => (
                      <li key={calendarKey(calendar)}>
                        <label className="check">
                          <input type="checkbox" checked={!hidden.has(calendarKey(calendar))} onChange={(e) => setShown(calendar, e.target.checked)} />
                          <span className="cal-dot" style={{ "--c": calendar.color ?? "var(--accent)" } as CSSProperties} aria-hidden="true" />
                          <span>{calendar.name}</span>
                          {!calendar.writable && <span className="source-meta">Read-only</span>}
                        </label>
                      </li>
                    ))}
                  </ul>
                )
              );
            }}
          />
          {start && <DefaultCalendar calendars={calendars.filter((c) => c.writable && !hidden.has(calendarKey(c)))} start={start} chosen={chosen} setDefault={setDefault} />}
        </div>
      </div>
    </div>
  );
}

/** Which calendar new events go in, from those the member may add to and shows; with none chosen, where they go instead. */
function DefaultCalendar({ calendars, start, chosen, setDefault }: { calendars: readonly Calendar[]; start: NonNullable<Start>; chosen: string; setDefault: (calendar: Calendar) => boolean }) {
  const id = useId();
  const usable = calendars.some((c) => calendarKey(c) === chosen);
  return (
    <section className="sources" aria-labelledby={id}>
      <h2 id={id}>Default calendar</h2>
      <select
        aria-labelledby={id}
        aria-describedby={`${id}-about`}
        value={usable ? chosen : ""}
        onChange={(e) => {
          const calendar = calendars.find((c) => calendarKey(c) === e.target.value);
          if (calendar) setDefault(calendar);
        }}
      >
        {!usable && <option value="">None chosen</option>}
        {calendars.map((calendar) => (
          <option key={calendarKey(calendar)} value={calendarKey(calendar)}>
            {calendar.name}
          </option>
        ))}
      </select>
      <p id={`${id}-about`} className="source-meta">
        {start.by === "default" ? `New events go in ${start.calendar.name}: New event, a drag on the grid, and an agent's that names no calendar.` : startWords(start)}
      </p>
    </section>
  );
}
