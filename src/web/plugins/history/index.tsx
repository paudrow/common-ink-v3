import { useCallback, useEffect, useMemo, useState } from "react";
import { ALL_NOTES, type NoteSummary, type Plugin, type PluginHost, type ViewProps } from "../../plugin-api.ts";
import { titleOf } from "../lib/historyView.ts";
import { History, isScope, type Kept, type Left, type Scope } from "./History.tsx";

const PATH = "/history";
/** The page's state that asks for every note and everyone's changes, where no state leaves the page as it is. */
const EVERYTHING = "everything";
/** As many notes as history can be narrowed to at once. A folder with more shows the ones changed last. */
const MOST_NOTES = 200;

/** Changes when any of the notes does. */
const versionOf = (notes: readonly NoteSummary[]) => notes.reduce((sum, n) => sum + n.revision, 0);

/** Which of the notes the member may change: each note says so of itself, since a grant or a private note can differ from the member's role. */
function useEditable(notes: readonly NoteSummary[]): (noteId: string) => boolean {
  const editable = useMemo(() => new Set(notes.filter((n) => n.access === "edit").map((n) => n.id)), [notes]);
  return useCallback((noteId: string) => editable.has(noteId), [editable]);
}

const ANY = () => true;
const NONE = () => false;

/** Where each History that was shown keeps its ticks, by what it was of. */
type Places = (place: string) => Left;

/** The page, narrowed to the scope it was last opened with: a note's or a folder's notes from their History tab, or an author another plugin names. */
function Page({ host, app, places }: ViewProps & { host: PluginHost; places: Places }) {
  const handed = app.pageState;
  const [scope, setScope] = useState<Scope | null>(isScope(handed) ? handed : null);
  useEffect(() => {
    if (isScope(handed)) setScope(handed);
    else if (handed === EVERYTHING) setScope(null);
  }, [handed]);
  // Each scope is a place of its own, with its own ticks: History starts again from what that place kept.
  const canEdit = useEditable(app.notes ?? []);
  const place = `page ${scope ? ("author" in scope ? `by ${scope.author.kind} ${scope.author.id}` : `of ${scope.noteIds.join()}`) : "everything"}`;
  return (
    <History key={place} host={host} me={app.me.id} canEdit={canEdit} scope={scope} layout="page" version={versionOf(app.notes ?? [])} empty="Nothing has been written in this workspace yet." onScope={setScope} onOpenNote={app.openNote} onChanged={app.refresh} left={places(place)} />
  );
}

interface OfFolderProps extends ViewProps {
  host: PluginHost;
  folderId: string;
  name: string;
  notes: readonly NoteSummary[];
  places: Places;
}

/** History for the inspector, narrowed to a folder's notes. All notes is every note there is. */
function OfFolder({ host, app, folderId, name, notes, places }: OfFolderProps) {
  const whole = folderId === ALL_NOTES;
  const canEdit = useEditable(notes);
  const ids = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MOST_NOTES).map((n) => n.id).join(","), [notes]);
  const scope = useMemo<Scope | null>(() => (whole ? null : { label: name, noteIds: ids ? ids.split(",") : [] }), [whole, name, ids]);
  const empty = whole ? "Nothing has been written in this workspace yet." : "Nothing has been written in this folder yet.";
  if (!whole && !notes.length) return <p className="empty">{empty}</p>;
  return <History host={host} me={app.me.id} canEdit={canEdit} scope={scope} layout="panel" version={versionOf(notes)} empty={empty} onOpenHistory={() => app.go(PATH, { state: scope ?? EVERYTHING })} onOpenNote={app.openNote} onChanged={app.refresh} left={places(`folder ${folderId}`)} />;
}

export const history: Plugin = {
  id: "history",
  name: "History",
  description: "Every change to a note, who made it, and a way to take it back.",
  icon: "history",
  activate(host) {
    // Kept while the app is open and no longer: a reload starts with nothing ticked.
    const kept = new Map<string, Kept>();
    const places: Places = (place) => ({ get: () => kept.get(place), set: (left) => void kept.set(place, left) });
    host.views.register("page", {
      id: "history",
      path: PATH,
      label: "History",
      icon: "history",
      nav: "more",
      component: ({ app }) => <Page host={host} app={app} places={places} />,
    });
    host.views.register("inspector", {
      id: "history",
      label: "History",
      icon: "history",
      for: "note",
      badge: (app) => (app.unseen ? "Changes you haven't seen" : null),
      component: ({ app, note }) => {
        const scope: Scope = { label: titleOf(note.title), noteIds: [note.id], one: true };
        return (
          <History
            key={note.id}
            host={host}
            me={app.me.id}
            canEdit={note.access === "edit" ? ANY : NONE}
            scope={scope}
            layout="panel"
            version={note.revision}
            empty="Nothing has been written in this note yet."
            onOpenHistory={() => app.go(PATH, { state: scope })}
            onOpenNote={app.openNote}
            onChanged={app.refresh}
            onLoaded={(changes) => app.markSeen(note.id, changes[0]?.revision ?? 0)}
            left={places(`note ${note.id}`)}
          />
        );
      },
    });
    host.views.register("inspector", {
      id: "folder-history",
      label: "History",
      icon: "history",
      for: "folder",
      component: ({ app, folderId, name, notes }) => <OfFolder key={folderId} host={host} app={app} folderId={folderId} name={name} notes={notes} places={places} />,
    });
  },
};
