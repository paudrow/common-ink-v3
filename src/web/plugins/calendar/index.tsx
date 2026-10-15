import type { Plugin } from "../../plugin-api.ts";
import { referenceEmbed } from "../lib/references.tsx";
import { CalendarPage } from "./Calendar.tsx";
import { whenLabel } from "./dates.ts";
import { eventsToFind, finding, listedAs } from "./finding.ts";
import { copyEventReference, referTo } from "./referring.ts";

/** How many events `[[` offers at most, after the notes. */
const MOST_OFFERED = 8;
/** How long `[[` waits for the first reading of the events before it offers the notes alone. */
const FIRST_READ_MS = 800;

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The Calendar: the member's events from the calendars they connected, which nobody else in the
 * workspace sees. A note references one as `::event{ref label}`, which shows the event as it is now
 * to the member whose it is and the label to everyone else.
 */
export const calendar: Plugin = {
  id: "calendar",
  name: "Calendar",
  description: "Shows the events of the calendars you connect, which nobody else in the workspace sees, and lets a note reference one.",
  icon: "calendar",
  settings: {
    weekStarts: {
      type: "string",
      enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      default: "Monday",
      title: "First day of the week",
      description: "The day a week starts on in the Calendar: the first day Week shows, and the first column of Month.",
    },
    weekends: { type: "boolean", default: true, title: "Highlight weekends", description: "Shades Saturday and Sunday in the Calendar's days and months." },
    hidden: {
      type: "list",
      default: [],
      maxItems: 100,
      maxLength: 200,
      remembered: true,
      title: "Hidden calendars",
      description: "The calendars unticked in the Calendar's Calendars dialog, whose events the Calendar doesn't show. They are kept on the server with your settings for this workspace, so the Calendar shows the same calendars in every browser you sign in on.",
    },
  },
  activate(host) {
    // `[[` offers events after notes: one picked is written as its reference, made then, so the event lists the note.
    host.completions.register({
      id: "events",
      trigger: "[[",
      spaces: true,
      anywhere: true,
      order: 1,
      items(typed) {
        const timeZone = zone();
        const { now, read } = eventsToFind(host, timeZone);
        // `[[` alone only starts reading them, so they are there by the first letter.
        if (!typed.trim() || /[[\]|]/.test(typed)) return [];
        const offer = (events: Parameters<typeof finding>[0]) =>
          finding(events, typed, Date.now(), timeZone)
            .slice(0, MOST_OFFERED)
            .map((event) => ({ ...listedAs(event, timeZone), insert: () => referTo(host, event) }));
        // The notes' list waits for every completion's answer, so a first reading that is slow holds it up a moment at most.
        return now ? offer(now) : Promise.race([read.then(offer), new Promise<never[]>((done) => setTimeout(() => done([]), FIRST_READ_MS))]);
      },
    });
    host.commands.register({ id: "calendar.copyReference", title: "Copy event reference", group: "Calendar", run: () => void copyEventReference(host) });
    host.views.register("page", { id: "calendar", path: "/calendar", label: "Calendar", icon: "calendar", nav: "primary", order: 40, component: (props) => <CalendarPage host={host} {...props} /> });
    host.embeds.register(
      referenceEmbed({
        host,
        kind: "event",
        title: "Event",
        hint: "copy a reference from an event on the Calendar page, and paste it over this",
        // The title alone: adding the time as the details arrive would widen the chip, and a line that just fit would gain a row.
        shown: ({ event }) => ({ text: event.title || "Untitled", title: `${whenLabel(event.when, zone())} · ${event.calendar}${event.location ? ` · ${event.location}` : ""}` }),
        details: ({ event }) => (
          <dl className="ref-details">
            <dt>Event</dt>
            <dd>{event.title || "Untitled"}</dd>
            <dt>When</dt>
            <dd>{whenLabel(event.when, zone())}</dd>
            <dt>Calendar</dt>
            <dd>{event.calendar}</dd>
            {event.location && (
              <>
                <dt>Location</dt>
                <dd>{event.location}</dd>
              </>
            )}
          </dl>
        ),
      }),
    );
  },
};
