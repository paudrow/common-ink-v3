import { shiftDay } from "../../core/events.ts";
import { newId } from "../../core/ids.ts";
import type { Calendar, CalendarEvent, Contact, ContactCard, EventWhen } from "../../core/protocol.ts";
import { SourceError, type CalendarSource, type ContactsSource, type Described } from "../../core/sources.ts";
import { connectPlain, connectionOf } from "./connections.ts";
import type { Provider } from "./index.ts";

/*
 * A calendar and contacts that come from nowhere, for this machine and for Previews, where nobody
 * has a Google account to connect. They go through everything a real data source does, so the
 * views, references and changes can be tried and tested without Google. The events are the same
 * every week, worked out from the date alone, and a change to one is kept beside the person, as is
 * an event the person adds.
 *
 * src/worker/sources/index.ts offers this only where dev sign-in is on, which production never is.
 */

export const PROVIDER = "sample";
const SOURCES = ["sample-calendar", "sample-contacts"] as const;

const SOURCE_ID = "sample-calendar";
const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
/** What the id of an event the person added starts with, which no event of the week's starts with. */
const ADDED = "new.";

const CALENDARS = {
  work: { name: "Work", color: "#3f51b5", writable: true },
  personal: { name: "Personal", color: "#0b8043", writable: true },
  holidays: { name: "Holidays", color: "#8e24aa", writable: false },
} as const satisfies Record<string, Omit<Calendar, "sourceId" | "id">>;
type CalendarKey = keyof typeof CALENDARS;

const calendarOf = (id: string): Calendar | null => (Object.hasOwn(CALENDARS, id) ? { sourceId: SOURCE_ID, id, ...CALENDARS[id as CalendarKey] } : null);
const ALL_CALENDARS = Object.keys(CALENDARS).map((id) => calendarOf(id)!);

interface Pattern {
  key: string;
  /** The days of the week it is on, Sunday 0, by the date in UTC. */
  days: readonly number[];
  title: string;
  calendar: CalendarKey;
  /** Hours into its UTC day that it starts, and how long it is. Absent for an all-day event, which has `lasts` days. */
  at?: number;
  hours?: number;
  lasts?: number;
  timeZone?: string;
  location?: string;
  recurring?: true;
}

const PATTERNS: readonly Pattern[] = [
  { key: "standup", days: [1, 2, 3, 4, 5], title: "Standup", calendar: "work", at: 14, hours: 0.25, timeZone: "America/New_York", recurring: true },
  { key: "planning", days: [1], title: "Planning", calendar: "work", at: 15, hours: 1, timeZone: "America/New_York", location: "Room 4" },
  { key: "lunch", days: [2], title: "Lunch with Sam", calendar: "personal", at: 17, hours: 1, timeZone: "America/Chicago", location: "Cafe Lula" },
  { key: "offsite", days: [3], title: "Offsite", calendar: "work", lasts: 2 },
  // Two that start under half an hour apart, side by side in a day, and two that start further apart, the later over the earlier.
  { key: "review", days: [4], title: "Design review", calendar: "work", at: 15, hours: 1.5 },
  { key: "dentist", days: [4], title: "Dentist", calendar: "personal", at: 15.25, hours: 0.75 },
  { key: "focus", days: [4], title: "Focus time", calendar: "work", at: 17, hours: 2 },
  { key: "coffee", days: [4], title: "Coffee with Ada", calendar: "personal", at: 17.75, hours: 0.5 },
  // Starts late in the UTC day and ends in the next, so the day it is on depends on where it is read.
  { key: "tokyo", days: [4], title: "Call with Tokyo", calendar: "work", at: 23.5, hours: 1, timeZone: "Asia/Tokyo" },
  { key: "holiday", days: [5], title: "Company holiday", calendar: "holidays", lasts: 1 },
];

const NOTHING_MORE = { title: null, addresses: [], birthday: null, notes: null, photo: null, urls: [] };
const CONTACTS: readonly Omit<ContactCard, "sourceId" | "url">[] = [
  { ...NOTHING_MORE, id: "ada", name: "Ada Lovelace", emails: ["ada@example.com"], phones: ["+1 555 0100"], organization: "Analytical Engines", title: "Analyst", birthday: "1815-12-10" },
  { ...NOTHING_MORE, id: "grace", name: "Grace Hopper", emails: ["grace@example.com", "hopper@navy.example"], phones: [], organization: "Navy", title: "Rear Admiral", notes: "Met at the compiler workshop." },
  {
    id: "sam",
    name: "Sam Okafor",
    emails: [],
    phones: ["+1 555 0142"],
    organization: "Okafor Plumbing",
    title: "Owner",
    addresses: ["12 Water Lane, Springfield"],
    birthday: "--04-21",
    notes: "Fixed the boiler in March. Prefers a text to a call.",
    photo: null,
    urls: ["https://okafor-plumbing.example"],
  },
  { ...NOTHING_MORE, id: "zoe", name: "Zoë Álvarez", emails: ["zoe@example.com"], phones: [], organization: null },
  { ...NOTHING_MORE, id: "lin", name: "Lin Wei", emails: ["lin@example.org"], phones: ["+86 10 5550 0199"], organization: "Harbor Books", addresses: ["3 Harbor Road, Ningbo"] },
];

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

function occurrence(pattern: Pattern, day: string): CalendarEvent {
  const start = Date.parse(`${day}T00:00:00Z`);
  const when: EventWhen = pattern.at === undefined ? { allDay: true, from: day, to: shiftDay(day, (pattern.lasts ?? 1) - 1) } : { allDay: false, from: start + pattern.at * HOUR, to: start + (pattern.at + (pattern.hours ?? 1)) * HOUR };
  const calendar = CALENDARS[pattern.calendar];
  return {
    sourceId: SOURCE_ID,
    id: `${pattern.key}.${day}`,
    calendarId: pattern.calendar,
    calendar: calendar.name,
    color: calendar.color,
    title: pattern.title,
    when,
    timeZone: pattern.timeZone ?? null,
    location: pattern.location ?? null,
    description: null,
    recurring: pattern.recurring === true,
    editable: calendar.writable,
    etag: "0",
    url: null,
  };
}

function madeBy(id: string): CalendarEvent | null {
  const [key, day] = id.split(".");
  const pattern = PATTERNS.find((p) => p.key === key);
  return pattern && day && /^\d{4}-\d{2}-\d{2}$/.test(day) && pattern.days.includes(new Date(`${day}T00:00:00Z`).getUTCDay()) ? occurrence(pattern, day) : null;
}

interface Changed {
  revision: number;
  data: string;
}

/** An event as it was made, with what the person has changed of it since. */
const changed = (event: CalendarEvent, row: Changed | undefined): CalendarEvent => (row ? { ...event, ...(JSON.parse(row.data) as Partial<CalendarEvent>), etag: String(row.revision) } : event);

/** An event by its id: one of the week's, or one the person added, whose row is all of it. */
function eventOf(id: string, row: Changed | undefined): CalendarEvent | null {
  const event = madeBy(id) ?? (id.startsWith(ADDED) && row ? (JSON.parse(row.data) as CalendarEvent) : null);
  return event && changed(event, row);
}

function calendar(db: D1Database, personId: string, info: Described): CalendarSource {
  const changes = async () =>
    new Map((await db.prepare("SELECT record_id, revision, data FROM sample_records WHERE person_id = ?").bind(personId).all<Changed & { record_id: string }>()).results.map((row) => [row.record_id, row]));
  return {
    kind: "calendar",
    info,
    async list(span) {
      const rows = await changes();
      const events: CalendarEvent[] = [];
      // A day early, for the event that starts on one day and ends in the span on the next.
      for (let time = span.from - 2 * DAY_MS; time < span.to; time += DAY_MS) {
        const day = dayOf(time);
        const weekday = new Date(time).getUTCDay();
        for (const pattern of PATTERNS) if (pattern.days.includes(weekday)) events.push(changed(occurrence(pattern, day), rows.get(`${pattern.key}.${day}`)));
      }
      for (const [id, row] of rows) if (id.startsWith(ADDED)) events.push(eventOf(id, row)!);
      const overlaps = ({ when }: CalendarEvent) => (when.allDay ? Date.parse(`${when.from}T00:00:00Z`) - DAY_MS < span.to && Date.parse(`${when.to}T00:00:00Z`) + 2 * DAY_MS > span.from : when.from < span.to && when.to >= span.from);
      return { calendars: ALL_CALENDARS, events: events.filter(overlaps) };
    },
    get: async (id) => eventOf(id, (await changes()).get(id)),
    calendar: async (id) => calendarOf(id),
    async update(id, change, etag) {
      const event = eventOf(id, (await changes()).get(id));
      if (!event) throw new SourceError("refused", "No such event");
      const data = JSON.stringify({ ...JSON.parse((await changes()).get(id)?.data ?? "{}"), ...change });
      // One statement either way, so of two changes made from the same reading exactly one is taken.
      const row = await (etag === "0"
        ? db.prepare("INSERT INTO sample_records (person_id, record_id, revision, data) VALUES (?, ?, 1, ?) ON CONFLICT (person_id, record_id) DO NOTHING RETURNING revision, data").bind(personId, id, data)
        : db.prepare("UPDATE sample_records SET revision = revision + 1, data = ?3 WHERE person_id = ?1 AND record_id = ?2 AND CAST(revision AS TEXT) = ?4 RETURNING revision, data").bind(personId, id, data, etag)
      ).first<Changed>();
      if (!row) throw new SourceError("stale", "It was changed since you opened it. Open it again, then make your change.");
      return changed(event, row);
    },
    async create(calendarId, fields) {
      const calendar = calendarOf(calendarId);
      if (!calendar?.writable) throw new SourceError("refused", "That calendar can't be added to");
      const event: CalendarEvent = {
        sourceId: SOURCE_ID,
        id: `${ADDED}${newId()}`,
        calendarId,
        calendar: calendar.name,
        color: calendar.color,
        title: fields.title,
        when: fields.when,
        timeZone: null,
        location: fields.location ?? null,
        description: fields.description ?? null,
        recurring: false,
        editable: true,
        etag: "1",
        url: null,
      };
      await db.prepare("INSERT INTO sample_records (person_id, record_id, revision, data) VALUES (?, ?, 1, ?)").bind(personId, event.id, JSON.stringify(event)).run();
      return event;
    },
  };
}

function contacts(info: Described): ContactsSource {
  const all: ContactCard[] = CONTACTS.map((contact) => ({ ...contact, sourceId: "sample-contacts", url: null }));
  // A listing holds what a contact is found by, as a source's listing does; the rest is read one contact at a time.
  const listed = all.map(({ sourceId, id, name, emails, phones, organization, url }): Contact => ({ sourceId, id, name, emails, phones, organization, url }));
  return { kind: "contacts", info, list: async () => ({ contacts: listed, more: false }), get: async (id) => all.find((c) => c.id === id) ?? null };
}

export function sample(db: D1Database, now: () => number): Provider {
  return {
    owns: (id) => (SOURCES as readonly string[]).includes(id),
    async of(personId) {
      const connection = await connectionOf(db, personId, PROVIDER);
      const info = (id: (typeof SOURCES)[number], name: string): Described => ({ id, name, provider: "Sample data", state: connection ? "connected" : "not_connected", account: connection?.account ?? null });
      return [calendar(db, personId, info(SOURCE_ID, "Sample calendar")), contacts(info("sample-contacts", "Sample contacts"))];
    },
    async connect(personId) {
      await connectPlain(db, personId, PROVIDER, "Sample data", now());
      return { redirect: null };
    },
    async disconnect(personId) {
      await db.batch([db.prepare("DELETE FROM sample_records WHERE person_id = ?").bind(personId), db.prepare("DELETE FROM source_connections WHERE person_id = ? AND provider = ?").bind(personId, PROVIDER)]);
    },
  };
}
