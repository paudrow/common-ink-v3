import { describe, expect, it } from "vitest";
import type { EventWhen } from "../../src/web/plugin-api.ts";
import { bars, layoutDay, openingMinutes, piecesOf } from "../../src/web/plugins/calendar/layout.ts";

const at = (iso: string) => Date.parse(`${iso}Z`);
const ev = (title: string, from: string, to: string) => ({ title, when: { allDay: false, from: at(from), to: at(to) } as EventWhen });
const allDay = (title: string, from: string, to: string) => ({ title, when: { allDay: true, from, to } as EventWhen });
const laid = (items: ReturnType<typeof ev>[], day: string, zone = "UTC") => layoutDay(piecesOf(items, day, zone)).map((p) => [p.item.title, p.top, p.bottom, p.lane, p.lanes, p.span, p.indent]);

describe("a day's events in the grid, as v1 laid them out", () => {
  it("puts events that start under half an hour apart side by side, one that starts later inside another on top of it indented, and widens each into free lanes", () => {
    const items = [ev("A", "2026-09-29T09:00", "2026-09-29T10:00"), ev("B", "2026-09-29T09:30", "2026-09-29T11:00"), ev("C", "2026-09-29T09:45", "2026-09-29T10:15"), ev("D", "2026-09-29T10:30", "2026-09-29T11:30"), ev("Lunch", "2026-09-29T12:00", "2026-09-29T13:00")];
    expect(laid(items, "2026-09-29")).toEqual([
      ["A", 540, 600, 0, 2, 1, 0],
      ["B", 570, 660, 0, 2, 1, 1],
      ["C", 585, 615, 1, 2, 1, 0],
      ["D", 630, 690, 0, 2, 2, 2],
      ["Lunch", 720, 780, 0, 1, 1, 0],
    ]);
  });

  it("puts the longer of two that start together first, and a third that starts within half an hour of it in the lane the short one is done with", () => {
    const items = [ev("Standup", "2026-09-29T09:00", "2026-09-29T09:15"), ev("Review", "2026-09-29T09:00", "2026-09-29T10:00"), ev("Call", "2026-09-29T09:20", "2026-09-29T09:50")];
    expect(laid(items, "2026-09-29").map((p) => p.slice(0, 5))).toEqual([
      ["Review", 540, 600, 0, 2],
      ["Standup", 540, 555, 1, 2],
      ["Call", 560, 590, 1, 2],
    ]);
  });

  it("draws a moment as a quarter hour long for overlaps, and keeps its own end", () => {
    const items = [ev("Ping", "2026-09-29T09:00", "2026-09-29T09:00"), ev("Later", "2026-09-29T09:10", "2026-09-29T09:40")];
    expect(laid(items, "2026-09-29")).toEqual([
      ["Ping", 540, 540, 0, 2, 1, 0],
      ["Later", 550, 580, 1, 2, 1, 0],
    ]);
  });

  it("lays out the sample calendar's Thursday, as test/browser/calendar.spec.ts measures it, in New York", () => {
    const thursday = [ev("Standup", "2026-10-15T14:00", "2026-10-15T14:15"), ev("Design review", "2026-10-15T15:00", "2026-10-15T16:30"), ev("Dentist", "2026-10-15T15:15", "2026-10-15T16:00"), ev("Focus time", "2026-10-15T17:00", "2026-10-15T19:00"), ev("Coffee with Ada", "2026-10-15T17:45", "2026-10-15T18:15"), ev("Call with Tokyo", "2026-10-15T23:30", "2026-10-16T00:30")];
    expect(layoutDay(piecesOf(thursday, "2026-10-15", "America/New_York")).map((p) => [p.item.title, p.top, p.lane, p.lanes, p.span, p.indent])).toEqual([
      ["Standup", 600, 0, 1, 1, 0],
      ["Design review", 660, 0, 2, 1, 0],
      ["Dentist", 675, 1, 2, 1, 0],
      ["Focus time", 780, 0, 1, 1, 0],
      ["Coffee with Ada", 825, 0, 1, 1, 1],
      ["Call with Tokyo", 1170, 0, 1, 1, 0],
    ]);
  });

  it("clips an event that crosses midnight to each day it is on, on the member's clock, and leaves a day long or more to the all-day row", () => {
    const late = ev("Late", "2026-10-15T23:30", "2026-10-16T00:30");
    const long = ev("Long", "2026-10-15T08:00", "2026-10-16T08:00");
    expect(piecesOf([late, long], "2026-10-15", "UTC").map((p) => [p.item.title, p.top, p.bottom, p.before, p.after])).toEqual([["Late", 1410, 1440, false, true]]);
    expect(piecesOf([late, long], "2026-10-16", "UTC").map((p) => [p.item.title, p.top, p.bottom, p.before, p.after])).toEqual([["Late", 0, 30, true, false]]);
    expect(piecesOf([late], "2026-10-16", "Asia/Tokyo").map((p) => [p.top, p.bottom])).toEqual([[510, 570]]);
  });

  it("stacks all-day bars across the days on show so none overlap, and says which go on past either end", () => {
    const days = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"];
    const items = [allDay("Offsite", "2026-10-14", "2026-10-15"), allDay("Trip", "2026-10-09", "2026-10-12"), allDay("Holiday", "2026-10-16", "2026-10-16"), allDay("Retreat", "2026-10-15", "2026-10-20"), ev("Conference", "2026-10-12T09:00", "2026-10-13T12:00"), ev("Lunch", "2026-10-12T12:00", "2026-10-12T13:00")];
    expect(bars(items, days, "UTC").map((b) => [b.item.title, b.from, b.to, b.row, b.before, b.after])).toEqual([
      ["Trip", 0, 1, 0, true, false],
      ["Conference", 1, 2, 1, false, false],
      ["Offsite", 3, 4, 0, false, false],
      ["Retreat", 4, 6, 1, false, true],
      ["Holiday", 5, 5, 0, false, false],
    ]);
  });

  it("opens half an hour above 8:00 or the first event, or with now a third of the way down when it would be below the fold", () => {
    expect([openingMinutes(null, null, 600), openingMinutes(6 * 60, null, 600), openingMinutes(10 * 60, null, 600)]).toEqual([450, 330, 450]);
    expect([openingMinutes(null, 9 * 60, 600), openingMinutes(null, 13 * 60, 300), openingMinutes(null, 23.9 * 60, 300)]).toEqual([450, 680, 960]);
  });
});
