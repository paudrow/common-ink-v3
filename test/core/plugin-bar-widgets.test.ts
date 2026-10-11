import { describe, expect, it } from "vitest";
import { runningIn } from "../../src/web/plugins/noteClocks.tsx";
import { counted } from "../../src/web/plugins/wordCount.tsx";

describe("the clocks a note has running", () => {
  const both = new Set(["timer", "stopwatch"]);
  const text = "# Tea\n\nSteep ::timer{5m since=2026-10-10T12:00:00.000Z} idle ::timer{5m} paused ::stopwatch{at=5s}\n\nLap ::stopwatch{since=2026-10-10T12:00:01.000Z} and unread ::timer{soon since=2026-10-10T12:00:00.000Z}\n";

  it("are those written as running, with where each is in the note", () => {
    expect(runningIn(text, both).map((r) => [r.kind, r.clock.length, text.slice(r.at, r.at + 9)])).toEqual([
      ["timer", "5m", "::timer{5"],
      ["stopwatch", null, "::stopwat"],
    ]);
  });

  it("leave out the embeds of a plugin that is off, and the opening of a block", () => {
    expect(runningIn(text, new Set(["stopwatch"])).map((r) => r.kind)).toEqual(["stopwatch"]);
    expect(runningIn(":::timer{5m since=2026-10-10T12:00:00.000Z}\n:::", both)).toEqual([]);
  });
});

describe("a note's word count", () => {
  it("counts words and not markdown's marks, and rounds reading time up to a minute", () => {
    expect(counted("")).toEqual({ words: 0, minutes: 0 });
    expect(counted("# Plan\n\n- [ ] write the *first* draft\n\n---\n")).toEqual({ words: 5, minutes: 1 });
    expect(counted(Array(231).fill("word").join(" "))).toEqual({ words: 231, minutes: 2 });
    expect(counted("naïve café 東京 2026")).toEqual({ words: 4, minutes: 1 });
    expect(counted("Steep ::timer{5m since=2026-10-10T12:00:00.000Z} now\n\n:::kanban{}\n## To do\n- write\n:::\n")).toEqual({ words: 5, minutes: 1 });
  });
});
