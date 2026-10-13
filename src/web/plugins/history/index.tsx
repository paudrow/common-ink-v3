import { useEffect, useState } from "react";
import { ALL_NOTES, type Plugin, type PluginHost, type ViewProps } from "../../plugin-api.ts";
import { FolderHistory, HistoryMode, NoteHistory, isScope, type Scope } from "./History.tsx";

const PATH = "/history";
/** The page's state that asks for every note and everyone's changes, where no state leaves the page as it is. */
const EVERYTHING = "everything";

/** The page, narrowed to the scope it was last opened with: a note's or a folder's notes from their History tab, or an author another plugin names. */
function Page({ host, app }: ViewProps & { host: PluginHost }) {
  const handed = app.pageState;
  const [scope, setScope] = useState<Scope | null>(isScope(handed) ? handed : null);
  useEffect(() => {
    if (isScope(handed)) setScope(handed);
    else if (handed === EVERYTHING) setScope(null);
  }, [handed]);
  return <HistoryMode host={host} me={app.me.id} notes={app.notes ?? []} scope={scope} onScope={setScope} onOpenNote={app.openNote} onChanged={app.refresh} />;
}

/** The day another page asked History to start from, as the dashboard does for the changes since a member's last visit. */
const fromOf = (state: unknown) => (typeof state === "object" && state !== null && "from" in state && typeof state.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(state.from) ? state.from : null);

export const history: Plugin = {
  id: "history",
  name: "History",
  description: "Every change to a note, who made it, and a way to take it back.",
  icon: "history",
  activate(host) {
    host.views.register("page", {
      id: "history",
      path: PATH,
      label: "History",
      icon: "history",
      nav: "more",
      component: ({ app }) => <Page host={host} app={app} />,
    });
    host.views.register("inspector", {
      id: "history",
      label: "History",
      icon: "history",
      for: "note",
      badge: (app) => (app.unseen ? "Changes you haven't seen" : null),
      component: ({ app, note }) => (
        <NoteHistory host={host} me={app.me.id} note={note} canEdit={note.access === "edit"} onChanged={app.refresh} onOpenNote={app.openNote} onOpenHistory={(scope) => app.go(PATH, { state: scope })} onSeen={app.markSeen} />
      ),
    });
    host.views.register("inspector", {
      id: "folder-history",
      label: "History",
      icon: "history",
      for: "folder",
      component: ({ app, folderId, name, notes }) => (
        <FolderHistory
          host={host}
          me={app.me.id}
          name={name}
          notes={notes}
          whole={folderId === ALL_NOTES}
          onOpenNote={app.openNote}
          onOpenHistory={(scope) => app.go(PATH, { state: scope ?? EVERYTHING })}
          onChanged={app.refresh}
        />
      ),
    });
  },
};
