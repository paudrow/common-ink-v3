import { inOrder, widened, within, type Span } from "./events.ts";
import { dayIn } from "./history.ts";
import { newId } from "./ids.ts";
import { OpError, type Calendar, type CalendarEvent, type Contact, type ContactCard, type ContactChange, type EventWhen, type MailSender, type MailThread, type MailThreadRead, type Reference, type Source, type SourceKind, type SourceRecord } from "./protocol.ts";

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

/** How a contacts data source that takes changes makes them. Each answers the contact as it is kept after. */
export interface ContactChanges {
  /** `etag` is the contact's as the member read it. */
  update(id: string, change: ContactChange, etag: string): Promise<ContactCard>;
  /** A JPEG or PNG in base64, or null to take the contact's own picture off. */
  photo(id: string, photo: string | null): Promise<ContactCard>;
  create(fields: ContactChange & { name: string }): Promise<ContactCard>;
}

export interface ContactsSource {
  kind: "contacts";
  info: Described;
  list(): Promise<{ contacts: Contact[]; more: boolean }>;
  /** One contact with all the source holds of them. */
  get(id: string): Promise<ContactCard | null>;
  /** Absent on a read-only data source. */
  changes?: ContactChanges;
}

/**
 * The mail a person sent, copied or forwarded to `address`, kept for them. It is read-only: nothing
 * here changes a message, and nothing is sent anywhere. Its senders are the addresses it recognizes
 * the person by, which are theirs to add and remove whether or not it is connected.
 */
export interface MailSource {
  kind: "email";
  info: Described;
  /** Where mail is sent to be kept, such as notes@in.commonink.app. */
  address: string;
  list(ask: { query?: string | undefined; before?: number | undefined; limit: number }): Promise<{ threads: MailThread[]; more: boolean }>;
  /** The thread an id names: a thread's, or one of its messages'. */
  thread(id: string): Promise<MailThreadRead | null>;
  /** Whether an id is one message's, which a reference then points at within its thread. */
  isMessage(id: string): Promise<boolean>;
  senders: {
    list(): Promise<MailSender[]>;
    /** Answers the code mail from the address carries to verify it. */
    add(address: string): Promise<string>;
    remove(address: string): Promise<void>;
  };
}

export type DataSource = CalendarSource | ContactsSource | MailSource;

/** Where data sources come from. Each call answers for one person, from what that person connected. */
export interface Sources {
  of(personId: string): Promise<DataSource[]>;
  /** Connects one, or says where the person's browser goes to agree to it. `back` is where they return to. `edit` asks to change it too. */
  connect(personId: string, sourceId: string, back: string, edit?: boolean): Promise<{ redirect: string | null }>;
  disconnect(personId: string, sourceId: string): Promise<void>;
  /**
   * For deleting an account, which deletes its connections with everything else: reads, while they
   * are still here, what telling each provider to end them takes, and answers what tells them. That
   * is called only once the deletion went through, so an account that stays keeps its own.
   */
  ending(personId: string): Promise<() => Promise<void>>;
}

export const NO_SOURCES: Sources = { of: async () => [], connect: async () => ({ redirect: null }), disconnect: async () => {}, ending: async () => async () => {} };

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
const RECORD = { calendar: "event", contacts: "contact", email: "email" } as const satisfies Record<SourceKind, SourceRecord["kind"]>;

interface Asker {
  db: D1Database;
  sources: Sources;
  /** The person asking, or the person an agent asks for. */
  personId: string;
  now: number;
}

const describe = (source: DataSource, state = source.info.state): Source => ({ ...source.info, state, kind: source.kind, writable: (source.kind === "calendar" ? source.update : source.kind === "contacts" ? source.changes : undefined) !== undefined });

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

/**
 * The Calendar plugin's settings the server reads, by their keys in the member's settings: the plugin
 * declares them, and each names a calendar by `calendarKey`.
 */
export const CALENDAR_SETTINGS = { default: "calendar.default", hidden: "calendar.hidden" } as const;

/** How a setting names a calendar: its data source and its id, with a space between. */
export const calendarKey = (calendar: Pick<Calendar, "sourceId" | "id">) => `${calendar.sourceId} ${calendar.id}`;

export interface CalendarSettings {
  /** The `calendarKey` of the member's default calendar, or null for none. */
  default: string | null;
  /** The `calendarKey`s of the calendars the member hid on the Calendar page. */
  hidden: ReadonlySet<string>;
}

/** What a member's settings, as they wrote them, say of their calendars. Anything they got wrong reads as unset. */
export function calendarSettings(text: string | null | undefined): CalendarSettings {
  let written: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(text ?? "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) written = value as Record<string, unknown>;
  } catch {
    // Settings that can't be read are the defaults, as they are in the app.
  }
  const chosen = written[CALENDAR_SETTINGS.default];
  const hidden = written[CALENDAR_SETTINGS.hidden];
  return { default: typeof chosen === "string" && chosen ? chosen : null, hidden: new Set(Array.isArray(hidden) ? hidden.filter((k): k is string => typeof k === "string") : []) };
}

/**
 * Where a new event goes when nobody names a calendar: the member's default while they may add to it and haven't hidden it, as on the Calendar page;
 * otherwise the first calendar they may add to that they haven't hidden, and otherwise the first they
 * may add to. Null when they may add to none. The server keeps no calendar used last, which the
 * Calendar page falls back to in its browser before the first.
 */
export function defaultCalendar(calendars: readonly Calendar[], settings: CalendarSettings): Calendar | null {
  const writable = calendars.filter((c) => c.writable);
  return writable.find((c) => calendarKey(c) === settings.default && !settings.hidden.has(calendarKey(c))) ?? writable.find((c) => !settings.hidden.has(calendarKey(c))) ?? writable[0] ?? null;
}

/**
 * The calendar `event.create` adds to: the one it names, or with none named, the member's default as
 * `defaultCalendar` chooses it from the calendars they have now. `settings` is read only then.
 */
export async function calendarFor(asker: Asker, named: { sourceId?: string | undefined; calendarId?: string | undefined }, settings: () => Promise<CalendarSettings>): Promise<{ sourceId: string; calendarId: string }> {
  const { sourceId, calendarId } = named;
  if (sourceId !== undefined && calendarId !== undefined) return { sourceId, calendarId };
  if (sourceId !== undefined || calendarId !== undefined) throw new OpError("invalid", "Name the calendar by both sourceId and calendarId, or by neither for the member's default calendar");
  const { read } = await readEach<CalendarSource, Calendar[]>(asker, "calendar", async (source) => {
    const { calendars } = await source.list({ from: asker.now, to: asker.now + 1 });
    return source.create ? calendars : calendars.map((c) => ({ ...c, writable: false }));
  });
  const mine = await settings();
  const calendars = read.flat();
  // A default whose data source couldn't be read now is not gone: the event waits for it rather than going in another calendar.
  const defaultSource = mine.default?.slice(0, mine.default.indexOf(" "));
  if (defaultSource && (await asker.sources.of(asker.personId)).some((s) => s.info.id === defaultSource && s.info.state === "connected") && !calendars.some((c) => c.sourceId === defaultSource))
    throw new OpError("conflict", "The member's default calendar can't be reached now. Try again, or name the calendar");
  const chosen = defaultCalendar(calendars, mine);
  if (!chosen) throw new OpError("conflict", "There is no calendar to add it to: connect a calendar that can be added to on the Calendar page first");
  return { sourceId: chosen.sourceId, calendarId: chosen.id };
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
  const has = words([contact.name, ...contact.emails.map((e) => e.value), contact.organization ?? ""].join(" "));
  return words(query).every((word) => has.some((w) => w.startsWith(word)));
}

export async function listContacts(asker: Asker, query: string | undefined): Promise<{ contacts: Contact[]; sources: Source[]; more: boolean }> {
  const { sources, read } = await readEach<ContactsSource, { contacts: Contact[]; more: boolean }>(asker, "contacts", (source) => source.list());
  const contacts = read.flatMap((r) => r.contacts).filter((contact) => !query || contactMatches(contact, query));
  contacts.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : 1));
  return { contacts, sources, more: read.some((r) => r.more) };
}

/** A contacts data source's way to change them, or why there is none: read-only, or agreed to for reading alone. */
function changesOf(source: ContactsSource): ContactChanges {
  if (source.changes) return source.changes;
  throw new OpError("forbidden", source.info.reconnectToWrite ? `Connect ${source.info.name} again to edit contacts` : `${source.info.name} is read-only`);
}

/** Runs a change on a contacts data source, saying what went wrong outside as an operation says it. */
async function changing(source: ContactsSource, change: () => Promise<ContactCard>): Promise<ContactCard> {
  try {
    return await change();
  } catch (err) {
    if (err instanceof OpError) throw err;
    return failed(source, err);
  }
}

/** One of the asker's contacts, where it is kept and as it is now, before anything is sent to change it. */
const contactOf = (source: ContactsSource, id: string) =>
  changing(source, async () => {
    const card = await source.get(id);
    if (!card) throw new OpError("not_found", "No such contact");
    return card;
  });

/**
 * Changes one of the asker's contacts where it is kept. Whether it may be changed is decided here,
 * from the data source as it is now: a read-only one is refused before anything is sent.
 */
export async function updateContact(asker: Asker, sourceId: string, id: string, etag: string, change: ContactChange): Promise<ContactCard> {
  const source = await sourceOf(asker, sourceId, "contacts");
  const changes = changesOf(source);
  const card = await contactOf(source, id);
  if (Object.values(change).every((value) => value === undefined)) {
    if (card.etag !== etag) throw new OpError("conflict", "It was changed since you opened it. Open it again, then make your change.");
    return card;
  }
  return changing(source, () => changes.update(id, change, etag));
}

/** Puts a picture on one of the asker's contacts, or takes theirs off. */
export async function photoContact(asker: Asker, sourceId: string, id: string, photo: string | null): Promise<ContactCard> {
  const source = await sourceOf(asker, sourceId, "contacts");
  const changes = changesOf(source);
  await contactOf(source, id);
  return changing(source, () => changes.photo(id, photo));
}

/** Adds a contact to the asker's own contacts where they are kept. */
export async function createContact(asker: Asker, sourceId: string, fields: ContactChange & { name: string }): Promise<ContactCard> {
  const source = await sourceOf(asker, sourceId, "contacts");
  const changes = changesOf(source);
  return changing(source, () => changes.create(fields));
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
  if (source.kind === "email") {
    const thread = await source.thread(id);
    return thread && { kind: "email", ref, thread, messageId: (await source.isMessage(id)) ? id : null };
  }
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
  const label = record.kind === "event" ? record.event.title : record.kind === "contact" ? record.contact.name : (record.thread.messages.find((m) => m.id === record.messageId)?.subject ?? record.thread.subject);
  return { ref: row!.id, kind: RECORD[source.kind], text: writtenReference(RECORD[source.kind], row!.id, label) };
}

/** The most references to one record that the notes about it are looked for by: the asker's own, and one for each other member. */
const MAX_REFERENCES = 50;

/**
 * Whether the asker can read the event now, from their own calendar. Any failure is a no: asked only
 * when a teammate referenced the event, a failure said aloud would tell the asker that someone had.
 */
async function readsEvent(asker: Asker, sourceId: string, id: string): Promise<boolean> {
  const source = (await asker.sources.of(asker.personId)).find((s) => s.info.id === sourceId);
  if (source?.kind !== "calendar" || source.info.state !== "connected") return false;
  return source.get(id).then(
    (event) => event !== null,
    () => false,
  );
}

/**
 * The references the notes about one of the asker's records hold: the asker's own, and for an event
 * the asker can read now, every other member's of the workspace to the same event. An event's id
 * names it for everyone whose calendar holds it (Google's is its calendar's id and its own), so the
 * members of a shared calendar refer to one event by one id. A contact is one person's own, and
 * only their own reference is theirs. Following a reference is still its maker's alone (`readRecord`).
 */
export async function referencesTo(asker: Asker, workspaceId: string, sourceId: string, id: string): Promise<string[]> {
  const { results } = await asker.db
    .prepare(
      `SELECT id, person_id FROM source_refs WHERE data_source = ?1 AND record_id = ?2 AND (person_id = ?3 OR person_id IN (SELECT person_id FROM members WHERE workspace_id = ?4))
       ORDER BY person_id = ?3 DESC, created_at, id LIMIT ?5`,
    )
    .bind(sourceId, id, asker.personId, workspaceId, MAX_REFERENCES)
    .all<{ id: string; person_id: string }>();
  const own = results.filter((r) => r.person_id === asker.personId).map((r) => r.id);
  if (own.length === results.length || !(await readsEvent(asker, sourceId, id))) return own;
  return results.map((r) => r.id);
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

/** The asker's email data source, connected or not, for what is theirs either way: the addresses it knows them by. */
async function mailOf(asker: Asker): Promise<MailSource> {
  const source = (await asker.sources.of(asker.personId)).find((s): s is MailSource => s.kind === "email");
  if (!source) throw new OpError("not_found", "Email isn't set up on this Common Ink");
  return source;
}

/** A page of the asker's email threads, latest first. With email not connected there are none, and `sources` says so. */
export async function listMail(asker: Asker, ask: { query?: string | undefined; before?: number | undefined; limit: number }): Promise<{ threads: MailThread[]; sources: Source[]; more: boolean; address: string | null }> {
  const { sources, read } = await readEach<MailSource, { threads: MailThread[]; more: boolean; address: string }>(asker, "email", async (source) => ({ ...(await source.list(ask)), address: source.address }));
  const address = read[0]?.address ?? (await mailOf(asker).then((s) => s.address, () => null));
  return { threads: read.flatMap((r) => r.threads), sources, more: read.some((r) => r.more), address };
}

export async function readMail(asker: Asker, sourceId: string, id: string): Promise<MailThreadRead> {
  const source = await sourceOf(asker, sourceId, "email");
  const thread = await source.thread(id);
  if (!thread) throw new OpError("not_found", "No such thread");
  return thread;
}

export async function mailSenders(asker: Asker): Promise<{ address: string | null; senders: MailSender[] }> {
  const source = await mailOf(asker);
  return { address: source.address, senders: await source.senders.list() };
}

export async function addMailSender(asker: Asker, address: string): Promise<{ address: string | null; senders: MailSender[]; code: string }> {
  const code = await (await mailOf(asker)).senders.add(address);
  return { ...(await mailSenders(asker)), code };
}

export async function removeMailSender(asker: Asker, address: string): Promise<{ address: string | null; senders: MailSender[] }> {
  await (await mailOf(asker)).senders.remove(address);
  return mailSenders(asker);
}
