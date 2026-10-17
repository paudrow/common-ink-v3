import { describe, expect, it } from "vitest";
import type { Calendar } from "../../src/core/protocol.ts";
import { startOf, startWords } from "../../src/web/plugins/calendar/choosing.ts";
import { calendar as plugin } from "../../src/web/plugins/calendar/index.tsx";

const cal = (id: string, name: string, writable = true): Calendar => ({ sourceId: "s", id, name, color: null, writable });
const WORK = cal("work", "Work");
const PERSONAL = cal("personal", "Personal");
const HOLIDAYS = cal("holidays", "Holidays", false);
const ALL = [WORK, PERSONAL, HOLIDAYS];
const TARGETS = [WORK, PERSONAL];

/** Where a new event starts and what the form says of it, for a default and a calendar used last in this browser. */
const starts = (chosen: string, last: unknown, targets = TARGETS, all = ALL) => {
  const start = startOf(targets, all, chosen, last);
  return start && { in: start.calendar.name, says: startWords(start) };
};

describe("the calendar a new event starts in", () => {
  it("is the member's default while they may add to it here", () => {
    expect(starts("s personal", "s work")).toEqual({ in: "Personal", says: "Your default calendar." });
  });

  it("is the one added to last with no default, and the first with neither, saying so", () => {
    expect(starts("", "s personal")).toEqual({ in: "Personal", says: "No default calendar is set, so new events start in Personal, the calendar you added to last." });
    expect(starts("", null)).toEqual({ in: "Work", says: "No default calendar is set, so new events start in Work, the first calendar you can add to." });
    expect(starts("", "s holidays"), "one used last that can't be added to now").toEqual({ in: "Work", says: "No default calendar is set, so new events start in Work, the first calendar you can add to." });
  });

  it("says why a default it can't use is passed over: read-only, hidden, or no longer connected", () => {
    expect(starts("s holidays", "s personal")).toEqual({ in: "Personal", says: "Your default calendar, Holidays, can only be read, so new events start in Personal, the calendar you added to last." });
    expect(starts("s work", null, [PERSONAL])).toEqual({ in: "Personal", says: "Your default calendar, Work, is hidden, so new events start in Personal, the first calendar you can add to." });
    expect(starts("gone cal", null)).toEqual({ in: "Work", says: "Your default calendar is no longer connected, so new events start in Work, the first calendar you can add to." });
  });

  it("is none when there is no calendar to add to", () => {
    expect(starts("s work", "s work", [], [HOLIDAYS])).toBeNull();
  });

  it("is kept in the remembered setting calendar.default, which the server reads for an agent's create_event", () => {
    expect(plugin.id).toBe("calendar");
    expect(plugin.settings?.default).toMatchObject({ type: "string", default: "", remembered: true, title: "Default calendar" });
  });
});
