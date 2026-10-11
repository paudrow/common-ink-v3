import { describe, expect, it } from "vitest";
import { durationOf, durationText, elapsedOf, finished, readClock, shown, toggled, writeClock, type Clock } from "../../src/web/plugins/lib/clock.ts";

const NOON = Date.parse("2026-10-10T12:00:00.000Z");
const timer = (config: string) => readClock(config, "timer")!;
const watch = (config: string) => readClock(config, "stopwatch")!;

describe("a clock's config", () => {
  it("reads and writes durations", () => {
    expect([durationOf("5m"), durationOf("1h30m"), durationOf("90s"), durationOf("1h2m3s")]).toEqual([300_000, 5_400_000, 90_000, 3_723_000]);
    expect([durationOf(""), durationOf("5"), durationOf("5 m"), durationOf("m"), durationOf("5m1h")]).toEqual([null, null, null, null, null]);
    expect([durationText(300_000), durationText(5_400_000), durationText(3_723_999), durationText(0)]).toEqual(["5m", "1h30m", "1h2m3s", "0s"]);
  });

  it("reads each way a stopwatch and a timer are written, and writes each back as it was", () => {
    const written: [config: string, kind: "timer" | "stopwatch", clock: Clock][] = [
      ["", "stopwatch", { length: null, run: { is: "idle" } }],
      ["at=1m5s", "stopwatch", { length: null, run: { is: "stopped", elapsed: 65_000 } }],
      ["since=2026-10-10T12:00:00.000Z", "stopwatch", { length: null, run: { is: "running", since: NOON } }],
      ["5m", "timer", { length: "5m", run: { is: "idle" } }],
      ["90s at=30s", "timer", { length: "90s", run: { is: "stopped", elapsed: 30_000 } }],
      ["1h30m since=2026-10-10T12:00:00.000Z", "timer", { length: "1h30m", run: { is: "running", since: NOON } }],
    ];
    for (const [config, kind, clock] of written) {
      expect([config, readClock(config, kind)]).toEqual([config, clock]);
      expect(writeClock(clock)).toBe(config);
    }
  });

  it("reads nothing from a config that says anything else", () => {
    for (const config of ["", "soon", "0s", "5m later", "5m at=", "5m since=tomorrow", "5m at=10s later", "at=10s"]) expect([config, readClock(config, "timer")]).toEqual([config, null]);
    for (const config of ["5m", "at=ten", "since=", "lap=3"]) expect([config, readClock(config, "stopwatch")]).toEqual([config, null]);
  });
});

describe("a clock two members pressed at once", () => {
  it("reads the last word the merge left, and the next press writes one word", () => {
    const merged = "5m since=2026-10-10T12:00:03.000Z since=2026-10-10T12:00:00.000Z";
    expect(timer(merged)).toEqual({ length: "5m", run: { is: "running", since: NOON } });
    expect(writeClock(toggled(timer(merged), NOON + 10_000))).toBe("5m at=10s");
    expect(watch("since=2026-10-10T12:00:03.000Z since=2026-10-10T12:00:00.000Z")).toEqual({ length: null, run: { is: "running", since: NOON } });
    expect(watch("since=2026-10-10T12:00:00.000Z at=4s")).toEqual({ length: null, run: { is: "stopped", elapsed: 4000 } });
    expect(timer("5m at=10s since=2026-10-10T12:00:00Z").run).toEqual({ is: "running", since: NOON });
  });
});

describe("a clock running", () => {
  it("starts a stopwatch, stops it at whole seconds, and starts it again from there", () => {
    const running = toggled(watch(""), NOON);
    expect(writeClock(running)).toBe("since=2026-10-10T12:00:00.000Z");
    expect(shown(running, NOON + 65_400)).toBe("1:05");

    const stopped = toggled(running, NOON + 65_400);
    expect(writeClock(stopped)).toBe("at=1m5s");
    expect(shown(stopped, NOON + 999_999)).toBe("1:05");

    const again = toggled(stopped, NOON + 100_000);
    expect(elapsedOf(again.run, NOON + 110_000)).toBe(75_000);
    expect(shown(again, NOON + 3_700_000)).toBe("1:01:05");
  });

  it("counts a timer down from its length, the same for anyone who reads the note, and holds what is left when paused", () => {
    const running = toggled(timer("5m"), NOON);
    expect(writeClock(running)).toBe("5m since=2026-10-10T12:00:00.000Z");
    expect([shown(running, NOON), shown(running, NOON + 100), shown(running, NOON + 61_000)]).toEqual(["5:00", "5:00", "3:59"]);
    expect(shown(timer(writeClock(running)), NOON + 61_000)).toBe("3:59");

    const paused = toggled(running, NOON + 61_900);
    expect(writeClock(paused)).toBe("5m at=1m1s");
    expect(shown(paused, NOON + 500_000)).toBe("3:59");
  });

  it("finishes a timer at nothing left, and starts it over from there", () => {
    const running = timer("5m since=2026-10-10T12:00:00.000Z");
    expect([finished(running, NOON + 299_999), finished(running, NOON + 300_000)]).toEqual([false, true]);
    expect(shown(running, NOON + 400_000)).toBe("0:00");
    expect(writeClock(toggled(running, NOON + 400_000))).toBe("5m");
    expect(finished(watch("at=99h"), NOON)).toBe(false);
  });

  it("shows nothing run for a clock started by someone whose clock is ahead", () => {
    expect(shown(watch("since=2026-10-10T12:00:05.000Z"), NOON)).toBe("0:00");
    expect(shown(timer("5m since=2026-10-10T12:00:05.000Z"), NOON)).toBe("5:00");
  });
});
