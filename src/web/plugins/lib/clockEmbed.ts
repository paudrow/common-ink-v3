import type { Embed } from "../../plugin-api.ts";
import { finished, readClock, shown, toggled, writeClock } from "./clock.ts";

const KINDS = {
  stopwatch: { title: "Stopwatch", hint: "Start or stop the stopwatch", example: "::stopwatch{}" },
  timer: { title: "Timer", hint: "Start or pause the timer", example: "::timer{5m}" },
} as const;

/**
 * A stopwatch or a timer drawn in a note: a button that starts and stops it, and one that sets it
 * back. Each press rewrites the embed's config, which is where its time is kept, and the buttons
 * are changed where they stand, so nothing in the line moves. A member who can't change the note
 * sees the time and can't press it.
 */
export function clockEmbed(kind: keyof typeof KINDS): Embed["render"] {
  const { title, hint, example } = KINDS[kind];
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

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "clock-reset";
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
      if (done) clearInterval(ticking);
    };
    const fit = () => {
      clearInterval(ticking);
      ticking = clock?.run.is === "running" ? setInterval(show, 250) : undefined;
      // The button that sets it back keeps its place while there is nothing to set back, so starting the clock moves nothing after it.
      reset.disabled = !clock || clock.run.is === "idle";
      const parts = clock ? (embed.readOnly ? [toggle] : [toggle, reset]) : [unread];
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
