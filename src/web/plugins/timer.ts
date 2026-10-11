import type { Plugin } from "../plugin-api.ts";
import { clockEmbed } from "./lib/clockEmbed.ts";

/** `::timer{5m}` in a note, counting down from its length. How far it has run is kept in the note after the length, as a stopwatch's is. */
export const timer: Plugin = {
  id: "timer",
  name: "Timer",
  activate(host) {
    host.embeds.register({ name: "timer", title: "Timer", starts: { config: "5m" }, render: clockEmbed("timer") });
  },
};
