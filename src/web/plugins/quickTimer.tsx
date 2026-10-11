import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDismiss, type Plugin } from "../plugin-api.ts";
import { durationOf, finished, shown, type Clock } from "./lib/clock.ts";
import { useTick } from "./lib/useTick.ts";

/** A quick timer as it is kept: how long it runs, as typed, and when it was started. */
interface Kept {
  length: string;
  since: number;
}

const KEY = "running";
const kept = (value: unknown): Kept | null => {
  const { length, since } = (value ?? {}) as Partial<Kept>;
  return typeof length === "string" && durationOf(length) && typeof since === "number" ? { length, since } : null;
};

/**
 * A timer that belongs to no note: started from the command palette, shown in the bottom bar. There
 * is no markdown to hold it, so it is kept in this browser for this workspace. It runs on through a
 * reload here, nobody else sees it, and another browser doesn't have it. There is one at a time.
 */
export const quickTimer: Plugin = {
  id: "quick-timer",
  name: "Quick timer",
  description: "A timer that belongs to no note, started from the command palette.",
  icon: "clock",
  activate(host) {
    const listeners = new Set<() => void>();
    let now = kept(host.storage.get(KEY));
    const set = (next: Kept | null) => {
      now = next;
      host.storage.set(KEY, next);
      for (const listener of [...listeners]) listener();
    };
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    };

    host.commands.register({ id: "quickTimer.start", title: "Start a quick timer…", run: () => host.app().toggleOverlay("quick-timer") });
    host.commands.register({ id: "quickTimer.stop", title: "Stop the quick timer", run: () => set(null) });

    host.views.register("overlay", {
      id: "quick-timer",
      component: ({ close }) => {
        const ref = useRef<HTMLFormElement>(null);
        const input = useRef<HTMLInputElement>(null);
        const [length, setLength] = useState(now?.length ?? "5m");
        const valid = !!durationOf(length.trim());
        useDismiss(close, ref);
        useEffect(() => {
          const focused = document.activeElement;
          input.current!.select();
          return () => {
            if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
          };
        }, []);
        return (
          <form
            ref={ref}
            className="palette quick-timer"
            role="dialog"
            aria-label="Quick timer"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              set({ length: length.trim(), since: Date.now() });
              close();
            }}
          >
            <input ref={input} aria-label="How long" aria-invalid={!valid} aria-describedby="quick-timer-how" value={length} onChange={(e) => setLength(e.target.value)} />
            <p id="quick-timer-how" className="quick-timer-how">
              {valid ? "Enter starts it in the bottom bar. It is kept in this browser, not in a note." : "Write a length such as 5m, 90s, or 1h30m."}
            </p>
          </form>
        );
      },
    });

    host.views.register("bar", {
      id: "quick-timer",
      component: () => {
        const running = useSyncExternalStore(subscribe, () => now);
        const clock: Clock | null = running && { length: running.length, run: { is: "running", since: running.since } };
        const time = useTick(clock !== null);
        if (!clock) return null;
        const done = finished(clock, time);
        return (
          <button type="button" className="bar-item bar-clock" data-done={done || undefined} title={done ? "Dismiss" : "Stop it"} aria-label={`Quick timer, ${done ? "finished" : `${shown(clock, time)} left`}`} onClick={() => set(null)}>
            Quick timer {shown(clock, time)}
          </button>
        );
      },
    });
  },
};
