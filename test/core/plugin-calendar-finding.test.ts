import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../src/core/protocol.ts";
import { finding, listedAs, sought, upcoming } from "../../src/web/plugins/calendar/finding.ts";

const ZONE = "America/New_York";
const TODAY = "2026-10-15";
// 2 pm in New York on the 15th of October 2026.
const NOW = Date.parse("2026-10-15T18:00:00Z");

const event = (id: string, title: string, from: string, hours = 1, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  sourceId: "sample-calendar",
  id,
  calendarId: "work",
  calendar: "Work",
  color: null,
  title,
  when: { allDay: false, from: Date.parse(from), to: Date.parse(from) + hours * 3_600_000 },
  timeZone: null,
  location: null,
  description: null,
  recurring: false,
  editable: true,
  etag: "0",
  url: null,
  ...over,
});
// A sync every weekday at 10 am in New York, each occurrence an event of its own, and others.
const SYNCS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"].map((day) => event(`sync.${day}`, "Team sync", `${day}T14:00:00Z`, 0.5, { recurring: true }));
const OTHERS = [
  event("plan", "Planning", "2026-10-19T15:00:00Z"),
  event("late", "Call with Tokyo", "2026-10-20T03:30:00Z"),
  { ...event("off", "Offsite", "2026-10-21T00:00:00Z"), calendar: "Personal", when: { allDay: true as const, from: "2026-10-21", to: "2026-10-22" } },
  event("may", "May review", "2026-11-02T15:00:00Z"),
];
const ALL = [...SYNCS, ...OTHERS];
const ids = (typed: string) => finding(ALL, typed, NOW, ZONE).map((e) => e.id);

describe("what is typed to find an event", () => {
  it("reads a day in any of the ways one is written, and the rest as words", () => {
    for (const typed of ["sync oct 20", "Sync October 20", "sync 20 oct", "sync 20th Oct", "sync 10/20", "sync 2026-10-20", "oct 20, sync", "sync oct. 20", "sync 10/20/2026", "sync Oct 20 2026"]) expect(sought(typed, TODAY)).toEqual({ words: ["sync"], day: "2026-10-20" });
    expect(sought("standup tomorrow", TODAY)).toEqual({ words: ["standup"], day: "2026-10-16" });
    expect(sought("yesterday", TODAY)).toEqual({ words: [], day: "2026-10-14" });
    expect(sought("today", TODAY).day).toBe(TODAY);
  });

  it("takes a day with no year as the one nearest today, and a month alone as a word", () => {
    expect(sought("jan 3", TODAY).day).toBe("2027-01-03");
    expect(sought("mar 1", TODAY).day).toBe("2027-03-01");
    expect(sought("apr 20", TODAY).day).toBe("2026-04-20");
    expect(sought("feb 30", TODAY)).toEqual({ words: ["feb", "30"], day: null });
    expect(sought("may review", TODAY)).toEqual({ words: ["may", "review"], day: null });
    expect(sought("q3 2026", TODAY)).toEqual({ words: ["q3", "2026"], day: null });
    expect(sought("toString", TODAY)).toEqual({ words: ["tostring"], day: null });
    expect(sought("oct 20 2027", TODAY).day).toBe("2027-10-20");
  });
});

describe("finding events to link or go to", () => {
  it("lists each occurrence of a repeating event on its own, the nearest to now first", () => {
    expect(ids("sync")).toEqual(["sync.2026-10-15", "sync.2026-10-16", "sync.2026-10-14", "sync.2026-10-13", "sync.2026-10-12", "sync.2026-10-19", "sync.2026-10-20"]);
    expect(ids("team s")).toEqual(ids("sync"));
  });

  it("narrows to the day typed, in the member's zone, and an event of several days is on each", () => {
    expect(ids("sync oct 20")).toEqual(["sync.2026-10-20"]);
    // 11:30 pm on the 19th in New York, the 20th in UTC.
    expect(ids("tokyo oct 19")).toEqual(["late"]);
    expect(ids("tokyo oct 20")).toEqual([]);
    expect(ids("oct 22")).toEqual(["off"]);
    expect(ids("oct 19")).toEqual(["sync.2026-10-19", "plan", "late"]);
  });

  it("finds by the start of a title's words, accents and case aside, and nothing for nothing typed", () => {
    expect(ids("REV")).toEqual(["may"]);
    expect(ids("ync")).toEqual([]);
    expect(ids("  ")).toEqual([]);
  });

  it("lists an event with its day, its time and its calendar", () => {
    expect(listedAs(SYNCS[3]!, ZONE)).toEqual({ label: "Team sync", detail: "Thu, Oct 15, 2026 · 10:00 AM · Work" });
    expect(listedAs(OTHERS[2]!, ZONE)).toEqual({ label: "Offsite", detail: "Wed, Oct 21, 2026 · All day · Personal" });
  });
});

describe("the next events, which @ alone offers", () => {
  it("are those still to start, soonest first, an all-day one from the next day and before the timed ones of its day", () => {
    const allDay = (id: string, day: string) => ({ ...event(id, id, `${day}T00:00:00Z`), when: { allDay: true as const, from: day, to: day } });
    const ongoing = event("ongoing", "Ongoing", "2026-10-15T17:30:00Z");
    const ids = upcoming([...ALL, ongoing, allDay("today", TODAY), allDay("tomorrow", "2026-10-16")], NOW, ZONE).map((e) => e.id);
    expect(ids).toEqual(["tomorrow", "sync.2026-10-16", "sync.2026-10-19", "plan", "late", "sync.2026-10-20", "off", "may"]);
  });
});
