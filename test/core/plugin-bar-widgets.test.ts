import { describe, expect, it } from "vitest";
import { runningIn } from "../../src/web/plugins/noteClocks.tsx";

describe("the clocks a note has running", () => {
  const both = new Set(["timer", "stopwatch"]);
  const text = "# Tea\n\nSteep /timer(5m since=2026-10-10T12:00:00.000Z) idle /timer(5m) paused /stopwatch(at=5s)\n\nLap /stopwatch(since=2026-10-10T12:00:01.000Z) and unread /timer(soon since=2026-10-10T12:00:00.000Z)\n";

  it("are those written as running, with where each is in the note", () => {
    expect(runningIn(text, both).map((r) => [r.kind, r.clock.length, text.slice(r.at, r.at + 9)])).toEqual([
      ["timer", "5m", "/timer(5m"],
      ["stopwatch", null, "/stopwatc"],
    ]);
  });

  it("leave out the embeds of a plugin that is off, and what only looks like one", () => {
    expect(runningIn(text, new Set(["stopwatch"])).map((r) => r.kind)).toEqual(["stopwatch"]);
    expect(runningIn("a/timer(5m since=2026-10-10T12:00:00.000Z) ::timer{5m since=2026-10-10T12:00:00.000Z}", both)).toEqual([]);
  });
});
