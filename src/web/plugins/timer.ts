import type { Plugin } from "../plugin-api.ts";
import { clockEmbed, clockOptions } from "./lib/clockEmbed.ts";

/** `::timer{5m}` in a note, counting down from its length. How far it has run is kept in the note after the length, as a stopwatch's is. */
export const timer: Plugin = {
  id: "timer",
  name: "Timer",
  description: "A countdown in a note, written ::timer{5m}, that runs the same for everyone reading.",
  icon: "clock",
  activate(host) {
    host.embeds.register({ name: "timer", title: "Timer", live: true, starts: { config: "5m" }, render: clockEmbed("timer"), options: clockOptions("timer") });
  },
};
