import { callsIn, type Plugin } from "../plugin-api.ts";
import { finished, readClock, shown, type Clock } from "./lib/clock.ts";
import { openNotes } from "./lib/openNotes.ts";
import { useTick } from "./lib/useTick.ts";

const KINDS = { timer: "Timer", stopwatch: "Stopwatch" } as const;

interface Running {
  kind: keyof typeof KINDS;
  clock: Clock;
  /** Where in the note it is written. */
  at: number;
}

/** The timers and stopwatches a note's text has running, or run out and not yet set back, in the order they are written. */
export function runningIn(text: string, kinds: ReadonlySet<string>): Running[] {
  return callsIn(text).flatMap((call) => {
    if (!Object.hasOwn(KINDS, call.name) || !kinds.has(call.name)) return [];
    const kind = call.name as keyof typeof KINDS;
    const clock = readClock(call.config, kind);
    return clock?.run.is === "running" ? [{ kind, clock, at: call.from }] : [];
  });
}

/**
 * The open note's running timers and stopwatches, in the bottom bar, so their time is in sight
 * wherever the note is scrolled to. Pressing one scrolls the note to it.
 */
export const noteClocks: Plugin = {
  id: "note-clocks",
  name: "Note clocks",
  description: "The open note's running timers and stopwatches, in the bottom bar.",
  icon: "clock",
  activate(host) {
    const notes = openNotes(host);
    host.views.register("bar", {
      id: "note-clocks",
      live: true,
      component: ({ app }) => {
        const text = notes.useText(app.noteId);
        const on = new Set(host.embeds.list().map((e) => e.name));
        const running = text === null ? [] : runningIn(text, on);
        const now = useTick(running.length > 0);
        return running.map(({ kind, clock, at }) => {
          const done = finished(clock, now);
          const time = shown(clock, now);
          return (
            <button key={at} type="button" className="bar-clock" data-done={done || undefined} title="Show it in the note" aria-label={`${KINDS[kind]} in this note, ${done ? "finished" : kind === "timer" ? `${time} left` : time}`} onClick={() => notes.show(app.noteId!, at)}>
              {KINDS[kind]} {time}
            </button>
          );
        });
      },
    });
  },
};
