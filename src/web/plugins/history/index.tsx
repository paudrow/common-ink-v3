import type { Plugin } from "../../plugin-api.ts";
import { HistoryMode, NoteHistory } from "./History.tsx";

export const history: Plugin = {
  id: "history",
  name: "History",
  description: "Every change to a note, who made it, and a way to take it back.",
  icon: "history",
  activate(host) {
    host.views.register("page", {
      id: "history",
      path: "/history",
      label: "History",
      icon: "history",
      nav: "more",
      component: ({ app }) => (
        <HistoryMode
          host={host}
          notes={app.notes ?? []}
          canEdit={app.canEdit}
          showAuthor={typeof app.pageState === "string" ? app.pageState : null}
          onOpenNote={app.openNote}
          onChanged={app.noteChanged}
          onReverted={app.refresh}
        />
      ),
    });
    host.views.register("inspector", {
      id: "history",
      label: "History",
      icon: "history",
      badge: (app) => (app.unseen ? "Changes you haven't seen" : null),
      component: ({ app, note }) => <NoteHistory host={host} noteId={note.id} revision={note.revision} canEdit={note.access === "edit"} onChanged={app.noteChanged} onSeen={app.markSeen} />,
    });
  },
};
