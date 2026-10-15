import { useEffect, useRef, type KeyboardEvent } from "react";
import { Icon, type CalendarEvent, type PluginHost } from "../../plugin-api.ts";
import { whenLabel } from "./dates.ts";
import { Audience, NewNoteAbout, useNotesAbout } from "./EventNotes.tsx";
import { eventAddress, linkNotes } from "./linking.ts";

const STEPS: Record<string, (at: number, count: number) => number> = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/** Up and Down from action to action, round from the last to the first, and Home and End to the ends. */
function move(e: KeyboardEvent<HTMLElement>) {
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-action]")];
  const at = all.indexOf(e.target as HTMLElement);
  const step = STEPS[e.key];
  if (at < 0 || !step) return;
  e.preventDefault();
  all[step(at, all.length)]!.focus();
}

interface Props {
  host: PluginHost;
  event: CalendarEvent;
  /** The note the link is in. */
  noteId: string;
  close: () => void;
}

/**
 * What a press on an event link in a note opens: what the event is, then what to do with it. Open
 * note about it opens the latest other note about the event, or New note about this event makes
 * one; the notes about it are listed when there are several; Go to calendar shows it on the Calendar.
 */
export function EventLink({ host, event, noteId, close }: Props) {
  const app = host.app();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const listed = useNotesAbout(host, event);
  const { latest, listed: notes } = listed.is === "listed" ? linkNotes(listed.notes, noteId) : { latest: null, listed: [] };
  const ref = useRef<HTMLDivElement>(null);

  // The first action is known once the notes are read; the keyboard goes to it if what had it went.
  useEffect(() => {
    if (listed.is !== "reading" && !ref.current?.contains(document.activeElement)) ref.current?.querySelector<HTMLElement>("[data-action]")?.focus();
  }, [listed.is]);

  const open = (id: string) => {
    close();
    app.openNote(id, { preview: false });
  };

  return (
    <div ref={ref} className="chip-menu event-link" onKeyDown={move}>
      <div className="event-link-head">
        <strong>{event.title || "Untitled"}</strong>
        <span>{whenLabel(event.when, timeZone)}</span>
        <span>{[event.calendar, event.location].filter(Boolean).join(" · ")}</span>
      </div>
      {listed.is === "reading" && (
        <button type="button" className="chip-choice" aria-disabled="true" data-action data-autofocus>
          <Icon name="text" />
          <span>Finding notes about it…</span>
        </button>
      )}
      {listed.is === "failed" && (
        <p role="alert" className="said failed event-link-said">
          {listed.message}
        </p>
      )}
      {latest && (
        <button type="button" className="chip-choice" data-action aria-label={`Open note about it: ${latest.title || "Untitled"}`} onClick={() => open(latest.id)}>
          <Icon name="text" />
          <span className="event-link-open">
            Open note about it
            <span className="event-link-title">{latest.title || "Untitled"}</span>
          </span>
        </button>
      )}
      {listed.is === "listed" && !latest && (
        <NewNoteAbout
          host={host}
          app={app}
          event={event}
          timeZone={timeZone}
          close={close}
          starter={(start) => (
            <button type="button" className="chip-choice" data-action onClick={start}>
              <Icon name="plus" />
              <span>New note about this event</span>
            </button>
          )}
        />
      )}
      {notes.length > 0 && (
        <section className="event-link-notes" aria-label="Notes about this event">
          <h3>Notes about this event</h3>
          {notes.map((note) => (
            <button key={note.id} type="button" className="chip-choice" data-action onClick={() => open(note.id)}>
              <span className="event-link-title">{note.title || "Untitled"}</span>
              <Audience of={note.audience} />
            </button>
          ))}
        </section>
      )}
      <button
        type="button"
        className="chip-choice"
        data-action
        onClick={() => {
          close();
          app.go(eventAddress(event, timeZone));
        }}
      >
        <Icon name="calendar" />
        <span>Go to calendar</span>
      </button>
    </div>
  );
}
