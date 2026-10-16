import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Folder, Results, Shared, SharedNote } from "../core/protocol.ts";
import { ApiError, openShared, readShared, sharedUploadAddress } from "./api.ts";
import { useDrawing } from "./drawingHost.ts";
import { forEditor } from "./editorExtensions.ts";
import { embedding, embedsAre } from "./embedding.ts";
import { noteHighlighting } from "./highlight.ts";
import { reading } from "./readOnly.ts";

/** A link's address: `/s/<token>`. */
const ADDRESS = /^\/s\/([A-Za-z0-9_-]{20,64})$/;

export const sharedToken = (pathname: string) => ADDRESS.exec(pathname)?.[1] ?? null;

type Opened = { kind: "loading" } | { kind: "open"; shared: Shared } | { kind: "signed-out" } | { kind: "nothing" } | { kind: "error"; message: string };
type Read = { kind: "loading" } | { kind: "note"; note: Results["shared.read"] } | { kind: "nothing" } | { kind: "error"; message: string };

/** What a failed answer means for the page. No such link and a link that was taken away answer alike. */
const failed = (err: unknown) =>
  err instanceof ApiError && err.status === 401
    ? ({ kind: "signed-out" } as const)
    : err instanceof ApiError && err.status === 404
      ? ({ kind: "nothing" } as const)
      : ({ kind: "error", message: err instanceof Error ? err.message : String(err) } as const);

function useHash() {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const read = () => setHash(location.hash.slice(1));
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  }, []);
  return hash;
}

/** What a link opens, for whoever holds it: the note, or the folder's notes, to read and nothing more. */
export function SharedPage({ token }: { token: string }) {
  const [opened, setOpened] = useState<Opened>({ kind: "loading" });
  const hash = useHash();

  useEffect(() => {
    const meta = Object.assign(document.createElement("meta"), { name: "robots", content: "noindex" });
    document.head.append(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let live = true;
    openShared(token).then(
      (shared) => live && setOpened({ kind: "open", shared }),
      (err) => live && setOpened(failed(err)),
    );
    return () => {
      live = false;
    };
  }, [token]);

  switch (opened.kind) {
    case "loading":
      return null;
    case "signed-out":
      return (
        <Message title="Sign in to open this">
          <p>This link opens for people signed in to Common Ink.</p>
          <a className="button primary" href={`/auth/google?next=${encodeURIComponent(`/s/${token}`)}`}>
            Sign in with Google
          </a>
        </Message>
      );
    case "nothing":
      return (
        <Message title="This link opens nothing">
          <p>It may have been turned off, or the address may be incomplete. Ask whoever sent it for a new one.</p>
        </Message>
      );
    case "error":
      return (
        <Message title="This link couldn't be opened">
          <p>{opened.message}</p>
        </Message>
      );
    case "open": {
      const { shared } = opened;
      const noteId = shared.on.kind === "note" ? shared.on.id : /^[a-z0-9]{12}$/.test(hash) ? hash : null;
      return (
        <div className="shared">
          <header className="shared-head">
            <a className="shared-brand" href="/">
              <img src="/favicon.svg" alt="" width={18} height={18} />
              <span>Common Ink</span>
            </a>
            {shared.on.kind === "folder" && <span className="shared-title">{shared.on.name}</span>}
            <span className="badge">Read only</span>
          </header>
          <div className="shared-body">
            {shared.on.kind === "folder" && <Listing shared={shared} openId={noteId} />}
            <main className="shared-main" aria-label="Note">
              {noteId ? <SharedNoteView key={noteId} token={token} noteId={noteId} /> : <p className="notice">{shared.notes.length ? "Pick a note to read it." : "There are no notes in this folder."}</p>}
            </main>
          </div>
        </div>
      );
    }
  }
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="sign-in">
      <img src="/favicon.svg" alt="" width={56} height={56} />
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** A shared folder's notes, under the folders they are in. */
function Listing({ shared, openId }: { shared: Shared; openId: string | null }) {
  const byTitle = (a: SharedNote, b: SharedNote) => (a.title || "Untitled").localeCompare(b.title || "Untitled");
  const inside = (folderId: string | null): ReactNode => {
    const notes = shared.notes.filter((n) => n.folderId === folderId).sort(byTitle);
    const folders = shared.folders.filter((f: Folder) => f.parentId === folderId);
    if (!notes.length && !folders.length) return null;
    return (
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <a href={`#${note.id}`} className="note-row" aria-current={note.id === openId ? "page" : undefined}>
              <span className="row-title">{note.title || "Untitled"}</span>
              {note.snippet && <span className="row-snippet">{note.snippet}</span>}
            </a>
          </li>
        ))}
        {folders.map((folder) => (
          <li key={folder.id}>
            <span className="shared-folder">{folder.name}</span>
            {inside(folder.id)}
          </li>
        ))}
      </ul>
    );
  };
  return (
    <nav className="shared-list" aria-label="Notes">
      {inside(null)}
    </nav>
  );
}

function SharedNoteView({ token, noteId }: { token: string; noteId: string }) {
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const el = useRef<HTMLDivElement>(null);
  const { embeds, extensions, linksTo } = useDrawing((id) => sharedUploadAddress(token, id), (id) => void (location.hash = id));
  const mine = useMemo(() => forEditor({ noteId }), [noteId]);
  const added = useMemo(() => mine(extensions).extensions, [mine, extensions]);

  useEffect(() => {
    let live = true;
    readShared(token, noteId).then(
      (note) => live && setRead({ kind: "note", note }),
      (err) => live && setRead(failed(err).kind === "error" ? (failed(err) as Read) : { kind: "nothing" }),
    );
    return () => {
      live = false;
    };
  }, [token, noteId]);

  const note = read.kind === "note" ? read.note : null;
  useEffect(() => {
    if (!note || !el.current) return;
    linksTo(note);
    const view = new EditorView({
      parent: el.current,
      state: EditorState.create({
        doc: note.text,
        extensions: [reading, added, markdown({ base: markdownLanguage }), noteHighlighting, embedding(noteId), embedsAre(embeds), EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": "Note text" })],
      }),
    });
    return () => view.destroy();
  }, [note, added, embeds]);

  if (read.kind === "loading") return null;
  if (read.kind === "nothing") return <p className="notice">This link doesn't open that note.</p>;
  if (read.kind === "error") return <p className="notice">{read.message}</p>;
  return (
    <section className="note">
      <div className="note-scroll">
        <div className="editor" ref={el} />
      </div>
    </section>
  );
}
