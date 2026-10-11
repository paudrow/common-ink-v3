import { dayIn } from "./history.ts";
import type { CalendarEvent, EventWhen } from "./protocol.ts";

const DAY_MS = 86_400_000;

/** A span of time as an operation asks for it, and the zone whose days it is read in. */
export interface Span {
  from: number;
  to: number;
  timeZone: string;
}

/**
 * The span to ask a data source for so that it answers every all-day event `span` covers. An all-day
 * event has no instants of its own: where it is kept it is found by the days of some zone, which is
 * within a day of the asker's.
 */
export const widened = (span: Span): { from: number; to: number } => ({ from: span.from - DAY_MS, to: span.to + DAY_MS });

/**
 * Whether an event is in a span. An event between two instants is when it overlaps the span. An
 * all-day event is when one of its days is a day the span covers in the span's zone, so today's
 * all-day event is today's wherever the asker is.
 */
export function within(when: EventWhen, span: Span): boolean {
  if (!when.allDay) return when.from < span.to && (when.to > span.from || when.from >= span.from);
  const day = dayIn(span.timeZone);
  return when.from <= day(Math.max(span.from, span.to - 1)) && when.to >= day(span.from);
}

/** Soonest first by the asker's days, and on a day the all-day events before the rest. */
export function inOrder(events: readonly CalendarEvent[], timeZone: string): CalendarEvent[] {
  const day = dayIn(timeZone);
  const key = ({ when }: CalendarEvent) => (when.allDay ? `${when.from} 0` : `${day(when.from)} 1${String(when.from).padStart(16, "0")}`);
  return events
    .map((event) => ({ event, key: key(event) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.event.title.localeCompare(b.event.title) || (a.event.id < b.event.id ? -1 : 1)))
    .map(({ event }) => event);
}

/** The day after a calendar date, and the day before: how an all-day event's last day is told from the exclusive end a calendar keeps. */
export function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
}
