import type { Plugin } from "../../plugin-api.ts";
import { HistoryMode, NoteHistory } from "./History.tsx";

export const history: Plugin = {
  id: "history",
  name: "History",
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
          personId={app.me.id}
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
      component: ({ app, note }) => <NoteHistory host={host} noteId={note.id} revision={note.revision} canEdit={app.canEdit} onChanged={app.noteChanged} onSeen={app.markSeen} />,
    });
  },
};
