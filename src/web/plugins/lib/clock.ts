/**
 * A stopwatch or a timer as its config says it. All of it is in the note, so it runs on through a
 * reload and for everyone reading the note: a running one holds the instant it would have started
 * from zero, and the time shown is worked out from that.
 */
export interface Clock {
  /** How long a timer runs, as written, such as `5m`. Null for a stopwatch. */
  length: string | null;
  run: Run;
}

export type Run = { is: "idle" } | { is: "running"; since: number } | { is: "stopped"; elapsed: number };

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** `1h30m`, `5m`, `90s` in milliseconds, or null for anything else. */
export function durationOf(written: string): number | null {
  const match = written ? DURATION.exec(written) : null;
  if (!match) return null;
  const [h = "0", m = "0", s = "0"] = match.slice(1);
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
}

export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const parts = [[Math.floor(seconds / 3600), "h"], [Math.floor((seconds % 3600) / 60), "m"], [seconds % 60, "s"]] as const;
  return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n}${unit}`).join("") || "0s";
}

/** One word of a config that says how the clock is running, or null for any other word. */
function runOf(word: string): Run | null {
  const [key, value = ""] = word.split("=", 2);
  if (key === "since") {
    const since = Date.parse(value);
    return Number.isNaN(since) ? null : { is: "running", since };
  }
  const elapsed = key === "at" ? durationOf(value) : null;
  return elapsed === null ? null : { is: "stopped", elapsed };
}

/**
 * Reads a config: for a timer its length and then how it is running, for a stopwatch only the
 * latter. `since=<instant>` is running and `at=<duration>` is stopped there. Two members who press
 * the same clock at once each write such a word, and the note keeps both, so the last one is the
 * one read and the next press writes the config clean. Null when a word says anything else, so
 * nothing a member wrote is read as something it isn't.
 */
export function readClock(config: string, kind: "timer" | "stopwatch"): Clock | null {
  const words = config.trim().split(/\s+/).filter(Boolean);
  const length = kind === "timer" ? (words.shift() ?? "") : null;
  if (length !== null && !durationOf(length)) return null;
  const runs = words.map(runOf);
  if (runs.includes(null)) return null;
  return { length, run: runs.at(-1) ?? { is: "idle" } };
}

export function writeClock({ length, run }: Clock): string {
  const how = run.is === "running" ? `since=${new Date(run.since).toISOString()}` : run.is === "stopped" ? `at=${durationText(run.elapsed)}` : "";
  return [length, how].filter(Boolean).join(" ");
}

/** How long it has run. A clock ahead of this one can't make that less than nothing. */
export const elapsedOf = (run: Run, now: number) => (run.is === "running" ? Math.max(0, now - run.since) : run.is === "stopped" ? run.elapsed : 0);

/** Whether a timer has run its length. */
export const finished = (clock: Clock, now: number) => clock.length !== null && elapsedOf(clock.run, now) >= durationOf(clock.length)!;

/** Starts one that isn't running, from where it stopped, and stops one that is. A timer that has finished starts over. */
export function toggled(clock: Clock, now: number): Clock {
  if (finished(clock, now)) return { ...clock, run: { is: "idle" } };
  const { run } = clock;
  if (run.is === "running") return { ...clock, run: { is: "stopped", elapsed: Math.floor(elapsedOf(run, now) / 1000) * 1000 } };
  return { ...clock, run: { is: "running", since: now - elapsedOf(run, now) } };
}

/** The time as it is shown: what a stopwatch has run, and what a timer has left. */
export function shown(clock: Clock, now: number): string {
  const elapsed = elapsedOf(clock.run, now);
  const seconds = clock.length === null ? Math.floor(elapsed / 1000) : Math.ceil(Math.max(0, durationOf(clock.length)! - elapsed) / 1000);
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
