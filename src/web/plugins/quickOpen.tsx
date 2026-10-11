import { useState } from "react";
import type { Plugin, ViewProps } from "../plugin-api.ts";
import { listable } from "./lib/listable.ts";
import { Palette } from "./lib/Palette.tsx";

/** Notes by title. Archived ones are left out until they are asked for, and one in Trash is never offered. */
function QuickOpen({ app, close }: ViewProps & { close: () => void }) {
  const [archived, setArchived] = useState(false);
  const notes = app.notes && listable(app.notes, archived);
  return (
    <Palette
      label="Go to note"
      placeholder="Find a note by its title"
      most={50}
      empty={notes?.length ? "No notes match." : notes ? "There are no notes yet." : "Loading notes…"}
      items={(notes ?? []).map((n) => ({ id: n.id, label: n.title || "Untitled", hint: [n.state === "archived" && "Archived", app.folders?.pathName(n.folderId)].filter(Boolean).join(" · ") }))}
      toggle={{ label: "Include archived", on: archived, set: setArchived }}
      onPick={(id) => app.openNote(id, { reveal: true })}
      onClose={close}
    />
  );
}

export const quickOpen: Plugin = {
  id: "quick-open",
  name: "Quick open",
  activate(host) {
    host.commands.register({ id: "notes.quickOpen", title: "Go to note…", keys: ["mod+p"], run: () => host.app().toggleOverlay("notes") });
    host.views.register("overlay", { id: "notes", component: QuickOpen });
  },
};
