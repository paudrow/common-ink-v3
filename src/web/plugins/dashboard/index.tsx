import { useEffect, useSyncExternalStore } from "react";
import type { NoteSummary, Plugin } from "../../plugin-api.ts";
import { todoOpener } from "../lib/openTodo.ts";
import { DEFAULT_LAYOUT, Dashboard, PinIcon } from "./Dashboard.tsx";
import { writeLayout } from "./layout.ts";
import { pinsOf, type Pins } from "./pins.ts";
import { membersStamp } from "./today.ts";

/**
 * In the bar above a note: whether it is pinned to the member's dashboard, and the button that pins it
 * or takes the pin away. It is there from the first, so nothing beside it moves once the pins are
 * known. An archived note keeps its pin and is off the dashboard, which the button says.
 */
function PinMark({ pins, note }: { pins: Pins; note: NoteSummary }) {
  const ids = useSyncExternalStore(pins.subscribe, pins.ids);
  useEffect(() => pins.want(), [pins]);
  if (note.state === "trashed") return null;
  const pinned = ids?.includes(note.id) ?? false;
  const label = pinned ? "Unpin from dashboard" : "Pin to dashboard";
  const waits = note.state === "archived" ? (pinned ? "Pinned. It is on your dashboard again once this note is unarchived." : "Pin to dashboard. An archived note is on your dashboard once it is unarchived.") : label;
  return (
    <button type="button" className="pin-mark" aria-label={label} aria-description={waits === label ? undefined : waits} title={waits} aria-pressed={pinned} disabled={ids === null} onClick={() => pins.set(note.id, !pinned)}>
      <PinIcon />
    </button>
  );
}

/**
 * The Dashboard: what is ahead of one member today, drawn from the operations every other view uses.
 * It is the home page, so it is what the app opens to when no note is addressed and no tab is open. Pins are the
 * member's own and kept by the server, outside any note, and so is which panels it shows and how.
 */
export const dashboard: Plugin = {
  id: "dashboard",
  name: "Dashboard",
  description: "The home page: what is ahead of you today, your pinned notes, and what changed.",
  icon: "dashboard",
  settings: {
    layout: {
      type: "list",
      default: writeLayout(DEFAULT_LAYOUT),
      maxItems: 20,
      maxLength: 40,
      remembered: true,
      title: "Dashboard panels",
      description: "The panels your Dashboard shows, in order, each with its size: small, wide, tall or large. Change them with Edit dashboard on the Dashboard. They are kept on the server with your settings for this workspace, so the Dashboard looks the same in every browser you sign in on.",
    },
  },
  activate(host) {
    const pins = pinsOf(host);
    const openTodo = todoOpener(host);
    host.views.register("page", { id: "dashboard", path: "/dashboard", home: true, label: "Dashboard", icon: "dashboard", nav: "primary", order: 10, component: ({ app }) => <Dashboard host={host} app={app} pins={pins} onOpenTodo={openTodo} /> });
    host.views.register("mark", { id: "pin", component: ({ note }) => <PinMark pins={pins} note={note} /> });

    // A pin is listed while its note is in sight and out of Trash, so the pins are read again when a note comes or goes, and for no edit.
    let members: string | null = null;
    return host.onItems(() => {
      const notes = host.app().notes;
      if (!notes) return;
      const now = membersStamp(notes);
      if (members !== null && now !== members && pins.ids() !== null) pins.read();
      members = now;
    });
  },
};
