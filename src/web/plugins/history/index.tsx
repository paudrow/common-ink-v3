import type { Plugin } from "../../plugin-api.ts";
import { HistoryMode, NoteHistory } from "./History.tsx";

/** The day another page asked History to start from, as the dashboard does for the changes since a member's last visit. */
const fromOf = (state: unknown) => (typeof state === "object" && state !== null && "from" in state && typeof state.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(state.from) ? state.from : null);

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
          notes={app.notes ?? []}
          canEdit={app.canEdit}
          showAuthor={typeof app.pageState === "string" ? app.pageState : null}
          showFrom={fromOf(app.pageState)}
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
