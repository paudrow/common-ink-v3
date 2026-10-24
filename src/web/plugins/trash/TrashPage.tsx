import { useEffect, useRef, useState } from "react";
import { ago, useNow, type PluginHost, type TrashedNote, type TrashedUpload, type ViewProps } from "../../plugin-api.ts";
import { reasonOf } from "../lib/FoundNote.tsx";
import { lifecycle, mayPurge, uploadLifecycle } from "../lib/lifecycle.ts";
import { ShowMore, usePaged } from "../lib/paged.tsx";
import { SelectionBar } from "../lib/SelectionBar.tsx";
import { actedOn, clear } from "../lib/selecting.ts";
import { daysLeft, leftLabel } from "./days.ts";
import { Purge } from "./Purge.tsx";

const titleOf = (note: { title: string }) => note.title || "Untitled";

/** How many notes in Trash a read lists, and the most it lists read again after Show more. They are trash.list's own. */
const PAGE = 100;
const MOST = 500;

/**
 * Trash: every note waiting there that the member can see, with the way back and the way out. Notes,
 * and files, can be selected to restore together, which is a step that undo takes back. Delete
 * forever is one at a time, and nothing takes it back.
 */
export function TrashPage({ host, app }: ViewProps & { host: PluginHost }) {
  const now = useNow();
  const [asked, setAsked] = useState(0);
  const [files, setFiles] = useState<TrashedUpload[] | null>(null);
  /** Why the files couldn't be read, until they are. */
  const [filesUnread, setFilesUnread] = useState<string | null>(null);
  const { restore, purge } = lifecycle(host);
  const uploads = uploadLifecycle(host);
  const notesList = useRef<HTMLUListElement>(null);
  const filesList = useRef<HTMLUListElement>(null);
  // Read again whenever the app learns that Trash changed, here or anywhere else.
  const known = app.trashed.map((n) => n.id).sort().join(",");

  const paged = usePaged<TrashedNote>(
    (page) => host.perform({ type: "trash.list", ...page }).then(({ notes, next }) => ({ rows: notes, next })),
    (note) => note.id,
    { of: "trash", again: `${known}/${asked}`, page: PAGE, most: MOST },
  );
  const { rows: listed } = paged;
  const unread = paged.problem ?? filesUnread;

  useEffect(() => {
    let live = true;
    host.perform({ type: "upload.trashed" }).then(
      (uploads) => {
        if (!live) return;
        setFiles(uploads);
        setFilesUnread(null);
      },
      (err: { status?: unknown } | null) => {
        if (!live) return;
        // A guest is told nothing of the workspace's files. A fault says nothing of them, and leaves what was read.
        if (typeof err?.status === "number" && err.status < 500) {
          setFiles([]);
          setFilesUnread(null);
        } else setFilesUnread(reasonOf(err));
      },
    );
    return () => {
      live = false;
    };
  }, [host, asked, known]);
  // A file restored or trashed again, here or anywhere else, is told to the app, and the files are read again.
  useEffect(() => host.uploads.onReferred(() => setAsked((n) => n + 1)), [host]);

  /** Restores the notes, or the files, of rows: a row's own, or every row selected with it, which are let go. */
  const of = <T extends { id: string; access: string }>(all: readonly T[] | null, rows: readonly HTMLElement[]) => (all ?? []).filter((t) => t.access === "edit" && rows.some((row) => row.dataset.row === t.id));
  const restoreNotes = (rows: readonly HTMLElement[]) => {
    if (notesList.current) clear(notesList.current);
    void restore(of(listed, rows).map((n) => n.id));
  };
  const restoreFiles = (rows: readonly HTMLElement[]) => {
    if (filesList.current) clear(filesList.current);
    void uploads.restore(of(files, rows));
  };

  return (
    <section className="mode-view trash-page" aria-label="Trash">
      <h1>Trash</h1>
      <p className="trash-lede">A note or a file moved to Trash waits here for 30 days and is then removed for good: a note with its history, a file with its bytes. Until then it can be restored.</p>
      {unread && (
        <p role="alert" className="said failed">
          {unread}
        </p>
      )}
      {listed && !listed.length && files?.length === 0 && <p className="trash-none">Trash is empty.</p>}
      <SelectionBar list={notesList} actions={[{ label: "Restore", icon: "restore", run: restoreNotes }]} />
      {listed && listed.length > 0 && (
        <ul ref={notesList} className="trash-list" aria-label="Notes in Trash" data-selectable>
          {listed.map((note) => {
            const folder = note.folderId && app.folders?.byId.has(note.folderId) ? app.folders.pathName(note.folderId) : null;
            return (
              <li key={note.id} data-row={note.id}>
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
                  <button type="button" className="button small" disabled={note.access !== "edit"} onClick={(e) => restoreNotes(actedOn(e.currentTarget.closest("li")!))}>
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
      {files && files.length > 0 && (
        <>
          <h2 className="trash-part">Files</h2>
          <SelectionBar list={filesList} actions={[{ label: "Restore", icon: "restore", run: restoreFiles }]} />
          <ul ref={filesList} className="trash-list" aria-label="Files in Trash" data-selectable>
            {files.map((file) => {
              const folder = file.folderId && app.folders?.byId.has(file.folderId) ? app.folders.pathName(file.folderId) : null;
              return (
                <li key={file.id} data-row={file.id}>
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
                    <button type="button" className="button small" disabled={file.access !== "edit"} onClick={(e) => restoreFiles(actedOn(e.currentTarget.closest("li")!))}>
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
