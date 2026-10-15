import { describe, expect, it } from "vitest";
import type { NoteAbout } from "../../src/core/protocol.ts";
import { eventAddress, linkNotes } from "../../src/web/plugins/calendar/linking.ts";

const note = (id: string, updatedAt: number, audience: NoteAbout["audience"] = "private"): NoteAbout => ({ id, title: `Note ${id}`, updatedAt, audience });

describe("what an event link offers of the notes about its event", () => {
  it("offers to make one when the only note about it is the one the link is in, or there is none", () => {
    expect(linkNotes([note("here", 5)], "here")).toEqual({ latest: null, listed: [] });
    expect(linkNotes([], "here")).toEqual({ latest: null, listed: [] });
  });

  it("opens the one other note and lists nothing", () => {
    expect(linkNotes([note("here", 9), note("a", 3, "workspace")], "here")).toEqual({ latest: note("a", 3, "workspace"), listed: [] });
  });

  it("opens the one changed last of several, whatever order they come in, and lists them all, the latest first, leaving out the note the link is in", () => {
    const notes = [note("old", 1), note("here", 99), note("new", 7, "shared"), note("mid", 4, "workspace")];
    expect(linkNotes(notes, "here")).toEqual({ latest: note("new", 7, "shared"), listed: [note("new", 7, "shared"), note("mid", 4, "workspace"), note("old", 1)] });
  });
});

describe("the Calendar's address at an event", () => {
  it("names the event and its day where the member is", () => {
    // 02:30 UTC on Oct 16 is still Oct 15 in New York.
    expect(eventAddress({ sourceId: "s1", id: "e 1", when: { allDay: false, from: Date.parse("2026-10-16T02:30:00Z"), to: Date.parse("2026-10-16T03:00:00Z") } }, "America/New_York")).toBe("/calendar?source=s1&event=e+1&day=2026-10-15");
    expect(eventAddress({ sourceId: "s1", id: "e2", when: { allDay: true, from: "2026-10-20", to: "2026-10-21" } }, "Asia/Tokyo")).toBe("/calendar?source=s1&event=e2&day=2026-10-20");
  });
});
