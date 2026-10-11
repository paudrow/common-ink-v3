import { describe, expect, it } from "vitest";
import type { CalendarEvent, EventWhen } from "../../src/web/plugin-api.ts";
import { cellsOf, dayIn, dayLabel, daysOf, daysOfEvent, formOf, instantAt, isDay, sameWhen, shiftDay, shiftMonth, spanOf, startOfDay, step, timeIn, timeLabel, titleOf, whenLabel, whenOf } from "../../src/web/plugins/calendar/dates.ts";

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const LA = "America/Los_Angeles";
const KIRITIMATI = "Pacific/Kiritimati";

const TOKYO_CALL: EventWhen = { allDay: false, from: at("2026-10-15T23:30:00Z"), to: at("2026-10-16T00:30:00Z") };
const OFFSITE: EventWhen = { allDay: true, from: "2026-10-14", to: "2026-10-15" };

const event = (title: string, when: EventWhen): CalendarEvent => ({ sourceId: "s", id: title, calendar: "Work", color: null, title, when, timeZone: null, location: null, description: null, recurring: false, editable: true, etag: "0", url: null });

describe("the days a view shows", () => {
  it("is the week from Sunday, the whole weeks a month touches, or two weeks from a day", () => {
    expect(daysOf("week", "2026-10-14")).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(daysOf("week", "2026-10-11")[0]).toBe("2026-10-11");
    expect(daysOf("week", "2027-01-01")).toEqual(["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);

    const october = daysOf("month", "2026-10-14");
    expect([october.length, october[0], october.at(-1)]).toEqual([35, "2026-09-27", "2026-10-31"]);
    const february = daysOf("month", "2026-02-10");
    expect([february.length, february[0], february.at(-1)]).toEqual([28, "2026-02-01", "2026-02-28"]);
    const august = daysOf("month", "2026-08-31");
    expect([august.length, august[0], august.at(-1)]).toEqual([42, "2026-07-26", "2026-09-05"]);

    const agenda = daysOf("agenda", "2026-12-25");
    expect([agenda.length, agenda[0], agenda.at(-1)]).toEqual([14, "2026-12-25", "2027-01-07"]);
  });

  it("moves by a week, a month, or the agenda's length", () => {
    expect([step("week", "2026-10-14", 1), step("week", "2026-10-14", -1)]).toEqual(["2026-10-21", "2026-10-07"]);
    expect([step("month", "2026-01-31", 1), step("month", "2026-01-31", -1), step("month", "2026-12-15", 1)]).toEqual(["2026-02-01", "2025-12-01", "2027-01-01"]);
    expect([step("agenda", "2026-10-14", 1), step("agenda", "2026-10-14", -1)]).toEqual(["2026-10-28", "2026-09-30"]);
  });

  it("counts dates across months, years and leap days", () => {
    expect([shiftDay("2026-10-31", 1), shiftDay("2026-01-01", -1), shiftDay("2024-02-28", 1), shiftDay("2026-02-28", 1)]).toEqual(["2026-11-01", "2025-12-31", "2024-02-29", "2026-03-01"]);
    expect([shiftMonth("2026-10-14", 0), shiftMonth("2024-01-31", 1)]).toEqual(["2026-10-01", "2024-02-01"]);
    expect(["2026-10-14", "2026-02-30", "2026-1-01", "tomorrow"].map(isDay)).toEqual([true, false, false, false]);
  });

  it("is called by its month, or by its first and last day", () => {
    expect([titleOf("month", "2026-10-14", "en-US"), titleOf("week", "2026-10-14", "en-US"), titleOf("agenda", "2026-12-25", "en-US")]).toEqual(["October 2026", "Oct 11 – Oct 17, 2026", "Dec 25 – Jan 7, 2027"]);
  });
});

describe("a day in the member's zone", () => {
  it("starts at that zone's midnight, far from UTC's", () => {
    expect(startOfDay("2026-10-15", KIRITIMATI)).toBe(at("2026-10-14T10:00:00Z"));
    expect(startOfDay("2026-10-15", LA)).toBe(at("2026-10-15T07:00:00Z"));
    expect(startOfDay("2026-10-15", "Asia/Kolkata")).toBe(at("2026-10-14T18:30:00Z"));
    expect(startOfDay("2026-10-15", "UTC")).toBe(at("2026-10-15T00:00:00Z"));
  });

  it("is 23 hours long when the clock goes forward and 25 when it goes back", () => {
    const length = (day: string, zone: string) => (startOfDay(shiftDay(day, 1), zone) - startOfDay(day, zone)) / HOUR;

    expect([length("2026-03-07", LA), length("2026-03-08", LA), length("2026-03-09", LA)]).toEqual([24, 23, 24]);
    expect([length("2026-10-31", LA), length("2026-11-01", LA), length("2026-11-02", LA)]).toEqual([24, 25, 24]);
    expect(length("2026-03-29", "Europe/London")).toBe(23);
  });

  it("starts at its first instant where the clock skips midnight", () => {
    // Cuba's clock goes from midnight straight to 1 am on the day it goes forward.
    const start = startOfDay("2026-03-08", "America/Havana");

    expect(start).toBe(at("2026-03-08T05:00:00Z"));
    expect([dayIn(start - 1, "America/Havana"), dayIn(start, "America/Havana"), timeIn(start, "America/Havana")]).toEqual(["2026-03-07", "2026-03-08", "01:00"]);
  });

  it("asks for exactly the days on show, the long and short ones too", () => {
    const span = spanOf(daysOf("week", "2026-11-03"), LA);

    expect(span).toEqual({ from: at("2026-11-01T07:00:00Z"), to: at("2026-11-08T08:00:00Z"), timeZone: LA });
    expect((span.to - span.from) / HOUR).toBe(7 * 24 + 1);
    expect(spanOf(["2026-10-15"], KIRITIMATI)).toEqual({ from: at("2026-10-14T10:00:00Z"), to: at("2026-10-15T10:00:00Z"), timeZone: KIRITIMATI });
  });

  it("reads an instant as the date and time on that zone's clock", () => {
    expect([dayIn(TOKYO_CALL.from as number, KIRITIMATI), timeIn(TOKYO_CALL.from as number, KIRITIMATI)]).toEqual(["2026-10-16", "13:30"]);
    expect([dayIn(TOKYO_CALL.from as number, LA), timeIn(TOKYO_CALL.from as number, LA)]).toEqual(["2026-10-15", "16:30"]);
    expect([dayIn(at("2026-10-15T00:00:00Z"), "UTC"), timeIn(at("2026-10-15T00:00:00Z"), "UTC")]).toEqual(["2026-10-15", "00:00"]);
  });

  it("finds the instant a clock shows a time, through both changes of the clock", () => {
    expect(instantAt("2026-10-15", 16 * 60 + 30, LA)).toBe(at("2026-10-15T23:30:00Z"));
    expect(instantAt("2026-03-08", 3 * 60 + 30, LA), "after the clock went forward").toBe(at("2026-03-08T10:30:00Z"));
    expect(instantAt("2026-03-08", 2 * 60 + 30, LA), "a time the clock skipped is that far after the change").toBe(at("2026-03-08T10:30:00Z"));
    expect(instantAt("2026-11-01", 60 + 30, LA), "a time the clock shows twice is the first").toBe(at("2026-11-01T08:30:00Z"));
    expect(instantAt("2026-11-01", 12 * 60, LA)).toBe(at("2026-11-01T20:00:00Z"));
  });
});

describe("the days an event is on", () => {
  it("puts an event between two instants on the day it starts where the member is", () => {
    expect(daysOfEvent(TOKYO_CALL, KIRITIMATI)).toEqual(["2026-10-16"]);
    expect(daysOfEvent(TOKYO_CALL, LA)).toEqual(["2026-10-15"]);
    expect(daysOfEvent(TOKYO_CALL, "UTC"), "an hour that crosses midnight is on the day it starts").toEqual(["2026-10-15"]);
    expect(daysOfEvent(TOKYO_CALL, "Asia/Tokyo")).toEqual(["2026-10-16"]);
  });

  it("puts one that lasts days on each of them, and not on the day it ends at midnight", () => {
    expect(daysOfEvent({ allDay: false, from: at("2026-10-14T16:00:00Z"), to: at("2026-10-16T19:00:00Z") }, LA)).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(daysOfEvent({ allDay: false, from: at("2026-10-14T07:00:00Z"), to: at("2026-10-16T07:00:00Z") }, LA)).toEqual(["2026-10-14", "2026-10-15"]);
  });

  it("puts an all-day event on its own dates wherever it is read", () => {
    for (const zone of [KIRITIMATI, LA, "UTC", "Pacific/Pago_Pago"]) expect(daysOfEvent(OFFSITE, zone), zone).toEqual(["2026-10-14", "2026-10-15"]);
    expect(daysOfEvent({ allDay: true, from: "2026-10-31", to: "2026-11-02" }, LA), "over the day the clock goes back").toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(daysOfEvent({ allDay: true, from: "2026-10-16", to: "2026-10-16" }, LA)).toEqual(["2026-10-16"]);
  });

  it("fills the cells of a week, all-day events apart from the rest", () => {
    const events = [event("Offsite", OFFSITE), event("Standup", { allDay: false, from: at("2026-10-15T14:00:00Z"), to: at("2026-10-15T14:15:00Z") }), event("Call with Tokyo", TOKYO_CALL), event("Last week", { allDay: true, from: "2026-10-09", to: "2026-10-11" })];
    const shown = (zone: string) =>
      Object.fromEntries(
        cellsOf(daysOf("week", "2026-10-14"), events, zone)
          .filter((cell) => cell.allDay.length + cell.timed.length)
          .map((cell) => [cell.day, [...cell.allDay.map((e) => `${e.title} (all day)`), ...cell.timed.map((e) => e.title)]]),
      );

    expect(shown(LA)).toEqual({ "2026-10-11": ["Last week (all day)"], "2026-10-14": ["Offsite (all day)"], "2026-10-15": ["Offsite (all day)", "Standup", "Call with Tokyo"] });
    expect(shown(KIRITIMATI)).toEqual({ "2026-10-11": ["Last week (all day)"], "2026-10-14": ["Offsite (all day)"], "2026-10-15": ["Offsite (all day)"], "2026-10-16": ["Standup", "Call with Tokyo"] });
    expect(cellsOf(daysOf("week", "2026-10-14"), events, LA)).toHaveLength(7);
  });
});

describe("an event's time as a person reads it", () => {
  it("is said in the member's zone", () => {
    expect([timeLabel(TOKYO_CALL.from as number, KIRITIMATI, "en-US"), timeLabel(TOKYO_CALL.from as number, LA, "en-US")]).toEqual(["1:30 PM", "4:30 PM"]);
    expect(whenLabel(TOKYO_CALL, LA, "en-US")).toBe("Thu, Oct 15, 2026, 4:30 PM – 5:30 PM");
    expect(whenLabel(TOKYO_CALL, KIRITIMATI, "en-US")).toBe("Fri, Oct 16, 2026, 1:30 PM – 2:30 PM");
    expect(whenLabel(TOKYO_CALL, "UTC", "en-US")).toBe("Thu, Oct 15, 2026, 11:30 PM – Fri, Oct 16, 2026, 12:30 AM");
    expect(whenLabel(OFFSITE, KIRITIMATI, "en-US")).toBe("Wed, Oct 14, 2026 – Thu, Oct 15, 2026, all day");
    expect(whenLabel({ allDay: true, from: "2026-10-16", to: "2026-10-16" }, LA, "en-US")).toBe("Fri, Oct 16, 2026, all day");
    expect([dayLabel("2026-10-14", "heading", "en-US"), dayLabel("2026-10-14", "short", "en-US")]).toEqual(["Wednesday, October 14", "Oct 14"]);
  });
});

describe("an event's time in a form", () => {
  it("is dates and times of day in the member's zone, and reads back as it was", () => {
    expect(formOf(TOKYO_CALL, KIRITIMATI)).toEqual({ allDay: false, fromDay: "2026-10-16", fromTime: "13:30", toDay: "2026-10-16", toTime: "14:30" });
    expect(formOf(TOKYO_CALL, "UTC")).toEqual({ allDay: false, fromDay: "2026-10-15", fromTime: "23:30", toDay: "2026-10-16", toTime: "00:30" });
    expect(formOf(OFFSITE, LA)).toMatchObject({ allDay: true, fromDay: "2026-10-14", toDay: "2026-10-15" });
    for (const zone of [KIRITIMATI, LA, "UTC", "Asia/Kolkata"]) {
      expect(whenOf(formOf(TOKYO_CALL, zone), zone), zone).toEqual(TOKYO_CALL);
      expect(whenOf(formOf(OFFSITE, zone), zone), zone).toEqual(OFFSITE);
    }
  });

  it("becomes the event's time when it is changed", () => {
    expect(whenOf({ allDay: false, fromDay: "2026-10-16", fromTime: "09:00", toDay: "2026-10-16", toTime: "10:15" }, LA)).toEqual({ allDay: false, from: at("2026-10-16T16:00:00Z"), to: at("2026-10-16T17:15:00Z") });
    expect(whenOf({ ...formOf(TOKYO_CALL, LA), allDay: true }, LA), "an event made all-day is on the days it was on").toEqual({ allDay: true, from: "2026-10-15", to: "2026-10-15" });
    expect(whenOf({ ...formOf(OFFSITE, LA), allDay: false }, LA)).toEqual({ allDay: false, from: at("2026-10-14T16:00:00Z"), to: at("2026-10-15T17:00:00Z") });
  });

  it("says why it holds no time", () => {
    expect(whenOf({ allDay: true, fromDay: "2026-10-16", fromTime: "", toDay: "2026-10-15", toTime: "" }, LA)).toEqual({ problem: "It ends before it starts." });
    expect(whenOf({ allDay: false, fromDay: "2026-10-16", fromTime: "10:00", toDay: "2026-10-16", toTime: "09:00" }, LA)).toEqual({ problem: "It ends before it starts." });
    expect(whenOf({ allDay: false, fromDay: "2026-10-16", fromTime: "", toDay: "2026-10-16", toTime: "09:00" }, LA)).toEqual({ problem: "Give the time it starts and the time it ends." });
    expect(whenOf({ allDay: true, fromDay: "", fromTime: "", toDay: "2026-10-16", toTime: "" }, LA)).toEqual({ problem: "Give the day it starts and the day it ends." });
  });

  it("tells a changed time from the same one", () => {
    expect([sameWhen(TOKYO_CALL, { ...TOKYO_CALL }), sameWhen(TOKYO_CALL, { ...TOKYO_CALL, to: (TOKYO_CALL.to as number) + 1 }), sameWhen(OFFSITE, { allDay: true, from: "2026-10-14", to: "2026-10-16" })]).toEqual([true, false, false]);
  });
});
