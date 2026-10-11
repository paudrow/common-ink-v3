import { useEffect, useState } from "react";
import type { Plugin, PluginHost, Upload, ViewProps } from "../plugin-api.ts";
import { listable } from "./lib/listable.ts";
import { Palette } from "./lib/Palette.tsx";
import { openable, uploadItem, uploadPath, UPLOADS_PATH } from "./uploads/finding.ts";

/**
 * Notes by title, and uploads by file name while the Uploads page is there to open one on. Archived
 * ones are left out until they are asked for, and one in Trash is never offered.
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
  return (
    <Palette
      label="Go to note"
      placeholder={hasUploads ? "Find a note by its title, or an upload by its name" : "Find a note by its title"}
      empty={notes?.length ? "No notes match." : notes ? "There are no notes yet." : "Loading notes…"}
      items={openable(noteItems, hasUploads ? uploads : [], (u) => ["Upload", u.state === "archived" && "Archived"].filter(Boolean).join(" · "))}
      toggle={{ label: "Include archived", on: archived, set: setArchived }}
      onPick={(id) => {
        const upload = uploadItem(id);
        if (upload) app.go(uploadPath(upload));
        else app.openNote(id);
      }}
      onClose={close}
    />
  );
}

export const quickOpen: Plugin = {
  id: "quick-open",
  name: "Quick open",
  activate(host) {
    host.commands.register({ id: "notes.quickOpen", title: "Go to note…", keys: ["mod+p"], run: () => host.app().toggleOverlay("notes") });
    host.views.register("overlay", { id: "notes", component: (props) => <QuickOpen host={host} {...props} /> });
  },
};
