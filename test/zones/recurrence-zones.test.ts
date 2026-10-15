// Run by node, where the process has a time zone to set: the core's own tests run where it is always UTC.
// A due date is a calendar date, so the next one is the same day whatever zone the server or the browser is in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDue, parseRule } from "../../src/core/recurrence.ts";
import { completeTodo } from "../../src/core/todos.ts";

/** Zones whose clocks change, on both sides of UTC and of the date line, and one that changes by half an hour. */
const ZONES = ["America/New_York", "Europe/London", "Pacific/Apia", "Australia/Lord_Howe", "America/Santiago", "UTC"];

/** Rules stepped over the days clocks change in 2026: 8 March and 1 November in New York, 29 March and 25 October in London, 5 April and 4 October in Sydney. */
const NEXT: [rule: string, due: string | null, done: string, next: string][] = [
  ["1d", "2026-03-07", "2026-03-07", "2026-03-08"],
  ["1d", "2026-03-08", "2026-03-08", "2026-03-09"],
  ["1d", "2026-10-31", "2026-10-31", "2026-11-01"],
  ["1d", "2026-11-01", "2026-11-01", "2026-11-02"],
  ["1d", "2026-03-28", "2026-03-28", "2026-03-29"],
  ["1d", "2026-03-29", "2026-03-29", "2026-03-30"],
  ["1d", "2026-10-24", "2026-10-24", "2026-10-25"],
  ["1d", "2026-10-25", "2026-10-25", "2026-10-26"],
  ["1d", "2026-04-04", "2026-04-04", "2026-04-05"],
  ["1d", "2026-10-03", "2026-10-03", "2026-10-04"],
  ["1w", "2026-03-05", "2026-03-05", "2026-03-12"],
  ["2w", "2026-10-25", "2026-11-09", "2026-11-22"],
  ["1m", "2026-02-08", "2026-02-08", "2026-03-08"],
  ["1y", "2025-03-08", "2025-03-08", "2026-03-08"],
  ["3d-after-done", null, "2026-03-07", "2026-03-10"],
  ["1d", "2026-10-31", "2026-12-25", "2026-12-26"],
  ["sun", "2026-03-01", "2026-03-01", "2026-03-08"],
  ["mon,thu", null, "2026-10-31", "2026-11-02"],
  ["last-day", "2026-02-28", "2026-02-28", "2026-03-31"],
  ["1st-day", "2026-10-15", "2026-10-15", "2026-11-01"],
  ["2nd-sun", "2026-02-08", "2026-02-08", "2026-03-08"],
  ["last-sun", "2026-09-27", "2026-09-27", "2026-10-25"],
];

for (const zone of ZONES) {
  test(`the next due date is the same day in ${zone}`, () => {
    process.env.TZ = zone;
    assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, zone);
    if (zone === "America/New_York") assert.notEqual(new Date(2026, 2, 7, 12).getTimezoneOffset(), new Date(2026, 2, 9, 12).getTimezoneOffset());
    for (const [rule, due, done, next] of NEXT) assert.equal(nextDue(parseRule(rule)!, { due, done }), next, `${rule} due ${due} done ${done}`);
    assert.deepEqual(completeTodo("- [ ] Clocks due:2026-03-07 every:1d", "2026-03-07"), { line: "- [ ] Clocks due:2026-03-08 every:1d done:2026-03-07x1", filed: "- [x] Clocks due:2026-03-07" });
  });
}
