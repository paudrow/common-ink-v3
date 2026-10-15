import { useEffect, useMemo, useState } from "react";
import type { CalendarEvent, Plugin, PluginHost, ViewProps } from "../plugin-api.ts";
import { dayIn } from "./calendar/dates.ts";
import { eventsToFind, finding, listedAs } from "./calendar/finding.ts";
import { listable } from "./lib/listable.ts";
import { Palette } from "./lib/Palette.tsx";

/** How many events are offered at most beside the notes. */
const MOST_EVENTS = 10;

/** The member's events to go to, while the Calendar page is there to open one on: read once it opens, and null until they are. */
function useEvents(host: PluginHost, calendar: boolean, timeZone: string): readonly CalendarEvent[] | null {
  const [events, setEvents] = useState<readonly CalendarEvent[] | null>(null);
  useEffect(() => {
    if (!calendar) return;
    let current = true;
    const { now, read } = eventsToFind(host, timeZone);
    if (now) setEvents(now);
    void read.then((read) => current && setEvents(read));
    return () => void (current = false);
  }, [host, calendar, timeZone]);
  return calendar ? events : null;
}

/**
 * Notes by title, and with the Calendar on, the member's events by their title and a day typed, from
 * a month back to three months ahead, the nearest first, each opened on the Calendar. Archived notes
 * are left out until they are asked for, and one in Trash is never offered.
 */
function QuickOpen({ host, app, close }: ViewProps & { host: PluginHost; close: () => void }) {
  const [archived, setArchived] = useState(false);
  const notes = app.notes && listable(app.notes, archived);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const calendar = app.pages.some((page) => page.path === "/calendar");
  const events = useEvents(host, calendar, timeZone);
  const idOf = (event: CalendarEvent) => `event ${event.sourceId} ${event.id}`;
  const found = (typed: string) =>
    finding(events ?? [], typed, Date.now(), timeZone)
      .slice(0, MOST_EVENTS)
      .map((event) => {
        const { label, detail } = listedAs(event, timeZone);
        return { id: idOf(event), label, hint: `Event · ${detail}` };
      });
  const open = (event: CalendarEvent) => {
    const day = event.when.allDay ? event.when.from : dayIn(event.when.from, timeZone);
    app.go(`/calendar?${new URLSearchParams({ source: event.sourceId, event: event.id, day })}`);
  };
  return (
    <Palette
      label="Go to note"
      placeholder={calendar ? "Find a note by its title, or an event by its title and day" : "Find a note by its title"}
      most={50}
      empty={notes?.length ? "No notes match." : notes ? "There are no notes yet." : "Loading notes…"}
      items={(notes ?? []).map((n) => ({ id: n.id, label: n.title || "Untitled", hint: [n.state === "archived" && "Archived", app.folders?.pathName(n.folderId)].filter(Boolean).join(" · ") }))}
      toggle={{ label: "Include archived", on: archived, set: setArchived }}
      found={calendar ? found : undefined}
      onPick={(id) => {
        const event = events?.find((e) => idOf(e) === id);
        if (event) open(event);
        else app.openNote(id);
      }}
      onClose={close}
    />
  );
}

export const quickOpen: Plugin = {
  id: "quick-open",
  name: "Quick open",
  description: "Go to a note by typing part of its title, or to an event on the Calendar by its title and day.",
  icon: "search",
  activate(host) {
    host.commands.register({ id: "notes.quickOpen", title: "Go to note…", keys: ["mod+p"], group: "Navigation", run: () => host.app().toggleOverlay("notes") });
    host.views.register("overlay", { id: "notes", component: (props) => <QuickOpen host={host} {...props} /> });
  },
};
