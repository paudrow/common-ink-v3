import type { Plugin } from "../plugin-api.ts";
import { clockEmbed } from "./lib/clockEmbed.ts";

/** `::stopwatch{}` in a note. Its time is kept in the note: `::stopwatch{since=…}` while it runs, and `::stopwatch{at=1m5s}` once stopped. */
export const stopwatch: Plugin = {
  id: "stopwatch",
  name: "Stopwatch",
  activate(host) {
    host.embeds.register({ name: "stopwatch", title: "Stopwatch", render: clockEmbed("stopwatch") });
  },
};
