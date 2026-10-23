import { useEffect, useMemo, useState } from "react";
import { allPages, folderTitle, type App, type CalendarEvent, type Opened, type Plugin, type PluginHost, type Upload, type ViewProps } from "../plugin-api.ts";
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

/** How many places visited lately are offered at most, after the tabs open. */
const MOST_RECENT = 12;

/**
 * What is offered first before anything is typed: the tabs open, each with its pane where there are
 * several, the one visited last first and the one in front last; then the notes, lists and pages
 * visited lately that aren't open, the latest first. Every other note follows them.
 */
function placesFor(app: App): { item: { id: string; label: string; hint: string }; opened: Opened; tab: boolean }[] {
  const recent = app.recent();
  const tabs = app.openTabs();
  const panes = new Set(tabs.map((t) => t.pane)).size;
  const note = (id: string) => app.notes?.find((n) => n.id === id);
  const page = (id: string) => app.pages.find((p) => p.id === id);
  /** Where a page has a tab for each of several keys, as each tag's page does, which one an address is. */
  const tabAt = (opened: Opened) => (opened.kind === "page" ? page(opened.id)?.tabAt?.(opened.path.split("?")[0]!) : undefined);
  const sameTab = (a: Opened, b: Opened) => a.kind === b.kind && a.id === b.id && tabAt(a)?.key === tabAt(b)?.key;
  const rank = (opened: Opened) => {
    const at = recent.findIndex((r) => sameTab(r, opened));
    return app.opened && sameTab(app.opened, opened) ? Infinity : at < 0 ? recent.length : at;
  };
  const named = (opened: Opened) =>
    opened.kind === "note"
      ? (note(opened.id)?.title || "Untitled")
      : opened.kind === "folder"
        ? ((app.folders && folderTitle(app.folders, opened.id)) ?? "Folder")
        : (tabAt(opened)?.title ?? page(opened.id)?.label ?? "Page");
  const kindOf = (opened: Opened) => {
    if (opened.kind === "note") return app.folders?.pathName(note(opened.id)?.folderId ?? null) ?? "";
    if (opened.kind === "folder") return "Folder";
    const at = opened.path.split("?")[0];
    // The home page at `/` is at its own place, as a page at its own path is. Under it, the rest of the path says which.
    if (at === "/" || at === page(opened.id)?.path) return "Page";
    try {
      return `Page · ${decodeURIComponent(at!)}`;
    } catch {
      return `Page · ${at}`;
    }
  };
  const there = (opened: Opened) => (opened.kind === "note" ? !!note(opened.id) : opened.kind === "folder" ? !app.folders || folderTitle(app.folders, opened.id) !== null : !!page(opened.id));
  const open = tabs
    .filter((t) => there(t.opened))
    .toSorted((a, b) => rank(a.opened) - rank(b.opened))
    .map(({ opened, pane }, i) => ({ item: { id: `tab ${i}`, label: named(opened), hint: [panes > 1 ? `Open in pane ${pane}` : "Open", kindOf(opened)].filter(Boolean).join(" · ") }, opened, tab: true }));
  const lately = recent
    .filter((r) => there(r) && !tabs.some((t) => sameTab(t.opened, r)))
    .slice(0, MOST_RECENT)
    .map((opened, i) => ({ item: { id: `recent ${i}`, label: named(opened), hint: ["Recent", kindOf(opened)].filter(Boolean).join(" · ") }, opened, tab: false }));
  return [...open, ...lately];
}

/**
 * Before anything is typed, the tabs open and the places visited lately, then every other note. Typed: notes by title, uploads by file name while the Uploads page is there to open one on, and with the
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
    // Quick open finds an upload by any part of its name, so it reads every one the member can see.
    allPages((after) => host.perform({ type: "upload.list", includeArchived: archived, limit: 500, after }), (page) => page.uploads).then(
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
  const [places] = useState(() => placesFor(app));
  const toPlace = ({ opened }: (typeof places)[number]) => {
    // A tab is put in front where it is, kept or a preview as it was, as going to its address does.
    app.go(opened.kind === "note" ? app.notePath(opened.id) : opened.kind === "folder" ? app.folderPath(opened.id) : opened.path);
  };
  return (
    <Palette
      label="Go to note"
      placeholder={calendar && hasUploads ? "Find a note by its title, an upload by its name, or an event by its title and day" : calendar ? "Find a note by its title, or an event by its title and day" : hasUploads ? "Find a note by its title, or an upload by its name" : "Find a note by its title"}
      empty={notes?.length ? "No notes match." : notes ? "There are no notes yet." : "Loading notes…"}
      items={openable(noteItems, hasUploads ? uploads : [], (u) => ["Upload", u.state === "archived" && "Archived"].filter(Boolean).join(" · "))}
      toggle={{ label: "Include archived", on: archived, set: setArchived }}
      found={calendar ? found : undefined}
      idle={places.length ? [...places.map((p) => p.item), ...noteItems.filter((n) => !places.some((p) => p.opened.kind === "note" && p.opened.id === n.id))] : undefined}
      onPick={(id) => {
        const place = places.find((p) => p.item.id === id);
        if (place) return toPlace(place);
        const event = events?.find((e) => idOf(e) === id);
        const upload = uploadItem(id);
        if (event) open(event);
        else if (upload) app.go(uploadPath(upload));
        // A note found by its title opens in the pane in front; a tab listed with its pane is gone to there.
        else app.openNote(id);
      }}
      onClose={close}
    />
  );
}

export const quickOpen: Plugin = {
  id: "quick-open",
  name: "Quick open",
  description: "Go to a tab open or a place visited lately, a note by typing part of its title, or an event on the Calendar by its title and day.",
  icon: "search",
  activate(host) {
    host.commands.register({ id: "notes.quickOpen", title: "Go to note…", keys: ["mod+p"], group: "Navigation", run: () => host.app().toggleOverlay("notes") });
    host.views.register("overlay", { id: "notes", component: (props) => <QuickOpen host={host} {...props} /> });
  },
};
