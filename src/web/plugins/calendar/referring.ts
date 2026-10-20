import type { CalendarEvent, PluginHost } from "../../plugin-api.ts";
import { copyReference } from "../lib/references.tsx";
import { dayIn, dayLabel } from "./dates.ts";

/**
 * The event last opened on the Calendar page, which the palette's Copy event reference copies. It
 * stays after its panel closes, as a press in the palette closes it, until the page is left.
 */
let last: CalendarEvent | null = null;

export const opened = (event: CalendarEvent | null) => void (last = event);

/** What a note writes to reference an event, made for the member now, or null when it couldn't be, which is said. */
export async function referTo(host: PluginHost, event: Pick<CalendarEvent, "sourceId" | "id">): Promise<string | null> {
  try {
    return (await host.perform({ type: "record.refer", sourceId: event.sourceId, id: event.id })).text;
  } catch (err) {
    host.app().notify({ message: (err as Error).message, icon: "calendar" });
    return null;
  }
}

/** Copies the reference to the event open on the Calendar page, to be pasted into a note, and says so. */
export async function copyEventReference(host: PluginHost): Promise<void> {
  if (!last) return void host.app().notify({ message: "Open an event on the Calendar first, then copy its reference.", icon: "calendar" });
  await copyReference(host, last, eventNamed(last), "calendar");
}

/** How a notice names an event: its title and its day, since a title alone can be many events. */
const eventNamed = (event: CalendarEvent) =>
  `${event.title || "Untitled"}, ${dayLabel(event.when.allDay ? event.when.from : dayIn(event.when.from, Intl.DateTimeFormat().resolvedOptions().timeZone), "short")}`;
