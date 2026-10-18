import type { Author, CalendarEvent, HistoryEntry, NoteSummary } from "../../plugin-api.ts";
import { dayIn, shiftDay, startOfDay } from "../calendar/dates.ts";

/**
 * The member's day: its date where they are, and the instants it runs between there. Everything the
 * dashboard calls today is read from one of these, so a note edited at 11 pm in Auckland is today's
 * there though the date in UTC is still yesterday's.
 */
export interface Today {
  day: string;
  from: number;
  to: number;
  timeZone: string;
}

export function todayAt(now: number, timeZone: string): Today {
  const day = dayIn(now, timeZone);
  return { day, from: startOfDay(day, timeZone), to: startOfDay(shiftDay(day, 1), timeZone), timeZone };
}

const during = (time: number, today: Today) => time >= today.from && time < today.to;

export interface Ahead {
  event: CalendarEvent;
  /** Whether it has started: an all-day event has, and so has one the member is in the middle of. */
  started: boolean;
}

/**
 * The events still ahead today: every all-day event on the member's date, and each other event of
 * the day that hasn't ended. One that ended a minute ago is not ahead. They stay in the order listed.
 */
export function aheadToday(events: readonly CalendarEvent[], today: Today, now: number): Ahead[] {
  return events.flatMap((event) => {
    const { when } = event;
    if (when.allDay) return when.from <= today.day && when.to >= today.day ? [{ event, started: true }] : [];
    return when.from < today.to && when.to > now ? [{ event, started: when.from <= now }] : [];
  });
}

export interface TodaysNote {
  note: NoteSummary;
  /** Whether it was made today, and not only edited. */
  made: boolean;
}

/** The live notes made or edited on the member's day, latest edit first, without `except`, their daily note, which is shown on its own. */
export function editedToday(notes: readonly NoteSummary[], today: Today, except: string | null = null): TodaysNote[] {
  return notes
    .filter((note) => note.state === "live" && note.id !== except && (during(note.updatedAt, today) || during(note.createdAt, today)))
    .toSorted((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    .map((note) => ({ note, made: during(note.createdAt, today) }));
}

export interface ChangedNote {
  noteId: string;
  title: string;
  changes: number;
  /** When the latest of them was made. */
  latest: number;
  /** Who made them, whoever changed it latest first, each with how many were theirs. */
  authors: { key: string; author: Author; changes: number }[];
}

export const authorKey = (author: Author) => (author.kind === "agent" ? `agent:${author.agentId}` : author.kind === "plugin" ? `plugin:${author.pluginId}` : `member:${author.personId}`);

/** Changes as `history.list` answers them, newest first, summed up by note and by who made them. The note changed latest comes first. */
export function summarize(changes: readonly HistoryEntry[]): ChangedNote[] {
  const notes = new Map<string, ChangedNote>();
  for (const change of changes) {
    let note = notes.get(change.noteId);
    if (!note) notes.set(change.noteId, (note = { noteId: change.noteId, title: change.noteTitle, changes: 0, latest: change.createdAt, authors: [] }));
    note.changes++;
    const key = authorKey(change.author);
    const by = note.authors.find((a) => a.key === key);
    if (by) by.changes++;
    else note.authors.push({ key, author: change.author, changes: 1 });
  }
  return [...notes.values()];
}

/** How far back the summary reaches for a member who has never marked it read. */
export const FIRST_SUMMARY_MS = 7 * 86_400_000;

/**
 * What says the todos may have changed: the live notes that have an open todo, each at its revision.
 * Typing in a note with no todo in it changes nothing here.
 */
export const todoStamp = (notes: readonly NoteSummary[]) =>
  notes
    .filter((n) => n.state === "live" && n.openTodos > 0)
    .map((n) => `${n.id}:${n.revision}`)
    .sort()
    .join(",");

/** Which notes the member can see and the state of each, which is what a pin or a daily note being there turns on. No edit to a note changes it. */
export const membersStamp = (notes: readonly NoteSummary[]) =>
  notes
    .map((n) => `${n.id}:${n.state}`)
    .sort()
    .join(",");

/** The notes last changed by someone other than the member, each at its revision: where a change the summary doesn't have yet would show. */
export function othersMarks(notes: readonly NoteSummary[], me: string): ReadonlyMap<string, number> {
  return new Map(notes.filter((n) => !(n.updatedBy.kind === "member" && n.updatedBy.personId === me)).map((n) => [n.id, n.revision]));
}

/** Whether `after` has a note `before` lacks, or one further along: someone else changed something. A note the member changed last drops out, which is nothing new. */
export const rose = (before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>) => [...after].some(([id, revision]) => (before.get(id) ?? -1) < revision);
