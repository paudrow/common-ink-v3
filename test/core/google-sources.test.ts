import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whoAmI } from "../../src/core/accounts.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type OpInput } from "../../src/core/protocol.ts";
import { SOURCE_SCOPES, WRITE_SCOPES } from "../../src/worker/google.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { connectionOf, keepTokens } from "../../src/worker/sources/connections.ts";
import { patchOf, personOf, toCard } from "../../src/worker/sources/google.ts";
import { sourcesFor } from "../../src/worker/sources/index.ts";
import { vault } from "../../src/worker/vault.ts";
import { FakeGoogle, INSUFFICIENT, RATE_LIMITED, idToken, type FakeCalendar } from "./google.ts";
import { addMember, newMember } from "./members.ts";

const T0 = Date.UTC(2026, 9, 14, 12);
const WEEK = { from: Date.UTC(2026, 9, 11), to: Date.UTC(2026, 9, 18), timeZone: "America/Chicago" };
const KEY = "a-token-key-for-tests-0123456789abcdef";
const SECRET = "test-session-secret";
const CALENDAR_SCOPES = [...SOURCE_SCOPES["google-calendar"]];
const ALL_SCOPES = [...CALENDAR_SCOPES, ...SOURCE_SCOPES["google-contacts"]];
const CONTACTS_WRITE = WRITE_SCOPES["google-contacts"]!;
const SETTINGS = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", TOKEN_KEY: KEY, SESSION_SECRET: SECRET, DEV_SIGN_IN: undefined, ALLOWED_EMAILS: undefined };
const configured = (more: Partial<Env> = {}) => ({ ...env, ...SETTINGS, ...more }) as Env;

const mine = (): FakeCalendar => ({
  id: "ada@example.com",
  summary: "Ada",
  accessRole: "owner",
  primary: true,
  backgroundColor: "#9FE1E7",
  events: [
    { id: "lunch", etag: '"1"', status: "confirmed", summary: "Lunch with Sam", location: "Cafe Lula", htmlLink: "https://www.google.com/calendar/event?eid=bHVuY2g", start: { dateTime: "2026-10-13T12:00:00-05:00", timeZone: "America/Chicago" }, end: { dateTime: "2026-10-13T13:00:00-05:00", timeZone: "America/Chicago" }, organizer: { self: true } },
    // An all-day event's end is the day after its last: this one is the 14th and the 15th.
    { id: "offsite", etag: '"1"', status: "confirmed", summary: "Offsite", start: { date: "2026-10-14" }, end: { date: "2026-10-16" }, organizer: { self: true } },
    { id: "standup_20261015T140000Z", etag: '"1"', status: "confirmed", summary: "Standup", recurringEventId: "standup", start: { dateTime: "2026-10-15T14:00:00Z" }, end: { dateTime: "2026-10-15T14:15:00Z" }, organizer: { self: true } },
    { id: "gone", etag: '"1"', status: "cancelled", start: { dateTime: "2026-10-15T15:00:00Z" }, end: { dateTime: "2026-10-15T16:00:00Z" } },
    { id: "theirs", etag: '"1"', status: "confirmed", summary: "Their meeting", start: { dateTime: "2026-10-16T15:00:00Z" }, end: { dateTime: "2026-10-16T16:00:00Z" }, organizer: { self: false } },
  ],
});
const holidays = (): FakeCalendar => ({ id: "en.usa#holiday@group.v.calendar.google.com", summary: "Holidays", accessRole: "reader", selected: true, events: [{ id: "h1", etag: '"1"', status: "confirmed", summary: "Columbus Day", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }] });
const hidden = (): FakeCalendar => ({ id: "old@group.calendar.google.com", summary: "Unticked", accessRole: "owner", selected: false, events: [{ id: "x", etag: '"1"', summary: "Not shown", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } }] });

const PEOPLE = [
  {
    resourceName: "people/c1",
    etag: "%Eg",
    names: [{ displayName: "Sam Okafor", metadata: { primary: true } }],
    phoneNumbers: [{ value: "+1 555 0142", type: "mobile", formattedType: "Mobile", canonicalForm: "+15550142", metadata: { primary: true } }],
    organizations: [{ name: "Okafor Plumbing", title: "Owner", department: "Boilers" }],
  },
  { resourceName: "people/c2", etag: "%Eg", names: [{ displayName: "Zoë Álvarez" }], emailAddresses: [{ value: "zoe@example.com" }, { value: "z@example.org" }] },
  { resourceName: "people/c3", etag: "%Eg", emailAddresses: [{ value: "nameless@example.com" }] },
  { resourceName: "people/c4", etag: "%Eg" },
];

interface Held {
  access?: string;
  refresh?: string | null;
  expiresAt?: number;
  scopes?: string[];
}

/** A member whose Google account is connected, a Google that knows their tokens, and a way to ask as them. */
async function connected(held: Held = {}, more: Partial<Env> = {}) {
  const google = new FakeGoogle();
  google.calendars = [mine(), holidays(), hidden()];
  google.people = structuredClone(PEOPLE);
  const ada = await newMember("Ada");
  const { access = "at-1", refresh = "rt-1", expiresAt = T0 + 3_600_000, scopes = ALL_SCOPES } = held;
  google.valid.add(access);
  if (scopes.includes(CONTACTS_WRITE)) google.contactWriters.add(access);
  if (refresh) google.refreshes.set(refresh, "at-2");
  await keepTokens(env.DB, vault(KEY)!, ada.personId, "google", "ada@example.com", { accessToken: access, refreshToken: refresh, expiresAt, scopes }, T0);
  const sources = sourcesFor(configured(more), new URL("https://commonink.app/"), google.fetch, () => T0);
  const ask = <T extends OpInput>(op: T, actor: Actor = ada) => perform(env.DB, actor, op, T0, sources);
  // Email is offered everywhere and comes from no Google account: these are Google's.
  const states = async () => Object.fromEntries((await ask({ type: "source.list" })).sources.filter((s) => s.provider === "Google").map((s) => [s.id, s.state]));
  return { google, ada, ask, states, sources };
}

const refusal = async (asking: Promise<unknown>) => {
  try {
    await asking;
  } catch (err) {
    if (err instanceof OpError) return `${err.code}: ${err.message}`;
    throw err;
  }
  return "done";
};

/** Google lists the calendars, and from then on turns the token down. */
const listedThenTurnedDown = (google: FakeGoogle) => () => {
  google.valid.delete("at-1");
  return Response.json({ kind: "calendar#calendarList", items: google.calendars.map(({ events: _, ...calendar }) => calendar) });
};

afterEach(() => vi.unstubAllGlobals());

describe("tokens at rest", () => {
  it("are sealed with a fresh nonce each time, and open only under the same key, for the same row, unchanged", async () => {
    const v = vault(KEY)!;
    const [a, b] = [await v.seal("ya29.secret", "google:p1:access"), await v.seal("ya29.secret", "google:p1:access")];
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("ya29");
    expect(await v.open(a, "google:p1:access")).toBe("ya29.secret");
    expect(await v.open(a, "google:p2:access")).toBeNull();
    expect(await v.open(a, "google:p1:refresh")).toBeNull();
    expect(await vault(`${KEY}x`)!.open(a, "google:p1:access")).toBeNull();
    const [version, nonce, body] = a.split(".") as [string, string, string];
    expect(await v.open(`${version}.${nonce}.${body.slice(0, -2)}${body.endsWith("AA") ? "BB" : "AA"}`, "google:p1:access")).toBeNull();
    for (const junk of [null, "", "v1", "v2.a.b", "ya29.secret"]) expect(await v.open(junk, "google:p1:access")).toBeNull();
  });

  it("has no vault without a key, or with one short enough to guess", () => {
    expect(vault(undefined)).toBeNull();
    expect(vault("")).toBeNull();
    expect(vault("short")).toBeNull();
  });

  it("are never in the database as Google gave them, and never in anything an operation or /api/me answers", async () => {
    const { ada, ask } = await connected({ access: "ya29.ACCESS-plain", refresh: "1//REFRESH-plain" });
    const row = JSON.stringify(await env.DB.prepare("SELECT * FROM source_connections WHERE person_id = ?").bind(ada.personId).first());
    expect(row).not.toMatch(/ACCESS-plain|REFRESH-plain/);
    const said = JSON.stringify([await ask({ type: "source.list" }), await ask({ type: "event.list", ...WEEK }), await ask({ type: "contact.list" }), await whoAmI(env.DB, ada.personId)]);
    expect(said).not.toMatch(/ACCESS-plain|REFRESH-plain|v1\.[A-Za-z0-9_-]{16}\./);
    const me = await worker.fetch(new Request("https://commonink.app/api/me", { headers: { Cookie: `__Host-ink_session=${await sign({ personId: ada.personId }, SECRET, 600)}` } }) as never, configured({ ALLOWED_EMAILS: (await whoAmI(env.DB, ada.personId)).person.email }));
    expect(me.status).toBe(200);
    expect(await me.text()).not.toMatch(/ACCESS-plain|REFRESH-plain|token/i);
  });

  it("are not kept at all without a key, and Google's data sources aren't offered", async () => {
    const { ask } = await connected({}, { TOKEN_KEY: undefined });
    expect((await ask({ type: "source.list" })).sources.map((s) => s.id)).toEqual(["email"]);
    expect(await refusal(ask({ type: "source.connect", id: "google-calendar" }))).toBe("not_found: No such data source");
  });
});

describe("Google Calendar", () => {
  it("lists the events of the calendars the member shows, page after page, as Common Ink's events", async () => {
    const { google, ask } = await connected();
    google.pageSize = 2;
    const { events, sources } = await ask({ type: "event.list", ...WEEK });
    expect(sources).toEqual([{ id: "google-calendar", kind: "calendar", name: "Google Calendar", provider: "Google", state: "connected", writable: true, account: "ada@example.com" }]);
    expect(events.map((e) => [e.title, e.calendar, e.when.allDay ? `${e.when.from}..${e.when.to}` : new Date(e.when.from).toISOString(), e.editable, e.recurring])).toEqual([
      ["Columbus Day", "Holidays", "2026-10-12..2026-10-12", false, false],
      ["Lunch with Sam", "Ada", "2026-10-13T17:00:00.000Z", true, false],
      ["Offsite", "Ada", "2026-10-14..2026-10-15", true, false],
      ["Standup", "Ada", "2026-10-15T14:00:00.000Z", true, true],
      ["Their meeting", "Ada", "2026-10-16T15:00:00.000Z", false, false],
    ]);
    expect(events[1]).toMatchObject({ sourceId: "google-calendar", id: "ada@example.com lunch", color: "#9fe1e7", timeZone: "America/Chicago", location: "Cafe Lula", etag: '"1"', url: "https://www.google.com/calendar/event?eid=bHVuY2g" });
    // Three pages of five events at two a page, and each occurrence asked for on its own.
    const asked = google.asked("GET", /\/calendars\/ada%40example\.com\/events$/);
    expect(asked.map((s) => s.url.searchParams.get("pageToken"))).toEqual([null, "2", "4"]);
    expect(Object.fromEntries(asked[0]!.url.searchParams)).toEqual({ timeMin: "2026-10-10T00:00:00.000Z", timeMax: "2026-10-19T00:00:00.000Z", singleEvents: "true", orderBy: "startTime", maxResults: "2500" });
    expect(google.asked("GET", /old%40group/)).toEqual([]);
  });

  it("changes an event only if it is as the member read it, and says what Google now holds", async () => {
    const { google, ask } = await connected();
    const changed = await ask({ type: "event.update", sourceId: "google-calendar", id: "ada@example.com lunch", etag: '"1"', title: "Lunch with Sam and Lin", when: { allDay: false, from: Date.parse("2026-10-13T18:00:00Z"), to: Date.parse("2026-10-13T19:00:00Z") } });
    expect(changed).toMatchObject({ title: "Lunch with Sam and Lin", etag: '"2"', when: { allDay: false, from: Date.parse("2026-10-13T18:00:00Z") }, timeZone: "America/Chicago", location: "Cafe Lula" });
    const [patch] = google.asked("PATCH", /./);
    expect(patch!.url.href).toBe("https://www.googleapis.com/calendar/v3/calendars/ada%40example.com/events/lunch");
    expect(patch!.headers.get("If-Match")).toBe('"1"');
    expect(patch!.headers.get("Authorization")).toBe("Bearer at-1");
    expect(JSON.parse(patch!.body)).toEqual({ summary: "Lunch with Sam and Lin", start: { dateTime: "2026-10-13T18:00:00.000Z", date: null }, end: { dateTime: "2026-10-13T19:00:00.000Z", date: null } });

    // The same reading, used again, is stale: Google answers 412 and the event keeps the first change.
    expect(await refusal(ask({ type: "event.update", sourceId: "google-calendar", id: "ada@example.com lunch", etag: '"1"', title: "Clobbered" }))).toBe("conflict: It was changed in Google since you opened it. Open it again, then make your change.");
    expect(google.calendars[0]!.events[0]!.summary).toBe("Lunch with Sam and Lin");
  });

  it("writes an all-day event with the day after its last as its end, and takes the time away", () => {
    expect(patchOf({ when: { allDay: true, from: "2026-12-31", to: "2027-01-01" } })).toEqual({ start: { date: "2026-12-31", dateTime: null, timeZone: null }, end: { date: "2027-01-02", dateTime: null, timeZone: null } });
    expect(patchOf({ title: "", location: "Here" })).toEqual({ summary: "", location: "Here" });
  });

  it("refuses to change an event in a calendar the member can only read, or one they don't organize, and sends Google nothing", async () => {
    const { google, ask } = await connected();
    expect(await refusal(ask({ type: "event.update", sourceId: "google-calendar", id: "en.usa#holiday@group.v.calendar.google.com h1", etag: '"1"', title: "Workday" }))).toBe('forbidden: You can only read the calendar "Holidays"');
    expect(await refusal(ask({ type: "event.update", sourceId: "google-calendar", id: "ada@example.com theirs", etag: '"1"', title: "Mine now" }))).toBe('forbidden: You can only read the calendar "Ada"');
    expect(google.asked("PATCH", /./)).toEqual([]);
  });

  it("lists the calendars the member shows, and adds an event to one they may write as Google's events.insert takes it", async () => {
    const { google, ask } = await connected();
    expect((await ask({ type: "event.list", ...WEEK })).calendars).toEqual([
      { sourceId: "google-calendar", id: "ada@example.com", name: "Ada", color: "#9fe1e7", writable: true },
      { sourceId: "google-calendar", id: "en.usa#holiday@group.v.calendar.google.com", name: "Holidays", color: null, writable: false },
    ]);
    google.sent.length = 0;
    const when = { allDay: false as const, from: Date.parse("2026-10-15T15:00:00Z"), to: Date.parse("2026-10-15T15:30:00Z") };
    const made = await ask({ type: "event.create", sourceId: "google-calendar", calendarId: "ada@example.com", title: "Dentist", when, location: "Main St", description: "Bring the card" });
    expect(made).toEqual({ sourceId: "google-calendar", id: "ada@example.com made5", calendarId: "ada@example.com", calendar: "Ada", color: "#9fe1e7", title: "Dentist", when, timeZone: null, location: "Main St", description: "Bring the card", recurring: false, editable: true, etag: '"1"', url: "https://www.google.com/calendar/event?eid=bWFkZQ" });
    // The calendar is read once to say whether it may be added to, once more as it is added to, and the event is sent once.
    expect(google.sent.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
      "GET /calendar/v3/users/me/calendarList/ada%40example.com",
      "GET /calendar/v3/users/me/calendarList/ada%40example.com",
      "POST /calendar/v3/calendars/ada%40example.com/events",
    ]);
    const [insert] = google.asked("POST", /./);
    expect(insert!.headers.get("Authorization")).toBe("Bearer at-1");
    expect(JSON.parse(insert!.body)).toEqual({ summary: "Dentist", location: "Main St", description: "Bring the card", start: { dateTime: "2026-10-15T15:00:00.000Z", date: null }, end: { dateTime: "2026-10-15T15:30:00.000Z", date: null } });

    await ask({ type: "event.create", sourceId: "google-calendar", calendarId: "ada@example.com", title: "Away", when: { allDay: true, from: "2026-10-16", to: "2026-10-17" } });
    expect(JSON.parse(google.asked("POST", /./)[1]!.body)).toEqual({ summary: "Away", start: { date: "2026-10-16", dateTime: null, timeZone: null }, end: { date: "2026-10-18", dateTime: null, timeZone: null } });
    expect((await ask({ type: "event.list", ...WEEK })).events.filter((e) => e.id.includes(" made")).map((e) => [e.title, e.when.allDay ? `${e.when.from}..${e.when.to}` : new Date(e.when.from).toISOString()])).toEqual([
      ["Dentist", "2026-10-15T15:00:00.000Z"],
      ["Away", "2026-10-16..2026-10-17"],
    ]);
  });

  it("refuses to add to a calendar the member can only read, doesn't show, or doesn't have, and sends Google no event", async () => {
    const { google, ask } = await connected();
    const add = (calendarId: string) => refusal(ask({ type: "event.create", sourceId: "google-calendar", calendarId, title: "x", when: { allDay: true, from: "2026-10-16", to: "2026-10-16" } }));
    expect(await add("en.usa#holiday@group.v.calendar.google.com")).toBe('forbidden: You can only read the calendar "Holidays"');
    for (const calendarId of ["old@group.calendar.google.com", "nobody@example.com", "..", ".", "../../users/me/settings", "https://evil.example/", "ada@example.com/events"]) expect(await add(calendarId), calendarId).toBe("not_found: No such calendar");
    for (const sent of google.sent) expect(sent.url.pathname, sent.url.href).toMatch(/^\/calendar\/v3\/users\/me\/calendarList\/[^/]+$/);
    // A calendar the member stopped being able to write while it was being added to is refused by Google's side of it too.
    const [ada] = google.calendars;
    google.once.set("GET /calendar/v3/users/me/calendarList/ada%40example.com", () => {
      ada!.accessRole = "reader";
      return Response.json({ kind: "calendar#calendarListEntry", ...ada, accessRole: "owner", events: undefined });
    });
    expect(await add("ada@example.com")).toBe('forbidden: You can only read the calendar "Ada"');
    expect(google.asked("POST", /./)).toEqual([]);
  });

  it("takes an answer to an insert that isn't JSON, isn't an event, or is an error as Google not answering, and says so", async () => {
    const { google, ask } = await connected();
    const add = () => refusal(ask({ type: "event.create", sourceId: "google-calendar", calendarId: "ada@example.com", title: "x", when: { allDay: true, from: "2026-10-16", to: "2026-10-16" } }));
    const POST = "POST /calendar/v3/calendars/ada%40example.com/events";
    google.once.set(POST, () => new Response("<html>ya29.token-in-a-page</html>", { status: 200 }));
    expect(await add()).toBe("unavailable: Google answered with something Common Ink couldn't read. Try again in a moment.");
    google.once.set(POST, () => Response.json({ id: "x", etag: '"1"' }));
    expect(await add()).toBe("unavailable: Google answered with something Common Ink can't read");
    google.once.set(POST, () => Response.json({ error: { code: 500, message: "Backend Error" } }, { status: 500 }));
    expect(await add()).toBe("unavailable: Google is busy. Try again in a moment.");
    google.once.set(POST, () => Response.json({ error: { code: 403, errors: [{ reason: "requiredAccessLevel" }] } }, { status: 403 }));
    expect(await add()).toBe("forbidden: Google doesn't allow that change");
    // Gone between being read and being added to: refused as a change to an event that went is.
    google.once.set(POST, () => Response.json({ error: { code: 404 } }, { status: 404 }));
    expect(await add()).toBe("forbidden: No such calendar");
    expect(google.calendars[0]!.events).toHaveLength(5);
  });

  it("sends a record's id nowhere but into one segment of a path on Google's host, whatever it says", async () => {
    const { google, ask } = await connected();
    const hostile = ["https://evil.example/steal lunch", "ada@example.com ../../../users/me/settings", "ada@example.com lunch?alt=media", "../../oauth2/v1/tokeninfo lunch", "ada@example.com lunch extra", " lunch", "ada@example.com ", "ada@example.com ..", "ada@example.com .", ".. lunch", ". lunch"];
    for (const id of hostile) expect(await refusal(ask({ type: "event.update", sourceId: "google-calendar", id, etag: '"1"', title: "x" })), id).toMatch(/^not_found: /);
    for (const id of ["people/../../v1/otherContacts", "people/c1?x=y", "https://evil.example/", "people/c1/../c2"]) expect(await refusal(ask({ type: "record.refer", sourceId: "google-contacts", id })), id).toBe("not_found: No such record");
    for (const sent of google.sent) {
      expect(["https://www.googleapis.com", "https://people.googleapis.com"]).toContain(sent.url.origin);
      expect(sent.url.pathname).toMatch(/^\/calendar\/v3\/(users\/me\/calendarList|calendars)\/[^/]+(\/events\/[^/]+)?$/);
      expect(sent.url.search).toBe("");
    }
    expect(google.asked("PATCH", /./)).toEqual([]);
  });
});

describe("when Google stops taking a token", () => {
  it("renews a lapsed token before asking, keeps the new one sealed, and asks with it", async () => {
    const { google, ada, ask } = await connected({ expiresAt: T0 - 1 });
    expect((await ask({ type: "event.list", ...WEEK })).events).toHaveLength(5);
    const [renewal] = google.asked("POST", /^\/token$/);
    expect(Object.fromEntries(new URLSearchParams(renewal!.body))).toEqual({ client_id: "client-id", client_secret: "client-secret", refresh_token: "rt-1", grant_type: "refresh_token" });
    expect(new Set(google.asked("GET", /calendar/).map((s) => s.headers.get("Authorization")))).toEqual(new Set(["Bearer at-2"]));
    const kept = (await connectionOf(env.DB, ada.personId, "google"))!;
    expect(kept.accessToken).not.toContain("at-2");
    expect(await vault(KEY)!.open(kept.accessToken, `google:${ada.personId}:access`)).toBe("at-2");
    // Google's renewal named no scopes and gave no refresh token: both are kept as they were.
    expect(kept.scopes).toEqual(ALL_SCOPES);
    expect(await vault(KEY)!.open(kept.refreshToken, `google:${ada.personId}:refresh`)).toBe("rt-1");
    expect(kept.expiresAt).toBe(T0 + 3_599_000);
  });

  it("renews once when Google answers 401, asks once more, and carries on", async () => {
    const { google, ask } = await connected();
    google.valid.delete("at-1");
    expect((await ask({ type: "contact.list" })).contacts.map((c) => c.name)).toEqual(["nameless@example.com", "Sam Okafor", "Zoë Álvarez"]);
    expect(google.asked("POST", /^\/token$/)).toHaveLength(1);
    expect(google.asked("GET", /connections/).map((s) => s.headers.get("Authorization"))).toEqual(["Bearer at-1", "Bearer at-2"]);
  });

  it("asks the member to reconnect when the renewed token is turned down too, and throws the tokens away", async () => {
    const { google, ada, ask, states } = await connected();
    google.valid.delete("at-1");
    google.dead.add("at-2");
    expect((await ask({ type: "contact.list" })).sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
    expect(google.asked("GET", /connections/)).toHaveLength(2);
    expect(await states()).toEqual({ "google-calendar": "needs_reconnect", "google-contacts": "needs_reconnect" });
    expect(await connectionOf(env.DB, ada.personId, "google")).toMatchObject({ accessToken: null, refreshToken: null, broken: true });
  });

  it("asks the member to reconnect when Google no longer takes the refresh token, or there never was one", async () => {
    const revoked = await connected({ expiresAt: T0 - 1 });
    revoked.google.refreshes.clear();
    expect((await revoked.ask({ type: "event.list", ...WEEK })).sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
    expect(await refusal(revoked.ask({ type: "event.update", sourceId: "google-calendar", id: "ada@example.com lunch", etag: '"1"', title: "x" }))).toBe("conflict: Reconnect Google Calendar first");
    expect(revoked.google.asked("GET", /calendar/)).toEqual([]);

    const hourly = await connected({ refresh: null, expiresAt: T0 - 1 });
    expect(await hourly.states()).toEqual({ "google-calendar": "needs_reconnect", "google-contacts": "needs_reconnect" });
    const fresh = await connected({ refresh: null });
    expect(await fresh.states()).toEqual({ "google-calendar": "connected", "google-contacts": "connected" });
  });

  it("keeps nothing of a renewal that lands after the member disconnected: the connection stays ended", async () => {
    const { google, ada, ask, states } = await connected({ expiresAt: T0 - 1 });
    google.during.set("POST /token", () => ask({ type: "source.disconnect", id: "google-calendar" }));
    const listed = await ask({ type: "event.list", ...WEEK });
    expect(listed.events).toEqual([]);
    expect(listed.sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
    expect(await connectionOf(env.DB, ada.personId, "google")).toBeNull();
    expect(await states()).toEqual({ "google-calendar": "not_connected", "google-contacts": "not_connected" });
    // The token Google handed over for the ended connection is asked nothing.
    expect(google.asked("GET", /calendar/)).toEqual([]);
    expect(google.revoked).toEqual(["rt-1"]);
  });

  it("keeps nothing of a renewal for a connection that was ended and made again meanwhile", async () => {
    const { google, ada, ask } = await connected({ expiresAt: T0 - 1 });
    google.refreshes.set("rt-again", "at-again");
    google.during.set("POST /token", () => keepTokens(env.DB, vault(KEY)!, ada.personId, "google", "ada@example.com", { accessToken: "at-again-0", refreshToken: "rt-again", expiresAt: T0 + 3_600_000, scopes: ALL_SCOPES }, T0));
    await ask({ type: "event.list", ...WEEK });
    const kept = (await connectionOf(env.DB, ada.personId, "google"))!;
    expect(await vault(KEY)!.open(kept.accessToken, `google:${ada.personId}:access`)).toBe("at-again-0");
    expect(await vault(KEY)!.open(kept.refreshToken, `google:${ada.personId}:refresh`)).toBe("rt-again");
  });

  it("leaves a data source that needs reconnecting as it is when the token is renewed, and the account too", async () => {
    const { google, ada, ask, states } = await connected();
    google.once.set("GET /calendar/v3/users/me/calendarList", INSUFFICIENT.calendar);
    await ask({ type: "event.list", ...WEEK });
    await env.DB.prepare("UPDATE source_connections SET expires_at = ? WHERE person_id = ?").bind(T0 - 1, ada.personId).run();
    expect((await ask({ type: "contact.list" })).contacts).toHaveLength(3);
    expect(google.asked("POST", /^\/token$/)).toHaveLength(1);
    expect(await states()).toEqual({ "google-calendar": "needs_reconnect", "google-contacts": "connected" });
    expect(await connectionOf(env.DB, ada.personId, "google")).toMatchObject({ account: "ada@example.com", lapsed: ["google-calendar"], broken: false, scopes: ALL_SCOPES });
    // And the calendar is not asked again at each renewal only to be refused again.
    const before = google.asked("GET", /calendar/).length;
    await ask({ type: "event.list", ...WEEK });
    expect(google.asked("GET", /calendar/)).toHaveLength(before);
  });

  it("renews once for a read of many calendars whose token Google turns down, and marks a dead connection once", async () => {
    const many = await connected();
    many.google.calendars = Array.from({ length: 10 }, (_, i) => ({ ...mine(), id: `cal${i}@group.calendar.google.com`, primary: false, selected: true }));
    // The list of calendars is read with the old token, which stops being taken before their events are.
    many.google.once.set("GET /calendar/v3/users/me/calendarList", listedThenTurnedDown(many.google));
    expect((await many.ask({ type: "event.list", ...WEEK })).events).toHaveLength(40);
    expect(many.google.asked("POST", /^\/token$/)).toHaveLength(1);
    expect(many.google.asked("GET", /events$/).filter((s) => s.headers.get("Authorization") === "Bearer at-2")).toHaveLength(10);

    const dead = await connected();
    dead.google.calendars = many.google.calendars;
    dead.google.refreshes.clear();
    dead.google.once.set("GET /calendar/v3/users/me/calendarList", listedThenTurnedDown(dead.google));
    const writes: string[] = [];
    const watched = { ...env.DB, prepare: (sql: string) => (/SET broken = 1/.test(sql) && writes.push(sql), env.DB.prepare(sql)), batch: env.DB.batch.bind(env.DB) } as unknown as D1Database;
    const sources = sourcesFor({ ...configured(), DB: watched } as Env, new URL("https://commonink.app/"), dead.google.fetch, () => T0);
    expect((await perform(env.DB, dead.ada, { type: "event.list", ...WEEK }, T0, sources)).sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
    expect(dead.google.asked("POST", /^\/token$/)).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it("says Google is busy when renewing fails for any other reason, and leaves the connection as it was", async () => {
    const { google, ask, states } = await connected({ expiresAt: T0 - 1 });
    google.once.set("POST /token", () => new Response("upstream", { status: 503 }));
    expect(await refusal(ask({ type: "event.list", ...WEEK }))).toBe("unavailable: Google didn't answer for renewing access. Try again in a moment.");
    expect(await states()).toEqual({ "google-calendar": "connected", "google-contacts": "connected" });
  });

  it("marks one data source as needing to be reconnected when what was agreed to no longer covers it, and leaves the other", async () => {
    const { google, ask, states } = await connected();
    google.once.set("GET /calendar/v3/users/me/calendarList", INSUFFICIENT.calendar);
    expect((await ask({ type: "event.list", ...WEEK })).sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
    expect(await states()).toEqual({ "google-calendar": "needs_reconnect", "google-contacts": "connected" });
    expect((await ask({ type: "contact.list" })).contacts).toHaveLength(3);
    google.once.set("GET /v1/people/me/connections", INSUFFICIENT.people);
    expect((await ask({ type: "contact.list" })).sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
    expect(google.asked("POST", /^\/token$/)).toEqual([]);
  });

  it("says a data source isn't connected when the member never agreed to all it needs", async () => {
    const onlyContacts = await connected({ scopes: [...SOURCE_SCOPES["google-contacts"]] });
    expect(await onlyContacts.states()).toEqual({ "google-calendar": "not_connected", "google-contacts": "connected" });
    expect((await onlyContacts.ask({ type: "event.list", ...WEEK })).events).toEqual([]);
    expect(onlyContacts.google.asked("GET", /calendar/)).toEqual([]);
    const halfCalendar = await connected({ scopes: [CALENDAR_SCOPES[0]!] });
    expect(await halfCalendar.states()).toEqual({ "google-calendar": "not_connected", "google-contacts": "not_connected" });
  });

  it("says Google is busy for a rate limit or a failure of Google's, and marks nothing", async () => {
    const { google, ask, states } = await connected();
    for (const answer of [RATE_LIMITED.usage, RATE_LIMITED.tooMany, () => new Response("oops", { status: 500 }), () => Response.json({ items: "not a list" })]) {
      google.once.set("GET /calendar/v3/users/me/calendarList", answer);
      expect(await refusal(ask({ type: "event.list", ...WEEK }))).toMatch(/^unavailable: Google /);
    }
    expect(await states()).toEqual({ "google-calendar": "connected", "google-contacts": "connected" });
  });

  it("opens nothing after the key changes: the member reconnects", async () => {
    const { ask } = await connected({}, { TOKEN_KEY: `${KEY}-rotated` });
    expect((await ask({ type: "contact.list" })).sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
  });
});

describe("what one operation may ask of Google", () => {
  it("reaches Google through a fetch called as a plain function, which is the only way the runtime's own can be called", async () => {
    // The default, with nothing handed in: the runtime's fetch, here standing behind a global that is as strict about `this` as it is.
    const { google, ada } = await connected();
    vi.stubGlobal("fetch", google.fetch);
    const sources = sourcesFor(configured(), new URL("https://commonink.app/"));
    expect((await perform(env.DB, ada, { type: "event.list", ...WEEK }, T0, sources)).events).toHaveLength(5);
    expect((await perform(env.DB, ada, { type: "contact.list" }, T0, sources)).contacts).toHaveLength(3);
  });

  it("reads an account with thirty calendars a few at a time, the twenty it covers, each in one request", async () => {
    const { google, ask } = await connected();
    google.calendars = Array.from({ length: 30 }, (_, i) => ({ ...mine(), id: `cal${i}@group.calendar.google.com`, primary: i === 0, selected: true }));
    expect((await ask({ type: "event.list", ...WEEK })).events).toHaveLength(80);
    expect(google.most).toBeLessThanOrEqual(6);
    expect(google.most).toBeGreaterThan(1);
    expect(google.sent).toHaveLength(21);
    expect(google.asked("GET", /events$/)[0]!.url.searchParams.get("maxResults")).toBe("2500");
  });

  it("stops before a Worker's allowance of requests is spent, and says there is too much", async () => {
    const { google, ask, states } = await connected();
    google.calendars = Array.from({ length: 30 }, (_, i) => ({ ...mine(), id: `cal${i}@group.calendar.google.com`, selected: true }));
    google.pageSize = 1;
    expect(await refusal(ask({ type: "event.list", ...WEEK }))).toBe("unavailable: There is too much in Google to fetch at once. Show fewer calendars in Google Calendar, or look at a shorter span.");
    expect(google.sent.length).toBeLessThanOrEqual(45);
    expect(await states()).toEqual({ "google-calendar": "connected", "google-contacts": "connected" });
  });

  it("tells the member a request that took too long from one that couldn't be sent, and writes down which, with no id in it and nothing of what the runtime said", async () => {
    const { google, ask } = await connected();
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: string) => void warned.push(line));
    google.once.set("GET /calendar/v3/users/me/calendarList", () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await refusal(ask({ type: "event.list", ...WEEK }))).toBe("unavailable: Google took too long to answer. Try again in a moment.");
    google.once.set("GET /calendar/v3/users/me/calendarList/ada%40example.com", () => {
      throw new TypeError("Network connection lost sending Bearer ya29.token-in-a-message");
    });
    expect(await refusal(ask({ type: "event.update", sourceId: "google-calendar", id: "ada@example.com lunch", etag: '"1"', title: "x" }))).toBe("unavailable: Common Ink couldn't reach Google. Try again in a moment.");
    google.once.set("GET /v1/people/me/connections", () => {
      throw new Error("Too many subrequests.");
    });
    expect(await refusal(ask({ type: "contact.list" }))).toMatch(/^unavailable: There is too much in Google to fetch at once/);
    expect(warned).toEqual([
      "Google request failed: TimeoutError (GET www.googleapis.com/calendar/v3/users/me/calendarList)",
      "Google request failed: TypeError (GET www.googleapis.com/calendar/v3/users/me/calendarList/…)",
      "Google request failed: Error, too many subrequests (GET people.googleapis.com/v1/people/me/connections)",
    ]);
    vi.restoreAllMocks();
  });

  it("takes an answer that isn't JSON for no answer, and passes on nothing of what it said", async () => {
    const { google, ask } = await connected();
    google.once.set("GET /calendar/v3/users/me/calendarList", () => new Response("<html>ya29.token-in-a-page</html>", { status: 200 }));
    expect(await refusal(ask({ type: "event.list", ...WEEK }))).toBe("unavailable: Google answered with something Common Ink couldn't read. Try again in a moment.");
  });
});

describe("Google Contacts", () => {
  it("lists every page of the member's contacts, and reads one by the reference a note holds", async () => {
    const { google, ask } = await connected();
    google.pageSize = 3;
    const { contacts, sources, more } = await ask({ type: "contact.list" });
    expect(sources).toEqual([{ id: "google-contacts", kind: "contacts", name: "Google Contacts", provider: "Google", state: "connected", writable: false, reconnectToWrite: true, account: "ada@example.com" }]);
    expect(more).toBe(false);
    expect(contacts).toEqual([
      { sourceId: "google-contacts", id: "people/c3", name: "nameless@example.com", emails: [{ value: "nameless@example.com", type: null }], phones: [], organization: null, url: "https://contacts.google.com/person/c3" },
      { sourceId: "google-contacts", id: "people/c1", name: "Sam Okafor", emails: [], phones: [{ value: "+1 555 0142", type: "mobile" }], organization: "Okafor Plumbing", url: "https://contacts.google.com/person/c1" },
      { sourceId: "google-contacts", id: "people/c2", name: "Zoë Álvarez", emails: [{ value: "zoe@example.com", type: null }, { value: "z@example.org", type: null }], phones: [], organization: null, url: "https://contacts.google.com/person/c2" },
    ]);
    const pages = google.asked("GET", /connections$/);
    expect(pages.map((s) => s.url.searchParams.get("pageToken"))).toEqual([null, "3"]);
    expect(pages[0]!.url.searchParams.get("personFields")).toBe("names,emailAddresses,phoneNumbers,organizations");

    const { ref } = await ask({ type: "record.refer", sourceId: "google-contacts", id: "people/c1" });
    expect(await ask({ type: "record.read", ref })).toMatchObject({ kind: "contact", contact: { name: "Sam Okafor" } });
    expect(google.asked("GET", /\/v1\/people\/c1$/)).toHaveLength(2);
  });
});

describe("editing a Google contact", () => {
  const editing = () => connected({ scopes: [...ALL_SCOPES, CONTACTS_WRITE] });
  const sentBody = (google: FakeGoogle, method: string, path: RegExp) => google.asked(method, path).map((s) => JSON.parse(s.body) as unknown);

  it("is refused while the member agreed only to read contacts, before anything is sent, and connecting again with edit asks for the scope that changes them", async () => {
    const { google, ask } = await connected();
    expect((await ask({ type: "source.list" })).sources.find((s) => s.id === "google-contacts")).toMatchObject({ state: "connected", writable: false, reconnectToWrite: true });
    expect(await refusal(ask({ type: "contact.update", sourceId: "google-contacts", id: "people/c1", etag: "%Eg", phones: [] }))).toBe("forbidden: Connect Google Contacts again to edit contacts");
    expect(await refusal(ask({ type: "contact.photo", sourceId: "google-contacts", id: "people/c1", photo: null }))).toBe("forbidden: Connect Google Contacts again to edit contacts");
    expect(await refusal(ask({ type: "contact.create", sourceId: "google-contacts", name: "Grace" }))).toBe("forbidden: Connect Google Contacts again to edit contacts");
    expect(google.sent).toEqual([]);
    const { redirect } = await ask({ type: "source.connect", id: "google-contacts", back: "/person/Sam%20Okafor", edit: true });
    expect(redirect).toBe("/auth/google/connect?source=google-contacts&edit=1&next=%2Fperson%2FSam%2520Okafor");
  });

  it("is a contacts data source that takes changes once the member agreed to the scope that changes contacts, which reads them too", async () => {
    const { ask } = await connected({ scopes: [...CALENDAR_SCOPES, CONTACTS_WRITE] });
    expect((await ask({ type: "source.list" })).sources.find((s) => s.id === "google-contacts")).toEqual({ id: "google-contacts", kind: "contacts", name: "Google Contacts", provider: "Google", state: "connected", writable: true, account: "ada@example.com" });
    expect((await ask({ type: "contact.list" })).contacts).toHaveLength(3);
  });

  it("changes only the fields named, as People's updateContact takes them, keeping each label and the organization's department, and answers the card Google holds", async () => {
    const { google, ask } = await editing();
    const card = await ask({ type: "contact.update", sourceId: "google-contacts", id: "people/c1", etag: "%Eg", name: "Samuel Okafor", phones: [{ value: "+1 555 0142", type: "mobile" }, { value: "+1 555 0199", type: null }], emails: [{ value: "sam@okafor.example", type: null }], title: null, birthday: "--04-21", notes: "Text first" });
    const [patch] = google.asked("PATCH", /^\/v1\/people\/c1:updateContact$/);
    expect(patch!.url.searchParams.get("updatePersonFields")).toBe("names,emailAddresses,phoneNumbers,organizations,birthdays,biographies");
    expect(JSON.parse(patch!.body)).toEqual({
      etag: "%Eg",
      names: [{ unstructuredName: "Samuel Okafor" }],
      phoneNumbers: [{ value: "+1 555 0142", type: "mobile" }, { value: "+1 555 0199" }],
      emailAddresses: [{ value: "sam@okafor.example" }],
      organizations: [{ name: "Okafor Plumbing", department: "Boilers" }],
      birthdays: [{ date: { month: 4, day: 21 } }],
      biographies: [{ value: "Text first", contentType: "TEXT_PLAIN" }],
    });
    expect(card).toMatchObject({ id: "people/c1", name: "Samuel Okafor", phones: [{ value: "+1 555 0142", type: "mobile" }, { value: "+1 555 0199", type: null }], emails: [{ value: "sam@okafor.example", type: null }], organization: "Okafor Plumbing", title: null, birthday: "--04-21", notes: "Text first" });
    expect(card.etag).not.toBe("%Eg");
    // Read back, it is as Google now holds it.
    const { ref } = await ask({ type: "record.refer", sourceId: "google-contacts", id: "people/c1" });
    expect(await ask({ type: "record.read", ref })).toMatchObject({ contact: { name: "Samuel Okafor", etag: card.etag } });
  });

  it("writes each label with its value through updateContact, and a label the member wrote comes back from Google as its formattedType", async () => {
    const { google, ask } = await editing();
    const card = await ask({ type: "contact.update", sourceId: "google-contacts", id: "people/c2", etag: "%Eg", emails: [{ value: "zoe@example.com", type: "work" }, { value: "z@example.org", type: "Book club" }], urls: [{ value: "https://zoe.example", type: "blog" }] });
    const [patch] = google.asked("PATCH", /^\/v1\/people\/c2:updateContact$/);
    expect(patch!.url.searchParams.get("updatePersonFields")).toBe("emailAddresses,urls");
    expect(JSON.parse(patch!.body)).toEqual({ etag: "%Eg", emailAddresses: [{ value: "zoe@example.com", type: "work" }, { value: "z@example.org", type: "Book club" }], urls: [{ value: "https://zoe.example", type: "blog" }] });
    expect((google.people[1] as { emailAddresses: unknown }).emailAddresses).toEqual([{ value: "zoe@example.com", type: "work", formattedType: "Work" }, { value: "z@example.org", type: "Book club", formattedType: "Book club" }]);
    expect(card).toMatchObject({ emails: [{ value: "zoe@example.com", type: "work" }, { value: "z@example.org", type: "Book club" }], urls: [{ value: "https://zoe.example", type: "blog" }] });
    const { ref } = await ask({ type: "record.refer", sourceId: "google-contacts", id: "people/c2" });
    expect(await ask({ type: "record.read", ref })).toMatchObject({ contact: { emails: [{ value: "zoe@example.com", type: "work" }, { value: "z@example.org", type: "Book club" }] } });
    // Taken off, a label is sent as no type at all.
    await ask({ type: "contact.update", sourceId: "google-contacts", id: "people/c2", etag: card.etag, emails: [{ value: "zoe@example.com", type: null }] });
    expect(JSON.parse(google.asked("PATCH", /^\/v1\/people\/c2:updateContact$/)[1]!.body)).toMatchObject({ emailAddresses: [{ value: "zoe@example.com" }] });
  });

  it("refuses a change made from a stale reading, says so, and Google keeps what it had", async () => {
    const { google, ask } = await editing();
    await ask({ type: "contact.update", sourceId: "google-contacts", id: "people/c1", etag: "%Eg", notes: "First" });
    expect(await refusal(ask({ type: "contact.update", sourceId: "google-contacts", id: "people/c1", etag: "%Eg", notes: "Second" }))).toBe("conflict: It was changed in Google since you opened it. Open it again, then make your change.");
    expect((google.people[0] as { biographies: unknown }).biographies).toEqual([{ value: "First", contentType: "TEXT_PLAIN" }]);
    // A contact that isn't there is said so before anything is sent to change it.
    const before = google.sent.length;
    expect(await refusal(ask({ type: "contact.update", sourceId: "google-contacts", id: "people/c99", etag: "%Eg", notes: "x" }))).toBe("not_found: No such contact");
    expect(google.sent.slice(before).map((s) => s.method)).toEqual(["GET"]);
  });

  it("puts a picture on a contact with updateContactPhoto and takes it off with deleteContactPhoto, and a picture is drawn only from where Google keeps them", async () => {
    const { google, ask } = await editing();
    const pictured = await ask({ type: "contact.photo", sourceId: "google-contacts", id: "people/c1", photo: "/9j/4AAQSkZJRg==" });
    expect(sentBody(google, "PATCH", /^\/v1\/people\/c1:updateContactPhoto$/)).toEqual([{ photoBytes: "/9j/4AAQSkZJRg==", personFields: "names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,photos,urls" }]);
    expect(pictured.photo).toMatch(/^https:\/\/lh3\.googleusercontent\.com\/contacts\/c1-/);
    const taken = await ask({ type: "contact.photo", sourceId: "google-contacts", id: "people/c1", photo: null });
    expect(google.asked("DELETE", /^\/v1\/people\/c1:deleteContactPhoto$/)).toHaveLength(1);
    expect(taken.photo).toBeNull();
  });

  it("adds a contact with createContact, and lists it after", async () => {
    const { google, ask } = await editing();
    const made = await ask({ type: "contact.create", sourceId: "google-contacts", name: "Grace Hopper", emails: [{ value: "grace@example.com", type: null }] });
    expect(sentBody(google, "POST", /^\/v1\/people:createContact$/)).toEqual([{ names: [{ unstructuredName: "Grace Hopper" }], emailAddresses: [{ value: "grace@example.com" }] }]);
    expect(made).toMatchObject({ name: "Grace Hopper", emails: [{ value: "grace@example.com", type: null }], phones: [] });
    expect((await ask({ type: "contact.list", query: "grace" })).contacts.map((c) => c.id)).toEqual([made.id]);
  });

  it("writes a change as a whole for each field, an organization and title both cleared as none, and no field it wasn't given", () => {
    expect(personOf({ organization: null, title: null }, { organizations: [{ name: "A", title: "B" }, { name: "Second" }] })).toEqual({ person: { organizations: [{ name: "Second" }] }, fields: ["organizations"] });
    expect(personOf({ birthday: "1990-01-02", addresses: [] })).toEqual({ person: { birthdays: [{ date: { year: 1990, month: 1, day: 2 } }], addresses: [] }, fields: ["birthdays", "addresses"] });
    expect(personOf({ birthday: null, notes: null, urls: [{ value: "https://a.example", type: null }] })).toEqual({ person: { birthdays: [], biographies: [], urls: [{ value: "https://a.example" }] }, fields: ["birthdays", "biographies", "urls"] });
  });
});

describe("duplicate Google contacts", () => {
  /** Sam twice more: once by his number with Google's own country code, once by his name in other case. */
  const withDuplicates = async () => {
    const asked = await connected({ scopes: [...ALL_SCOPES, CONTACTS_WRITE] });
    asked.google.people.push(
      { resourceName: "people/c5", etag: "%Eg", names: [{ displayName: "Okafor Plumbing" }], phoneNumbers: [{ value: "555-0142", type: "work" }] },
      { resourceName: "people/c6", etag: "%Eg", names: [{ displayName: "sam okafor" }], emailAddresses: [{ value: "sam@okafor.example" }] },
    );
    return asked;
  };
  const listed = async (ask: Awaited<ReturnType<typeof connected>>["ask"]) => (await ask({ type: "contact.duplicates" })).pairs.map((p) => [p.contacts[0].name, p.contacts[1].name, p.sameBy]);

  it("are the pairs of the member's contacts that share a number or a name, read from Google and sent nothing", async () => {
    const { google, ask } = await withDuplicates();
    expect(await listed(ask)).toEqual([
      ["Okafor Plumbing", "Sam Okafor", ["phone"]],
      ["Sam Okafor", "sam okafor", ["name"]],
    ]);
    expect(google.sent.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("leave out a pair the member said is not the same person, for good, and only for them", async () => {
    const { ask, google } = await withDuplicates();
    expect(await ask({ type: "contact.dismiss", sourceId: "google-contacts", ids: ["people/c1", "people/c5"] })).toEqual({ dismissed: true });
    // Said again, the other way round, it is still one answer.
    await ask({ type: "contact.dismiss", sourceId: "google-contacts", ids: ["people/c5", "people/c1"] });
    expect(await listed(ask)).toEqual([["Sam Okafor", "sam okafor", ["name"]]]);
    expect(google.sent.filter((s) => s.method !== "GET")).toEqual([]);
    expect(await refusal(ask({ type: "contact.dismiss", sourceId: "google-contacts", ids: ["people/c1", "people/c1"] }))).toBe("invalid: A contact is always the same person as itself");
    const { results } = await env.DB.prepare("SELECT data_source, first_id, second_id FROM contact_dismissals").all();
    expect(results).toEqual([{ data_source: "google-contacts", first_id: "people/c1", second_id: "people/c5" }]);
  });

  it("are the member's alone to list and dismiss: an agent is refused both", async () => {
    const { ada, ask } = await withDuplicates();
    const agent: Actor = { kind: "agent", agentId: "agent-1", personId: ada.personId, workspaceId: ada.workspaceId };
    expect(await refusal(ask({ type: "contact.duplicates" }, agent))).toBe("forbidden: An agent can't contact.duplicates");
    expect(await refusal(ask({ type: "contact.dismiss", sourceId: "google-contacts", ids: ["people/c1", "people/c5"] }, agent))).toBe("forbidden: An agent can't contact.dismiss");
  });
});

describe("disconnecting", () => {
  it("tells Google to end what was agreed to, deletes the tokens, and leaves the member's other workspace mates untouched", async () => {
    const { google, ada, ask, sources } = await connected();
    const eve = await addMember(ada, "editor", "Eve");
    await keepTokens(env.DB, vault(KEY)!, eve.personId, "google", "eve@example.com", { accessToken: "at-eve", refreshToken: "rt-eve", expiresAt: T0 + 1000, scopes: ALL_SCOPES }, T0);
    expect((await ask({ type: "source.disconnect", id: "google-contacts" })).sources.map((s) => [s.id, s.state, s.account])).toEqual([["google-calendar", "not_connected", null], ["google-contacts", "not_connected", null], ["email", "not_connected", null]]);
    expect(google.revoked).toEqual(["rt-1"]);
    expect(await connectionOf(env.DB, ada.personId, "google")).toBeNull();
    expect(await connectionOf(env.DB, eve.personId, "google")).not.toBeNull();
    // An admin can't end another member's connection: the operation has nobody to name but the asker.
    await perform(env.DB, ada, { type: "source.disconnect", id: "google-calendar" }, T0, sources);
    expect(await connectionOf(env.DB, eve.personId, "google")).not.toBeNull();
  });

  it("deletes the tokens even when Google doesn't answer", async () => {
    const { google, ada, ask } = await connected();
    google.once.set("POST /revoke", () => new Response("down", { status: 503 }));
    await ask({ type: "source.disconnect", id: "google-calendar" });
    expect(await connectionOf(env.DB, ada.personId, "google")).toBeNull();
  });

  it("says where the member's browser goes to connect, and sends nothing to Google itself", async () => {
    const { google, ask } = await connected();
    expect((await ask({ type: "source.connect", id: "google-calendar", back: "/calendar" })).redirect).toBe("/auth/google/connect?source=google-calendar&next=%2Fcalendar");
    expect(google.sent).toEqual([]);
  });
});

describe("signing in and connecting with Google", () => {
  /** Who is on the list: two fixed emails, and everyone a session was made for here, since a session of someone off the list is nobody's. */
  const listed = new Set(["ada@example.com", "eve@example.com"]);
  const visit = (path: string, cookies: Record<string, string> = {}, more: Partial<Env> = {}) =>
    worker.fetch(new Request(`https://commonink.app${path}`, { headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") }, redirect: "manual" }) as never, configured({ ALLOWED_EMAILS: [...listed].join(" "), ...more }));
  const cookiesOf = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => [c.slice(0, c.indexOf("=")), decodeURIComponent(c.slice(c.indexOf("=") + 1, c.indexOf(";")))]));
  const sessionOf = async (personId: string) => {
    listed.add((await whoAmI(env.DB, personId)).person.email);
    return { "__Host-ink_session": await sign({ t: "session", personId }, SECRET, 600) };
  };

  /** The tokens Google was told to end. */
  const revoked: string[] = [];

  /** Google's token endpoint, answering the code from its redirect. */
  function tokenEndpoint(answer: { email: string; scope: string; refresh_token?: string; sub?: string }): URLSearchParams[] {
    const sent: URLSearchParams[] = [];
    revoked.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/revoke") {
        revoked.push((init.body as URLSearchParams).get("token")!);
        return Response.json({});
      }
      if (url !== "https://oauth2.googleapis.com/token") throw new Error(`A request left for ${url}`);
      sent.push(init.body as URLSearchParams);
      return Response.json({ access_token: "at-new", expires_in: 3599, token_type: "Bearer", scope: `openid ${answer.scope}`, ...(answer.refresh_token ? { refresh_token: answer.refresh_token } : {}), id_token: idToken({ aud: "client-id", iss: "https://accounts.google.com", email: answer.email, email_verified: true, name: "Ada", ...(answer.sub && { sub: answer.sub }) }) });
    });
    return sent;
  }

  /** Goes to Google and comes back with a code, as a browser would. */
  async function roundTrip(start: string, cookies: Record<string, string>, back: Record<string, string> = { code: "the-code" }) {
    const out = await visit(start, cookies);
    const asked = new URL(out.headers.get("Location")!);
    const state = cookiesOf(out);
    const home = await visit(`/auth/google/callback?${new URLSearchParams({ state: asked.searchParams.get("state")!, ...back })}`, { ...cookies, ...state });
    return { asked, home };
  }

  it("asks at sign-in for who the person is and both data sources, in a way Google answers with a refresh token", async () => {
    const asked = new URL((await visit("/auth/google")).headers.get("Location")!);
    expect(asked.origin + asked.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(asked.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", "profile", ...ALL_SCOPES]);
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ access_type: "offline", include_granted_scopes: "true", prompt: "select_account", code_challenge_method: "S256", response_type: "code" });
  });

  it("asks at sign-in only for who the person is where nothing could be kept: no key, no calendar or contacts on the consent screen", async () => {
    const asked = new URL((await visit("/auth/google", {}, { TOKEN_KEY: undefined })).headers.get("Location")!);
    expect(asked.searchParams.get("scope")).toBe("openid email profile");
    expect(asked.searchParams.has("access_type")).toBe(false);
  });

  it("ends at Google at once a grant that reaches data and won't be kept: no key, not on the list", async () => {
    // Someone who agreed to data sources before, signing in where there is no key: Google answers with what they agreed to then.
    tokenEndpoint({ email: "ada@example.com", scope: ALL_SCOPES.join(" ") });
    const out = await visit("/auth/google", {}, { TOKEN_KEY: undefined });
    const home = await visit(`/auth/google/callback?state=${new URL(out.headers.get("Location")!).searchParams.get("state")}&code=the-code`, cookiesOf(out), { TOKEN_KEY: undefined });
    expect(home.status).toBe(302);
    expect(revoked).toEqual(["at-new"]);

    tokenEndpoint({ email: "stranger@example.com", scope: ALL_SCOPES.join(" "), refresh_token: "rt-stranger" });
    const refused = await roundTrip("/auth/google", {});
    expect(refused.home.status).toBe(403);
    expect(revoked).toEqual(["rt-stranger"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE email = 'stranger@example.com'").first()).toEqual({ n: 0 });

    // Half of what the calendar needs opens no data source, so it isn't kept, and isn't left standing either.
    tokenEndpoint({ email: "eve@example.com", scope: CALENDAR_SCOPES[0]! });
    await roundTrip("/auth/google", {});
    expect(revoked).toEqual(["at-new"]);

    // A token that only says who the person is reaches no data, and is left to lapse: ending it would ask them to agree at every sign-in.
    tokenEndpoint({ email: "eve@example.com", scope: "email profile" });
    await roundTrip("/auth/google", {});
    expect(revoked).toEqual([]);
  });

  it("keeps what Google hands over at sign-in, sealed, for the person who signed in", async () => {
    const sent = tokenEndpoint({ email: "ada@example.com", scope: ALL_SCOPES.join(" "), refresh_token: "rt-new" });
    const { home } = await roundTrip("/auth/google?next=/calendar", {});
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe("/calendar");
    expect(sent[0]!.get("code")).toBe("the-code");
    const { id } = (await env.DB.prepare("SELECT id FROM people WHERE email = 'ada@example.com'").first<{ id: string }>())!;
    const kept = (await connectionOf(env.DB, id, "google"))!;
    expect(kept).toMatchObject({ account: "ada@example.com", scopes: ["openid", ...ALL_SCOPES], broken: false });
    expect(await vault(KEY)!.open(kept.refreshToken, `google:${id}:refresh`)).toBe("rt-new");
    expect(JSON.stringify(kept)).not.toMatch(/rt-new|at-new/);
    expect([...home.headers].join(" ")).not.toMatch(/rt-new|at-new/);
  });

  it("sends someone Google gave no refresh token on to agree once more, for what they agreed to and no more", async () => {
    await env.DB.prepare("DELETE FROM source_connections WHERE person_id IN (SELECT id FROM people WHERE email = 'eve@example.com')").run();
    tokenEndpoint({ email: "eve@example.com", scope: SOURCE_SCOPES["google-contacts"].join(" ") });
    const { home } = await roundTrip("/auth/google?next=/contacts", {});
    expect(home.headers.get("Location")).toBe("/auth/google/connect?source=google-contacts&next=%2Fcontacts");
    expect(cookiesOf(home)["__Host-ink_session"]).toBeTruthy();
  });

  it("keeps nothing for someone who agreed to no data source, and signs them in all the same", async () => {
    tokenEndpoint({ email: "eve@example.com", scope: "email profile" });
    await env.DB.prepare("DELETE FROM source_connections WHERE person_id IN (SELECT id FROM people WHERE email = 'eve@example.com')").run();
    const { home } = await roundTrip("/auth/google", {});
    expect(home.headers.get("Location")).toBe("/");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM source_connections c JOIN people p ON p.id = c.person_id WHERE p.email = 'eve@example.com'").first()).toEqual({ n: 0 });
  });

  it("connects one data source as the account signed in, showing what is agreed to, and returns where the member was", async () => {
    const ada = await newMember("Ada");
    const { email } = (await whoAmI(env.DB, ada.personId)).person;
    tokenEndpoint({ email, scope: CALENDAR_SCOPES.join(" "), refresh_token: "rt-connect" });
    const { asked, home } = await roundTrip("/auth/google/connect?source=google-calendar&next=/calendar", await sessionOf(ada.personId));
    expect(asked.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", "profile", ...CALENDAR_SCOPES]);
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ access_type: "offline", prompt: "consent", include_granted_scopes: "true", login_hint: email });
    expect(home.headers.get("Location")).toBe("/calendar");
    // Connecting starts no session: the member keeps the one they have.
    expect(cookiesOf(home)["__Host-ink_session"]).toBeUndefined();
    const kept = (await connectionOf(env.DB, ada.personId, "google"))!;
    expect(await vault(KEY)!.open(kept.refreshToken, `google:${ada.personId}:refresh`)).toBe("rt-connect");
  });

  it("connects contacts again to edit them, asking for the scope that changes them beside the one that reads them, and keeps what Google answers as contacts that take changes", async () => {
    const ada = await newMember("Ada");
    const { email } = (await whoAmI(env.DB, ada.personId)).person;
    // With include_granted_scopes Google answers everything agreed to, the old scopes with the new.
    tokenEndpoint({ email, scope: [...ALL_SCOPES, CONTACTS_WRITE].join(" "), refresh_token: "rt-edit" });
    const { asked, home } = await roundTrip("/auth/google/connect?source=google-contacts&edit=1&next=/person/Sam", await sessionOf(ada.personId));
    expect(asked.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", "profile", ...SOURCE_SCOPES["google-contacts"], CONTACTS_WRITE]);
    expect(home.headers.get("Location")).toBe("/person/Sam");
    expect((await connectionOf(env.DB, ada.personId, "google"))!.scopes).toContain(CONTACTS_WRITE);
    // Without edit nothing more than reading is asked.
    const plain = new URL((await visit("/auth/google/connect?source=google-contacts", await sessionOf(ada.personId))).headers.get("Location")!);
    expect(plain.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", "profile", ...SOURCE_SCOPES["google-contacts"]]);
  });

  it("keeps nothing when Google answers for another account, or the member said no, or isn't who started", async () => {
    const ada = await newMember("Ada");
    const eve = await newMember("Eve");
    tokenEndpoint({ email: "someone-else@example.com", scope: ALL_SCOPES.join(" "), refresh_token: "rt-other" });
    const other = await roundTrip("/auth/google/connect?source=google-calendar&next=/calendar", await sessionOf(ada.personId));
    expect(other.home.status).toBe(400);
    expect(await other.home.text()).toContain("another Google account");
    expect(revoked).toEqual(["rt-other"]);

    const refused = await roundTrip("/auth/google/connect?source=google-calendar&next=/calendar", await sessionOf(ada.personId), { error: "access_denied" });
    expect([refused.home.status, refused.home.headers.get("Location")]).toEqual([302, "/calendar"]);

    // The answer comes back to a browser that is now signed in as someone else.
    const out = await visit("/auth/google/connect?source=google-calendar", await sessionOf(ada.personId));
    const state = new URL(out.headers.get("Location")!).searchParams.get("state")!;
    const swapped = await visit(`/auth/google/callback?state=${state}&code=the-code`, { ...cookiesOf(out), ...(await sessionOf(eve.personId)) });
    expect(swapped.status).toBe(400);
    expect(revoked).toEqual(["rt-other", "rt-other"]);
    for (const person of [ada, eve]) expect(await connectionOf(env.DB, person.personId, "google")).toBeNull();
  });

  it("leaves at Google the agreement of another account that someone here keeps, when it answers for that account by mistake", async () => {
    const ada = await newMember("Ada");
    const eve = await newMember("Eve");
    const { email: eves } = (await whoAmI(env.DB, eve.personId)).person;
    tokenEndpoint({ email: eves, scope: ALL_SCOPES.join(" "), refresh_token: "rt-eve" });
    expect((await roundTrip("/auth/google/connect?source=google-calendar&next=/calendar", await sessionOf(eve.personId))).home.status).toBe(302);
    expect(await connectionOf(env.DB, eve.personId, "google")).not.toBeNull();

    // On a shared browser, Google answers Ada's request for Eve's account. Ending that would end Eve's.
    tokenEndpoint({ email: eves, scope: ALL_SCOPES.join(" "), refresh_token: "rt-eve-again" });
    const mistaken = await roundTrip("/auth/google/connect?source=google-calendar&next=/calendar", await sessionOf(ada.personId));
    expect(await mistaken.home.text()).toContain("another Google account");
    expect(revoked).toEqual([]);
    expect(await connectionOf(env.DB, ada.personId, "google")).toBeNull();
  });

  it("asks Google for nothing but data sources it has, and nothing for someone signed out", async () => {
    const ada = await newMember("Ada");
    expect((await visit("/auth/google/connect?source=google-drive", await sessionOf(ada.personId))).status).toBe(404);
    expect((await visit("/auth/google/connect", await sessionOf(ada.personId))).status).toBe(404);
    const signedOut = await visit("/auth/google/connect?source=google-calendar");
    expect([signedOut.status, signedOut.headers.get("Location")]).toEqual([302, "/auth/google"]);
  });

  it("knows a person by the Google account they first signed in with, and refuses that email from another account, or that account under another email", async () => {
    const id = crypto.randomUUID();
    const [ada, sam] = [`ada-${id}@example.com`, `sam-${id}@example.com`];
    listed.add(ada).add(sam);
    tokenEndpoint({ email: ada, scope: "email", sub: `sub-ada-${id}` });
    expect((await roundTrip("/auth/google", {})).home.status).toBe(302);
    expect((await roundTrip("/auth/google", {})).home.status).toBe(302);
    // The address passed to someone else's Google account: they don't become Ada here.
    tokenEndpoint({ email: ada, scope: "email", sub: `sub-other-${id}` });
    const taken = (await roundTrip("/auth/google", {})).home;
    expect([taken.status, await taken.text()]).toEqual([403, expect.stringContaining("signs in to Common Ink with another Google account")]);
    // Ada's Google account now says another address, which is someone else here already.
    tokenEndpoint({ email: sam, scope: "email", sub: `sub-sam-${id}` });
    expect((await roundTrip("/auth/google", {})).home.status).toBe(302);
    tokenEndpoint({ email: sam, scope: "email", sub: `sub-ada-${id}` });
    expect((await roundTrip("/auth/google", {})).home.status).toBe(403);
  });

  it("holds sign-in to the list of allowed emails, except where dev sign-in already lets anyone be anyone", async () => {
    tokenEndpoint({ email: "stranger@example.com", scope: "email" });
    expect((await roundTrip("/auth/google", {})).home.status).toBe(403);
    const local = (path: string, cookies: Record<string, string> = {}) => worker.fetch(new Request(`https://localhost${path}`, { headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ") }, redirect: "manual" }) as never, configured({ DEV_SIGN_IN: "1" }));
    const out = await local("/auth/google");
    const home = await local(`/auth/google/callback?state=${new URL(out.headers.get("Location")!).searchParams.get("state")}&code=the-code`, cookiesOf(out));
    expect([home.status, home.headers.get("Location")]).toEqual([302, "/"]);
  });
});

describe("a Google contact's labels", () => {
  it("are written as Google's own type when a label names one in any case, as its key or its words, whatever the browser's language", () => {
    const change = { emails: [{ value: "a@example.com", type: "WORK" }, { value: "b@example.com", type: "home email" }, { value: "c@example.com", type: "Workshop" }], phones: [{ value: "+1 555 0100", type: "MOBILE" }] };
    expect(personOf(change, {}).person).toMatchObject({
      emailAddresses: [{ value: "a@example.com", type: "work" }, { value: "b@example.com", type: "home" }, { value: "c@example.com", type: "Workshop" }],
      phoneNumbers: [{ value: "+1 555 0100", type: "mobile" }],
    });
  });

  it("are read as People's own type, and for a type Common Ink has no words for, as Google shows it in formattedType", () => {
    const card = toCard({
      resourceName: "people/c42",
      names: [{ displayName: "Grace Hopper" }],
      emailAddresses: [{ value: "grace@example.com", type: "work", formattedType: "Work" }, { value: "hopper@navy.example", type: "Navy", formattedType: "Navy" }, { value: "g@example.org", type: "", formattedType: "" }],
      phoneNumbers: [{ value: "+1 555 0100", type: "mobile", formattedType: "Mobile" }, { value: "+1 555 0101", type: "workMobile", formattedType: "Work Mobile" }, { value: "+1 555 0102" }],
      addresses: [{ formattedValue: "1 Yard Lane", type: "home", formattedType: "Home" }],
      urls: [{ value: "https://grace.example", type: "blog", formattedType: "Blog" }],
    });
    expect(card).toMatchObject({
      emails: [{ value: "grace@example.com", type: "work" }, { value: "hopper@navy.example", type: "Navy" }, { value: "g@example.org", type: null }],
      phones: [{ value: "+1 555 0100", type: "mobile" }, { value: "+1 555 0101", type: "Work Mobile" }, { value: "+1 555 0102", type: null }],
      addresses: [{ value: "1 Yard Lane", type: "home" }],
      urls: [{ value: "https://grace.example", type: "blog" }],
    });
  });

  it("are written as People's type with each value: a line with the same value and label as Google had it, and a label read from formattedType as Google's own type again", () => {
    const was = {
      phoneNumbers: [{ value: "+1 555 0101", type: "workMobile", formattedType: "Work Mobile", canonicalForm: "+15550101", metadata: { primary: true } }],
      emailAddresses: [{ value: "grace@example.com", type: "work", formattedType: "Work", metadata: { primary: true } }],
    };
    const change = {
      phones: [{ value: "+1 555 0101", type: "Work Mobile" }, { value: "+1 555 0199", type: "Work Mobile" }, { value: "+1 555 0100", type: null }],
      emails: [{ value: "grace@example.com", type: "home" }, { value: "hopper@navy.example", type: "Navy" }],
    };
    expect(personOf(change, was)).toEqual({
      person: {
        phoneNumbers: [{ value: "+1 555 0101", type: "workMobile" }, { value: "+1 555 0199", type: "workMobile" }, { value: "+1 555 0100" }],
        emailAddresses: [{ value: "grace@example.com", type: "home" }, { value: "hopper@navy.example", type: "Navy" }],
      },
      fields: ["phoneNumbers", "emailAddresses"],
    });
  });
});

describe("a Google contact's card", () => {
  it("holds all a page shows: title, addresses, a birthday with or without its year, notes, and only https pictures and pages", () => {
    const person = {
      resourceName: "people/c42",
      names: [{ displayName: "Sam Okafor" }],
      emailAddresses: [{ value: "sam@example.com" }],
      phoneNumbers: [{ value: "+1 555 0142" }],
      organizations: [{ name: "Okafor Plumbing", title: "Owner" }],
      addresses: [{ formattedValue: "12 Water Lane" }, {}],
      birthdays: [{ date: { month: 4, day: 21 } }],
      biographies: [{ value: "Prefers a text" }],
      photos: [{ url: "https://lh3.googleusercontent.com/default", default: true }, { url: "https://lh3.googleusercontent.com/sam" }],
      etag: "%EgM",
      urls: [{ value: "https://okafor.example" }, { value: "javascript:alert(1)" }],
    };
    expect(toCard(person)).toEqual({
      sourceId: "google-contacts",
      id: "people/c42",
      name: "Sam Okafor",
      emails: [{ value: "sam@example.com", type: null }],
      phones: [{ value: "+1 555 0142", type: null }],
      organization: "Okafor Plumbing",
      url: "https://contacts.google.com/person/c42",
      title: "Owner",
      addresses: [{ value: "12 Water Lane", type: null }],
      birthday: "--04-21",
      notes: "Prefers a text",
      photo: "https://lh3.googleusercontent.com/sam",
      urls: [{ value: "https://okafor.example", type: null }],
      etag: "%EgM",
    });
    expect(toCard({ ...person, birthdays: [{ date: { year: 1990, month: 4, day: 21 } }], photos: [{ url: "http://lh3.googleusercontent.com/sam" }] })).toMatchObject({ birthday: "1990-04-21", photo: null });
    // A picture from anywhere else isn't drawn: the page policy lets in only Google's.
    expect(toCard({ ...person, photos: [{ url: "https://lh3.example/sam" }] })).toMatchObject({ photo: null });
    expect(toCard({ resourceName: "people/c1" })).toBeNull();
  });
});
