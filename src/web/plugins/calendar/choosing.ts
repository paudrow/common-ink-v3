import type { Calendar } from "../../plugin-api.ts";
import { calendarKey } from "./listing.ts";

/** Where the form remembers, in this browser, the calendar last added to. */
export const LAST = "calendarTarget";

/**
 * Which calendar a new event starts in, and why: the member's default (`calendar.default`) while they
 * may add to it here, and otherwise the one they added to last in this browser, and otherwise the
 * first. `lost` is a default set that can't be used, and why. The server chooses for an agent the
 * same way, but keeps no calendar used last (`defaultCalendar` in src/core/sources.ts).
 */
export type Start = {
  calendar: Calendar;
  by: "default" | "last" | "first";
  lost: Lost | null;
} | null;

/** A default the member set that a new event can't go in: one hidden on the Calendar page, one they can only read, or one no longer connected. */
export type Lost = { why: "hidden" | "read-only"; name: string } | { why: "gone" };

/** `targets` are the calendars a new event may go in here: writable and shown. `all` is every calendar listed, to name a default that isn't among them. */
export function startOf(targets: readonly Calendar[], all: readonly Calendar[], chosen: string, last: unknown): Start {
  const byKey = (key: unknown) => targets.find((c) => calendarKey(c) === key);
  const first = targets[0];
  if (!first) return null;
  const chosenOne = chosen ? byKey(chosen) : undefined;
  if (chosenOne) return { calendar: chosenOne, by: "default", lost: null };
  const listed = all.find((c) => calendarKey(c) === chosen);
  const lost: Lost | null = !chosen ? null : !listed ? { why: "gone" } : { why: listed.writable ? "hidden" : "read-only", name: listed.name };
  const lastOne = byKey(last);
  return lastOne ? { calendar: lastOne, by: "last", lost } : { calendar: first, by: "first", lost };
}

/** What the form and the Calendars dialog say of where a new event goes, when it is not the default. */
export function startWords(start: Start): string {
  if (!start) return "";
  if (start.by === "default") return "Your default calendar.";
  const instead = start.by === "last" ? `${start.calendar.name}, the calendar you added to last` : `${start.calendar.name}, the first calendar you can add to`;
  if (!start.lost) return `No default calendar is set, so new events start in ${instead}.`;
  const lost = start.lost;
  const why = lost.why === "gone" ? "Your default calendar is no longer connected" : lost.why === "hidden" ? `Your default calendar, ${lost.name}, is hidden` : `Your default calendar, ${lost.name}, can only be read`;
  return `${why}, so new events start in ${instead}.`;
}
