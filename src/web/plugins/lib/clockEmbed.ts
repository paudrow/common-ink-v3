import type { Embed, EmbedOptions } from "../../plugin-api.ts";
import { durationOf, durationText, elapsedOf, finished, readClock, shown, toggled, writeClock } from "./clock.ts";
import { lettering, sketch } from "./sketch.ts";

/** A clock showing `time` with its start button, as the insert menu pictures a timer or a stopwatch. */
export const clockSketch = (time: string) => sketch(`<path d="M44 28 L62 42 L44 56 Z"/>` + lettering(74, 54, 34, time, 'font-weight="600"'));

const KINDS = {
  stopwatch: { title: "Stopwatch", hint: "Start or stop the stopwatch", example: "::stopwatch{}", stop: "Stop" },
  timer: { title: "Timer", hint: "Start or pause the timer", example: "::timer{5m}", stop: "Pause" },
} as const;

const HOW = "Write it like 25m, 1h30m or 90s.";

/** How long a stopwatch has run, set from its settings. A timer's length is a key of its config, which the host sets. */
export const stopwatchOptions: EmbedOptions = {
  fields({ config }) {
    const clock = readClock(config, "stopwatch");
    return clock ? [{ id: "time", label: "Time so far", kind: "text", value: durationText(elapsedOf(clock.run, Date.now())), hint: HOW }] : [];
  },
  set({ config }, id, value) {
    const clock = readClock(config, "stopwatch");
    const length = durationOf(value.trim());
    if (!clock || length === null || id !== "time") return HOW;
    // A running stopwatch runs on from the time it is set to.
    const run = clock.run.is === "running" ? ({ is: "running", since: Date.now() - length } as const) : length ? ({ is: "stopped", elapsed: length } as const) : ({ is: "idle" } as const);
    return { config: writeClock({ ...clock, run }) };
  },
};

/**
 * A stopwatch or a timer drawn in a note: its time, a button that starts and stops it, and one that
 * sets it back, each saying what it does. The time is a button too, which starts and stops it as the
 * one beside it does. Each press rewrites the embed's config, which is where its time is kept, and
 * the buttons are changed where they stand, so nothing in the line moves. A member who can't change
 * the note sees the time and can't press it.
 */
export function clockEmbed(kind: keyof typeof KINDS): Embed["render"] {
  const { title, hint, example, stop } = KINDS[kind];
  return (el, first) => {
    let embed = first;
    let clock = readClock(embed.config, kind);
    let ticking: ReturnType<typeof setInterval> | undefined;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "clock";
    toggle.title = embed.readOnly ? title : hint;
    toggle.disabled = embed.readOnly;
    toggle.addEventListener("click", () => clock && embed.update({ config: writeClock(toggled(clock, Date.now())) }));

    const press = document.createElement("button");
    press.type = "button";
    press.className = "clock-press";
    press.addEventListener("click", () => clock && embed.update({ config: writeClock(toggled(clock, Date.now())) }));

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "clock-reset";
    // What each button says is drawn from this and not written in it, so the time is the only text a clock adds to its line.
    reset.dataset.label = "Reset";
    reset.title = reset.ariaLabel = `Reset ${title.toLowerCase()}`;
    reset.addEventListener("click", () => {
      if (!clock) return;
      // It is about to have nothing to set back, and can't keep the focus then.
      toggle.focus();
      embed.update({ config: writeClock({ ...clock, run: { is: "idle" } }) });
    });

    const unread = document.createElement("span");
    unread.className = "clock-unread";
    unread.textContent = `${title}: write it like ${example}`;

    const show = () => {
      if (!clock) return;
      const now = Date.now();
      const done = finished(clock, now);
      toggle.textContent = shown(clock, now);
      toggle.classList.toggle("done", done);
      toggle.setAttribute("aria-label", `${title}, ${done ? "finished" : kind === "timer" ? `${toggle.textContent} left` : toggle.textContent}`);
      toggle.setAttribute("aria-pressed", String(clock.run.is === "running" && !done));
      const running = clock.run.is === "running" && !done;
      if (press.dataset.label !== (running ? stop : "Start")) {
        press.dataset.label = running ? stop : "Start";
        press.title = press.ariaLabel = `${press.dataset.label} ${title.toLowerCase()}`;
      }
      // A timer that has run out has nothing to start or stop until it is set back.
      press.disabled = done;
      if (done) clearInterval(ticking);
    };
    const fit = () => {
      clearInterval(ticking);
      ticking = clock?.run.is === "running" ? setInterval(show, 250) : undefined;
      // The button that sets it back is there, and can't be pressed, while there is nothing to set back, so starting the clock moves nothing after it.
      reset.disabled = !clock || clock.run.is === "idle";
      const parts = clock ? (embed.readOnly ? [toggle] : [toggle, press, reset]) : [unread];
      if (parts.some((part, i) => el.childNodes[i] !== part) || el.childNodes.length !== parts.length) el.replaceChildren(...parts);
      show();
    };
    fit();
    return {
      update(next) {
        embed = next;
        clock = readClock(next.config, kind);
        fit();
      },
      stop: () => clearInterval(ticking),
    };
  };
}
