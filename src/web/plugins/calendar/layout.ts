import type { CalendarEvent, EventWhen } from "../../plugin-api.ts";
import { daysBetween, minutesIn, shiftDay, startOfDay, type Day } from "./dates.ts";

/** Pixels an hour is tall in the Week and Day grids. */
export const HOUR_PX = 48;
export const DAY_MINUTES = 24 * 60;
/** Minutes apart two overlapping events start before the later one sits on top of the earlier rather than beside it. */
export const NEST = 30;
/** The least an event is drawn and compared as, so a moment still has room for its title. */
export const LEAST = 15;

const DAY_MS = 86_400_000;

/** Whether an event goes in the all-day row above the grid: an all-day one, and one a day long or more. */
export const inAllDayRow = (when: EventWhen) => when.allDay || when.to - when.from >= DAY_MS;

/** An event's piece of one day, in minutes from that day's midnight on the member's clock. */
export interface Piece<T> {
  item: T;
  top: number;
  bottom: number;
  /** It started on an earlier day, or goes on into a later one. */
  before: boolean;
  after: boolean;
}

/** A piece where it is drawn: in `lane` of `lanes`, widened over `span` lanes, and `indent` steps in from the lane's edge when it sits on another. */
export interface Placed<T> extends Piece<T> {
  lane: number;
  lanes: number;
  span: number;
  indent: number;
}

/** The pieces of `day` that timed events shorter than a day cover, clipped at its midnights, soonest first and longest first. */
export function piecesOf<T extends Pick<CalendarEvent, "when">>(events: readonly T[], day: Day, timeZone: string): Piece<T>[] {
  const from = startOfDay(day, timeZone);
  const to = startOfDay(shiftDay(day, 1), timeZone);
  const pieces: Piece<T>[] = [];
  for (const item of events) {
    const { when } = item;
    if (inAllDayRow(when) || when.allDay) continue;
    const touches = when.from < to && (when.to > from || when.from >= from);
    if (!touches) continue;
    const top = when.from <= from ? 0 : minutesIn(when.from, timeZone);
    const bottom = when.to >= to ? DAY_MINUTES : Math.max(top, minutesIn(when.to, timeZone));
    pieces.push({ item, top, bottom, before: when.from < from, after: when.to > to });
  }
  return pieces.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
}

const drawnEnd = (piece: { top: number; bottom: number }) => Math.max(piece.bottom, piece.top + LEAST);

/**
 * One day's pieces laid out as v1 laid them out. Pieces that start under NEST minutes apart sit side
 * by side, each in the first free lane; one that starts later, inside another, sits on top of it a
 * step indented, so both titles show and neither gets thin. Pieces that overlap, directly or through a
 * chain, share one set of lanes, and each widens into the lanes to its right that nothing overlapping it uses.
 */
export function layoutDay<T>(pieces: readonly Piece<T>[]): Placed<T>[] {
  const placed: Placed<T>[] = [...pieces].sort((a, b) => a.top - b.top || b.bottom - a.bottom).map((piece) => ({ ...piece, lane: 0, lanes: 1, span: 1, indent: 0 }));
  const overlap = (a: Placed<T>, b: Placed<T>) => a.top < drawnEnd(b) && b.top < drawnEnd(a);
  let cluster: Placed<T>[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(0, ...cluster.map((p) => p.lane)) + 1;
    for (const p of cluster) {
      p.lanes = lanes;
      let next = p.lane + 1;
      while (next < lanes && !cluster.some((o) => o.lane === next && overlap(o, p))) next++;
      p.span = next - p.lane;
    }
    cluster = [];
  };
  for (const piece of placed) {
    if (piece.top >= clusterEnd) close();
    const on = cluster.filter((p) => drawnEnd(p) > piece.top);
    const taken = on.filter((p) => piece.top - p.top < NEST).map((p) => p.lane);
    let lane = 0;
    while (taken.includes(lane)) lane++;
    piece.lane = lane;
    piece.indent = Math.max(-1, ...on.filter((p) => p.lane === lane).map((p) => p.indent)) + 1;
    cluster.push(piece);
    clusterEnd = Math.max(clusterEnd, drawnEnd(piece));
  }
  close();
  return placed;
}

/** An all-day row item as a bar across the days on show: the first and last of them it covers, its row, and whether it goes on past either end. */
export interface Bar<T> {
  item: T;
  from: number;
  to: number;
  row: number;
  before: boolean;
  after: boolean;
}

/** The days an all-day row item covers, as dates: an all-day event's own, and the days a long timed one touches on the member's clock. */
function datesOf(when: EventWhen, timeZone: string, days: readonly Day[]): Day[] {
  if (when.allDay) return days.filter((day) => day >= when.from && day <= when.to);
  return days.filter((day) => when.from < startOfDay(shiftDay(day, 1), timeZone) && when.to > startOfDay(day, timeZone));
}

/** The all-day row for `days`, which follow one another: each item as a bar, stacked so no two in a row overlap. */
export function bars<T extends Pick<CalendarEvent, "when">>(items: readonly T[], days: readonly Day[], timeZone: string): Bar<T>[] {
  if (!days.length) return [];
  const out: Bar<T>[] = [];
  const rows: number[] = [];
  const first = days[0]!;
  const sorted = items.filter((item) => inAllDayRow(item.when)).sort((a, b) => startOf(a.when, timeZone) - startOf(b.when, timeZone) || endOf(b.when, timeZone) - endOf(a.when, timeZone));
  for (const item of sorted) {
    const covered = datesOf(item.when, timeZone, days);
    if (!covered.length) continue;
    const [from, to] = [daysBetween(first, covered[0]!), daysBetween(first, covered.at(-1)!)];
    let row = rows.findIndex((last) => last < from);
    if (row < 0) row = rows.length;
    rows[row] = to;
    const { when } = item;
    const before = when.allDay ? when.from < covered[0]! : when.from < startOfDay(covered[0]!, timeZone);
    const after = when.allDay ? when.to > covered.at(-1)! : when.to > startOfDay(shiftDay(covered.at(-1)!, 1), timeZone);
    out.push({ item, from, to, row, before, after });
  }
  return out;
}

const startOf = (when: EventWhen, timeZone: string) => (when.allDay ? startOfDay(when.from, timeZone) : when.from);
const endOf = (when: EventWhen, timeZone: string) => (when.allDay ? startOfDay(shiftDay(when.to, 1), timeZone) : when.to);

/**
 * Where the grid opens scrolled to, in minutes: half an hour above the earlier of 8:00 and the first
 * event, unless now is on show and would be below the fold, when now sits a third of the way down.
 */
export function openingMinutes(firstEvent: number | null, now: number | null, shownMinutes: number): number {
  const top = Math.min(8 * 60, firstEvent ?? Infinity) - 30;
  const wanted = now !== null && now > top + shownMinutes ? now - shownMinutes / 3 : top;
  return Math.max(0, Math.min(16 * 60, wanted));
}
