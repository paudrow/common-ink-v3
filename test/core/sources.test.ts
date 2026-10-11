import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { inOrder, within } from "../../src/core/events.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type CalendarEvent, type Contact, type OpInput } from "../../src/core/protocol.ts";
import { SourceError, contactMatches, writtenReference, type CalendarSource, type ContactsSource, type DataSource, type Sources } from "../../src/core/sources.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { sourcesFor } from "../../src/worker/sources/index.ts";
import { addMember, newMember } from "./members.ts";

const T0 = Date.UTC(2026, 9, 14, 12);
const WEEK = { from: Date.UTC(2026, 9, 11), to: Date.UTC(2026, 9, 18), timeZone: "UTC" };

const event = (id: string, title: string, more: Partial<CalendarEvent> = {}): CalendarEvent => ({
  sourceId: "cal",
  id,
  calendar: "Mine",
  color: null,
  title,
  when: { allDay: false, from: T0, to: T0 + 3_600_000 },
  timeZone: null,
  location: null,
  description: null,
  recurring: false,
  editable: true,
  etag: "e1",
  url: null,
  ...more,
});

const contact = (id: string, name: string, more: Partial<Contact> = {}): Contact => ({ sourceId: "people", id, name, emails: [], phones: [], organization: null, url: null, ...more });

/** Data sources held in memory, each person's their own, with a record of everything asked of them. */
function world(options: { readOnly?: boolean; fails?: SourceError } = {}) {
  const events = new Map<string, CalendarEvent[]>();
  const contacts = new Map<string, Contact[]>();
  const asked: string[] = [];
  const updates: unknown[] = [];
  const state = new Map<string, DataSource["info"]["state"]>();
  const sources: Sources = {
    async of(personId) {
      asked.push(personId);
      const info = (id: string, name: string) => ({ id, name, provider: "Test", state: state.get(personId) ?? ("connected" as const), account: `${personId}@test` });
      const mine = () => events.get(personId) ?? [];
      const calendar: CalendarSource = {
        kind: "calendar",
        info: info("cal", "Test calendar"),
        async list() {
          if (options.fails) throw options.fails;
          return mine();
        },
        get: async (id) => mine().find((e) => e.id === id) ?? null,
        ...(options.readOnly
          ? {}
          : {
              async update(id, change, etag) {
                updates.push({ personId, id, change, etag });
                const at = mine().findIndex((e) => e.id === id);
                if (mine()[at]!.etag !== etag) throw new SourceError("stale", "It changed since you opened it");
                const next = { ...mine()[at]!, ...change, etag: `${etag}+` };
                mine()[at] = next;
                return next;
              },
            }),
      };
      const people: ContactsSource = { kind: "contacts", info: info("people", "Test contacts"), list: async () => ({ contacts: contacts.get(personId) ?? [], more: false }), get: async (id) => (contacts.get(personId) ?? []).find((c) => c.id === id) ?? null };
      return [calendar, people];
    },
    connect: async () => ({ redirect: "/somewhere" }),
    disconnect: async () => {},
  };
  const ask = <T extends OpInput>(actor: Actor, op: T) => perform(env.DB, actor, op, T0, sources);
  return { events, contacts, asked, updates, state, sources, ask };
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

const agentOf = async (person: Actor, scope?: { readOnly: boolean }): Promise<Actor> => ({ kind: "agent", agentId: (await connectAgent(env.DB, person.personId, "Claude")).agent.id, personId: person.personId, workspaceId: person.workspaceId, scope });

describe("data sources belong to one person", () => {
  it("answers each person with their own events and contacts, and an admin with nothing of anyone else's", async () => {
    const w = world();
    const ada = await newMember("Ada");
    const eve = await addMember(ada, "editor", "Eve");
    w.events.set(ada.personId, [event("a1", "Ada's dentist")]);
    w.events.set(eve.personId, [event("e1", "Eve's interview")]);
    w.contacts.set(ada.personId, [contact("c1", "Ada's plumber")]);
    w.contacts.set(eve.personId, [contact("c2", "Eve's lawyer")]);

    expect((await w.ask(ada, { type: "event.list", ...WEEK })).events.map((e) => e.title)).toEqual(["Ada's dentist"]);
    expect((await w.ask(eve, { type: "event.list", ...WEEK })).events.map((e) => e.title)).toEqual(["Eve's interview"]);
    expect((await w.ask(ada, { type: "contact.list" })).contacts.map((c) => c.name)).toEqual(["Ada's plumber"]);
    expect((await w.ask(eve, { type: "contact.list" })).contacts.map((c) => c.name)).toEqual(["Eve's lawyer"]);
    expect((await w.ask(ada, { type: "source.list" })).sources.map((s) => s.account)).toEqual([`${ada.personId}@test`, `${ada.personId}@test`]);
  });

  it("asks only for the person performing the operation, whatever the operation and whoever asks", async () => {
    const w = world();
    const ada = await newMember("Ada");
    const eve = await addMember(ada, "viewer", "Eve");
    w.events.set(eve.personId, [event("e1", "Eve's interview")]);
    const { ref } = await w.ask(eve, { type: "record.refer", sourceId: "cal", id: "e1" });
    w.asked.length = 0;
    for (const actor of [ada, await agentOf(ada)]) {
      await w.ask(actor, { type: "source.list" });
      await w.ask(actor, { type: "event.list", ...WEEK });
      await w.ask(actor, { type: "contact.list" });
      expect(await refusal(w.ask(actor, { type: "event.update", sourceId: "cal", id: "e1", etag: "e1", title: "Taken" }))).toBe("not_found: No such event");
      expect(await refusal(w.ask(actor, { type: "record.refer", sourceId: "cal", id: "e1" }))).toBe("not_found: No such record");
      // Eve's reference, asked for by Ada, is the same as one that was never made.
      expect(await refusal(w.ask(actor, { type: "record.read", ref }))).toBe("not_found: No such record");
      expect(await refusal(w.ask(actor, { type: "record.read", ref: "zzzzzzzzzzzz" }))).toBe("not_found: No such record");
    }
    expect(new Set(w.asked)).toEqual(new Set([ada.personId]));
    expect(w.updates).toEqual([]);
    expect(w.events.get(eve.personId)![0]!.title).toBe("Eve's interview");
  });

  it("lets a viewer and a guest use their own data sources: it needs nothing of the workspace", async () => {
    const w = world();
    const ada = await newMember("Ada");
    const vera = await addMember(ada, "viewer", "Vera");
    w.events.set(vera.personId, [event("v1", "Vera's class")]);
    expect((await w.ask(vera, { type: "event.update", sourceId: "cal", id: "v1", etag: "e1", title: "Vera's seminar" })).title).toBe("Vera's seminar");
  });

  it("gives a member's agent their events and contacts, a read-only token no changes, and no agent the connection itself", async () => {
    const w = world();
    const ada = await newMember("Ada");
    w.events.set(ada.personId, [event("a1", "Ada's dentist")]);
    const agent = await agentOf(ada);
    const reader = await agentOf(ada, { readOnly: true });
    expect((await w.ask(agent, { type: "event.list", ...WEEK })).events.map((e) => e.title)).toEqual(["Ada's dentist"]);
    expect((await w.ask(reader, { type: "event.list", ...WEEK })).events.map((e) => e.title)).toEqual(["Ada's dentist"]);
    expect(await refusal(w.ask(reader, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", title: "No" }))).toBe("forbidden: A read-only token can't event.update");
    expect(await refusal(w.ask(reader, { type: "record.refer", sourceId: "cal", id: "a1" }))).toBe("forbidden: A read-only token can't record.refer");
    expect((await w.ask(agent, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", title: "Ada's hygienist" })).title).toBe("Ada's hygienist");
    for (const type of ["source.connect", "source.disconnect"] as const) expect(await refusal(w.ask(agent, { type, id: "cal" }))).toBe(`forbidden: An agent can't ${type}`);
    expect(w.updates).toHaveLength(1);
  });

  it("gives whoever holds a link nothing", async () => {
    const w = world();
    const ada = await newMember("Ada");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Shared" });
    const link = await perform(env.DB, ada, { type: "grant.link", noteId: note.id, link: "public" });
    const token = link!.to.kind === "link" ? link!.to.token : "";
    for (const personId of [null, ada.personId]) {
      expect(await refusal(perform(env.DB, { kind: "visitor", token, personId }, { type: "event.list", ...WEEK }, T0, w.sources))).toBe("forbidden: A link can't event.list");
    }
  });
});

describe("changing an event", () => {
  it("sends the change with the etag the member read, and answers what the data source now holds", async () => {
    const w = world();
    const ada = await newMember();
    w.events.set(ada.personId, [event("a1", "Dentist")]);
    const changed = await w.ask(ada, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", title: "Hygienist", when: { allDay: true, from: "2026-10-15", to: "2026-10-15" } });
    expect(changed).toMatchObject({ title: "Hygienist", when: { allDay: true, from: "2026-10-15", to: "2026-10-15" }, etag: "e1+" });
    expect(w.updates).toEqual([{ personId: ada.personId, id: "a1", change: { title: "Hygienist", when: { allDay: true, from: "2026-10-15", to: "2026-10-15" } }, etag: "e1" }]);
  });

  it("refuses a change made from a stale reading, and changes nothing", async () => {
    const w = world();
    const ada = await newMember();
    w.events.set(ada.personId, [event("a1", "Dentist", { etag: "e2" })]);
    expect(await refusal(w.ask(ada, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", title: "Old news" }))).toBe("conflict: It changed since you opened it");
    expect(w.events.get(ada.personId)![0]!.title).toBe("Dentist");
  });

  it("is refused by a read-only data source before anything is sent, and the source says it isn't writable", async () => {
    const w = world({ readOnly: true });
    const ada = await newMember();
    w.events.set(ada.personId, [event("a1", "Dentist")]);
    expect((await w.ask(ada, { type: "source.list" })).sources.map((s) => [s.id, s.writable])).toEqual([["cal", false], ["people", false]]);
    expect((await w.ask(ada, { type: "event.list", ...WEEK })).events.map((e) => e.editable)).toEqual([false]);
    expect(await refusal(w.ask(ada, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", title: "No" }))).toBe("forbidden: Test calendar is read-only");
    // Contacts have no way to be changed at all: there is no such data source of a kind that takes one.
    expect(await refusal(w.ask(ada, { type: "event.update", sourceId: "people", id: "c1", etag: "e1", title: "No" }))).toBe("not_found: No such data source");
  });

  it("is refused for an event in a calendar the member can only read, though the data source takes changes", async () => {
    const w = world();
    const ada = await newMember();
    w.events.set(ada.personId, [event("h1", "Holiday", { editable: false, calendar: "Holidays" })]);
    expect(await refusal(w.ask(ada, { type: "event.update", sourceId: "cal", id: "h1", etag: "e1", title: "Workday" }))).toBe('forbidden: You can only read the calendar "Holidays"');
    expect(w.updates).toEqual([]);
  });

  it("refuses an event that ends before it starts", async () => {
    const w = world();
    const ada = await newMember();
    w.events.set(ada.personId, [event("a1", "Dentist")]);
    expect(await refusal(w.ask(ada, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", when: { allDay: true, from: "2026-10-15", to: "2026-10-14" } }))).toContain("invalid:");
    expect(await refusal(w.ask(ada, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", when: { allDay: true, from: "2026-02-30", to: "2026-03-01" } }))).toContain("invalid:");
  });
});

describe("a data source that stopped answering", () => {
  it("is listed as needing to be reconnected, and is not asked again until it is", async () => {
    const w = world({ fails: new SourceError("needs_reconnect", "No longer accepted") });
    const ada = await newMember();
    w.events.set(ada.personId, [event("a1", "Dentist")]);
    const listed = await w.ask(ada, { type: "event.list", ...WEEK });
    expect(listed.events).toEqual([]);
    expect(listed.sources.map((s) => [s.id, s.state])).toEqual([["cal", "needs_reconnect"]]);
    w.state.set(ada.personId, "needs_reconnect");
    expect(await refusal(w.ask(ada, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", title: "No" }))).toBe("conflict: Reconnect Test calendar first");
    expect((await w.ask(ada, { type: "contact.list" })).sources.map((s) => s.state)).toEqual(["needs_reconnect"]);
  });

  it("fails the whole read when it is busy, so half an answer isn't taken for an empty day", async () => {
    const w = world({ fails: new SourceError("busy", "Busy. Try again in a moment.") });
    const ada = await newMember();
    expect(await refusal(w.ask(ada, { type: "event.list", ...WEEK }))).toBe("unavailable: Busy. Try again in a moment.");
  });
});

describe("events in a span of time", () => {
  const allDay = (from: string, to = from) => ({ allDay: true as const, from, to });
  const span = (from: string, to: string, timeZone: string) => ({ from: Date.parse(from), to: Date.parse(to), timeZone });

  it("takes an all-day event by the asker's days, not by UTC's", () => {
    // Midnight to midnight of 14 October in Kiritimati, which is 13 October 10:00 to 14 October 10:00 in UTC.
    const kiritimati = span("2026-10-13T10:00:00Z", "2026-10-14T10:00:00Z", "Pacific/Kiritimati");
    expect(within(allDay("2026-10-14"), kiritimati)).toBe(true);
    expect(within(allDay("2026-10-13"), kiritimati)).toBe(false);
    expect(within(allDay("2026-10-15"), kiritimati)).toBe(false);
    // The same day in Los Angeles is 14 October 07:00 to 15 October 07:00 in UTC.
    const losAngeles = span("2026-10-14T07:00:00Z", "2026-10-15T07:00:00Z", "America/Los_Angeles");
    expect(within(allDay("2026-10-14"), losAngeles)).toBe(true);
    expect(within(allDay("2026-10-15"), losAngeles)).toBe(false);
    expect(within(allDay("2026-10-13"), losAngeles)).toBe(false);
    expect(within(allDay("2026-10-12", "2026-10-14"), losAngeles)).toBe(true);
  });

  it("takes any other event when it overlaps, and one that ends as the span starts not at all", () => {
    const day = span("2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z", "UTC");
    const timed = (from: string, to: string) => ({ allDay: false as const, from: Date.parse(from), to: Date.parse(to) });
    expect(within(timed("2026-10-13T23:30:00Z", "2026-10-14T00:30:00Z"), day)).toBe(true);
    expect(within(timed("2026-10-13T23:00:00Z", "2026-10-14T00:00:00Z"), day)).toBe(false);
    expect(within(timed("2026-10-15T00:00:00Z", "2026-10-15T01:00:00Z"), day)).toBe(false);
    expect(within(timed("2026-10-14T00:00:00Z", "2026-10-14T00:00:00Z"), day)).toBe(true);
  });

  it("lists soonest first by the asker's days, with a day's all-day events before the rest", () => {
    const events = [
      event("late", "Late", { when: { allDay: false, from: Date.parse("2026-10-14T23:30:00Z"), to: Date.parse("2026-10-15T00:30:00Z") } }),
      event("all", "All day on the 15th", { when: allDay("2026-10-15") }),
      event("early", "Early", { when: { allDay: false, from: Date.parse("2026-10-14T08:00:00Z"), to: Date.parse("2026-10-14T09:00:00Z") } }),
    ];
    expect(inOrder(events, "UTC").map((e) => e.id)).toEqual(["early", "late", "all"]);
    // In Tokyo the late event is on the 15th, after that day's all-day event.
    expect(inOrder(events, "Asia/Tokyo").map((e) => e.id)).toEqual(["early", "all", "late"]);
  });

  it("refuses a span that ends before it starts, and a zone that isn't one", async () => {
    const w = world();
    const ada = await newMember();
    expect(await refusal(w.ask(ada, { type: "event.list", from: 2, to: 1, timeZone: "UTC" }))).toBe("invalid: The span ends before it starts");
    expect(await refusal(w.ask(ada, { type: "event.list", from: 1, to: 2, timeZone: "Mars/Olympus" }))).toBe('invalid: "Mars/Olympus" isn\'t a time zone');
    // A span of all time would have a data source walk every day of it.
    expect(await refusal(w.ask(ada, { type: "event.list", from: 0, to: 9e15, timeZone: "UTC" }))).toBe("invalid: A span can be at most 400 days");
    expect(await refusal(w.ask(ada, { type: "event.list", from: 0, to: 401 * 86_400_000, timeZone: "UTC" }))).toBe("invalid: A span can be at most 400 days");
    expect((await w.ask(ada, { type: "event.list", from: 0, to: 400 * 86_400_000, timeZone: "UTC" })).events).toEqual([]);
  });

  it("asks the data source for a day either side, and keeps only what the span covers", async () => {
    const w = world();
    const ada = await newMember();
    w.events.set(ada.personId, [event("in", "In", { when: allDay("2026-10-14") }), event("out", "Out", { when: allDay("2026-10-18") })]);
    expect((await w.ask(ada, { type: "event.list", ...WEEK })).events.map((e) => e.id)).toEqual(["in"]);
  });
});

describe("contacts", () => {
  it("finds a contact by the start of any word of its name, email or organization, whatever the accents and case", () => {
    const zoe = contact("z", "Zoë Álvarez", { emails: ["zed@harbor.example"], organization: "Harbor Books" });
    for (const query of ["zoe", "ALVA", "zoe alv", "harbor", "books zo", "zed"]) expect(contactMatches(zoe, query), query).toBe(true);
    for (const query of ["oe", "zoe smith", "arbor"]) expect(contactMatches(zoe, query), query).toBe(false);
  });

  it("lists by name, and narrows by what is asked for", async () => {
    const w = world();
    const ada = await newMember();
    w.contacts.set(ada.personId, [contact("2", "sam okafor"), contact("1", "Ada Lovelace"), contact("3", "Zoë Álvarez")]);
    expect((await w.ask(ada, { type: "contact.list" })).contacts.map((c) => c.name)).toEqual(["Ada Lovelace", "sam okafor", "Zoë Álvarez"]);
    expect((await w.ask(ada, { type: "contact.list", query: "alv" })).contacts.map((c) => c.name)).toEqual(["Zoë Álvarez"]);
  });
});

describe("a reference to a record", () => {
  it("is an id that says nothing of the record, the same each time it is asked for, and reads the record as it is now", async () => {
    const w = world();
    const ada = await newMember();
    w.events.set(ada.personId, [event("a1", "Lunch with Sam")]);
    w.contacts.set(ada.personId, [contact("people/c1", "Sam Okafor")]);
    const made = await w.ask(ada, { type: "record.refer", sourceId: "cal", id: "a1" });
    expect(made).toEqual({ ref: expect.stringMatching(/^[a-z0-9]{12}$/), kind: "event", text: `::event{${made.ref} Lunch with Sam}` });
    expect(await w.ask(ada, { type: "record.refer", sourceId: "cal", id: "a1" })).toEqual(made);
    const person = await w.ask(ada, { type: "record.refer", sourceId: "people", id: "people/c1" });
    expect(person.text).toBe(`::contact{${person.ref} Sam Okafor}`);

    await w.ask(ada, { type: "event.update", sourceId: "cal", id: "a1", etag: "e1", title: "Dinner with Sam" });
    expect(await w.ask(ada, { type: "record.read", ref: made.ref })).toMatchObject({ kind: "event", ref: made.ref, event: { title: "Dinner with Sam" } });
    expect(await w.ask(ada, { type: "record.read", ref: person.ref })).toMatchObject({ kind: "contact", contact: { name: "Sam Okafor" } });
    // Nothing of the record is kept: only where to find it, beside the person whose it is.
    const kept = await env.DB.prepare("SELECT * FROM source_refs WHERE id = ?").bind(made.ref).first();
    expect(kept).toEqual({ id: made.ref, person_id: ada.personId, data_source: "cal", record_id: "a1", created_at: T0 });
  });

  it("reads as no record once the record is gone from its data source", async () => {
    const w = world();
    const ada = await newMember();
    w.events.set(ada.personId, [event("a1", "Lunch")]);
    const { ref } = await w.ask(ada, { type: "record.refer", sourceId: "cal", id: "a1" });
    w.events.set(ada.personId, []);
    expect(await refusal(w.ask(ada, { type: "record.read", ref }))).toBe("not_found: No such record");
  });

  it("is written so a label can't end the embed or start another", () => {
    expect(writtenReference("event", "aaaaaaaaaaaa", "Plan {Q4}\n::html{x}")).toBe("::event{aaaaaaaaaaaa Plan Q4 ::html x}");
    expect(writtenReference("contact", "aaaaaaaaaaaa", "  ")).toBe("::contact{aaaaaaaaaaaa}");
  });

  it("stays the person's own in a note other members read: the note holds the label, and they can follow nothing", async () => {
    const w = world();
    const ada = await newMember("Ada");
    const eve = await addMember(ada, "editor", "Eve");
    w.events.set(ada.personId, [event("a1", "Lunch with Sam", { location: "Cafe Lula", description: "Bring the contract" })]);
    const { ref, text } = await w.ask(ada, { type: "record.refer", sourceId: "cal", id: "a1" });
    const note = await w.ask(ada, { type: "note.create", text: `# Plans\n\n${text}\n` });
    const read = await w.ask(eve, { type: "note.read", id: note.id });
    expect(read.text).toContain(`::event{${ref} Lunch with Sam}`);
    expect(JSON.stringify(read)).not.toMatch(/Cafe Lula|Bring the contract|a1"/);
    expect(await refusal(w.ask(eve, { type: "record.read", ref }))).toBe("not_found: No such record");
  });
});

describe("the sample data", () => {
  const offered = (vars: Partial<Env>, host: string) => sourcesFor({ ...env, ...vars } as Env, new URL(`https://${host}/`), fetch, () => T0);

  it("is offered where dev sign-in is on and nowhere else, whatever is set", async () => {
    const ada = await newMember();
    expect((await offered({ DEV_SIGN_IN: "1" }, "localhost").of(ada.personId)).map((s) => s.info.id)).toEqual(["sample-calendar", "sample-contacts"]);
    expect((await offered({ DEV_SIGN_IN: "1" }, "pr-48-common-ink-v3.draftox.workers.dev").of(ada.personId)).map((s) => s.info.id)).toEqual(["sample-calendar", "sample-contacts"]);
    expect(await offered({ DEV_SIGN_IN: "1" }, "commonink.app").of(ada.personId)).toEqual([]);
    expect(await offered({}, "localhost").of(ada.personId)).toEqual([]);
    // Connecting it where it isn't offered connects nothing.
    const production = offered({ DEV_SIGN_IN: "1" }, "commonink.app");
    expect(await refusal(perform(env.DB, ada, { type: "source.connect", id: "sample-calendar" }, T0, production))).toBe("not_found: No such data source");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM source_connections WHERE person_id = ?").bind(ada.personId).first()).toEqual({ n: 0 });
  });

  it("connects, lists the same week for anyone, keeps one person's change from another, and forgets it all on disconnect", async () => {
    const sources = offered({ DEV_SIGN_IN: "1" }, "localhost");
    const ada = await newMember("Ada");
    const eve = await addMember(ada, "editor", "Eve");
    const ask = <T extends OpInput>(actor: Actor, op: T) => perform(env.DB, actor, op, T0, sources);
    expect((await ask(ada, { type: "event.list", ...WEEK })).sources.map((s) => s.state)).toEqual(["not_connected"]);
    expect((await ask(ada, { type: "source.connect", id: "sample-calendar" })).redirect).toBeNull();
    await ask(eve, { type: "source.connect", id: "sample-contacts" });

    const week = (await ask(ada, { type: "event.list", ...WEEK })).events;
    expect(week.map((e) => `${e.when.allDay ? e.when.from : new Date(e.when.from).toISOString().slice(0, 16)} ${e.title}`)).toEqual([
      "2026-10-12T14:00 Standup",
      "2026-10-12T15:00 Planning",
      "2026-10-13T14:00 Standup",
      "2026-10-13T17:00 Lunch with Sam",
      "2026-10-14 Offsite",
      "2026-10-14T14:00 Standup",
      "2026-10-15T14:00 Standup",
      "2026-10-15T23:30 Call with Tokyo",
      "2026-10-16 Company holiday",
      "2026-10-16T14:00 Standup",
    ]);
    const lunch = week.find((e) => e.title === "Lunch with Sam")!;
    const holiday = week.find((e) => e.title === "Company holiday")!;
    expect([lunch.editable, holiday.editable]).toEqual([true, false]);

    const moved = await ask(ada, { type: "event.update", sourceId: lunch.sourceId, id: lunch.id, etag: lunch.etag, title: "Lunch with Sam and Lin" });
    expect(moved.etag).not.toBe(lunch.etag);
    expect(await refusal(ask(ada, { type: "event.update", sourceId: lunch.sourceId, id: lunch.id, etag: lunch.etag, title: "Clobbered" }))).toContain("conflict:");
    expect(await refusal(ask(ada, { type: "event.update", sourceId: holiday.sourceId, id: holiday.id, etag: holiday.etag, title: "Workday" }))).toBe('forbidden: You can only read the calendar "Holidays"');
    expect((await ask(ada, { type: "event.list", ...WEEK })).events.map((e) => e.title)).toContain("Lunch with Sam and Lin");
    expect((await ask(eve, { type: "event.list", ...WEEK })).events.map((e) => e.title)).toContain("Lunch with Sam");
    expect((await ask(eve, { type: "contact.list", query: "zoe" })).contacts.map((c) => c.name)).toEqual(["Zoë Álvarez"]);

    expect((await ask(ada, { type: "source.disconnect", id: "sample-calendar" })).sources.map((s) => s.state)).toEqual(["not_connected", "not_connected"]);
    await ask(ada, { type: "source.connect", id: "sample-calendar" });
    expect((await ask(ada, { type: "event.list", ...WEEK })).events.map((e) => e.title)).not.toContain("Lunch with Sam and Lin");
  });
});

describe("through the Worker", () => {
  const SECRET = "test-session-secret";
  const settings = { ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: "1", GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, TOKEN_KEY: undefined } as unknown as Env;

  it("the app and an agent reach the same data sources, each as the member, and production offers no sample data", async () => {
    const ada = await newMember("Ada");
    const cookie = `__Host-ink_session=${await sign({ personId: ada.personId }, SECRET, 600)}`;
    const op = async (host: string, body: OpInput) => {
      const res = await worker.fetch(new Request(`https://${host}/api/workspaces/${ada.workspaceId}/ops`, { method: "POST", headers: { Cookie: cookie, Origin: `https://${host}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never, settings);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await op("commonink.app", { type: "source.list" })).body).toEqual({ sources: [] });
    expect((await op("commonink.app", { type: "source.connect", id: "sample-calendar" })).status).toBe(404);
    expect((await op("localhost", { type: "source.connect", id: "sample-calendar" })).body).toMatchObject({ redirect: null });
    const listed = await op("localhost", { type: "event.list", ...WEEK });
    expect((listed.body.events as CalendarEvent[]).map((e) => e.title)).toContain("Lunch with Sam");

    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const tool = async (host: string, name: string, args: object) => {
      const res = await worker.fetch(new Request(`https://${host}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }) as never, settings);
      return ((await res.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    };
    expect(await tool("localhost", "list_events", WEEK)).toContain("Lunch with Sam");
    expect(await tool("localhost", "list_contacts", { query: "sam" })).toContain("Sam Okafor");
    expect(JSON.parse(await tool("commonink.app", "list_events", WEEK))).toEqual({ events: [], sources: [] });
  });
});
