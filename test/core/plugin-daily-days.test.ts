import { describe, expect, it } from "vitest";
import { dayHeading, dayTitled, todayIn, toward } from "../../src/web/plugins/daily/days.ts";

const at = (iso: string) => Date.parse(iso);

describe("the days a member walks to from a daily note", () => {
  it("are the day before and the day after, across the end of a month and of a year", () => {
    expect(toward("2026-10-01", -1, "2026-10-16").day).toBe("2026-09-30");
    expect(toward("2026-09-30", 1, "2026-10-16").day).toBe("2026-10-01");
    expect(toward("2026-03-01", -1, "2026-10-16").day).toBe("2026-02-28");
    expect(toward("2028-03-01", -1, "2026-10-16").day).toBe("2028-02-29");
    expect(toward("2026-12-31", 1, "2026-10-16").day).toBe("2027-01-01");
  });

  it("make today's note and tomorrow's when they aren't there, and only find any other day's", () => {
    const today = "2026-10-31";
    expect([-2, -1, 0, 1, 2].map((by) => toward(today, by, today))).toEqual([
      { day: "2026-10-29", make: false },
      { day: "2026-10-30", make: false },
      { day: "2026-10-31", make: true },
      { day: "2026-11-01", make: true },
      { day: "2026-11-02", make: false },
    ]);
    expect(toward("2026-11-01", -1, today)).toEqual({ day: "2026-10-31", make: true });
    expect(toward("2026-10-30", 1, today)).toEqual({ day: "2026-10-31", make: true });
  });
});

describe("today, where the member is", () => {
  it("is their own date where it isn't the date in UTC, and yesterday and tomorrow are counted from it", () => {
    const now = at("2026-11-01T03:00:00Z");
    expect(todayIn(now, "UTC")).toBe("2026-11-01");
    const inLA = todayIn(now, "America/Los_Angeles");
    expect(inLA).toBe("2026-10-31");
    expect(toward(inLA, -1, inLA)).toEqual({ day: "2026-10-30", make: false });
    expect(toward(inLA, 1, inLA)).toEqual({ day: "2026-11-01", make: true });

    const late = at("2026-10-31T11:00:00Z");
    const inKiritimati = todayIn(late, "Pacific/Kiritimati");
    expect(inKiritimati).toBe("2026-11-01");
    expect(toward(inKiritimati, -1, inKiritimati)).toEqual({ day: "2026-10-31", make: false });
  });
});

describe("the day a daily note is for", () => {
  it("is read from a heading or a title that is a real date, and from nothing else", () => {
    expect(dayHeading("# 2026-10-16")).toBe("2026-10-16");
    expect(dayHeading("# 2026-10-16  ")).toBe("2026-10-16");
    expect(dayHeading("## 2026-10-16")).toBeNull();
    expect(dayHeading("# 2026-10-16 standup")).toBeNull();
    expect(dayHeading("# 2026-02-30")).toBeNull();
    expect(dayTitled("2026-10-16")).toBe("2026-10-16");
    expect(dayTitled("Plans")).toBeNull();
  });
});
