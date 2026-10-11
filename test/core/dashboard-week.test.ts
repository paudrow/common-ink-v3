import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { CalendarEvent, OpInput } from "../../src/core/protocol.ts";
import { sourcesFor } from "../../src/worker/sources/index.ts";
import { newMember } from "./members.ts";

/*
 * The dashboard's events, asked the way the page asks them, at every hour of a week in a zone on
 * each side of UTC, against the sample calendar the browser tests use. The clock is the test's: the
 * operation is handed `now`, the member's day is worked out from it, and nothing reads the wall
 * clock. So what test/browser/dashboard.spec.ts relies on at whatever moment it runs is held here
 * for every moment.
 */

/** The dashboard's day logic, as much of it as is asked here. */
interface DayLogic {
  todayAt(now: number, timeZone: string): { day: string; from: number; to: number; timeZone: string };
  aheadToday(events: readonly CalendarEvent[], today: ReturnType<DayLogic["todayAt"]>, now: number): { event: CalendarEvent; started: boolean }[];
}
// Loaded by a path made here: this file is checked as worker code, and a plain import would have the whole web app checked as that too.
const module = "today";
const { aheadToday, todayAt } = (await import(`../../src/web/plugins/dashboard/${module}.ts`)) as DayLogic;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;
/** Monday 2026-10-05, 00:20 UTC: off the hour, so no event starts or ends at an instant asked about. */
const WEEK_START = Date.UTC(2026, 9, 5, 0, 20);
/** Fixed zones, so the day's bounds can be worked out here without the code under test. */
const ZONES = [
  { timeZone: "Pacific/Kiritimati", ahead: 14 * HOUR },
  { timeZone: "Etc/GMT+12", ahead: -12 * HOUR },
] as const;

const written = (time: number) => new Date(time).toISOString().slice(0, 10);
const shift = (day: string, by: number) => written(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS);
const sources = sourcesFor({ ...env, DEV_SIGN_IN: "1" } as Env, new URL("http://localhost/"));

/**
 * The occurrences a browser test may move, as it picks them: the editable ones of the last three
 * dates in UTC and of this one, listed from the start of the first of those dates. Listed from the
 * instant three days back instead, an event earlier on that date is cut off, which is how the
 * browser test came to find two where it needs three on a Sunday or a Monday after 14:15 UTC.
 */
const movableAt = async (ask: <T extends OpInput>(op: T) => Promise<unknown>, now: number, from = Date.parse(`${written(now - 3 * DAY_MS)}T00:00:00Z`)) => {
  const { events } = (await ask({ type: "event.list", from, to: now + DAY_MS, timeZone: "UTC" })) as { events: CalendarEvent[] };
  return events.filter((e) => e.editable && e.id.slice(-10) >= written(now - 3 * DAY_MS) && e.id.slice(-10) <= written(now));
};

describe("the dashboard's events, at every hour of a week on both sides of UTC", () => {
  it("lists the all-day event of the member's date and the events not yet over, and never one that ended or is another day's", async () => {
    const ada = await newMember();
    const wrong: string[] = [];
    const few: string[] = [];
    const cut: string[] = [];
    let asked = 0;
    await perform(env.DB, ada, { type: "source.connect", id: "sample-calendar" }, WEEK_START, sources);

    for (let hour = 0; hour < 7 * 24; hour++) {
      const now = WEEK_START + hour * HOUR;
      const ask = <T extends OpInput>(op: T) => perform(env.DB, ada as Actor, op, now, sources);
      for (const { timeZone, ahead } of ZONES) {
        const at = `${new Date(now).toISOString().slice(0, 16)}Z ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(now).getUTCDay()]} in ${timeZone}`;
        await env.DB.prepare("DELETE FROM sample_records WHERE person_id = ?").bind(ada.personId).run();
        const day = written(now + ahead);
        const endOfDay = Date.parse(`${shift(day, 1)}T00:00:00Z`) - ahead;

        const movable = await movableAt(ask, now);
        if (movable.length < 3) few.push(`${at}: ${movable.length}`);
        if ((await movableAt(ask, now, now - 3 * DAY_MS)).length < 3) cut.push(at);
        if (movable.length < 3) continue;
        const move = (event: CalendarEvent, title: string, when: CalendarEvent["when"]) => ask({ type: "event.update", sourceId: event.sourceId, id: event.id, etag: event.etag, title, when });
        await move(movable[0]!, "Moved all day", { allDay: true, from: day, to: day });
        await move(movable[1]!, "Moved and over", { allDay: false, from: now - 20 * MINUTE, to: now - 10 * MINUTE });
        await move(movable[2]!, "Moved and ahead", { allDay: false, from: now + HOUR, to: now + 2 * HOUR });

        // As the page asks: the member's day, in their zone.
        const today = todayAt(now, timeZone);
        expect([today.day, today.to], at).toEqual([day, endOfDay]);
        const { events } = await ask({ type: "event.list", from: today.from, to: today.to, timeZone });
        const shown = aheadToday(events, today, now).map(({ event }) => event.title);
        asked++;

        // Worked out here from everything there is around now, by the rule as the issue words it.
        const { events: all } = await ask({ type: "event.list", from: now - 4 * DAY_MS, to: now + 3 * DAY_MS, timeZone: "UTC" });
        const due = all.filter(({ when }) => (when.allDay ? when.from <= day && when.to >= day : when.from < endOfDay && when.to > now)).map((e) => e.title);
        if (JSON.stringify([...shown].sort()) !== JSON.stringify([...due].sort())) wrong.push(`${at}: shown ${shown.join(", ")}; due ${due.join(", ")}`);
        if (!shown.includes("Moved all day") || shown.includes("Moved and over") || shown.includes("Moved and ahead") !== now + HOUR < endOfDay) wrong.push(`${at}: the moved events, shown ${shown.join(", ")}`);
      }
    }

    expect(wrong).toEqual([]);
    expect(few, "three editable occurrences to move, whatever the day and hour").toEqual([]);
    expect(asked).toBe(7 * 24 * ZONES.length);
    // The listing the browser test used to make is short exactly here, in either zone: on a Sunday and a Monday, from 14:15 UTC, when the
    // standup three days before has ended, to the end of that date in UTC.
    const fromStandupsEnd = (date: number, weekday: string) => Array.from({ length: 10 }, (_, i) => `2026-10-${String(date).padStart(2, "0")}T${14 + i}:20Z ${weekday}`);
    expect([...new Set(cut.map((at) => at.slice(0, 21)))]).toEqual([...fromStandupsEnd(5, "Mon"), ...fromStandupsEnd(11, "Sun")]);
  }, 120_000);
});
