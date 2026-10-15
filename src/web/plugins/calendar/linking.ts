import type { CalendarEvent, NoteAbout } from "../../plugin-api.ts";
import { dayIn } from "./dates.ts";

/** What an event link offers of the notes about its event, leaving out the note the link is in, where the member already is. */
export interface LinkNotes {
  /** What Open note about it opens: the one changed last. Null when there is no other, and New note about this event takes its place. */
  latest: NoteAbout | null;
  /** Every one of them, the latest first, when there is more than that one; otherwise none. */
  listed: readonly NoteAbout[];
}

/** `notes` are those about the event the member can see, as `record.notes` answers; `linkIn` is the note the link is in. */
export function linkNotes(notes: readonly NoteAbout[], linkIn: string): LinkNotes {
  const others = notes.filter((n) => n.id !== linkIn).toSorted((a, b) => b.updatedAt - a.updatedAt);
  return { latest: others[0] ?? null, listed: others.length > 1 ? others : [] };
}

/** The Calendar's address at an event: the page shows its day with the event open. */
export function eventAddress(event: Pick<CalendarEvent, "sourceId" | "id" | "when">, timeZone: string): string {
  const day = event.when.allDay ? event.when.from : dayIn(event.when.from, timeZone);
  return `/calendar?${new URLSearchParams({ source: event.sourceId, event: event.id, day })}`;
}
