import { useEffect, useMemo, useState } from "react";
import type { CalendarEvent, Plugin, PluginHost, Upload, ViewProps } from "../plugin-api.ts";
import { eventsToFind, finding, listedAs } from "./calendar/finding.ts";
import { eventAddress } from "./calendar/linking.ts";
import { listable } from "./lib/listable.ts";
import { Palette } from "./lib/Palette.tsx";
import { openable, uploadItem, uploadPath, UPLOADS_PATH } from "./uploads/finding.ts";

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
 * Notes by title, uploads by file name while the Uploads page is there to open one on, and with the
 * Calendar on, the member's events by their title and a day typed, from a month back to three months
 * ahead, the nearest first, each opened on the Calendar. Archived notes and uploads are left out until
 * they are asked for, and one in Trash is never offered.
 */
function QuickOpen({ host, app, close }: ViewProps & { host: PluginHost; close: () => void }) {
  const [archived, setArchived] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const notes = app.notes && listable(app.notes, archived);
  const hasUploads = app.pages.some((p) => p.path === UPLOADS_PATH);

  useEffect(() => {
    if (!hasUploads) return;
    let live = true;
    host.perform({ type: "upload.list", includeArchived: archived }).then(
      (listed) => live && setUploads(listed),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [host, hasUploads, archived]);

  const noteItems = (notes ?? []).map((n) => ({ id: n.id, label: n.title || "Untitled", hint: [n.state === "archived" && "Archived", app.folders?.pathName(n.folderId)].filter(Boolean).join(" · ") }));
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
  const open = (event: CalendarEvent) => app.go(eventAddress(event, timeZone));
  return (
    <Palette
      label="Go to note"
      placeholder={calendar && hasUploads ? "Find a note by its title, an upload by its name, or an event by its title and day" : calendar ? "Find a note by its title, or an event by its title and day" : hasUploads ? "Find a note by its title, or an upload by its name" : "Find a note by its title"}
      empty={notes?.length ? "No notes match." : notes ? "There are no notes yet." : "Loading notes…"}
      items={openable(noteItems, hasUploads ? uploads : [], (u) => ["Upload", u.state === "archived" && "Archived"].filter(Boolean).join(" · "))}
      toggle={{ label: "Include archived", on: archived, set: setArchived }}
      found={calendar ? found : undefined}
      onPick={(id) => {
        const event = events?.find((e) => idOf(e) === id);
        const upload = uploadItem(id);
        if (event) open(event);
        else if (upload) app.go(uploadPath(upload));
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
