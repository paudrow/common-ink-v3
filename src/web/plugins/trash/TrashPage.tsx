import { useEffect, useState } from "react";
import { ago, useNow, type PluginHost, type TrashedNote, type TrashedUpload, type ViewProps } from "../../plugin-api.ts";
import { lifecycle, mayPurge, restoredMessage } from "../lib/lifecycle.ts";
import { ShowMore, usePaged } from "../lib/paged.tsx";
import { daysLeft, leftLabel } from "./days.ts";
import { Purge } from "./Purge.tsx";

const titleOf = (note: { title: string }) => note.title || "Untitled";

/** How many notes in Trash a read lists, and the most it lists read again after Show more. They are trash.list's own. */
const PAGE = 100;
const MOST = 500;

/** Trash: every note waiting there that the member can see, with the way back and the way out. */
export function TrashPage({ host, app }: ViewProps & { host: PluginHost }) {
  const now = useNow();
  const [asked, setAsked] = useState(0);
  const [files, setFiles] = useState<TrashedUpload[]>([]);
  const { restoring, purge } = lifecycle(host);
  // Read again whenever the app learns that Trash changed, here or anywhere else.
  const known = app.trashed.map((n) => n.id).sort().join(",");

  const paged = usePaged<TrashedNote>(
    (page) => host.perform({ type: "trash.list", ...page }).then(({ notes, next }) => ({ rows: notes, next })),
    (note) => note.id,
    { of: "trash", again: `${known}/${asked}`, page: PAGE, most: MOST },
  );
  const { rows: listed, problem: unread } = paged;

  useEffect(() => {
    let live = true;
    host.perform({ type: "upload.trashed" }).then(
      (uploads) => live && setFiles(uploads),
      // A guest is told nothing of the workspace's files.
      () => live && setFiles([]),
    );
    return () => {
      live = false;
    };
  }, [host, asked]);

  /** Tells the app what a file is now, so each note that shows it follows. */
  const restoreFile = (file: TrashedUpload) =>
    host.perform({ type: "upload.restore", id: file.id }).then(
      ({ folderGone, name, type, kind, size, width, height, state }) => {
        host.uploads.learn([{ id: file.id, upload: { name, type, kind, size, width, height, state } }]);
        host.app().notify({ message: `${file.name}: ${restoredMessage(folderGone)}`, icon: "check" });
        setAsked((n) => n + 1);
        app.refresh();
      },
      (err: Error) => host.app().notify({ message: err.message }),
    );

  const restore = (note: TrashedNote) =>
    restoring(note.id).then(
      (said) => host.app().notify({ ...said, message: `${titleOf(note)}: ${said.message}` }),
      (err: Error) => host.app().notify({ message: err.message }),
    );

  return (
    <section className="mode-view trash-page" aria-label="Trash">
      <h1>Trash</h1>
      <p className="trash-lede">A note or a file moved to Trash waits here for 30 days and is then removed for good: a note with its history, a file with its bytes. Until then it can be restored.</p>
      {unread && (
        <p role="alert" className="said failed">
          {unread}
        </p>
      )}
      {listed && !listed.length && !files.length && <p className="trash-none">Trash is empty.</p>}
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
      <ShowMore paged={paged} />
      {files.length > 0 && (
        <>
          <h2 className="trash-part">Files</h2>
          <ul className="trash-list" aria-label="Files in Trash">
            {files.map((file) => {
              const folder = file.folderId && app.folders?.byId.has(file.folderId) ? app.folders.pathName(file.folderId) : null;
              return (
                <li key={file.id}>
                  <div className="trash-what">
                    <span className="trash-title">{file.name}</span>
                    <span className="trash-meta">
                      {folder && <span>Returns to {folder}</span>}
                      <span>
                        Trashed by {file.trashedBy.name} {ago(file.trashedAt, now)}
                      </span>
                      <span>{leftLabel(daysLeft(file.purgesAt ?? now, now))}</span>
                    </span>
                  </div>
                  <div className="trash-actions">
                    <button type="button" className="button small" disabled={file.access !== "edit"} onClick={() => void restoreFile(file)}>
                      Restore
                    </button>
                    {file.access === "edit" && (host.workspace.role === "admin" || host.workspace.role === "editor") && (
                      <Purge
                        title={file.name}
                        gone="The file is removed now, and can't be brought back. Notes that use it will say a file isn't available."
                        onPurge={async () => {
                          await host.perform({ type: "upload.purge", id: file.id });
                          host.uploads.learn([{ id: file.id, upload: null }]);
                          host.app().notify({ message: `${file.name} was deleted forever.`, icon: "trash" });
                          setAsked((n) => n + 1);
                        }}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
