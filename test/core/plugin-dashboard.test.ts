import { describe, expect, it } from "vitest";
import type { CalendarEvent, HistoryEntry, NoteSummary } from "../../src/core/protocol.ts";
import { aheadToday, editedToday, membersStamp, othersMarks, rose, summarize, todayAt, todoStamp } from "../../src/web/plugins/dashboard/today.ts";

const HOUR = 3_600_000;
/** 11:30 UTC on October 11: half past midnight on the 12th in Auckland, and half past four in the morning of the 11th in Los Angeles. */
const NOW = Date.UTC(2026, 9, 11, 11, 30);
/** 03:30 UTC on October 12: still the evening of the 11th in Los Angeles. */
const LATE = Date.UTC(2026, 9, 12, 3, 30);

const event = (title: string, when: CalendarEvent["when"]): CalendarEvent => ({ sourceId: "cal", id: title, calendarId: "work", calendar: "Work", color: null, title, when, timeZone: null, location: null, description: null, recurring: false, editable: true, etag: "0", url: null });
const note = (id: string, createdAt: number, updatedAt: number, state: NoteSummary["state"] = "live"): NoteSummary => ({
  id,
  title: id,
  slug: id,
  folderId: null,
  revision: 1,
  createdAt,
  updatedAt,
  updatedBy: { kind: "member", personId: "p", name: "Ada" },
  snippet: "",
  openTodos: 0,
  access: "edit",
  private: false,
  state,
  purgesAt: null,
  stateAt: null,
});

describe("the member's day", () => {
  it("is the date where they are and the instants it runs between, on either side of UTC", () => {
    expect(todayAt(NOW, "Pacific/Auckland")).toEqual({ day: "2026-10-12", from: Date.UTC(2026, 9, 11, 11), to: Date.UTC(2026, 9, 12, 11), timeZone: "Pacific/Auckland" });
    expect(todayAt(NOW, "America/Los_Angeles")).toEqual({ day: "2026-10-11", from: Date.UTC(2026, 9, 11, 7), to: Date.UTC(2026, 9, 12, 7), timeZone: "America/Los_Angeles" });
    expect(todayAt(LATE, "America/Los_Angeles").day).toBe("2026-10-11");
    expect(todayAt(LATE, "UTC").day).toBe("2026-10-12");
  });

  it("is as long as the clocks make it on a day they change", () => {
    const spring = todayAt(Date.UTC(2026, 2, 8, 20), "America/Los_Angeles");
    expect([spring.day, (spring.to - spring.from) / HOUR]).toEqual(["2026-03-08", 23]);
  });
});

describe("events still ahead today", () => {
  const events = [
    event("Holiday", { allDay: true, from: "2026-10-12", to: "2026-10-12" }),
    event("Yesterday's offsite", { allDay: true, from: "2026-10-10", to: "2026-10-11" }),
    event("Ended", { allDay: false, from: NOW - 2 * HOUR, to: NOW - HOUR }),
    event("Just ended", { allDay: false, from: NOW - HOUR, to: NOW }),
    event("Under way", { allDay: false, from: NOW - HOUR / 2, to: NOW + HOUR / 2 }),
    event("Later", { allDay: false, from: NOW + 3 * HOUR, to: NOW + 4 * HOUR }),
    event("Tomorrow", { allDay: false, from: NOW + 30 * HOUR, to: NOW + 31 * HOUR }),
  ];
  const ahead = (timeZone: string, now = NOW) => aheadToday(events, todayAt(now, timeZone), now).map(({ event, started }) => `${event.title}${started ? " (started)" : ""}`);

  it("are the all-day events on the member's own date and the events that haven't ended, east of UTC", () => {
    expect(ahead("Pacific/Auckland")).toEqual(["Holiday (started)", "Under way (started)", "Later"]);
  });

  it("and west of UTC, where the same moment is the day before: the all-day event of the 12th isn't today's yet", () => {
    expect(ahead("America/Los_Angeles")).toEqual(["Yesterday's offsite (started)", "Under way (started)", "Later"]);
  });

  it("drop an event the moment it ends", () => {
    expect(ahead("Pacific/Auckland", NOW + HOUR / 2)).toEqual(["Holiday (started)", "Later"]);
  });
});

describe("notes made or edited today", () => {
  const notes = [
    note("made-and-edited", NOW - HOUR / 4, NOW - HOUR / 8),
    note("old-edited-now", NOW - 100 * HOUR, NOW - HOUR / 4),
    note("edited-an-hour-ago", NOW - 100 * HOUR, NOW - HOUR),
    note("edited-yesterday-everywhere", NOW - 100 * HOUR, NOW - 30 * HOUR),
    note("archived-now", NOW - HOUR / 4, NOW - HOUR / 4, "archived"),
    note("daily", NOW - HOUR / 4, NOW - HOUR / 4),
  ];
  const listed = (timeZone: string) => editedToday(notes, todayAt(NOW, timeZone), "daily").map(({ note, made }) => `${note.id}${made ? " (made)" : ""}`);

  it("are the live ones changed since the member's own midnight, latest first, without their daily note", () => {
    // Half past midnight in Auckland: an edit an hour ago was yesterday there.
    expect(listed("Pacific/Auckland")).toEqual(["made-and-edited (made)", "old-edited-now"]);
    // Half past four in the morning in Los Angeles: the same edit was today.
    expect(listed("America/Los_Angeles")).toEqual(["made-and-edited (made)", "old-edited-now", "edited-an-hour-ago"]);
  });

  it("go by the member's date and not the date in UTC", () => {
    // Evening of the 11th in Los Angeles, already the 12th in UTC: a note edited at 20:00 UTC on the 11th is today's there, and not in UTC.
    const afternoon = [note("afternoon", 0, Date.UTC(2026, 9, 11, 20))];
    expect(editedToday(afternoon, todayAt(LATE, "America/Los_Angeles")).map(({ note }) => note.id)).toEqual(["afternoon"]);
    expect(editedToday(afternoon, todayAt(LATE, "UTC"))).toEqual([]);
  });
});

describe("the summary of changes", () => {
  const change = (noteId: string, revision: number, createdAt: number, author: HistoryEntry["author"]): HistoryEntry => ({ noteId, noteTitle: `Title of ${noteId}`, revision, baseRevision: revision - 1, author, createdAt, label: null, reverts: null, revertedBy: null, restores: 0, added: 0, removed: 0, diff: null });
  const grace = { kind: "member" as const, personId: "g", name: "Grace" };
  const claude = { kind: "agent" as const, agentId: "c", name: "Claude", onBehalfOf: "g" };

  it("sums changes up by note and by author, an agent apart from its member, the note changed latest first", () => {
    const summed = summarize([change("plan", 5, 50, claude), change("budget", 2, 40, grace), change("plan", 4, 30, grace), change("plan", 3, 20, claude)]);

    expect(summed.map((n) => [n.title, n.changes, n.latest, n.authors.map((a) => `${a.author.name} the ${a.author.kind}: ${a.changes}`)])).toEqual([
      ["Title of plan", 3, 50, ["Claude the agent: 2", "Grace the member: 1"]],
      ["Title of budget", 1, 40, ["Grace the member: 1"]],
    ]);
  });
});

describe("when to read again", () => {
  const withTodos = (n: NoteSummary, openTodos: number, revision = n.revision): NoteSummary => ({ ...n, openTodos, revision });
  const by = (n: NoteSummary, personId: string, revision: number): NoteSummary => ({ ...n, revision, updatedAt: n.updatedAt + revision, updatedBy: { kind: "member", personId, name: personId } });
  const notes = [withTodos(note("a", 1, 5), 2), note("b", 2, 3)];

  it("is, for todos, when a note with an open todo changes, gains its first or loses its last, and not when any other note is typed in", () => {
    expect(todoStamp([...notes])).toBe(todoStamp(notes));
    expect(todoStamp([notes[0]!, { ...notes[1]!, revision: 9, updatedAt: 99 }])).toBe(todoStamp(notes));
    expect(todoStamp([withTodos(notes[0]!, 2, 2), notes[1]!])).not.toBe(todoStamp(notes));
    expect(todoStamp([notes[0]!, withTodos(notes[1]!, 1)])).not.toBe(todoStamp(notes));
    expect(todoStamp([withTodos(notes[0]!, 0, 2), notes[1]!])).not.toBe(todoStamp(notes));
    expect(todoStamp([{ ...notes[0]!, state: "archived" }, notes[1]!])).not.toBe(todoStamp(notes));
  });

  it("is, for pins and the daily note, when a note comes into sight, leaves it, or changes state, and never for an edit", () => {
    expect(membersStamp([notes[1]!, notes[0]!])).toBe(membersStamp(notes));
    expect(membersStamp([notes[0]!, { ...notes[1]!, revision: 9, updatedAt: 99 }])).toBe(membersStamp(notes));
    expect(membersStamp([notes[0]!])).not.toBe(membersStamp(notes));
    expect(membersStamp([...notes, note("c", 6, 6)])).not.toBe(membersStamp(notes));
    expect(membersStamp([notes[0]!, { ...notes[1]!, state: "archived" }])).not.toBe(membersStamp(notes));
  });

  it("is, for the summary, when someone else changed a note, and not when the member did, even to a note another had changed last", () => {
    const start = [by(notes[0]!, "grace", 2), by(notes[1]!, "me", 2)];
    const marks = (list: NoteSummary[]) => othersMarks(list, "me");
    expect([...marks(start)]).toEqual([["a", 2]]);
    expect(rose(marks(start), marks(start))).toBe(false);
    expect(rose(marks(start), marks([start[0]!, by(start[1]!, "me", 3)])), "the member typed").toBe(false);
    expect(rose(marks(start), marks([by(start[0]!, "me", 3), start[1]!])), "the member changed the note Grace had").toBe(false);
    expect(rose(marks(start), marks([by(start[0]!, "grace", 3), start[1]!])), "Grace typed again").toBe(true);
    expect(rose(marks(start), marks([start[0]!, by(start[1]!, "grace", 3)])), "Grace changed the member's note").toBe(true);
    expect(rose(marks(start), marks([...start, by(note("c", 1, 1), "grace", 1)])), "Grace made a note").toBe(true);
    const agent: NoteSummary = { ...start[1]!, revision: 3, updatedBy: { kind: "agent", agentId: "x", name: "Claude", onBehalfOf: "me" } };
    expect(rose(marks(start), marks([start[0]!, agent])), "the member's own agent is someone else").toBe(true);
  });
});
