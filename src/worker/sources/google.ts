import { z } from "zod";
import { shiftDay } from "../../core/events.ts";
import type { Calendar, CalendarEvent, Contact, EventWhen } from "../../core/protocol.ts";
import { SourceError, type CalendarSource, type ContactsSource, type DataSource, type Described, type EventChange } from "../../core/sources.ts";
import { SOURCE_SCOPES, isGoogleSource, refresh, revoke, type GoogleConfig, type GoogleSourceId } from "../google.ts";
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
    if (res.status === 412) throw new SourceError("stale", "It was changed in Google since you opened it. Open it again, then make your change.");
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

const Person = z.object({
  resourceName: z.string(),
  names: z.array(z.object({ displayName: z.string().optional() })).optional(),
  emailAddresses: z.array(z.object({ value: z.string().optional() })).optional(),
  phoneNumbers: z.array(z.object({ value: z.string().optional() })).optional(),
  organizations: z.array(z.object({ name: z.string().optional() })).optional(),
});
const Connections = z.object({ connections: z.array(z.unknown()).default([]), nextPageToken: z.string().optional() });
const PERSON = /^people\/([A-Za-z0-9_-]{1,100})$/;
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations";

function toContact(raw: unknown): Contact | null {
  const parsed = Person.safeParse(raw);
  const key = parsed.success ? PERSON.exec(parsed.data.resourceName)?.[1] : undefined;
  if (!parsed.success || !key) return null;
  const values = (items: { value?: string }[] | undefined) => (items ?? []).flatMap((i) => (i.value ? [i.value] : []));
  const emails = values(parsed.data.emailAddresses);
  const phones = values(parsed.data.phoneNumbers);
  const organization = parsed.data.organizations?.find((o) => o.name)?.name ?? null;
  const name = parsed.data.names?.find((n) => n.displayName)?.displayName ?? emails[0] ?? organization ?? phones[0];
  // A contact with nothing to call it by is nothing to list.
  if (!name) return null;
  return { sourceId: "google-contacts", id: parsed.data.resourceName, name, emails, phones, organization, url: `https://contacts.google.com/person/${key}` };
}

function contactsSource(session: Session, info: Described): ContactsSource {
  const ask = (url: string) => session.ask("google-contacts", url);
  return {
    kind: "contacts",
    info,
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
      const person = await ask(`${PEOPLE}/people/${key}?${new URLSearchParams({ personFields: PERSON_FIELDS })}`);
      return person === null ? null : toContact(person);
    },
  };
}

/** Whether a data source is connected, from what the person agreed to and whether Google still takes it. */
function stateOf(connection: Connection | null, id: GoogleSourceId, now: number): Described["state"] {
  if (!connection) return "not_connected";
  const agreed = SOURCE_SCOPES[id].every((scope) => connection.scopes.includes(scope));
  if (connection.broken || connection.lapsed.includes(id)) return agreed || connection.broken ? "needs_reconnect" : "not_connected";
  if (!agreed) return "not_connected";
  // With no way to renew it, a token that has lapsed is the end of the connection.
  return connection.refreshToken === null && connection.expiresAt <= now ? "needs_reconnect" : "connected";
}

/** Google's data sources, where this Common Ink has a Google client and a key to seal tokens with. */
export function google(deps: Deps): Provider {
  return {
    owns: isGoogleSource,
    async of(personId) {
      const connection = await connectionOf(deps.db, personId, PROVIDER);
      // With no connection there is nothing to open, and a source that isn't connected is never asked.
      const session = new Session(deps, connection ?? { personId, provider: PROVIDER, account: "", accessToken: null, refreshToken: null, expiresAt: 0, scopes: [], broken: true, lapsed: [] });
      const info = (id: GoogleSourceId): Described => ({ id, name: NAMES[id], provider: "Google", state: stateOf(connection, id, deps.now()), account: connection?.account ?? null });
      return [calendarSource(session, info("google-calendar")), contactsSource(session, info("google-contacts"))] satisfies DataSource[];
    },
    // Agreeing happens at Google, in the person's browser: /auth/google/connect in src/worker/auth.ts.
    connect: async (_personId, sourceId, back) => ({ redirect: `/auth/google/connect?${new URLSearchParams({ source: sourceId, next: back })}` }),
    /**
     * Ends the connection: Google is told to end everything the person agreed to, and the tokens
     * are deleted whether or not it answers, so nothing here can use them again.
     */
    async disconnect(personId) {
      const connection = await connectionOf(deps.db, personId, PROVIDER);
      if (!connection) return;
      const token = (await openToken(deps.vault, connection, "refresh")) ?? (await openToken(deps.vault, connection, "access"));
      await forget(deps.db, personId, PROVIDER);
      if (token) await revoke(token, deps.outbound);
    },
  };
}
