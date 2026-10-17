import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type Calendar, type CalendarEvent, type OpInput } from "../../src/core/protocol.ts";
import { SourceError, calendarSettings, defaultCalendar, type CalendarSource, type Sources } from "../../src/core/sources.ts";
import { newMember } from "./members.ts";

const T0 = Date.UTC(2026, 9, 14, 12);
const AT = { allDay: false as const, from: T0, to: T0 + 3_600_000 };

const cal = (sourceId: string, id: string, name: string, writable = true): Calendar => ({ sourceId, id, name, color: null, writable });
const WORK = cal("cal", "work", "Work");
const PERSONAL = cal("cal", "personal", "Personal");
const HOLIDAYS = cal("cal", "holidays", "Holidays", false);
/** A calendar that says it can be written, in a data source that takes no changes. */
const SHARED = cal("ro", "shared", "Shared");

/** One person's two calendar data sources, the first taking changes and the second read-only, with every event asked to be made. */
function world(calendars: Calendar[] = [SHARED, HOLIDAYS, WORK, PERSONAL]) {
  const creates: { sourceId: string; calendarId: string; title: string }[] = [];
  /** The data sources that need connecting again, which the server can't read. */
  const lapsed = new Set<string>();
  const source = (id: string, writes: boolean): CalendarSource => ({
    kind: "calendar",
    info: {
      id,
      name: id === "cal" ? "Test calendar" : "Read-only calendar",
      provider: "Test",
      state: "connected",
      account: "me@test",
    },
    list: async () => {
      if (lapsed.has(id)) throw new SourceError("needs_reconnect", "Connect it again");
      return { calendars: calendars.filter((c) => c.sourceId === id), events: [] };
    },
    get: async () => null,
    calendar: async (calendarId) => calendars.find((c) => c.sourceId === id && c.id === calendarId) ?? null,
    ...(writes && {
      update: async () => {
        throw new Error("not asked");
      },
      async create(calendarId, fields) {
        creates.push({ sourceId: id, calendarId, title: fields.title });
        const made: CalendarEvent = {
          sourceId: id,
          id: `n${creates.length}`,
          calendarId,
          calendar: calendars.find((c) => c.id === calendarId)!.name,
          color: null,
          title: fields.title,
          when: fields.when,
          timeZone: null,
          location: null,
          description: null,
          recurring: false,
          editable: true,
          etag: "1",
          url: null,
        };
        return made;
      },
    }),
  });
  const sources: Sources = {
    of: async () => [source("ro", false), source("cal", true)],
    connect: async () => ({ redirect: null }),
    disconnect: async () => {},
  };
  const ask = <T extends OpInput>(actor: Actor, op: T) => perform(env.DB, actor, op, T0, sources);
  return { creates, ask, lapsed };
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

const settle = async (w: ReturnType<typeof world>, actor: Actor, settings: Record<string, unknown>) => {
  const { revision } = await w.ask(actor, { type: "settings.read" });
  await w.ask(actor, {
    type: "settings.write",
    text: JSON.stringify(settings),
    baseRevision: revision,
  });
};

describe("the default calendar, as the server chooses it", () => {
  it("is the member's default while they may add to it, then the first they may add to and haven't hidden, then the first they may add to", () => {
    const all = [SHARED, HOLIDAYS, WORK, PERSONAL].map((c) => (c === SHARED ? { ...c, writable: false } : c));
    const chosen = (text: string | null) => defaultCalendar(all, calendarSettings(text))?.id ?? null;

    expect(chosen(null)).toBe("work");
    expect(chosen(JSON.stringify({ "calendar.default": "cal personal" }))).toBe("personal");
    expect(chosen(JSON.stringify({ "calendar.default": "cal holidays" })), "one they can only read").toBe("work");
    expect(chosen(JSON.stringify({ "calendar.default": "gone mine" })), "one they no longer have").toBe("work");
    expect(chosen(JSON.stringify({ "calendar.hidden": ["cal work"] }))).toBe("personal");
    expect(chosen(JSON.stringify({ "calendar.hidden": ["cal work", "cal personal"] })), "every one hidden").toBe("work");
    expect(
      chosen(
        JSON.stringify({
          "calendar.default": "cal work",
          "calendar.hidden": ["cal work"],
        }),
      ),
      "a default hidden is passed over, as the Calendar page passes it over",
    ).toBe("personal");
    expect(chosen("{not json"), "settings that can't be read").toBe("work");
    expect(
      chosen(
        JSON.stringify({
          "calendar.default": 7,
          "calendar.hidden": "cal work",
        }),
      ),
      "values of the wrong kind",
    ).toBe("work");
    expect(defaultCalendar([HOLIDAYS], calendarSettings(null))).toBeNull();
  });
});

describe("event.create with no calendar named", () => {
  it("adds to the member's default, read from their settings, for the member and for their agent alike", async () => {
    const w = world();
    const ada = await newMember();
    const agent: Actor = {
      kind: "agent",
      agentId: (await connectAgent(env.DB, ada.personId, "Claude")).agent.id,
      personId: ada.personId,
      workspaceId: ada.workspaceId,
    };

    const first = await w.ask(agent, {
      type: "event.create",
      title: "No default yet",
      when: AT,
    });
    expect([first.sourceId, first.calendarId, first.calendar]).toEqual(["cal", "work", "Work"]);

    await settle(w, ada, { "calendar.default": "cal personal" });
    const second = await w.ask(agent, {
      type: "event.create",
      title: "Piano",
      when: AT,
    });
    expect([second.calendarId, second.calendar]).toEqual(["personal", "Personal"]);
    const third = await w.ask(ada, {
      type: "event.create",
      title: "Named",
      when: AT,
      sourceId: "cal",
      calendarId: "work",
    });
    expect(third.calendarId, "a calendar named is used, whatever the default").toBe("work");

    await settle(w, ada, {
      "calendar.default": "cal holidays",
      "calendar.hidden": ["cal work"],
    });
    expect(
      (
        await w.ask(agent, {
          type: "event.create",
          title: "Fallback",
          when: AT,
        })
      ).calendarId,
      "a default that can't be added to falls back to the first shown",
    ).toBe("personal");

    expect(w.creates).toEqual([
      { sourceId: "cal", calendarId: "work", title: "No default yet" },
      { sourceId: "cal", calendarId: "personal", title: "Piano" },
      { sourceId: "cal", calendarId: "work", title: "Named" },
      { sourceId: "cal", calendarId: "personal", title: "Fallback" },
    ]);
  });

  it("is refused when half the calendar is named, or the member may add to none, before anything is sent", async () => {
    const ada = await newMember();
    const w = world();
    expect(
      await refusal(
        w.ask(ada, {
          type: "event.create",
          title: "Half",
          when: AT,
          sourceId: "cal",
        }),
      ),
    ).toBe("invalid: Name the calendar by both sourceId and calendarId, or by neither for the member's default calendar");
    expect(
      await refusal(
        w.ask(ada, {
          type: "event.create",
          title: "Half",
          when: AT,
          calendarId: "work",
        }),
      ),
    ).toBe("invalid: Name the calendar by both sourceId and calendarId, or by neither for the member's default calendar");
    const readOnly = world([SHARED, HOLIDAYS]);
    expect(await refusal(readOnly.ask(ada, { type: "event.create", title: "Nowhere", when: AT }))).toBe("conflict: There is no calendar to add it to: connect a calendar that can be added to on the Calendar page first");
    expect([...w.creates, ...readOnly.creates]).toEqual([]);
  });

  it("waits for a default whose data source can't be read now, rather than putting the event in another calendar", async () => {
    const w = world([WORK, PERSONAL, cal("other", "spare", "Spare")]);
    const ada = await newMember();
    await settle(w, ada, { "calendar.default": "cal personal" });
    w.lapsed.add("cal");
    expect(await refusal(w.ask(ada, { type: "event.create", title: "Piano", when: AT }))).toBe("conflict: The member's default calendar can't be reached now. Try again, or name the calendar");
    expect(w.creates).toEqual([]);
  });
});
