import { useRef, useState, type FormEvent } from "react";
import { useDismiss, type Calendar, type CalendarEvent, type PluginHost } from "../../plugin-api.ts";
import { whenOf, type WhenForm } from "./dates.ts";
import { calendarKey } from "./listing.ts";

/** Where the form remembers the calendar last added to, so the next one starts there. */
const TARGET = "calendarTarget";

interface Props {
  host: PluginHost;
  /** The calendars the member may add to. */
  calendars: readonly Calendar[];
  /** When the event starts and ends, as the grid or the key asked for it. */
  when: WhenForm;
  timeZone: string;
  close: () => void;
  onAdded: (event: CalendarEvent) => void;
}

interface Fields extends WhenForm {
  title: string;
  target: string;
  location: string;
  description: string;
}

/** The calendar a new event goes in first: the one last added to, while the member may still add to it, and otherwise the first. */
export function targetOf(host: PluginHost, calendars: readonly Calendar[]): string {
  const kept = host.storage.get(TARGET);
  return calendars.some((c) => calendarKey(c) === kept) ? (kept as string) : calendars[0] ? calendarKey(calendars[0]) : "";
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const timeOf = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** "1 hr 30 min", for the length a form's times say. */
function lengthWords(form: WhenForm): string {
  if (form.allDay || form.fromDay !== form.toDay) return "";
  const minutes = minutesOf(form.toTime) - minutesOf(form.fromTime);
  if (!(minutes > 0)) return "";
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(" ");
}

/**
 * Adds an event. A drag or a click on the grid opens it with the time it covered; nothing is added
 * until Save, and Cancel or Escape leaves the calendar as it was.
 */
export function NewEvent({ host, calendars, when, timeZone, close, onAdded }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [fields, setFields] = useState<Fields>(() => ({ ...when, title: "", target: targetOf(host, calendars), location: "", description: "" }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useDismiss(busy ? null : close, ref);
  const set = (change: Partial<Fields>) => setFields((was) => ({ ...was, ...change }));

  // Moving the start keeps the length, as v1's form did.
  const setStart = (fromTime: string) => {
    if (!/^\d{2}:\d{2}$/.test(fromTime)) return set({ fromTime });
    const length = minutesOf(fields.toTime) - minutesOf(fields.fromTime);
    const end = minutesOf(fromTime) + Math.max(15, length);
    set({ fromTime, ...(fields.fromDay === fields.toDay && end < 24 * 60 && { toTime: timeOf(end) }) });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const at = whenOf(fields, timeZone);
    if ("problem" in at) return setProblem(at.problem);
    const calendar = calendars.find((c) => calendarKey(c) === fields.target);
    if (!calendar) return setProblem("Pick a calendar to add it to.");
    setBusy(true);
    setProblem(null);
    try {
      const made = await host.perform({ type: "event.create", sourceId: calendar.sourceId, calendarId: calendar.id, title: fields.title.trim(), when: at, ...(fields.location && { location: fields.location }), ...(fields.description && { description: fields.description }) });
      host.storage.set(TARGET, fields.target);
      onAdded(made);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  };

  const length = lengthWords(fields);
  return (
    <div className="event-scrim">
      <div ref={ref} className="event-dialog" role="dialog" aria-label="New event">
        <form className="event-form cal-new" aria-label="New event" onSubmit={(e) => void save(e)}>
          <input className="cal-new-title" aria-label="Title" placeholder="Add a title" autoFocus value={fields.title} maxLength={1000} onChange={(e) => set({ title: e.target.value })} />
          <div className="event-when">
            <label>
              <span>Starts</span>
              <input type="date" required value={fields.fromDay} onChange={(e) => set({ fromDay: e.target.value, ...(fields.toDay === fields.fromDay && { toDay: e.target.value }) })} />
            </label>
            {!fields.allDay && (
              <>
                <label>
                  <span>Start time</span>
                  <input type="time" required step={900} value={fields.fromTime} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label>
                  <span>End time</span>
                  <input type="time" required step={900} value={fields.toTime} onChange={(e) => set({ toTime: e.target.value })} />
                </label>
              </>
            )}
            <label>
              <span>Ends</span>
              <input type="date" required value={fields.toDay} onChange={(e) => set({ toDay: e.target.value })} />
            </label>
          </div>
          <div className="cal-new-row">
            <label className="check">
              <input type="checkbox" checked={fields.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
              <span>All day</span>
            </label>
            {length && <span className="cal-new-length">{length}</span>}
          </div>
          {calendars.length > 1 && (
            <label>
              <span>Calendar</span>
              <select value={fields.target} onChange={(e) => set({ target: e.target.value })}>
                {calendars.map((calendar) => (
                  <option key={calendarKey(calendar)} value={calendarKey(calendar)}>
                    {calendar.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Location</span>
            <input value={fields.location} maxLength={1000} onChange={(e) => set({ location: e.target.value })} />
          </label>
          <label>
            <span>Description</span>
            <textarea rows={3} value={fields.description} maxLength={8000} onChange={(e) => set({ description: e.target.value })} />
          </label>
          <div className="event-save">
            <button type="submit" className="button primary" disabled={busy}>
              Save
            </button>
            <button type="button" className="button" onClick={close} disabled={busy}>
              Cancel
            </button>
            {problem && (
              <span role="alert" className="said failed">
                {problem}
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
