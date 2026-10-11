import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type MouseEvent } from "react";
import { Icon, ago, useDismiss, useNow, type App, type Folders, type PluginHost, type Results, type Upload, type UploadKind, type ViewProps } from "../../plugin-api.ts";
import { Copyable } from "../lib/Copyable.tsx";
import { IncludeArchived, opening, reasonOf } from "../lib/FoundNote.tsx";
import { restoredMessage } from "../lib/lifecycle.ts";
import { SHARE_COMMAND, SHARE_OVERLAY } from "../sharing/Summary.tsx";
import { toldOf } from "./drawing.ts";
import { narrowed, selectedIn, uploadPath, UPLOADS_PATH, writtenFor } from "./finding.ts";
import type { Sender } from "./sending.ts";
import { formatBytes, KIND_LABEL } from "./sizing.ts";

type Read = Results["upload.read"];

const KINDS: readonly UploadKind[] = ["image", "video", "audio", "file"];
const KINDS_LABEL: Record<UploadKind, string> = { image: "Images", video: "Videos", audio: "Audio", file: "Other files" };

/** Every folder the member can see, outermost first, each by its path. */
function foldersIn(folders: Folders | null): { id: string; name: string; canAdd: boolean }[] {
  if (!folders) return [];
  const under = (parentId: string | null): { id: string; name: string; canAdd: boolean }[] =>
    folders.childrenOf(parentId).flatMap((f) => [{ id: f.id, name: folders.pathName(f.id), canAdd: f.access === "edit" }, ...under(f.id)]);
  return under(null);
}

const folderOf = (app: App, upload: Pick<Upload, "folderId">) => (upload.folderId && app.folders?.byId.has(upload.folderId) ? app.folders.pathName(upload.folderId) : null);

const plainClick = (e: MouseEvent) => !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0);

const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

interface Props extends ViewProps {
  host: PluginHost;
  sender: Sender;
}

/**
 * Every upload in the workspace that the member can see. Uploads are listed here and nowhere else:
 * the note list and the folders' counts are of notes. One is picked to see what it is, which notes
 * use it, and what can be done with it.
 */
export function UploadsPage({ host, app, sender }: Props) {
  const now = useNow();
  const selectedId = selectedIn(app.path);
  const [folderId, setFolderId] = useState("");
  const [kind, setKind] = useState<UploadKind | "">("");
  const [text, setText] = useState("");
  const [archived, setArchived] = useState(false);
  /** Where a new file goes, when the member has said. Otherwise the folder the list is narrowed to, or Unsorted. */
  const [chosenTarget, setTarget] = useState<string | null>(null);
  const [listed, setListed] = useState<Upload[] | null>(null);
  const [said, say] = useState<{ text: string; failed?: boolean } | null>(null);
  const [asked, setAsked] = useState(0);
  const [over, setOver] = useState(false);
  const sending = useSyncExternalStore(sender.subscribe, sender.sending);
  const reload = useCallback(() => setAsked((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    host.perform({ type: "upload.list", folderId: folderId || undefined, includeArchived: archived }).then(
      (uploads) => live && setListed(uploads),
      (err: unknown) => live && say({ text: reasonOf(err), failed: true }),
    );
    return () => {
      live = false;
    };
  }, [host, folderId, archived, asked]);

  const folders = foldersIn(app.folders);
  const targets = folders.filter((f) => f.canAdd);
  const target = chosenTarget ?? (targets.some((f) => f.id === folderId) ? folderId : (targets.find((f) => f.id === app.folders?.unsortedId)?.id ?? ""));
  const shown = narrowed(listed ?? [], { text, kind: kind || null });
  const narrowing = !!(text.trim() || kind || folderId);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    say(null);
    const taken = await sender.sendAll(files, { folderId: target || undefined });
    if (!taken.length) return;
    say({ text: taken.length === 1 ? `Uploaded ${taken[0]!.name}.` : `Uploaded ${taken.length} files.` });
    reload();
    app.refresh();
    app.go(uploadPath(taken.at(-1)!.id), { replace: true });
  };

  return (
    <section
      className="uploads-page"
      aria-label="Uploads"
      data-over={over || undefined}
      onDragOver={(e) => {
        if (!app.canEdit || !carriesFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        if (!app.canEdit || !carriesFiles(e)) return;
        e.preventDefault();
        setOver(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <div className="uploads-main">
        <header className="uploads-head">
          <h1>Uploads</h1>
          {app.canEdit && (
            <div className="uploads-add">
              <label>
                <span>Upload to</span>
                <select aria-label="Upload to folder" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {targets.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="button primary" onClick={() => sender.pick((files) => void upload(files))}>
                Upload files
              </button>
            </div>
          )}
        </header>
        <p className="uploads-lede">
          Files a note can show: a picture, a video, a recording, or anything to download. {app.canEdit ? "Drop files here to upload them, or paste or drop one into a note. " : ""}A file can be up to 50 MB.
        </p>
        <div className="uploads-tools">
          <input type="search" className="filter" aria-label="Filter uploads by name" placeholder="Filter by name" value={text} onChange={(e) => setText(e.target.value)} />
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as UploadKind | "")}>
            <option value="">All kinds</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KINDS_LABEL[k]}
              </option>
            ))}
          </select>
          <select aria-label="Folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">All folders</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <IncludeArchived checked={archived} onChange={setArchived} />
        </div>
        {sending.length > 0 && (
          <p className="said" role="status">
            Uploading {sending.map((s) => `${s.name} (${Math.round((100 * s.sent) / s.size)}%)`).join(", ")}
          </p>
        )}
        {said && (
          <p role={said.failed ? "alert" : "status"} className={said.failed ? "said failed" : "said"}>
            {said.text}
          </p>
        )}
        {listed && !shown.length && (
          <p className="uploads-none">{narrowing ? "No uploads match." : archived ? "There are no uploads yet." : "There are no uploads yet. Paste or drop a file into a note, or upload one here."}</p>
        )}
        {shown.length > 0 && (
          <ul className="uploads-list" aria-label="Uploads">
            {shown.map((u) => {
              const folder = folderOf(app, u);
              return (
                <li key={u.id}>
                  <a
                    href={uploadPath(u.id)}
                    className="upload-row"
                    aria-current={u.id === selectedId ? "true" : undefined}
                    onClick={(e) => {
                      if (!plainClick(e)) return;
                      e.preventDefault();
                      app.go(uploadPath(u.id));
                    }}
                  >
                    <span className="upload-thumb">{u.kind === "image" ? <img src={host.uploads.address(u.id)} alt="" loading="lazy" decoding="async" draggable={false} /> : <Icon name="uploads" />}</span>
                    <span className="upload-what">
                      <span className="upload-name">{u.name}</span>
                      <span className="upload-meta">
                        <span>{KIND_LABEL[u.kind]}</span>
                        <span>{formatBytes(u.size)}</span>
                        {folder && <span>{folder}</span>}
                        <span>
                          {u.uploadedBy.name}, {ago(u.createdAt, now)}
                        </span>
                        {u.private && <span className="found-archived">Private</span>}
                        {u.state === "archived" && <span className="found-archived">Archived</span>}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {selectedId && <Detail key={selectedId} host={host} app={app} id={selectedId} folders={targets} listed={asked} onChanged={reload} />}
      {over && <div className="uploads-drop">Drop to upload</div>}
    </section>
  );
}

interface DetailProps {
  host: PluginHost;
  app: App;
  id: string;
  /** The folders it can be moved to. */
  folders: { id: string; name: string }[];
  /** Changes when the list was read again, which is when to read this again. */
  listed: number;
  onChanged: () => void;
}

/** One upload: what it is, the notes that use it, and what can be done with it. */
function Detail({ host, app, id, folders, listed, onChanged }: DetailProps) {
  const now = useNow();
  const [read, setRead] = useState<Read | null>(null);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let live = true;
    host.perform({ type: "upload.read", id }).then(
      (upload) => live && (setRead(upload), setMissing(false)),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [host, id, listed]);

  const close = () => app.go(UPLOADS_PATH);

  /** Does one thing to the upload and tells the app what it is now, so the list and every note that shows it follow. */
  const act = async <T,>(doing: () => Promise<T>, after?: (done: T) => void) => {
    setProblem(null);
    setBusy(true);
    try {
      const done = await doing();
      if (done && typeof done === "object" && "kind" in done && "state" in done) host.uploads.learn([{ id, upload: toldOf(done as unknown as Upload) }]);
      after?.(done);
    } catch (err) {
      setProblem(reasonOf(err));
    }
    setBusy(false);
    setAsking(false);
    onChanged();
    app.refresh();
  };

  if (missing) {
    return (
      <aside className="upload-detail" aria-label="Upload">
        <DetailHead name="Upload" onClose={close} />
        <p className="uploads-none">This upload doesn't exist, or you can't see it.</p>
      </aside>
    );
  }
  if (!read) return <aside className="upload-detail" aria-label="Upload" aria-busy />;

  const address = host.uploads.address(read.id);
  const locked = read.access !== "edit" || busy;
  const trashed = read.state === "trashed";
  const folder = folderOf(app, read);
  const uses = read.usedIn.length;
  const canShare = host.commands.list().some((c) => c.id === SHARE_COMMAND);
  const restore = () =>
    act(
      () => host.perform({ type: "upload.restore", id }),
      ({ folderGone }) => app.notify({ message: `${read.name}: ${restoredMessage(folderGone)}` }),
    );
  const trash = () =>
    act(
      () => host.perform({ type: "upload.trash", id }),
      ({ usedIn }) =>
        app.notify({
          message: usedIn > 0 ? `Moved to Trash. ${usedIn === 1 ? "1 note uses it and now says" : `${usedIn} notes use it and now say`} it is in Trash.` : "Moved to Trash",
          action: { label: "Undo", run: () => void restore() },
        }),
    );

  return (
    <aside className="upload-detail" aria-label={read.name}>
      <DetailHead name={read.name} onClose={close} />
      {read.kind === "image" && !trashed && (
        <button type="button" className="upload-detail-picture" aria-label={`Open ${read.name}`} onClick={() => setPreviewing(true)}>
          <img src={address} alt="" draggable={false} />
        </button>
      )}
      <p className="upload-meta">
        <span>{KIND_LABEL[read.kind]}</span>
        <span>{formatBytes(read.size)}</span>
        {read.width && read.height && (
          <span>
            {read.width} × {read.height}
          </span>
        )}
        {folder && <span>{folder}</span>}
        <span>
          Uploaded by {read.uploadedBy.name} {ago(read.createdAt, now)}
        </span>
        {read.state === "archived" && <span className="found-archived">Archived</span>}
      </p>
      {problem && (
        <p role="alert" className="said failed">
          {problem}
        </p>
      )}
      {trashed ? (
        <div className="upload-actions">
          <p className="said">This file is in Trash. Notes that use it say so, and show it again once it is restored.</p>
          <button type="button" className="button small" disabled={locked} onClick={() => void restore()}>
            Restore
          </button>
        </div>
      ) : (
        <>
          <div className="upload-actions">
            {read.kind !== "file" && (
              <button type="button" className="button small" onClick={() => setPreviewing(true)}>
                Open
              </button>
            )}
            <a className="button small" href={address} download={read.name}>
              Download
            </a>
            {canShare && read.access === "edit" && (
              <button type="button" className="button small" onClick={() => app.toggleOverlay(SHARE_OVERLAY, { uploadId: read.id, name: read.name })}>
                Share
              </button>
            )}
            <button type="button" className="button small" disabled={locked} onClick={() => void act(() => host.perform({ type: "upload.archive", id, archived: read.state !== "archived" }))}>
              {read.state === "archived" ? "Unarchive" : "Archive"}
            </button>
            <button type="button" className="button small" disabled={locked} onClick={() => (uses > 0 ? setAsking(true) : void trash())}>
              Move to Trash
            </button>
            {asking && (
              <div className="confirm" role="group" aria-label={`Move ${read.name} to Trash`}>
                <span>
                  {uses === 1 ? "1 note still uses this file. It" : `${uses} notes still use this file. They`} will say it is in Trash until it is restored.
                </span>
                <button type="button" className="button small danger" autoFocus disabled={busy} onClick={() => void trash()}>
                  Move to Trash
                </button>
                <button type="button" className="link" onClick={() => setAsking(false)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
          <label className="upload-field">
            <span>Folder</span>
            <select aria-label="Move to folder" value={read.folderId ?? ""} disabled={locked} onChange={(e) => void act(() => host.perform({ type: "upload.move", id, folderId: e.target.value }))}>
              {!folders.some((f) => f.id === read.folderId) && <option value={read.folderId ?? ""}>{folder ?? "A folder you can't see"}</option>}
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {app.workspace.role !== "guest" && (
            <div className="upload-field">
              <label className="check">
                <input type="checkbox" checked={read.private} disabled={busy} onChange={(e) => void act(() => host.sharing.setPrivate({ uploadId: id }, e.target.checked))} />
                <span>Private</span>
              </label>
              <p className="said">
                {read.private
                  ? "Hidden from every other member, admins too, except the people it is shared with. A note that shows it tells them only that a file isn't available."
                  : "Whoever uploaded a file can make it private: hidden from every other member, except the people it is shared with."}
              </p>
            </div>
          )}
          <Copyable label="Embed" value={writtenFor(read)} />
          <p className="said">Paste this on a line of a note to show the file there. A link to a note doesn't open its files: only a link on the folder a file is in does.</p>
        </>
      )}
      <section className="upload-used" aria-label="Used in">
        <h3>Used in</h3>
        {uses ? (
          <ul>
            {read.usedIn.map((note) => (
              <li key={note.id}>
                <a {...opening(app, note)}>{note.title || "Untitled"}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="said">No note you can see uses this file.</p>
        )}
      </section>
      {previewing && <Preview name={read.name} kind={read.kind} address={address} close={() => setPreviewing(false)} />}
    </aside>
  );
}

function DetailHead({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <header className="upload-detail-head">
      <h2>{name}</h2>
      <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
        <Icon name="close" />
      </button>
    </header>
  );
}

/** A picture, a video or a recording, shown over the app. Nothing plays until the member asks. */
function Preview({ name, kind, address, close }: { name: string; kind: UploadKind; address: string; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(close, ref);
  return (
    <div className="upload-preview-back">
      <div ref={ref} className="upload-preview" role="dialog" aria-label={`Preview of ${name}`}>
        <header className="upload-detail-head">
          <h2>{name}</h2>
          <button type="button" className="icon-button" aria-label="Close preview" title="Close" autoFocus onClick={close}>
            <Icon name="close" />
          </button>
        </header>
        {kind === "image" && <img src={address} alt={name} />}
        {kind === "video" && <video src={address} controls preload="metadata" />}
        {kind === "audio" && <audio src={address} controls preload="none" />}
      </div>
    </div>
  );
}
