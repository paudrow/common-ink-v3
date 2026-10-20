import { z } from "zod";
import { shiftDay } from "../../core/events.ts";
import { logLine } from "../../core/logs.ts";
import { CONTACT_LABELS, labelType, type Calendar, type CalendarEvent, type Contact, type ContactCard, type ContactChange, type ContactLine, type EventWhen, type LabelledField } from "../../core/protocol.ts";
import { SourceError, type CalendarSource, type ContactsSource, type DataSource, type Described, type EventChange } from "../../core/sources.ts";
import { covers, isGoogleSource, refresh, revoke, writes as agreedToWrite, type GoogleConfig, type GoogleSourceId } from "../google.ts";
import type { Vault } from "../vault.ts";
import { connectionOf, forget, keepRenewed, markBroken, markLapsed, openToken, type Connection } from "./connections.ts";
import type { Provider } from "./index.ts";

/*
 * Google Calendar and Google Contacts, read and changed as the person who connected them. Every
 * request goes to one of the two hosts below and to nowhere else: a calendar's id, an event's id
 * and a contact's name are only ever one segment of a path on those hosts, never an address.
 */

export const PROVIDER = "google";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const PEOPLE = "https://people.googleapis.com/v1";
const HOSTS: ReadonlySet<string> = new Set([new URL(CALENDAR).origin, new URL(PEOPLE).origin]);

const TIMEOUT_MS = 15_000;
/** Renewed this long before it lapses, so a token isn't sent in its last moments. */
const EARLY_MS = 60_000;
const MAX_CALENDARS = 20;
const EVENT_PAGES = 4;
/** As many events as Google lists in one answer, so a calendar is nearly always one request. */
const EVENTS_A_PAGE = "2500";
/**
 * What one operation may send Google, and how much of it at once. A Worker is allowed a fixed number
 * of requests for each one it answers, 50 on the smallest plan, and a few connections at a time.
 */
const MAX_REQUESTS = 45;
const MAX_AT_ONCE = 6;
const CONTACT_PAGES = 5;

const NAMES: Record<GoogleSourceId, string> = { "google-calendar": "Google Calendar", "google-contacts": "Google Contacts" };

/** A path with every id in it taken out, so it can be written down. */
const shapeOf = (path: string) =>
  path
    .replace(/\/(calendars|calendarList|events)\/[^/]+/g, "/$1/…")
    .replace(/\/people\/(?!me\b)[^/]+/, "/people/…");

/**
 * A request that never got an answer: what the member is told, and a line for whoever runs this
 * Common Ink that says what failed and where. Neither holds a token, an id, or anything Google said.
 */
function unreached(err: unknown, method: string, to: URL): SourceError {
  const { name, message } = err instanceof Error ? err : { name: "Unknown", message: String(err) };
  // The error's name and not its message, which is the runtime's to word and could quote what was sent.
  const crowded = /too many subrequests/i.test(message);
  console.warn(`Google request failed: ${name}${crowded ? ", too many subrequests" : ""} (${method} ${to.host}${shapeOf(to.pathname)})`);
  if (name === "TimeoutError" || name === "AbortError") return new SourceError("busy", "Google took too long to answer. Try again in a moment.");
  if (crowded) return new SourceError("busy", "There is too much in Google to fetch at once. Show fewer calendars in Google Calendar, or look at a shorter span.");
  return new SourceError("busy", "Common Ink couldn't reach Google. Try again in a moment.");
}

const busy = (what: string) => new SourceError("busy", `Google didn't answer for ${what}. Try again in a moment.`);

interface Deps {
  db: D1Database;
  config: GoogleConfig;
  vault: Vault;
  outbound: typeof fetch;
  now: () => number;
}

const GoogleError = z.object({
  error: z.object({
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** Why Google refused, as its two APIs each say it: Calendar in `errors`, People in `details`. */
async function reasonsOf(res: Response): Promise<Set<string>> {
  const parsed = GoogleError.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return new Set();
  const { errors = [], details = [] } = parsed.data.error;
  return new Set([...errors, ...details].flatMap((e) => (e.reason ? [e.reason] : [])));
}

/** Google's answer as the shape it documents, or a failure that says nothing of what it held. */
function shaped<T extends z.ZodType>(shape: T, answer: unknown): z.output<T> {
  const parsed = shape.safeParse(answer);
  if (!parsed.success) throw new SourceError("busy", "Google answered with something Common Ink can't read");
  return parsed.data;
}

/** The status an error of Google's names, such as FAILED_PRECONDITION. */
async function statusOf(res: Response): Promise<string | undefined> {
  return GoogleError.safeParse(await res.clone().json().catch(() => null)).data?.error.status;
}

const SCOPE_REASONS = ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"];
const RATE_REASONS = ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "RATE_LIMIT_EXCEEDED"];

/**
 * One person's way into Google for the length of one operation. The token is opened once, renewed
 * once when it has lapsed or Google turns it down, and what was renewed is kept sealed.
 */
class Session {
  private token: Promise<string> | null = null;
  private renewal: Promise<string> | null = null;
  private ending: Promise<never> | null = null;
  private sent = 0;
  private flying = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private deps: Deps,
    private connection: Connection,
  ) {}

  private get personId() {
    return this.connection.personId;
  }

  /** Google no longer takes the tokens. However many requests find that out together, it is written once. */
  private broken(): Promise<never> {
    this.ending ??= markBroken(this.deps.db, this.personId, PROVIDER, this.deps.now()).then(() => {
      throw new SourceError("needs_reconnect", "Google no longer accepts this connection");
    });
    this.ending.catch(() => {});
    return this.ending;
  }

  private async renewed(): Promise<string> {
    const { db, config, vault, outbound, now } = this.deps;
    const held = await openToken(vault, this.connection, "refresh");
    if (!held) return this.broken();
    let tokens;
    try {
      tokens = await refresh(config, held, outbound, now());
    } catch {
      throw busy("renewing access");
    }
    if (!tokens) return this.broken();
    // The member disconnected while Google was answering: the token is theirs no longer, and nothing is asked with it.
    if (!(await keepRenewed(db, vault, this.connection, tokens, now()))) throw new SourceError("needs_reconnect", "This connection was ended");
    return tokens.accessToken;
  }

  /** One renewal for the whole operation, whichever request first needs it. */
  private renew(): Promise<string> {
    this.renewal ??= this.renewed();
    this.renewal.catch(() => {});
    return this.renewal;
  }

  private async current(): Promise<string> {
    const held = this.connection.expiresAt - EARLY_MS > this.deps.now() ? await openToken(this.deps.vault, this.connection, "access") : null;
    return held ?? this.renew();
  }

  /** Waits for one of the few places a request may be in flight at once, and counts it against what one operation may send. */
  private async turn(): Promise<void> {
    if (++this.sent > MAX_REQUESTS) throw new SourceError("busy", "There is too much in Google to fetch at once. Show fewer calendars in Google Calendar, or look at a shorter span.");
    if (this.flying >= MAX_AT_ONCE) await new Promise<void>((go) => this.waiting.push(go));
    else this.flying++;
  }

  private async send(url: string, init: RequestInit, token: string): Promise<Response> {
    const to = new URL(url);
    if (!HOSTS.has(to.origin)) throw new Error("Not an address of Google's");
    await this.turn();
    // Called as a function and never as `deps.outbound(...)`: the runtime's own fetch refuses to be called as something's method.
    const { outbound } = this.deps;
    try {
      return await outbound(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
    } catch (err) {
      throw unreached(err, init.method ?? "GET", to);
    } finally {
      // The place goes straight to whoever waited longest, or is given up.
      const next = this.waiting.shift();
      if (next) next();
      else this.flying--;
    }
  }

  /**
   * Asks Google as the person. Answers the body, or null for what isn't there. A token Google turns
   * down is renewed and the request sent once more, and no more than once.
   */
  async ask(source: GoogleSourceId, url: string, init: RequestInit = {}): Promise<unknown> {
    this.token ??= this.current();
    // Requests sent together wait on the one token, and a failure to get it is each one's to hear.
    this.token.catch(() => {});
    const used = await this.token;
    let res = await this.send(url, init, used);
    if (res.status === 401) {
      const next = await this.renew();
      // The token turned down was the renewed one: there is nothing further to try.
      if (next === used) return this.broken();
      res = await this.send(url, init, next);
      if (res.status === 401) return this.broken();
    }
    // An answer that isn't JSON is no answer: what it says instead is not passed on.
    if (res.ok) return res.json().catch(() => Promise.reject(new SourceError("busy", "Google answered with something Common Ink couldn't read. Try again in a moment.")));
    if (res.status === 404 || res.status === 410) return null;
    // Calendar says a stale etag with 412, People with 400 and FAILED_PRECONDITION.
    if (res.status === 412 || (res.status === 400 && (await statusOf(res)) === "FAILED_PRECONDITION")) throw new SourceError("stale", "It was changed in Google since you opened it. Open it again, then make your change.");
    if (res.status === 403) {
      const reasons = await reasonsOf(res);
      if (SCOPE_REASONS.some((r) => reasons.has(r))) {
        await markLapsed(this.deps.db, this.personId, PROVIDER, source, this.deps.now());
        throw new SourceError("needs_reconnect", `Google no longer lets Common Ink into ${NAMES[source]}`);
      }
      if (!RATE_REASONS.some((r) => reasons.has(r))) throw new SourceError("refused", "Google doesn't allow that change");
    }
    if (res.status === 403 || res.status === 429 || res.status >= 500) throw new SourceError("busy", "Google is busy. Try again in a moment.");
    throw new SourceError("refused", `Google refused (${res.status})`);
  }
}

const Time = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() });
const GoogleEvent = z.object({
  id: z.string(),
  etag: z.string(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: Time.optional(),
  end: Time.optional(),
  recurringEventId: z.string().optional(),
  eventType: z.string().optional(),
  locked: z.boolean().optional(),
  guestsCanModify: z.boolean().optional(),
  organizer: z.object({ self: z.boolean().optional() }).optional(),
});
type GoogleEvent = z.output<typeof GoogleEvent>;
const Events = z.object({ items: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() });
const GoogleCalendar = z.object({
  id: z.string(),
  summary: z.string().optional(),
  summaryOverride: z.string().optional(),
  backgroundColor: z.string().optional(),
  accessRole: z.string().optional(),
  selected: z.boolean().optional(),
  primary: z.boolean().optional(),
  hidden: z.boolean().optional(),
  deleted: z.boolean().optional(),
});
type GoogleCalendar = z.output<typeof GoogleCalendar>;
const Calendars = z.object({ items: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() });

const WRITES = new Set(["writer", "owner"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** When an event is, or null for one Google gives no usable time for. An all-day event's end is the day after its last. */
function whenOf(event: GoogleEvent): EventWhen | null {
  const { start, end } = event;
  if (start?.date && end?.date && DAY.test(start.date) && DAY.test(end.date)) {
    const last = shiftDay(end.date, -1);
    return { allDay: true, from: start.date, to: last < start.date ? start.date : last };
  }
  const from = Date.parse(start?.dateTime ?? "");
  const to = Date.parse(end?.dateTime ?? "");
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? { allDay: false, from, to } : null;
}

/** A record's id is the calendar's id and the event's, which have no space in them. */
const eventId = (calendarId: string, id: string) => `${calendarId} ${id}`;
const DOTS = /^\.{1,2}$/;
function partsOf(id: string): { calendarId: string; eventId: string } | null {
  const at = id.indexOf(" ");
  if (at <= 0 || at === id.length - 1 || id.includes(" ", at + 1)) return null;
  const parts = { calendarId: id.slice(0, at), eventId: id.slice(at + 1) };
  // Percent-encoding leaves a dot segment as it is, and an address then drops it and the segment before it.
  return DOTS.test(parts.calendarId) || DOTS.test(parts.eventId) ? null : parts;
}

const nameOf = (calendar: GoogleCalendar) => calendar.summaryOverride ?? calendar.summary ?? calendar.id;
const colorOf = (calendar: GoogleCalendar) => (calendar.backgroundColor && COLOR.test(calendar.backgroundColor) ? calendar.backgroundColor.toLowerCase() : null);
const writes = (calendar: GoogleCalendar) => WRITES.has(calendar.accessRole ?? "");

/** Whether the person shows the calendar in Google Calendar, which is what Common Ink lists of it. */
const shown = (calendar: GoogleCalendar) => !calendar.deleted && !calendar.hidden && (calendar.selected === true || calendar.primary === true);

const toCalendar = (calendar: GoogleCalendar): Calendar => ({ sourceId: "google-calendar", id: calendar.id, name: nameOf(calendar), color: colorOf(calendar), writable: writes(calendar) });

/** Only Google Calendar's own page for an event is linked to. */
const pageOf = (link: string | undefined) => (link && /^https:\/\/(www|calendar)\.google\.com\//.test(link) ? link : null);

function toEvent(calendar: GoogleCalendar, raw: unknown): CalendarEvent | null {
  const parsed = GoogleEvent.safeParse(raw);
  if (!parsed.success || parsed.data.status === "cancelled") return null;
  const event = parsed.data;
  const when = whenOf(event);
  if (!when) return null;
  const ordinary = event.eventType === undefined || event.eventType === "default";
  return {
    sourceId: "google-calendar",
    id: eventId(calendar.id, event.id),
    calendarId: calendar.id,
    calendar: nameOf(calendar),
    color: colorOf(calendar),
    title: event.summary ?? (calendar.accessRole === "freeBusyReader" ? "Busy" : "(No title)"),
    when,
    timeZone: event.start?.timeZone ?? null,
    location: event.location ?? null,
    description: event.description ?? null,
    recurring: event.recurringEventId !== undefined,
    editable: writes(calendar) && ordinary && event.locked !== true && (event.organizer?.self === true || event.guestsCanModify === true),
    etag: event.etag,
    url: pageOf(event.htmlLink),
  };
}

const calendarPath = (calendarId: string) => `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}`;

function calendarSource(session: Session, info: Described): CalendarSource {
  const ask = (url: string, init?: RequestInit) => session.ask("google-calendar", url, init);

  /** The calendars the person shows in Google Calendar, their own first, up to as many as one read covers. */
  async function calendars(): Promise<GoogleCalendar[]> {
    const found: GoogleCalendar[] = [];
    let pageToken: string | undefined;
    do {
      const page = shaped(Calendars, (await ask(`${CALENDAR}/users/me/calendarList?${new URLSearchParams({ maxResults: "250", ...(pageToken ? { pageToken } : {}) })}`)) ?? {});
      for (const item of page.items) {
        const calendar = GoogleCalendar.safeParse(item);
        if (calendar.success && shown(calendar.data)) found.push(calendar.data);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return found.sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false)).slice(0, MAX_CALENDARS);
  }

  async function calendarOf(calendarId: string): Promise<GoogleCalendar | null> {
    if (DOTS.test(calendarId)) return null;
    const calendar = GoogleCalendar.safeParse(await ask(`${CALENDAR}/users/me/calendarList/${encodeURIComponent(calendarId)}`));
    return calendar.success && !calendar.data.deleted ? calendar.data : null;
  }

  async function eventsOf(calendar: GoogleCalendar, span: { from: number; to: number }): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < EVENT_PAGES; page++) {
      const query = new URLSearchParams({ timeMin: new Date(span.from).toISOString(), timeMax: new Date(span.to).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: EVENTS_A_PAGE, ...(pageToken ? { pageToken } : {}) });
      const answer = await ask(`${calendarPath(calendar.id)}/events?${query}`);
      // A calendar that went away between the two reads has no events.
      if (answer === null) break;
      const listed = shaped(Events, answer);
      events.push(...listed.items.flatMap((item) => toEvent(calendar, item) ?? []));
      pageToken = listed.nextPageToken;
      if (!pageToken) break;
    }
    return events;
  }

  return {
    kind: "calendar",
    info,
    async list(span) {
      const shown = await calendars();
      return { calendars: shown.map(toCalendar), events: (await Promise.all(shown.map((calendar) => eventsOf(calendar, span)))).flat() };
    },
    async get(id) {
      const parts = partsOf(id);
      if (!parts) return null;
      const calendar = await calendarOf(parts.calendarId);
      if (!calendar) return null;
      const event = await ask(`${calendarPath(calendar.id)}/events/${encodeURIComponent(parts.eventId)}`);
      return event === null ? null : toEvent(calendar, event);
    },
    async update(id, change, etag) {
      const parts = partsOf(id);
      const calendar = parts && (await calendarOf(parts.calendarId));
      if (!parts || !calendar) throw new SourceError("refused", "No such event");
      const answer = await ask(`${calendarPath(calendar.id)}/events/${encodeURIComponent(parts.eventId)}`, {
        method: "PATCH",
        // Google changes the event only if it is still as the member read it.
        headers: { "Content-Type": "application/json", "If-Match": etag },
        body: JSON.stringify(patchOf(change)),
      });
      const event = answer === null ? null : toEvent(calendar, answer);
      if (!event) throw new SourceError("refused", "No such event");
      return event;
    },
    async calendar(id) {
      const calendar = await calendarOf(id);
      return calendar && shown(calendar) ? toCalendar(calendar) : null;
    },
    async create(calendarId, fields) {
      const calendar = await calendarOf(calendarId);
      if (!calendar) throw new SourceError("refused", "No such calendar");
      if (!writes(calendar)) throw new SourceError("refused", `You can only read the calendar "${nameOf(calendar)}"`);
      const answer = await ask(`${calendarPath(calendar.id)}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patchOf(fields)) });
      if (answer === null) throw new SourceError("refused", "No such calendar");
      const event = toEvent(calendar, answer);
      if (!event) throw new SourceError("busy", "Google answered with something Common Ink can't read");
      return event;
    },
  };
}

/** A change as Google's `events.patch` takes it. A time that changes kind names the other kind as gone. */
export function patchOf(change: EventChange): Record<string, unknown> {
  const { when } = change;
  return {
    ...(change.title === undefined ? {} : { summary: change.title }),
    ...(change.location === undefined ? {} : { location: change.location }),
    ...(change.description === undefined ? {} : { description: change.description }),
    ...(when === undefined
      ? {}
      : when.allDay
        ? { start: { date: when.from, dateTime: null, timeZone: null }, end: { date: shiftDay(when.to, 1), dateTime: null, timeZone: null } }
        : { start: { dateTime: new Date(when.from).toISOString(), date: null }, end: { dateTime: new Date(when.to).toISOString(), date: null } }),
  };
}

/** A line of a person's as People gives it, with its `type` and, for one People doesn't know, the label as written in `formattedType`. */
const Labelled = { type: z.string().optional(), formattedType: z.string().optional() };
const Person = z.object({
  resourceName: z.string(),
  etag: z.string().optional(),
  names: z.array(z.object({ displayName: z.string().optional() })).optional(),
  emailAddresses: z.array(z.object({ value: z.string().optional(), ...Labelled })).optional(),
  phoneNumbers: z.array(z.object({ value: z.string().optional(), ...Labelled })).optional(),
  organizations: z.array(z.object({ name: z.string().optional(), title: z.string().optional() })).optional(),
});
const Detailed = Person.extend({
  addresses: z.array(z.object({ formattedValue: z.string().optional(), ...Labelled })).optional(),
  birthdays: z.array(z.object({ date: z.object({ year: z.number().int().optional(), month: z.number().int().optional(), day: z.number().int().optional() }).optional() })).optional(),
  biographies: z.array(z.object({ value: z.string().optional() })).optional(),
  photos: z.array(z.object({ url: z.string().optional(), default: z.boolean().optional() })).optional(),
  urls: z.array(z.object({ value: z.string().optional(), ...Labelled })).optional(),
});
const Connections = z.object({ connections: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() });
const PERSON = /^people\/([A-Za-z0-9_-]{1,100})$/;
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";
/** All a contact's page shows of them, which is read one contact at a time. */
const CARD_FIELDS = `${PERSON_FIELDS},addresses,birthdays,biographies,photos,urls`;
const pad = (n: number) => String(n).padStart(2, "0");
/** Where Google keeps a contact's picture. */
const PICTURE = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//;

/** What each field of a change is called in People's `updatePersonFields`. */
const PERSON_FIELD = { name: "names", emails: "emailAddresses", phones: "phoneNumbers", organization: "organizations", title: "organizations", addresses: "addresses", birthday: "birthdays", urls: "urls", notes: "biographies" } as const satisfies Record<keyof ContactChange, string>;

type Entry = Record<string, unknown>;
/** An entry of a person's as it can be sent back: what Google works out itself taken off. */
const kept = ({ metadata: _, formattedType: __, canonicalForm: ___, ...entry }: Entry): Entry => entry;
const entries = (was: Entry, field: string): Entry[] => (Array.isArray(was[field]) ? (was[field] as unknown[]).filter((e): e is Entry => typeof e === "object" && e !== null) : []);

/** Where People keeps each of a contact's labelled fields, and the key of an entry there that holds its value. */
const LINES = { emails: ["emailAddresses", "value"], phones: ["phoneNumbers", "value"], addresses: ["addresses", "formattedValue"], urls: ["urls", "value"] } as const satisfies Record<LabelledField, readonly [string, string]>;

/** An entry's label as a contact holds it: People's own type, or for a type it doesn't know, the label as Google shows it. */
export function labelOf(field: LabelledField, { type, formattedType }: { type?: unknown; formattedType?: unknown }): string | null {
  const own = typeof type === "string" ? type.trim() : "";
  if (!own) return null;
  if (Object.hasOwn(CONTACT_LABELS[field], own)) return own;
  return (typeof formattedType === "string" && formattedType.trim()) || own;
}

/** A field's entries as lines, each with its value and label; one with no value is no line. */
function linesOf<E extends { type?: string; formattedType?: string }>(field: LabelledField, items: E[] | undefined, value: (entry: E) => string | undefined): ContactLine[] {
  return (items ?? []).flatMap((entry) => {
    const said = value(entry);
    return said ? [{ value: said, type: labelOf(field, entry) }] : [];
  });
}

/**
 * A field's lines as the member wrote them, as People takes them. A line that was there with the same
 * label is sent back as Google had it. A label read from Google is sent as Google's own type, so one
 * Common Ink has no words for, such as `workMobile`, stays what it was.
 */
function listed(field: LabelledField, lines: ContactLine[], before: Entry[]): Entry[] {
  const key = LINES[field][1];
  return lines.map((line) => {
    const same = before.find((e) => e[key] === line.value && labelOf(field, e) === line.type);
    if (same) return kept(same);
    const { type: _, ...was } = kept(before.find((e) => e[key] === line.value) ?? {});
    const type = line.type === null ? null : (before.find((e) => labelOf(field, e) === line.type)?.type ?? labelType(field, line.type));
    return { ...was, [key]: line.value, ...(type !== null && { type }) };
  });
}

/**
 * A change as People's `updateContact` and `createContact` take it: each field the change names, as a
 * whole, and the fields to name in `updatePersonFields`. `was` is the person as Google holds them, so
 * an email, a number or an address left as it was keeps its label, and a first organization its department.
 */
export function personOf(change: ContactChange, was: Entry = {}): { person: Entry; fields: string[] } {
  const person: Entry = {};
  if (change.name !== undefined) person.names = [{ unstructuredName: change.name }];
  for (const field of Object.keys(LINES) as LabelledField[]) {
    const lines = change[field];
    if (lines !== undefined) person[LINES[field][0]] = listed(field, lines, entries(was, LINES[field][0]));
  }
  if (change.organization !== undefined || change.title !== undefined) {
    const [first = {}, ...rest] = entries(was, "organizations").map(kept);
    const named = { ...first, ...(change.organization !== undefined && { name: change.organization }), ...(change.title !== undefined && { title: change.title }) };
    const org = Object.fromEntries(Object.entries(named).filter(([, v]) => v !== null && v !== undefined));
    person.organizations = org.name || org.title ? [org, ...rest] : rest;
  }
  if (change.birthday !== undefined) {
    const [, year, month, day] = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(change.birthday ?? "") ?? [];
    person.birthdays = change.birthday === null ? [] : [{ date: { ...(year !== "-" && { year: Number(year) }), month: Number(month), day: Number(day) } }];
  }
  if (change.notes !== undefined) person.biographies = change.notes ? [{ value: change.notes, contentType: "TEXT_PLAIN" }] : [];
  const fields = [...new Set((Object.keys(change) as (keyof ContactChange)[]).filter((key) => change[key] !== undefined).map((key) => PERSON_FIELD[key]))];
  return { person, fields };
}

function toContact(raw: unknown): Contact | null {
  const parsed = Person.safeParse(raw);
  const key = parsed.success ? PERSON.exec(parsed.data.resourceName)?.[1] : undefined;
  if (!parsed.success || !key) return null;
  const emails = linesOf("emails", parsed.data.emailAddresses, (e) => e.value);
  const phones = linesOf("phones", parsed.data.phoneNumbers, (e) => e.value);
  const organization = parsed.data.organizations?.find((o) => o.name)?.name ?? null;
  const name = parsed.data.names?.find((n) => n.displayName)?.displayName ?? emails[0]?.value ?? organization ?? phones[0]?.value;
  // A contact with nothing to call it by is nothing to list.
  if (!name) return null;
  return { sourceId: "google-contacts", id: parsed.data.resourceName, name, emails, phones, organization, url: `https://contacts.google.com/person/${key}` };
}

/** A contact with all Google holds of them that a page shows: a birthday without a year is --MM-DD, and only an https address is kept for a picture or a page. */
export function toCard(raw: unknown): ContactCard | null {
  const contact = toContact(raw);
  const parsed = Detailed.safeParse(raw);
  if (!contact || !parsed.success) return null;
  const { organizations, addresses, birthdays, biographies, photos, urls } = parsed.data;
  const date = birthdays?.find((b) => b.date?.month && b.date.day)?.date;
  const https = (address: string | undefined) => (address && /^https:\/\//.test(address) ? address : null);
  // A picture is drawn from where Google keeps it, which the page policy lets in, and from nowhere else.
  const picture = photos?.find((p) => p.url && !p.default)?.url;
  return {
    ...contact,
    etag: parsed.data.etag ?? "",
    title: organizations?.find((o) => o.title)?.title ?? null,
    addresses: linesOf("addresses", addresses, (a) => a.formattedValue),
    birthday: date ? `${date.year ? String(date.year).padStart(4, "0") : "-"}-${pad(date.month!)}-${pad(date.day!)}` : null,
    notes: biographies?.find((b) => b.value)?.value ?? null,
    photo: picture && PICTURE.test(picture) ? picture : null,
    urls: linesOf("urls", urls, (u) => https(u.value) ?? undefined),
  };
}

/** A person Google answered a change with, as a card, or a failure that says nothing of what it held. */
function answered(answer: unknown): ContactCard {
  const card = answer === null ? null : toCard(answer);
  if (!card) throw new SourceError("refused", "No such contact");
  return card;
}

function contactsSource(session: Session, info: Described, writable: boolean): ContactsSource {
  const ask = (url: string, init?: RequestInit) => session.ask("google-contacts", url, init);
  const sent = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const card = new URLSearchParams({ personFields: CARD_FIELDS });
  const keyOf = (id: string) => {
    const key = PERSON.exec(id)?.[1];
    if (!key) throw new SourceError("refused", "No such contact");
    return key;
  };
  return {
    kind: "contacts",
    info,
    ...(writable && {
      changes: {
        async update(id, change, etag) {
          const key = keyOf(id);
          const was = await ask(`${PEOPLE}/people/${key}?${new URLSearchParams({ personFields: CARD_FIELDS })}`);
          if (was === null) throw new SourceError("refused", "No such contact");
          const { person, fields } = personOf(change, was as Entry);
          // Google changes the contact only if it is still as the member read it.
          return answered(await ask(`${PEOPLE}/people/${key}:updateContact?${new URLSearchParams({ updatePersonFields: fields.join(","), personFields: CARD_FIELDS })}`, sent("PATCH", { ...person, etag })));
        },
        async photo(id, photo) {
          const key = keyOf(id);
          const answer =
            photo === null ? await ask(`${PEOPLE}/people/${key}:deleteContactPhoto?${card}`, { method: "DELETE" }) : await ask(`${PEOPLE}/people/${key}:updateContactPhoto`, sent("PATCH", { photoBytes: photo, personFields: CARD_FIELDS }));
          return answered(shaped(z.object({ person: z.unknown() }), answer ?? {}).person ?? null);
        },
        async create(fields) {
          return answered(await ask(`${PEOPLE}/people:createContact?${card}`, sent("POST", personOf(fields).person)));
        },
      },
    }),
    async list() {
      const contacts: Contact[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < CONTACT_PAGES; page++) {
        const listed = shaped(Connections, (await ask(`${PEOPLE}/people/me/connections?${new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: "1000", sortOrder: "FIRST_NAME_ASCENDING", ...(pageToken ? { pageToken } : {}) })}`)) ?? {});
        contacts.push(...listed.connections.flatMap((person) => toContact(person) ?? []));
        pageToken = listed.nextPageToken;
        if (!pageToken) break;
      }
      return { contacts, more: pageToken !== undefined };
    },
    async get(id) {
      const key = PERSON.exec(id)?.[1];
      if (!key) return null;
      const person = await ask(`${PEOPLE}/people/${key}?${new URLSearchParams({ personFields: CARD_FIELDS })}`);
      return person === null ? null : toCard(person);
    },
  };
}

/** Whether a data source is connected, from what the person agreed to and whether Google still takes it. */
function stateOf(connection: Connection | null, id: GoogleSourceId, now: number): Described["state"] {
  if (!connection) return "not_connected";
  const agreed = covers(id, connection.scopes);
  if (connection.broken || connection.lapsed.includes(id)) return agreed || connection.broken ? "needs_reconnect" : "not_connected";
  if (!agreed) return "not_connected";
  // With no way to renew it, a token that has lapsed is the end of the connection.
  return connection.refreshToken === null && connection.expiresAt <= now ? "needs_reconnect" : "connected";
}

/** Google's data sources, where this Common Ink has a Google client and a key to seal tokens with. */
export function google(deps: Deps): Provider {
  const ending = async (personId: string) => {
    const connection = await connectionOf(deps.db, personId, PROVIDER);
    const token = connection && ((await openToken(deps.vault, connection, "refresh")) ?? (await openToken(deps.vault, connection, "access")));
    if (!token) return null;
    return async () => {
      // Logged without the token or whose it was. The connection is ended here all the same.
      if (!(await revoke(token, deps.outbound))) logLine("Google didn't say it ended a connection that was disconnected here");
    };
  };
  return {
    owns: isGoogleSource,
    async of(personId) {
      const connection = await connectionOf(deps.db, personId, PROVIDER);
      // With no connection there is nothing to open, and a source that isn't connected is never asked.
      const session = new Session(deps, connection ?? { personId, provider: PROVIDER, account: "", accessToken: null, refreshToken: null, expiresAt: 0, scopes: [], broken: true, lapsed: [] });
      const info = (id: GoogleSourceId): Described => ({ id, name: NAMES[id], provider: "Google", state: stateOf(connection, id, deps.now()), account: connection?.account ?? null });
      // Contacts are read with one scope and changed with another, which a member who connected before editing came agrees to by connecting again.
      const editsContacts = agreedToWrite("google-contacts", connection?.scopes ?? []);
      const contacts = info("google-contacts");
      return [calendarSource(session, info("google-calendar")), contactsSource(session, editsContacts || contacts.state !== "connected" ? contacts : { ...contacts, reconnectToWrite: true }, editsContacts)] satisfies DataSource[];
    },
    // Agreeing happens at Google, in the person's browser: /auth/google/connect in src/worker/auth.ts.
    connect: async (_personId, sourceId, back, edit) => ({ redirect: `/auth/google/connect?${new URLSearchParams({ source: sourceId, ...(edit && { edit: "1" }), next: back })}` }),
    /**
     * Ends the connection: Google is told to end everything the person agreed to, and the tokens
     * are deleted whether or not it answers, so nothing here can use them again.
     */
    async disconnect(personId) {
      const end = await ending(personId);
      await forget(deps.db, personId, PROVIDER);
      await end?.();
    },
    ending,
  };
}
