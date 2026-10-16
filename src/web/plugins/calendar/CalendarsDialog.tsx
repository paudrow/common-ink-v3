import { useEffect, useRef, type CSSProperties } from "react";
import { useDismiss, type App, type Calendar, type PluginHost, type Source } from "../../plugin-api.ts";
import { Sources } from "../lib/Sources.tsx";
import { calendarKey } from "./listing.ts";

interface Props {
  host: PluginHost;
  app: App;
  sources: readonly Source[] | null;
  calendars: readonly Calendar[];
  /** The calendars the member chose not to see here, by `calendarKey`. */
  hidden: ReadonlySet<string>;
  setShown: (calendar: Calendar, shown: boolean) => void;
  onSources: (sources: readonly Source[]) => void;
  close: () => void;
}

/**
 * Everything about where the Calendar's events come from, behind its one button: each calendar data
 * source with its way to connect and disconnect, and under a connected one, its calendars, each
 * shown here or not.
 */
export function CalendarsDialog({ host, app, sources, calendars, hidden, setShown, onSources, close }: Props) {
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
        </div>
      </div>
    </div>
  );
}
