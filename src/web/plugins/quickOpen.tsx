import type { Plugin } from "../plugin-api.ts";
import { Palette } from "./lib/Palette.tsx";

export const quickOpen: Plugin = {
  id: "quick-open",
  name: "Quick open",
  activate(host) {
    host.commands.register({ id: "notes.quickOpen", title: "Go to note…", keys: ["mod+p"], run: () => host.app().toggleOverlay("notes") });
    host.views.register("overlay", {
      id: "notes",
      component: ({ app, close }) => (
        <Palette
          label="Go to note"
          placeholder="Find a note by its title"
          empty={app.notes?.length ? "No notes match." : app.notes ? "There are no notes yet." : "Loading notes…"}
          items={(app.notes ?? []).map((n) => ({ id: n.id, label: n.title || "Untitled", hint: app.folders?.pathName(n.folderId) }))}
          onPick={(id) => app.openNote(id)}
          onClose={close}
        />
      ),
    });
  },
};
