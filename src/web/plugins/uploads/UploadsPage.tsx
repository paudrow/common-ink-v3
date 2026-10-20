import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Icon, ago, useNow, type App, type Folders, type PluginHost, type Results, type Upload, type ViewProps } from "../../plugin-api.ts";
import { opening, reasonOf } from "../lib/FoundNote.tsx";
import { restoredMessage } from "../lib/lifecycle.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { ShowMore, usePaged } from "../lib/paged.tsx";
import { QueryBar } from "../lib/QueryBar.tsx";
import { SHARE_COMMAND, SHARE_OVERLAY } from "../sharing/Summary.tsx";
import { toldOf } from "./drawing.ts";
import { onlyMine, reachWords, selectedIn, uploaderWords, uploadPath, UPLOADS_PATH, withMine } from "./finding.ts";
import { openUpload, previewUpload } from "./opening.ts";
import { FilePreview } from "./Preview.tsx";
import { previewOf } from "./previewing.ts";
import { writtenNow, type Sender } from "./sending.ts";
import { formatBytes, KIND_LABEL } from "./sizing.ts";
import { Thumb } from "./Thumb.tsx";

type Read = Results["upload.read"];
type Listed = Results["upload.list"]["uploads"][number];

/** How long typing in the query rests before the list is asked for again. */
const PAUSE_MS = 200;
/** How many uploads a read lists, and the most it lists read again after Show more. They are upload.list's own. */
const PAGE = 100;
const MOST = 500;

/** Every folder the member can put a file in, outermost first, each by its path. */
function foldersIn(folders: Folders | null): { id: string; name: string }[] {
  if (!folders) return [];
  const under = (parentId: string | null): { id: string; name: string }[] =>
    folders.childrenOf(parentId).flatMap((f) => [...(f.access === "edit" ? [{ id: f.id, name: folders.pathName(f.id) }] : []), ...under(f.id)]);
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
 * Every upload in the workspace that the member can see, found by the query language. Uploads are
 * listed here and nowhere else: the note list and the folders' counts are of notes. A file sent from
 * here is the member's alone until it is put in a note. One is picked to see what it is, which notes
 * use it, and what can be done with it.
 */
export function UploadsPage({ host, app, sender }: Props) {
  const now = useNow();
  const selectedId = selectedIn(app.path);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState(0);
  const [over, setOver] = useState(false);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const run = (text: string) => setQuery(text.trim());

  const wanted = typed.trim();
  useEffect(() => {
    if (wanted === query) return;
    const timer = setTimeout(() => run(wanted), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [wanted, query]);

  const paged = usePaged<Listed>(
    (page) => host.perform({ type: "upload.list", query, ...page }).then(({ uploads, next }) => ({ rows: uploads, next })),
    (upload) => upload.id,
    { of: query, again: asked, page: PAGE, most: MOST },
  );
  const { rows: listed, problem } = paged;

  const mine = onlyMine(typed);
  const choose = (wantMine: boolean) => {
    const next = withMine(typed, wantMine);
    setTyped(next);
    run(next);
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const taken = await sender.sendAll(files);
    if (!taken.length) return;
    app.notify({ message: taken.length === 1 ? `Uploaded ${taken[0]!.name}. Only you can see it until you put it in a note.` : `Uploaded ${taken.length} files. Only you can see them until you put them in a note.` });
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
            <button type="button" className="button primary" onClick={() => sender.pick((files) => void upload(files))}>
              Upload files
            </button>
          )}
        </header>
        <p className="uploads-lede">
          Files a note can show: a picture, a video, a recording, or anything to download. {app.canEdit ? "Drop files here to upload them, or paste or drop one into a note. " : ""}A file sent from here is yours alone until you put it in a note, and then whoever reads the note sees it. A file can be up to 25 GB: a large one goes in parts, and picks up where it stopped if the connection drops.
        </p>
        <div className="uploads-tools">
          <div className="uploads-whose" role="group" aria-label="Whose uploads">
            <button type="button" aria-pressed={mine} onClick={() => choose(true)}>
              Mine
            </button>
            <button type="button" aria-pressed={!mine} onClick={() => choose(false)}>
              Everyone's
            </button>
          </div>
          <QueryBar
            host={host}
            app={app}
            scope="uploads"
            value={typed}
            label="Find uploads"
            placeholder="Find uploads: name, type:image, uploader:@me, used:no"
            problem={problem}
            onChange={(text, how) => {
              setTyped(text);
              if (how === "set" || !text.trim()) run(text);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && wanted !== query) run(wanted);
            }}
          />
        </div>
        {listed && !listed.length && <p className="uploads-none">{query ? "No uploads match." : "There are no uploads yet. Paste or drop a file into a note, or upload one here."}</p>}
        {listed && listed.length > 0 && (
          <ul className="uploads-list" aria-label="Uploads">
            {listed.map((u) => (
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
                  <Thumb host={host} upload={u} />
                  <span className="upload-what">
                    <span className="upload-name">{u.name}</span>
                    <span className="upload-meta">
                      <span>{KIND_LABEL[u.kind]}</span>
                      <span>{formatBytes(u.size)}</span>
                      <span>
                        {uploaderWords(u, app.me.id)}, {ago(u.createdAt, now)}
                      </span>
                      <span>{reachWords(u, app.me.id)}</span>
                      {u.state === "archived" && <span className="found-archived">Archived</span>}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <ShowMore paged={paged} />
      </div>
      {selectedId && <Detail key={selectedId} host={host} app={app} id={selectedId} listed={asked} onChanged={reload} />}
      {over && <div className="uploads-drop">Drop to upload</div>}
    </section>
  );
}

interface DetailProps {
  host: PluginHost;
  app: App;
  id: string;
  /** Changes when the list was read again, which is when to read this again. */
  listed: number;
  onChanged: () => void;
}

/** A menu open on the card: what can be done with the file, or the folders it can be moved to. */
type Opened = { menu: "more" | "folders"; x: number; y: number } | null;

/**
 * One upload: a preview of it, the same as a note draws, which shows it larger when pressed; then what
 * it is, Open and everything else behind one "…" menu, and the notes that use it.
 */
function Detail({ host, app, id, listed, onChanged }: DetailProps) {
  const now = useNow();
  const [read, setRead] = useState<Read | null>(null);
  const [missing, setMissing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [opened, setOpened] = useState<Opened>(null);
  const [said, setSaid] = useState("");
  const more = useRef<HTMLButtonElement>(null);

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
  const closeMenu = useCallback(() => {
    setOpened(null);
    more.current?.focus();
  }, []);
  /** Opens a menu under the "…" button, which is where the keyboard opens it too. */
  const openMenu = (menu: "more" | "folders") => {
    const box = more.current?.getBoundingClientRect();
    if (box) setOpened({ menu, x: box.left, y: box.bottom + 4 });
  };

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
  const copyEmbed = async () => {
    const written = await writtenNow(host, read);
    try {
      await navigator.clipboard.writeText(written);
      app.notify({ message: `Copied ${written}. Paste it on a line of a note to show the file there.` });
    } catch {
      // A page served over plain http has no clipboard to write to, so the embed is said to be copied by hand.
      app.notify({ message: `Copy ${written} and paste it on a line of a note to show the file there.`, stays: true });
    }
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = address;
    link.download = read.name;
    link.click();
  };

  const items: MenuItem[] = [
    { label: "Download", icon: "uploads" as const, action: download },
    ...(canShare && read.access === "edit" ? [{ label: "Share…", icon: "share" as const, action: () => app.toggleOverlay(SHARE_OVERLAY, { uploadId: read.id, name: read.name }) }] : []),
    { label: "Copy embed", icon: "copy" as const, action: () => void copyEmbed() },
    ...(read.access === "edit" ? [{ label: "Move to folder…", icon: "folders" as const, action: () => openMenu("folders"), disabled: busy, separated: true }] : []),
    ...(app.workspace.role !== "guest" && read.access === "edit"
      ? [
          {
            label: read.private ? "Share with the folder" : "Make private",
            disabled: busy,
            action: () =>
              void act(
                () => host.sharing.setPrivate({ uploadId: id }, !read.private),
                () =>
                  app.notify({
                    message: read.private ? `${read.name} is seen by whoever sees ${folder ?? "its folder"}, or a note it is in.` : `${read.name} is private: hidden from every other member, admins too, except the people it is shared with.`,
                  }),
              ),
          },
        ]
      : []),
    { label: read.state === "archived" ? "Unarchive" : "Archive", icon: read.state === "archived" ? ("unarchive" as const) : ("archive" as const), disabled: locked, action: () => void act(() => host.perform({ type: "upload.archive", id, archived: read.state !== "archived" })) },
    { label: "Move to Trash", icon: "trash" as const, disabled: locked, action: () => (uses > 0 ? setAsking(true) : void trash()) },
  ];
  const folders = foldersIn(app.folders).map((f) => ({ label: f.id === read.folderId ? `${f.name} (here)` : f.name, disabled: f.id === read.folderId, action: () => void act(() => host.perform({ type: "upload.move", id, folderId: f.id })) }));

  return (
    <aside
      className="upload-detail"
      aria-label={read.name}
      onKeyDown={(e) => {
        if (trashed || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
        e.preventDefault();
        openMenu("more");
      }}
    >
      <DetailHead name={read.name} onClose={close} />
      {!trashed && <DetailPreview host={host} upload={read} onSaid={setSaid} />}
      <p className="upload-meta">
        <span>{KIND_LABEL[read.kind]}</span>
        <span>{formatBytes(read.size)}</span>
        {!trashed && said && <span>{said}</span>}
        {read.width && read.height && (
          <span>
            {read.width} × {read.height}
          </span>
        )}
        {folder && <span>{folder}</span>}
        <span>
          Uploaded by {uploaderWords(read, app.me.id).replace(/^You$/, "you")} {ago(read.createdAt, now)}
        </span>
        <span>{reachWords({ ...read, uses }, app.me.id)}</span>
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
        <div className="upload-actions">
          <button type="button" className="button small primary" onClick={() => openUpload(host, read)}>
            Open
          </button>
          <button
            ref={more}
            type="button"
            className="icon-button"
            aria-label={`More for ${read.name}`}
            title="Download, share, move, archive or trash it"
            aria-haspopup="menu"
            aria-expanded={opened !== null}
            onClick={() => (opened ? closeMenu() : openMenu("more"))}
          >
            <Icon name="more" />
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
          <p className="said">No note you can see uses this file. Type / in a note and Insert an upload to put it there.</p>
        )}
      </section>
      {opened?.menu === "more" && <ContextMenu label={`More for ${read.name}`} x={opened.x} y={opened.y} items={items} onClose={closeMenu} />}
      {opened?.menu === "folders" && <ContextMenu label={`Move ${read.name} to`} x={opened.x} y={opened.y} items={folders} onClose={closeMenu} />}
    </aside>
  );
}

/** The panel's preview, which a press or Enter shows larger over the app. A player is pressed to play, and Open shows it larger. */
function DetailPreview({ host, upload, onSaid }: { host: PluginHost; upload: Read; onSaid: (words: string) => void }) {
  const shown = <FilePreview host={host} upload={upload} place="panel" onSaid={onSaid} />;
  if (previewOf(upload).shows === "player") return <div className="upload-detail-preview">{shown}</div>;
  const open = () => previewUpload(host, upload);
  return (
    <div
      className="upload-detail-preview upload-card-opens"
      role="button"
      tabIndex={0}
      aria-label={`Preview ${upload.name}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open();
      }}
    >
      {shown}
    </div>
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

