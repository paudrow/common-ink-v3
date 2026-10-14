import { useEffect, useMemo, useRef, useState } from "react";
import type { Calendar, CalendarEvent, PluginHost, Source } from "../../plugin-api.ts";
import { daysBetween, shiftDay, spanOf, type Day } from "./dates.ts";

/** Day 0 of the grid's count: a Sunday, so a week from Sunday starts on a multiple of 7. */
export const EPOCH: Day = "2000-01-02";
export const dayAt = (index: number): Day => shiftDay(EPOCH, index);
export const indexOf = (day: Day) => daysBetween(EPOCH, day);

/** Days are asked for in runs this long, each run once for each reading of the calendar. */
const CHUNK = 14;
/** How long the days wanted must stay wanted before they are asked for. */
const WAIT_MS = 80;
/** Runs further than this from the days wanted are forgotten. */
const KEEP_CHUNKS = 12;

export const keyOf = (event: Pick<CalendarEvent, "sourceId" | "id">) => `${event.sourceId} ${event.id}`;
export const calendarKey = (calendar: { sourceId: string; calendarId?: string; id?: string }) => `${calendar.sourceId} ${calendar.calendarId ?? calendar.id}`;

type Chunk =
  | { status: "reading"; reading: number }
  | { status: "listed"; reading: number; asking: number; events: readonly CalendarEvent[]; sources: readonly Source[]; calendars: readonly Calendar[]; at: number }
  | { status: "failed"; reading: number; message: string };

export interface Listing {
  /** Every event read for the days wanted, each once, soonest first as each run listed them. */
  events: readonly CalendarEvent[];
  sources: readonly Source[] | null;
  calendars: readonly Calendar[];
  /** Whether the run a day is in has been read, so what it shows is what is there. */
  listed(index: number): boolean;
  /** The oldest reading among the runs wanted that have answered: a change made at a later reading is not in what is shown yet. */
  reading: number;
  failed: string | null;
}

/**
 * The member's events on days `from` to `to` (counted from EPOCH, `to` not included), read a run of
 * days at a time and kept, so days slid into view were read before they got there. `reading` counts
 * the times the calendar was changed from here: each run is read again for it, and what was read
 * before stays on show until the new answer comes.
 */
export function useListing(host: PluginHost, timeZone: string, from: number, to: number, reading: number): Listing {
  const chunks = useRef(new Map<number, Chunk>());
  const [answered, setAnswered] = useState(0);
  const first = Math.floor(from / CHUNK);
  const last = Math.floor((to - 1) / CHUNK);

  useEffect(() => {
    const kept = chunks.current;
    for (const n of [...kept.keys()]) if (n < first - KEEP_CHUNKS || n > last + KEEP_CHUNKS) kept.delete(n);
    const ask = () => {
      for (let n = first; n <= last; n++) askFor(n);
    };
    // A slide flies over days it never stops on: what it wants is asked for once it has wanted it a moment, and the first reading at once.
    if (!kept.size) return ask();
    const timer = setTimeout(ask, WAIT_MS);
    return () => clearTimeout(timer);

    function askFor(n: number) {
      const had = kept.get(n);
      // A run that failed is asked again whenever it is wanted again.
      if (had && had.status !== "failed" && (had.status === "reading" ? had.reading : had.asking) >= reading) return;
      const days = Array.from({ length: CHUNK }, (_, i) => dayAt(n * CHUNK + i));
      if (had?.status === "listed") kept.set(n, { ...had, asking: reading });
      else kept.set(n, { status: "reading", reading });
      host.perform({ type: "event.list", ...spanOf(days, timeZone) }).then(
        (answer) => {
          const now = kept.get(n);
          if (now && now.status === "listed" && now.reading > reading) return;
          kept.set(n, { status: "listed", reading, asking: Math.max(reading, now?.status === "listed" ? now.asking : reading), at: Date.now(), ...answer });
          setAnswered((a) => a + 1);
        },
        (err: Error) => {
          const now = kept.get(n);
          // A run already on show stays on show; the next change asks again.
          if (now?.status !== "listed") kept.set(n, { status: "failed", reading, message: err.message });
          setAnswered((a) => a + 1);
        },
      );
    }
  }, [host, timeZone, first, last, reading]);

  return useMemo(() => {
    const seen = new Set<string>();
    const events: CalendarEvent[] = [];
    let latest: Extract<Chunk, { status: "listed" }> | null = null;
    let oldest = Infinity;
    let failed: string | null = null;
    for (let n = first; n <= last; n++) {
      const chunk = chunks.current.get(n);
      if (chunk?.status === "failed") failed = chunk.message;
      if (chunk?.status !== "listed") continue;
      oldest = Math.min(oldest, chunk.reading);
      if (!latest || chunk.at > latest.at) latest = chunk;
      for (const event of chunk.events) {
        const key = keyOf(event);
        if (!seen.has(key)) {
          seen.add(key);
          events.push(event);
        }
      }
    }
    const listed = (index: number) => chunks.current.get(Math.floor(index / CHUNK))?.status === "listed";
    return { events, sources: latest?.sources ?? null, calendars: latest?.calendars ?? [], listed, reading: oldest === Infinity ? -1 : oldest, failed };
    // `answered` is what changes when a run comes back; the map itself is the same object throughout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, last, answered, reading]);
}
