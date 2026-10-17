import { z } from "zod";
import type { Opened } from "./plugin-api.ts";

/** One place the member was: what was in front, and for a note where the cursor was in it. */
export interface Stop {
  place: Opened;
  /** An offset into the note's text. Null for a note whose cursor was never read, and for a folder's list or a page. */
  cursor: number | null;
}

/**
 * Where the member has been, for going back and forward through it, as a browser's history and
 * vim's jump list are walked. `stops` are in the order they were made and `at` is the one the member
 * is at, or -1 with none. `recent` is every place visited, the latest first, each once.
 */
export interface Travels {
  readonly stops: readonly Stop[];
  readonly at: number;
  readonly recent: readonly Opened[];
}

export type Travel =
  /** The app has something new in front. `left` is where the cursor was in the note it was at before, read as it left. */
  | { type: "arrive"; place: Opened; left: number | null }
  /** The cursor jumped within the note in front, as vim's G or a search sends it: a stop of its own, so Back comes back to `from`. */
  | { type: "jump"; noteId: string; from: number; to: number }
  /** The note's text changed: `map` says where an offset before the change is after it, so each stop in the note stays at its words. */
  | { type: "edit"; noteId: string; map: (at: number) => number };

export const NO_TRAVELS: Travels = { stops: [], at: -1, recent: [] };

const MOST_STOPS = 100;
const MOST_RECENT = 50;

const pathOf = (place: Opened) => (place.kind === "page" ? place.path.split("?")[0] : "");

/**
 * Whether two places are one stop: the same note or folder, or the same page at the same path. A
 * page's query, such as what Search was asked, is how it was left, and no other place: a person's
 * page and the next, or an upload and the list, are two.
 */
export const samePlace = (a: Opened | null | undefined, b: Opened | null | undefined) => !!a && !!b && a.kind === b.kind && a.id === b.id && pathOf(a) === pathOf(b);

const withCursor = (stop: Stop, cursor: number | null): Stop => (stop.place.kind === "note" && cursor !== null ? { ...stop, cursor } : stop);

/** `stops` cut after `at`, with `added` after them, as visiting from the middle of a browser's history drops what was ahead. */
function onward(travels: Travels, kept: Stop[], added: Stop[]): Travels {
  const stops = [...kept, ...added].slice(-MOST_STOPS);
  return { ...travels, stops, at: stops.length - 1 };
}

export function travelled(travels: Travels, travel: Travel): Travels {
  const here = travels.stops[travels.at];
  switch (travel.type) {
    case "arrive": {
      const recent = [travel.place, ...travels.recent.filter((p) => !samePlace(p, travel.place))].slice(0, MOST_RECENT);
      // Arriving where a step went, or at the page in front asked something else, is no stop of its own.
      if (here && samePlace(here.place, travel.place)) {
        const stops = travels.stops.map((s, i) => (i === travels.at ? { ...s, place: travel.place } : s));
        return { ...travels, stops, recent };
      }
      const kept = travels.stops.slice(0, travels.at + 1).map((s, i) => (i === travels.at ? withCursor(s, travel.left) : s));
      return { ...onward(travels, kept, [{ place: travel.place, cursor: null }]), recent };
    }
    case "jump": {
      if (!here || here.place.kind !== "note" || here.place.id !== travel.noteId || travel.from === travel.to) return travels;
      const kept = travels.stops.slice(0, travels.at);
      return onward(travels, kept, [{ place: here.place, cursor: travel.from }, { place: here.place, cursor: travel.to }]);
    }
    case "edit": {
      const moves = (s: Stop) => s.place.kind === "note" && s.place.id === travel.noteId && s.cursor !== null && travel.map(s.cursor) !== s.cursor;
      if (!travels.stops.some(moves)) return travels;
      return { ...travels, stops: travels.stops.map((s) => (moves(s) ? { ...s, cursor: travel.map(s.cursor!) } : s)) };
    }
  }
}

/**
 * The stop a step back (-1) or forward (1) goes to, with `at` on it, or the same travels when there
 * is nowhere to go. `here` is what is in front now, and `cursor` where the cursor is if that is a
 * note. Away from the stop the member is at, as on a page left out of the history, Back returns to
 * that stop. A stop that `canGo` refuses, as for a note gone to Trash, is stepped over, and so is
 * one that would leave everything where it is.
 */
export function stepped(travels: Travels, by: -1 | 1, here: Opened | null, cursor: number | null, canGo: (place: Opened) => boolean): Travels {
  const current = travels.stops[travels.at];
  const away = !samePlace(current?.place, here);
  const stops = away || !current ? travels.stops : travels.stops.map((s, i) => (i === travels.at ? withCursor(s, cursor) : s));
  const still = (stop: Stop) => !away && samePlace(stop.place, here) && (stop.place.kind !== "note" || stop.cursor === null || stop.cursor === cursor);
  for (let at = by < 0 && away ? travels.at : travels.at + by; at >= 0 && at < stops.length; at += by) {
    const stop = stops[at]!;
    if (canGo(stop.place) && !still(stop)) return { ...travels, stops, at };
  }
  return travels;
}

const Place = z.union([z.object({ kind: z.enum(["note", "folder"]), id: z.string() }), z.object({ kind: z.literal("page"), id: z.string(), path: z.string().regex(/^\/(?!\/)/) })]);
const Kept = z
  .object({
    stops: z.array(z.object({ place: Place, cursor: z.number().int().nonnegative().nullable() })).max(MOST_STOPS),
    at: z.number().int(),
    recent: z.array(Place).max(MOST_RECENT),
  })
  .refine((t) => (t.stops.length ? t.at >= 0 && t.at < t.stops.length : t.at === -1));

/** Travels as a browser kept them, or none when what it kept can't be used. */
export const keptTravels = (v: unknown): Travels => {
  const read = Kept.safeParse(v);
  return read.success ? read.data : NO_TRAVELS;
};
