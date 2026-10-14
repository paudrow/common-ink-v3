import { inOrder, widened, within, type Span } from "./events.ts";
import { dayIn } from "./history.ts";
import { newId } from "./ids.ts";
import { OpError, type Calendar, type CalendarEvent, type Contact, type ContactCard, type EventWhen, type Reference, type Source, type SourceKind, type SourceRecord } from "./protocol.ts";

/*
 * A data source is one person's: their calendar, their contacts. The core never reaches one itself.
 * It is handed `Sources`, which answers for one person at a time, and every function here asks it
 * for the person performing the operation and for nobody else. No operation takes a person, so
 * there is no way to ask for another's: not as an admin, and not as someone else's agent.
 */

/** What a data source says of itself. Whether it takes changes isn't said: it does when it has `update`, and one that does has `create` too. */
export type Described = Omit<Source, "writable" | "kind">;

export interface EventChange {
  title?: string;
  location?: string;
  description?: string;
  when?: EventWhen;
}

export interface NewEvent {
  title: string;
  when: EventWhen;
  location?: string;
  description?: string;
}

export interface CalendarSource {
  kind: "calendar";
  info: Described;
  /** Its calendars, and every event in them that overlaps the span, each occurrence of a recurring one on its own. */
  list(span: { from: number; to: number }): Promise<{ calendars: Calendar[]; events: CalendarEvent[] }>;
  get(id: string): Promise<CalendarEvent | null>;
  /** One of its calendars by its id, or null for one the person doesn't have. */
  calendar(id: string): Promise<Calendar | null>;
  /** Absent on a read-only data source. `etag` is the event's as the member read it. */
  update?(id: string, change: EventChange, etag: string): Promise<CalendarEvent>;
  /** Absent on a read-only data source. */
  create?(calendarId: string, fields: NewEvent): Promise<CalendarEvent>;
}

export interface ContactsSource {
  kind: "contacts";
  info: Described;
  list(): Promise<{ contacts: Contact[]; more: boolean }>;
  /** One contact with all the source holds of them. */
  get(id: string): Promise<ContactCard | null>;
}

export type DataSource = CalendarSource | ContactsSource;

/** Where data sources come from. Each call answers for one person, from what that person connected. */
export interface Sources {
  of(personId: string): Promise<DataSource[]>;
  /** Connects one, or says where the person's browser goes to agree to it. `back` is where they return to. */
  connect(personId: string, sourceId: string, back: string): Promise<{ redirect: string | null }>;
  disconnect(personId: string, sourceId: string): Promise<void>;
}

export const NO_SOURCES: Sources = { of: async () => [], connect: async () => ({ redirect: null }), disconnect: async () => {} };

/**
 * Why a data source didn't do what it was asked. `needs_reconnect`: it no longer answers for the
 * person. `stale`: the record changed since it was read. `refused`: it won't allow this. `busy`: it
 * didn't answer, or said to ask later.
 */
export type SourceFailure = "needs_reconnect" | "stale" | "refused" | "busy";

export class SourceError extends Error {
  constructor(
    readonly failure: SourceFailure,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** As much as one read of a calendar covers: a year and a month, so a year's view with its edges fits. */
export const MAX_SPAN_DAYS = 400;
const MAX_SPAN_MS = MAX_SPAN_DAYS * 86_400_000;

const NO_SUCH_SOURCE = "No such data source";
const NO_SUCH_RECORD = "No such record";

/** What a reference is written as, by the kind of data source its record is in. */
const RECORD = { calendar: "event", contacts: "contact" } as const satisfies Record<SourceKind, SourceRecord["kind"]>;

interface Asker {
  db: D1Database;
  sources: Sources;
  /** The person asking, or the person an agent asks for. */
  personId: string;
  now: number;
}

const describe = (source: DataSource, state = source.info.state): Source => ({ ...source.info, state, kind: source.kind, writable: source.kind === "calendar" && source.update !== undefined });

const reconnect = (source: DataSource) => new OpError("conflict", `Reconnect ${source.info.name} first`);

/** What went wrong outside, as an operation says it. */
function failed(source: DataSource, err: unknown): never {
  if (!(err instanceof SourceError)) throw err;
  if (err.failure === "needs_reconnect") throw reconnect(source);
  if (err.failure === "stale") throw new OpError("conflict", err.message);
  if (err.failure === "refused") throw new OpError("forbidden", err.message);
  throw new OpError("unavailable", err.message);
}

async function sourceOf<K extends SourceKind>(asker: Asker, sourceId: string, kind?: K): Promise<Extract<DataSource, { kind: K }>> {
  const source = (await asker.sources.of(asker.personId)).find((s) => s.info.id === sourceId && (kind === undefined || s.kind === kind));
  if (!source) throw new OpError("not_found", NO_SUCH_SOURCE);
  if (source.info.state !== "connected") throw reconnect(source);
  return source as Extract<DataSource, { kind: K }>;
}

export const listSources = async (asker: Asker): Promise<Source[]> => (await asker.sources.of(asker.personId)).map((source) => describe(source));

/**
 * Asks each connected data source of a kind, together. One that no longer answers for the person is
 * said to need reconnecting and the rest are still read. One that is busy fails the whole read:
 * half an answer would read as a day with nothing in it.
 */
async function readEach<S extends DataSource, T>(asker: Asker, kind: S["kind"], read: (source: S) => Promise<T>): Promise<{ sources: Source[]; read: T[] }> {
  const sources = (await asker.sources.of(asker.personId)).filter((s): s is S => s.kind === kind);
  const answers = await Promise.all(
    sources.map(async (source) => {
      if (source.info.state !== "connected") return { source: describe(source), read: null };
      try {
        return { source: describe(source), read: await read(source) };
      } catch (err) {
        if (err instanceof SourceError && err.failure === "needs_reconnect") return { source: describe(source, "needs_reconnect"), read: null };
        return failed(source, err);
      }
    }),
  );
  return { sources: answers.map((a) => a.source), read: answers.flatMap((a) => (a.read === null ? [] : [a.read])) };
}

export async function listEvents(asker: Asker, span: Span): Promise<{ events: CalendarEvent[]; sources: Source[]; calendars: Calendar[] }> {
  if (span.to <= span.from) throw new OpError("invalid", "The span ends before it starts");
  if (span.to - span.from > MAX_SPAN_MS) throw new OpError("invalid", `A span can be at most ${MAX_SPAN_DAYS} days`);
  try {
    dayIn(span.timeZone);
  } catch {
    throw new OpError("invalid", `"${span.timeZone}" isn't a time zone`);
  }
  const { sources, read } = await readEach<CalendarSource, { calendars: Calendar[]; events: CalendarEvent[] }>(asker, "calendar", (source) => source.list(widened(span)));
  const writable = new Set(sources.filter((s) => s.writable).map((s) => s.id));
  const events = read.flatMap((r) => r.events).filter((event) => within(event.when, span));
  return {
    events: inOrder(events, span.timeZone).map((event) => ({ ...event, editable: event.editable && writable.has(event.sourceId) })),
    sources,
    calendars: read.flatMap((r) => r.calendars).map((calendar) => ({ ...calendar, writable: calendar.writable && writable.has(calendar.sourceId) })),
  };
}

/**
 * Changes an event where it is kept. Whether it may be changed is decided here, from the event as
 * it is now: a read-only data source and an event the person can only read are both refused before
 * anything is sent.
 */
export async function updateEvent(asker: Asker, sourceId: string, id: string, etag: string, change: EventChange): Promise<CalendarEvent> {
  const source = await sourceOf(asker, sourceId, "calendar");
  if (!source.update) throw new OpError("forbidden", `${source.info.name} is read-only`);
  try {
    const event = await source.get(id);
    if (!event) throw new OpError("not_found", "No such event");
    if (!event.editable) throw new OpError("forbidden", `You can only read the calendar "${event.calendar}"`);
    if (change.title === undefined && change.location === undefined && change.description === undefined && change.when === undefined) return event;
    return await source.update(id, change, etag);
  } catch (err) {
    if (err instanceof OpError) throw err;
    return failed(source, err);
  }
}

/**
 * Adds an event to one of the person's calendars where it is kept. As with a change, whether it may
 * be added is decided here, from the calendar as it is now, before anything is sent.
 */
export async function createEvent(asker: Asker, sourceId: string, calendarId: string, fields: NewEvent): Promise<CalendarEvent> {
  const source = await sourceOf(asker, sourceId, "calendar");
  if (!source.create) throw new OpError("forbidden", `${source.info.name} is read-only`);
  try {
    const calendar = await source.calendar(calendarId);
    if (!calendar) throw new OpError("not_found", "No such calendar");
    if (!calendar.writable) throw new OpError("forbidden", `You can only read the calendar "${calendar.name}"`);
    return await source.create(calendarId, fields);
  } catch (err) {
    if (err instanceof OpError) throw err;
    return failed(source, err);
  }
}

const words = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether every word asked for starts a word of the contact's name, emails or organization. */
export function contactMatches(contact: Contact, query: string): boolean {
  const has = words([contact.name, ...contact.emails, contact.organization ?? ""].join(" "));
  return words(query).every((word) => has.some((w) => w.startsWith(word)));
}

export async function listContacts(asker: Asker, query: string | undefined): Promise<{ contacts: Contact[]; sources: Source[]; more: boolean }> {
  const { sources, read } = await readEach<ContactsSource, { contacts: Contact[]; more: boolean }>(asker, "contacts", (source) => source.list());
  const contacts = read.flatMap((r) => r.contacts).filter((contact) => !query || contactMatches(contact, query));
  contacts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : 1));
  return { contacts, sources, more: read.some((r) => r.more) };
}

/** The asker's own contacts that `is` says are someone, each with all its source holds. A source that can't be read gives none. */
export async function contactCards(asker: Asker, is: (contact: Contact) => boolean): Promise<ContactCard[]> {
  const { read } = await readEach<ContactsSource, ContactCard[]>(asker, "contacts", async (source) => {
    const { contacts } = await source.list();
    return (await Promise.all(contacts.filter(is).map((contact) => source.get(contact.id)))).filter((card) => card !== null);
  });
  return read.flat();
}

/**
 * What a note may hold of a record: its reference, and words its owner is content for every reader of the note to see.
 * An event's title can be someone else's, who invited the member: it writes no embed, link or code into the note.
 */
const labelled = (label: string) => label.replace(/[{}[\]`\s]+/g, " ").replace(/ +/g, " ").trim().slice(0, 200);

/** A reference as a note writes it: an embed whose config is the reference, then the label. */
export const writtenReference = (kind: SourceRecord["kind"], ref: string, label: string) => `::${kind}{${[ref, labelled(label)].filter(Boolean).join(" ")}}`;

async function recordOf(source: DataSource, ref: string, id: string): Promise<SourceRecord | null> {
  if (source.kind === "calendar") {
    const event = await source.get(id);
    return event && { kind: "event", ref, event: { ...event, editable: event.editable && source.update !== undefined } };
  }
  const contact = await source.get(id);
  return contact && { kind: "contact", ref, contact };
}

/**
 * The reference a person's note writes for one of their records. The reference is kept beside the
 * person, so it leads to the record for them and to nothing for anyone else who reads the note.
 */
export async function refer(asker: Asker, sourceId: string, id: string): Promise<Reference> {
  const source = await sourceOf(asker, sourceId);
  let record: SourceRecord | null;
  try {
    record = await recordOf(source, "", id);
  } catch (err) {
    return failed(source, err);
  }
  if (!record) throw new OpError("not_found", NO_SUCH_RECORD);
  const row = await asker.db
    .prepare(
      `INSERT INTO source_refs (id, person_id, data_source, record_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (person_id, data_source, record_id) DO UPDATE SET record_id = excluded.record_id RETURNING id`,
    )
    .bind(newId(), asker.personId, sourceId, id, asker.now)
    .first<{ id: string }>();
  const label = record.kind === "event" ? record.event.title : record.contact.name;
  return { ref: row!.id, kind: RECORD[source.kind], text: writtenReference(RECORD[source.kind], row!.id, label) };
}

/** The record a reference stands for, read where it is kept. Someone else's reference is no reference. */
export async function readRecord(asker: Asker, ref: string): Promise<SourceRecord> {
  const row = await asker.db.prepare("SELECT data_source, record_id FROM source_refs WHERE id = ? AND person_id = ?").bind(ref, asker.personId).first<{ data_source: string; record_id: string }>();
  if (!row) throw new OpError("not_found", NO_SUCH_RECORD);
  const source = await sourceOf(asker, row.data_source).catch((err: unknown) => {
    // A data source that is no longer offered here leaves its references leading nowhere, as a record deleted from it does.
    throw err instanceof OpError && err.code === "not_found" ? new OpError("not_found", NO_SUCH_RECORD) : err;
  });
  try {
    const record = await recordOf(source, ref, row.record_id);
    if (!record) throw new OpError("not_found", NO_SUCH_RECORD);
    return record;
  } catch (err) {
    if (err instanceof OpError) throw err;
    return failed(source, err);
  }
}
