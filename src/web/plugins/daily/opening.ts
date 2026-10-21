import type { PluginHost } from "../../plugin-api.ts";
import type { Asked } from "./days.ts";

/** Opens the member's daily note for the day asked, made as Today makes it when it may be, or says there is none. */
export async function openDay(host: PluginHost, { day, make }: Asked) {
  try {
    if (make) {
      const note = await host.perform({ type: "daily.open", on: day });
      host.app().noteChanged(note);
      host.app().refresh();
      host.app().openNote(note.id, { focus: true });
      return;
    }
    const { note } = await host.perform({ type: "daily.find", on: day });
    if (note) host.app().openNote(note.id, { focus: true });
    else host.app().notify({ message: `No note for ${day}` });
  } catch (err) {
    host.app().notify({ message: err instanceof Error ? err.message : "Common Ink can't be reached." });
  }
}
