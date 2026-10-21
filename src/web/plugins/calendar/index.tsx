import type { CalendarEvent, CompletionItem, Plugin } from "../../plugin-api.ts";
import { AT_ALONE, namable } from "../lib/pointing.ts";
import { reask } from "../lib/reasking.ts";
import { referenceEmbed } from "../lib/references.tsx";
import { CalendarPage } from "./Calendar.tsx";
import { whenLabel } from "./dates.ts";
import { EventLink } from "./EventLink.tsx";
import { eventsRead, eventsToFind, finding, listedAs, upcoming } from "./finding.ts";
import { copyEventReference, referTo } from "./referring.ts";

/** How many events `[[` and `@` offer at most, after the notes. */
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
    default: {
      type: "string",
      default: "",
      maxLength: 400,
      remembered: true,
      title: "Default calendar",
      description:
        "The calendar a new event goes in when you don't pick one: New event, a drag on the Calendar's grid, and an agent's create_event that names no calendar. Choose it in the Calendar's Calendars dialog. While it is unset, or can't be added to, the Calendar starts a new event in the calendar you added to last in that browser, and an agent adds to the first calendar you can add to and haven't hidden.",
    },
  },
  activate(host) {
    /** The reading of the events an open list is to be asked again for, once it lands: the first, until then none are known. */
    let awaited: Promise<unknown> | null = null;
    /**
     * The events found by what was typed after `[[` or `@`, nearest first: one picked is written as its
     * reference, made then, so the event lists the note. `@` alone offers the next few. The trigger
     * alone starts reading them, so they are there by the first letter. Until the first reading lands,
     * `[[` waits for it a moment, and `@` doesn't, so what else it lists is offered at once. Either
     * list, open when the reading lands, is asked again for the events.
     */
    const events = (typed: string, trigger: "[[" | "@"): CompletionItem[] | Promise<CompletionItem[]> => {
      const timeZone = zone();
      const { now, read } = eventsToFind(host, timeZone);
      if (now === null && awaited !== read) {
        awaited = read;
        // A reading that failed is asked for again by the next asking, so asking again for it would read on without end.
        void read.then(() => eventsRead() && reask());
      }
      const alone = trigger === "@" && typed === "";
      if ((!typed.trim() && !alone) || /[[\]|]/.test(typed)) return [];
      const offer = (events: readonly CalendarEvent[]) =>
        (alone ? upcoming(events, Date.now(), timeZone).slice(0, AT_ALONE.event) : finding(events, typed, Date.now(), timeZone).slice(0, MOST_OFFERED)).map((event): CompletionItem => {
          const { label, detail } = listedAs(event, timeZone);
          const facts = [["When", whenLabel(event.when, timeZone)], ...(event.location ? [["Where", event.location] as const] : [])] as const;
          return { kind: "event", label, description: detail, preview: { facts }, insert: () => referTo(host, event) };
        });
      // The list waits for every completion's answer, so a first reading that is slow holds it up a moment at most.
      if (now || trigger === "@") return offer(now ?? []);
      return Promise.race([read.then(offer), new Promise<never[]>((done) => setTimeout(() => done([]), FIRST_READ_MS))]);
    };
    host.completions.register({ id: "events", trigger: "[[", spaces: true, anywhere: true, items: (typed) => events(typed, "[[") });
    host.completions.register({ id: "events.at", trigger: "@", spaces: true, items: (typed) => (namable(typed) ? events(typed, "@") : []) });
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
        details: ({ event }, { noteId, close }) => <EventLink host={host} event={event} noteId={noteId} close={close} />,
      }),
    );
  },
};
