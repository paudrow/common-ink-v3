import { useEffect, useState } from "react";
import { ago, useNow, type PluginHost, type TrashedNote, type ViewProps } from "../../plugin-api.ts";
import { lifecycle, mayPurge } from "../lib/lifecycle.ts";
import { daysLeft, leftLabel } from "./days.ts";
import { Purge } from "./Purge.tsx";

const titleOf = (note: { title: string }) => note.title || "Untitled";

/** Trash: every note waiting there that the member can see, with the way back and the way out. */
export function TrashPage({ host, app }: ViewProps & { host: PluginHost }) {
  const now = useNow();
  const [listed, setListed] = useState<TrashedNote[] | null>(null);
  /** Why Trash couldn't be read, until it is. */
  const [unread, setUnread] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const { restoring, purge } = lifecycle(host);
  // Read again whenever the app learns that Trash changed, here or anywhere else.
  const known = app.trashed.map((n) => n.id).sort().join(",");

  useEffect(() => {
    let live = true;
    host.perform({ type: "trash.list" }).then(
      (notes) => {
        if (!live) return;
        setListed(notes);
        setUnread(null);
      },
      (err: Error) => live && setUnread(err.message),
    );
    return () => {
      live = false;
    };
  }, [host, known, asked]);

  const restore = (note: TrashedNote) =>
    restoring(note.id).then(
      (said) => host.app().notify({ ...said, message: `${titleOf(note)}: ${said.message}` }),
      (err: Error) => host.app().notify({ message: err.message }),
    );

  return (
    <section className="mode-view trash-page" aria-label="Trash">
      <h1>Trash</h1>
      <p className="trash-lede">A note moved to Trash waits here for 30 days and is then removed for good, with its history. Until then it can be read and restored.</p>
      {unread && (
        <p role="alert" className="said failed">
          {unread}
        </p>
      )}
      {listed && !listed.length && <p className="trash-none">Trash is empty.</p>}
      {listed && listed.length > 0 && (
        <ul className="trash-list" aria-label="Notes in Trash">
          {listed.map((note) => {
            const folder = note.folderId && app.folders?.byId.has(note.folderId) ? app.folders.pathName(note.folderId) : null;
            return (
              <li key={note.id}>
                <div className="trash-what">
                  <a
                    href={app.notePath(note.id)}
                    className="trash-title"
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      app.openNote(note.id);
                    }}
                  >
                    {titleOf(note)}
                  </a>
                  <span className="trash-meta">
                    {folder && <span>Returns to {folder}</span>}
                    <span>
                      Trashed by {note.trashedBy.name} {ago(note.trashedAt, now)}
                    </span>
                    <span>{leftLabel(daysLeft(note.purgesAt ?? now, now))}</span>
                  </span>
                </div>
                <div className="trash-actions">
                  <button type="button" className="button small" disabled={note.access !== "edit"} onClick={() => void restore(note)}>
                    Restore
                  </button>
                  {mayPurge(host, note) && (
                    <Purge
                      title={note.title}
                      onPurge={async () => {
                        await purge(note.id);
                        host.app().notify({ message: `${titleOf(note)} was deleted forever.`, icon: "trash" });
                        setAsked((n) => n + 1);
                      }}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
