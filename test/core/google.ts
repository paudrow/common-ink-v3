/*
 * Google, as far as Common Ink asks anything of it: a stand-in at the one place the Worker reaches
 * out. It answers in the shapes Google's API reference gives for the token and revoke endpoints,
 * Calendar's calendarList, events and events.insert, and People's connections, get, updateContact,
 * updateContactPhoto, deleteContactPhoto and createContact, and refuses the way they refuse.
 * It throws for a request to any other host, so no test passes by reaching somewhere else.
 */

export interface FakeEvent {
  id: string;
  etag: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start: { date?: string | null; dateTime?: string | null; timeZone?: string | null };
  end: { date?: string | null; dateTime?: string | null; timeZone?: string | null };
  recurringEventId?: string;
  eventType?: string;
  guestsCanModify?: boolean;
  organizer?: { self?: boolean };
}

export interface FakeCalendar {
  id: string;
  summary: string;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
  backgroundColor?: string;
  selected?: boolean;
  primary?: boolean;
  events: FakeEvent[];
}

export interface Sent {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

const HOSTS = new Set(["https://oauth2.googleapis.com", "https://www.googleapis.com", "https://people.googleapis.com"]);
const json = (body: unknown, status = 200) => Response.json(body, { status });
const refusal = (status: number, reason: string) => json({ error: { code: status, message: reason, errors: [{ domain: "global", reason, message: reason }] } }, status);

export class FakeGoogle {
  /** Access tokens Google takes now. */
  valid = new Set<string>();
  /** Refresh tokens Google takes, each with the access token it gives next. */
  refreshes = new Map<string, string>();
  /** Access tokens Google hands out and then turns down. */
  dead = new Set<string>();
  revoked: string[] = [];
  calendars: FakeCalendar[] = [];
  people: unknown[] = [];
  /** Access tokens agreed to change contacts, not only to read them. */
  contactWriters = new Set<string>();
  /** How many of each list a page holds. */
  pageSize = 250;
  /** Answers in place of the real one, by a request's method and path, each used once. */
  once = new Map<string, () => Response>();
  /** What happens while Google is working out its answer to a request, by method and path, each once. */
  during = new Map<string, () => Promise<unknown>>();
  sent: Sent[] = [];

  /** How many requests were being answered at once, at most. */
  most = 0;
  private open = 0;

  /** As the runtime's own fetch does, this refuses to be called as a method of anything: `deps.outbound(url)` throws. */
  fetch: typeof fetch;

  constructor() {
    const answer = (input: RequestInfo | URL, init?: RequestInit) => this.counted(input, init);
    this.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      return answer(input, init);
    } as typeof fetch;
  }

  /** An answer takes a moment, as a real one does, so requests sent together are in flight together. */
  private async counted(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.most = Math.max(this.most, ++this.open);
    try {
      await new Promise((later) => setTimeout(later, 1));
      return await this.answer(input, init);
    } finally {
      this.open--;
    }
  }

  private answer = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!HOSTS.has(url.origin)) throw new Error(`A request left for ${url.origin}, which isn't Google`);
    const sent: Sent = { method: init.method ?? "GET", url, headers: new Headers(init.headers), body: init.body instanceof URLSearchParams ? init.body.toString() : ((init.body as string | undefined) ?? "") };
    this.sent.push(sent);
    const key = `${sent.method} ${url.pathname}`;
    const meanwhile = this.during.get(key);
    if (meanwhile) {
      this.during.delete(key);
      await meanwhile();
    }
    const forced = this.once.get(key);
    if (forced) {
      this.once.delete(key);
      return forced();
    }
    if (url.origin === "https://oauth2.googleapis.com") return this.oauth(url, new URLSearchParams(sent.body));
    const token = /^Bearer (.+)$/.exec(sent.headers.get("Authorization") ?? "")?.[1];
    if (!token || !this.valid.has(token)) return json({ error: { code: 401, message: "Invalid Credentials", errors: [{ domain: "global", reason: "authError", location: "Authorization", locationType: "header" }], status: "UNAUTHENTICATED" } }, 401);
    return url.origin === "https://www.googleapis.com" ? this.calendar(sent) : this.contacts(sent, token);
  }) as typeof fetch;

  asked(method: string, path: RegExp): Sent[] {
    return this.sent.filter((s) => s.method === method && path.test(s.url.pathname));
  }

  private oauth(url: URL, form: URLSearchParams): Response {
    if (url.pathname === "/revoke") {
      this.revoked.push(form.get("token") ?? "");
      return json({});
    }
    if (form.get("grant_type") !== "refresh_token") return json({ error: "unsupported_grant_type" }, 400);
    const next = this.refreshes.get(form.get("refresh_token") ?? "");
    if (!next) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    if (!this.dead.has(next)) this.valid.add(next);
    return json({ access_token: next, expires_in: 3599, scope: "", token_type: "Bearer" });
  }

  private page<T>(items: T[], url: URL): { items: T[]; nextPageToken?: string } {
    const from = Number(url.searchParams.get("pageToken") ?? 0);
    const to = from + this.pageSize;
    return { items: items.slice(from, to), ...(to < items.length ? { nextPageToken: String(to) } : {}) };
  }

  private calendar({ method, url, headers, body }: Sent): Response {
    const path = url.pathname.replace("/calendar/v3", "").split("/").filter(Boolean).map(decodeURIComponent);
    const entry = ({ events: _, ...calendar }: FakeCalendar) => ({ kind: "calendar#calendarListEntry", ...calendar });
    if (path[0] === "users" && path[2] === "calendarList") {
      if (path.length === 3) return json({ kind: "calendar#calendarList", ...this.page(this.calendars.map(entry), url) });
      const found = this.calendars.find((c) => c.id === path[3]);
      return found ? json(entry(found)) : refusal(404, "notFound");
    }
    const calendar = this.calendars.find((c) => c.id === path[1]);
    if (path[0] !== "calendars" || path[2] !== "events" || !calendar) return refusal(404, "notFound");
    const writer = calendar.accessRole === "writer" || calendar.accessRole === "owner";
    // Google's insert takes a null as a field left out, and answers the event as it keeps it.
    const kept = (time: FakeEvent["start"]) => Object.fromEntries(Object.entries(time).filter(([, v]) => v !== null));
    if (path.length === 3 && method === "POST") {
      if (!writer) return refusal(403, "requiredAccessLevel");
      const given = JSON.parse(body) as FakeEvent;
      const made: FakeEvent = { ...given, id: `made${calendar.events.length}`, etag: '"1"', status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=bWFkZQ", start: kept(given.start), end: kept(given.end), organizer: { self: true } };
      calendar.events.push(made);
      return json(made);
    }
    if (path.length === 3) {
      const [min, max] = [Date.parse(url.searchParams.get("timeMin")!), Date.parse(url.searchParams.get("timeMax")!)];
      const at = (time: FakeEvent["start"]) => Date.parse(time.dateTime ?? `${time.date}T00:00:00Z`);
      const overlapping = calendar.events.filter((e) => at(e.start) < max && at(e.end) > min).sort((a, b) => at(a.start) - at(b.start));
      return json({ kind: "calendar#events", timeZone: "America/Chicago", ...this.page(overlapping, url) });
    }
    const event = calendar.events.find((e) => e.id === path[3]);
    if (!event) return refusal(404, "notFound");
    if (method === "GET") return json(event);
    if (method !== "PATCH") return refusal(405, "methodNotAllowed");
    if (!writer) return refusal(403, "forbidden");
    if (headers.get("If-Match") !== event.etag) return refusal(412, "conditionNotMet");
    const patch = JSON.parse(body) as Partial<FakeEvent>;
    // Google's patch: a field given replaces, an object given is merged, and null takes a field away.
    const merged = (was: object, change: object) => Object.fromEntries(Object.entries({ ...was, ...change }).filter(([, v]) => v !== null));
    Object.assign(event, { ...patch, ...(patch.start ? { start: merged(event.start, patch.start) } : {}), ...(patch.end ? { end: merged(event.end, patch.end) } : {}), etag: `"${Number(event.etag.replace(/"/g, "")) + 1}"` });
    return json(event);
  }

  private contacts({ method, url, body }: Sent, token: string): Response {
    if (url.pathname === "/v1/people/me/connections") {
      const { items, nextPageToken } = this.page(this.people, url);
      return json({ connections: items, ...(nextPageToken ? { nextPageToken } : {}), totalPeople: this.people.length, totalItems: this.people.length });
    }
    const missing = () => json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404);
    if (method !== "GET" && !this.contactWriters.has(token)) return INSUFFICIENT.people();
    type Person = Record<string, unknown> & { resourceName: string; etag: string };
    // People works out a name's displayName from what is written.
    const named = (given: Record<string, unknown>) => (Array.isArray(given.names) ? { ...given, names: (given.names as { unstructuredName?: string }[]).map((n) => ({ displayName: n.unstructuredName, ...n })) } : given);
    const etag = () => `%E${this.sent.length}`;
    if (url.pathname === "/v1/people:createContact") {
      if (method !== "POST") return refusal(405, "methodNotAllowed");
      const made = { ...named(JSON.parse(body) as Record<string, unknown>), resourceName: `people/c${100 + this.people.length}`, etag: etag() };
      this.people.push(made);
      return json(made);
    }
    const [, resourceName, action] = /^\/v1\/(people\/[^/:]+)(?::(\w+))?$/.exec(url.pathname) ?? [];
    const found = this.people.find((p) => (p as Person).resourceName === resourceName) as Person | undefined;
    if (!found) return missing();
    if (action === undefined && method === "GET") return json(found);
    if (action === "updateContact" && method === "PATCH") {
      const given = named(JSON.parse(body) as Record<string, unknown>);
      const fields = url.searchParams.get("updatePersonFields");
      if (!fields) return json({ error: { code: 400, message: "updatePersonFields mask is required.", status: "INVALID_ARGUMENT" } }, 400);
      if (given.etag !== found.etag) return json({ error: { code: 400, message: "Request person.etag is different than the current person.etag. Clear local cache and get the latest person.", status: "FAILED_PRECONDITION" } }, 400);
      // Each field named is replaced by what was sent, and one named and not sent is taken away.
      for (const field of fields.split(",")) found[field] = given[field] ?? [];
      found.etag = etag();
      return json(found);
    }
    if (action === "updateContactPhoto" && method === "PATCH") {
      found.photos = [{ url: `https://lh3.googleusercontent.com/contacts/${found.resourceName.slice(7)}-${this.sent.length}`, metadata: { source: { type: "CONTACT" } } }];
      found.etag = etag();
      return json({ person: found });
    }
    if (action === "deleteContactPhoto" && method === "DELETE") {
      found.photos = [];
      found.etag = etag();
      return json({ person: found });
    }
    return refusal(405, "methodNotAllowed");
  }
}

/** What Google says when the token is good and what was agreed to doesn't cover the request, as each API says it. */
export const INSUFFICIENT = {
  calendar: () => json({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } }, 403),
  people: () =>
    json({ error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }] } }, 403),
};
export const RATE_LIMITED = {
  usage: () => refusal(403, "rateLimitExceeded"),
  tooMany: () => refusal(429, "rateLimitExceeded"),
};

/** An ID token as Google's token endpoint gives one: three parts, of which Common Ink reads the middle. */
export const idToken = (claims: Record<string, unknown>) => `e30.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.sig`;
