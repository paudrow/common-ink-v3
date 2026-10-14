import { useEffect, useState } from "react";
import type { NoteSummary, Plugin, PluginHost, ViewProps } from "../plugin-api.ts";

type Found = { noteId: string; notes: NoteSummary[] } | { noteId: string; error: string };

function Backlinks({ host, app, note }: ViewProps & { host: PluginHost; note: NoteSummary }) {
  const [found, setFound] = useState<Found | null>(null);
  // Asked again whenever any note changes, since a link to this one may have been written or taken out.
  useEffect(() => {
    let live = true;
    host.perform({ type: "note.backlinks", id: note.id }).then(
      (notes) => live && setFound({ noteId: note.id, notes }),
      (err: Error) => live && setFound({ noteId: note.id, error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [host, note.id, app.notes]);

  if (found?.noteId !== note.id) return null;
  if ("error" in found) return <p role="alert" className="error">{found.error}</p>;
  if (!found.notes.length) return <p className="soon">No notes link here yet. Type [[ in another note to link to this one.</p>;
  return (
    <nav aria-label="Backlinks" className="backlinks">
      <ul>
        {found.notes.map((from) => (
          <li key={from.id}>
            <a
              href={app.notePath(from.id)}
              className="note-row"
              data-state={from.state === "archived" ? "archived" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                app.openNote(from.id, { preview: true });
              }}
            >
              <span className="row-title">{from.title || "Untitled"}</span>
              {from.snippet && <span className="row-snippet">{from.snippet}</span>}
              <span className="row-meta">
                <span>{app.folders?.pathName(from.folderId)}</span>
                {from.state === "archived" && <span className="state-label">Archived</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The inspector's Backlinks tab: the notes that link to the open note, as the core lists them for this member. */
export const backlinks: Plugin = {
  id: "backlinks",
  name: "Backlinks",
  description: "The notes that link to the open note, in the inspector.",
  icon: "backlinks",
  activate(host) {
    host.views.register("inspector", {
      id: "backlinks",
      label: "Backlinks",
      icon: "backlinks",
      for: ["note"],
      component: ({ app, about }) => (about.kind === "note" ? <Backlinks key={about.note.id} host={host} app={app} note={about.note} /> : null),
    });
  },
};
