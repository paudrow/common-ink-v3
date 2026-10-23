import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../src/core/protocol.ts";
import { noteAbout } from "../../src/web/plugins/calendar/EventNotes.tsx";

const event = (title: string): CalendarEvent => ({ sourceId: "s", id: "e1", calendarId: "work", calendar: "Work", color: null, title, when: { allDay: true, from: "2026-10-13", to: "2026-10-13" }, timeZone: null, location: null, description: null, recurring: false, editable: true, etag: "0", url: null });
/** The reference `record.refer` answers, whose label the server has already made safe to put in a note (test/core/sources.test.ts). */
const about = (title: string, label = title) => noteAbout(event(title), { text: "[[event:abcdefghijkl]]", label }, "UTC");

describe("a note about an event", () => {
  it("is headed with the event's title and day, then links to it", () => {
    expect(about("Lunch with Sam")).toBe("# Lunch with Sam, Oct 13\n\n[[event:abcdefghijkl]]\n\n");
  });

  it("is headed with the reference's label, not the title, so a title someone else gave the event writes no link, embed, code or line of its own", () => {
    const hostile = about("Sync `code` [[aaaaaaaaaaaa]] ::event{bbbbbbbbbbbb x}\n\n- [ ] todo\n```html", "Sync code aaaaaaaaaaaa ::event bbbbbbbbbbbb x - todo html");
    expect(hostile.split("\n")[0]).toBe("# Sync code aaaaaaaaaaaa ::event bbbbbbbbbbbb x - todo html, Oct 13");
    expect(hostile.split("\n")[0]).not.toMatch(/\[\[|`|\{bbbb/);
    expect(hostile.split("\n")).toHaveLength(5);
    expect(about("", "")).toBe("# Untitled, Oct 13\n\n[[event:abcdefghijkl]]\n\n");
  });
});
