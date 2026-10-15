import { useRef, useState, type FormEvent } from "react";
import { useDismiss, type App, type CalendarEvent, type OpInput, type PluginHost, type Source } from "../../plugin-api.ts";
import { CopyReference } from "../lib/CopyReference.tsx";
import { formOf, sameWhen, whenLabel, whenOf, type WhenForm } from "./dates.ts";
import { NewNoteAbout, NotesAbout } from "./EventNotes.tsx";

interface Props {
  host: PluginHost;
  app: App;
  event: CalendarEvent;
  /** The data source the event is in, when it is known. */
  source: Source | undefined;
  timeZone: string;
  close: () => void;
  /** Called when the event may no longer be what is listed: after a change, and after one that was refused. */
  onChanged: () => void;
}

type Said = { text: string; failed?: boolean };

type Change = Omit<Extract<OpInput, { type: "event.update" }>, "type" | "sourceId" | "id" | "etag">;

interface Fields extends WhenForm {
  title: string;
  location: string;
  description: string;
}

const fieldsOf = (event: CalendarEvent, timeZone: string): Fields => ({ title: event.title, location: event.location ?? "", description: event.description ?? "", ...formOf(event.when, timeZone) });

/** Only what the member changed, so a field someone changed elsewhere meanwhile isn't written back as it was. */
function changeOf(event: CalendarEvent, fields: Fields, timeZone: string): Change | { problem: string } {
  const when = whenOf(fields, timeZone);
  if ("problem" in when) return when;
  return {
    ...(fields.title !== event.title && { title: fields.title }),
    ...(fields.location !== (event.location ?? "") && { location: fields.location }),
    ...(fields.description !== (event.description ?? "") && { description: fields.description }),
    ...(!sameWhen(when, event.when) && { when }),
  };
}

/** Why an event can't be changed here. The server refuses it whatever is shown. */
const whyReadOnly = (event: CalendarEvent, source: Source | undefined) => (source && !source.writable ? `${source.name} is read-only.` : `You can only read the calendar ${event.calendar}.`);

/** One event: what it is and when, and for one the member may change, the form that changes it where it is kept. */
export function EventDetails({ host, app, event, source, timeZone, close, onChanged }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Kept here and not in the form, which is made again when the event is read again.
  const [said, say] = useState<Said | null>(null);
  useDismiss(close, ref);
  return (
    <div className="event-scrim">
      <div ref={ref} className="event-dialog" role="dialog" aria-label={`Event: ${event.title || "Untitled"}`}>
        <header className="event-head">
          <h2>{event.title || "Untitled"}</h2>
          <button type="button" className="link" onClick={close}>
            Close
          </button>
        </header>
        <div className="event-body">
          <dl className="event-facts">
            <dt>When</dt>
            <dd>
              {whenLabel(event.when, timeZone)}
              {event.recurring && <span className="event-note"> · One time of an event that recurs</span>}
            </dd>
            <dt>Calendar</dt>
            <dd>
              {event.calendar}
              {source && <span className="event-note"> · {source.name}</span>}
            </dd>
            {!event.editable && event.location && (
              <>
                <dt>Location</dt>
                <dd>{event.location}</dd>
              </>
            )}
            {!event.editable && event.description && (
              <>
                <dt>Description</dt>
                <dd className="event-description">{event.description}</dd>
              </>
            )}
          </dl>
          <div className="event-links">
            <CopyReference host={host} sourceId={event.sourceId} id={event.id} />
            <NewNoteAbout key={`${event.sourceId} ${event.id}`} host={host} app={app} event={event} timeZone={timeZone} close={close} />
            {event.url && /^https?:\/\//.test(event.url) && (
              <a href={event.url} target="_blank" rel="noopener noreferrer">
                Open in {source?.provider ?? "its calendar"}
              </a>
            )}
          </div>
          {event.editable ? (
            // A new form for each reading of the event, so one refused as stale starts again from the event as it is now.
            <EventForm key={event.etag} host={host} event={event} timeZone={timeZone} onChanged={onChanged} said={said} say={say} />
          ) : (
            <p className="event-read-only">{whyReadOnly(event, source)}</p>
          )}
          <NotesAbout key={`${event.sourceId} ${event.id}`} host={host} app={app} event={event} close={close} />
        </div>
      </div>
    </div>
  );
}

function EventForm({ host, event, timeZone, onChanged, said, say }: Pick<Props, "host" | "event" | "timeZone" | "onChanged"> & { said: Said | null; say: (said: Said | null) => void }) {
  const [fields, setFields] = useState(() => fieldsOf(event, timeZone));
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<Fields>) => setFields((was) => ({ ...was, ...change }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const change = changeOf(event, fields, timeZone);
    if ("problem" in change) return say({ text: change.problem, failed: true });
    if (!Object.keys(change).length) return say({ text: "Nothing to save." });
    setBusy(true);
    say(null);
    try {
      await host.perform({ type: "event.update", sourceId: event.sourceId, id: event.id, etag: event.etag, ...change });
      say({ text: `Saved to ${event.calendar}.` });
    } catch (err) {
      say({ text: (err as Error).message, failed: true });
    }
    setBusy(false);
    // Read again either way: a refusal may mean the event is no longer what this form was filled from.
    onChanged();
  };

  return (
    <form className="event-form" aria-label="Change event" onSubmit={(e) => void save(e)}>
      <label>
        <span>Title</span>
        <input value={fields.title} maxLength={1000} onChange={(e) => set({ title: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={fields.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
        <span>All day</span>
      </label>
      <div className="event-when">
        <label>
          <span>Starts</span>
          <input type="date" required value={fields.fromDay} onChange={(e) => set({ fromDay: e.target.value })} />
        </label>
        {!fields.allDay && (
          <label>
            <span>Start time</span>
            <input type="time" required value={fields.fromTime} onChange={(e) => set({ fromTime: e.target.value })} />
          </label>
        )}
        <label>
          <span>Ends</span>
          <input type="date" required value={fields.toDay} onChange={(e) => set({ toDay: e.target.value })} />
        </label>
        {!fields.allDay && (
          <label>
            <span>End time</span>
            <input type="time" required value={fields.toTime} onChange={(e) => set({ toTime: e.target.value })} />
          </label>
        )}
      </div>
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
        {said && (
          <span role={said.failed ? "alert" : "status"} className={said.failed ? "said failed" : "said"}>
            {said.text}
          </span>
        )}
      </div>
    </form>
  );
}
