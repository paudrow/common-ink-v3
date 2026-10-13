import type { Plugin } from "../../plugin-api.ts";
import { referenceEmbed } from "../lib/references.tsx";
import { CalendarPage } from "./Calendar.tsx";
import { whenLabel } from "./dates.ts";

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
  activate(host) {
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
