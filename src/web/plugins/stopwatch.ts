import type { Plugin } from "../plugin-api.ts";
import { clockEmbed, clockOptions } from "./lib/clockEmbed.ts";

/** `::stopwatch{}` in a note. Its time is kept in the note: `::stopwatch{since=…}` while it runs, and `::stopwatch{at=1m5s}` once stopped. */
export const stopwatch: Plugin = {
  id: "stopwatch",
  name: "Stopwatch",
  description: "A stopwatch in a note, written ::stopwatch{}, whose time is kept in the note.",
  icon: "stopwatch",
  activate(host) {
    host.embeds.register({ name: "stopwatch", title: "Stopwatch", live: true, render: clockEmbed("stopwatch"), options: clockOptions("stopwatch") });
  },
};
