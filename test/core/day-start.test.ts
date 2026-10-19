import { describe, expect, it } from "vitest";
import { dayIn, dayStartIn, timeIn } from "../../src/core/history.ts";

/** The first instant of `day` is on that day, and the instant before it is not. */
const begins = (zone: string, day: string, previous: string, clock: string) => {
  const start = dayStartIn(zone)(day);

  expect(dayIn(zone)(start)).toBe(day);
  expect(dayIn(zone)(start - 1)).toBe(previous);
  expect(timeIn(zone)(start).startsWith(`${day}T${clock}`)).toBe(true);
};

describe("when a calendar day begins", () => {
  it("is midnight where the zone has one", () => {
    begins("Africa/Cairo", "2026-04-23", "2026-04-22", "00:00:00.000");
    begins("America/Los_Angeles", "2026-03-08", "2026-03-07", "00:00:00.000");
    begins("UTC", "2026-04-24", "2026-04-23", "00:00:00.000");
  });

  it("is the next time the clocks read when the zone skips midnight", () => {
    // Egypt and Lebanon jump from midnight to 1:00 on the spring-forward day. Cuba does the same.
    begins("Africa/Cairo", "2026-04-24", "2026-04-23", "01:00:00.000");
    begins("Asia/Beirut", "2026-03-29", "2026-03-28", "01:00:00.000");
    begins("America/Havana", "2026-03-08", "2026-03-07", "01:00:00.000");
  });
});
