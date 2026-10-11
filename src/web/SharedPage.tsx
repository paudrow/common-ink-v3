import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Folder, NoteSummary, Results, Shared, SharedNote } from "../core/protocol.ts";
import { ApiError, openShared, readShared } from "./api.ts";
import { forEditor, usable } from "./editorExtensions.ts";
import { embedding, embedsAre } from "./embedding.ts";
import { noteHighlighting } from "./highlight.ts";
import type { App, Plugin } from "./plugin-api.ts";
import { createPluginHost } from "./pluginHost.ts";
import { bullets } from "./plugins/bullets/index.ts";
import { labelledReferences } from "./plugins/lib/references.tsx";
import { codeBlocks } from "./plugins/code/index.ts";
import { gfm } from "./plugins/gfm/index.ts";
import { html } from "./plugins/html/index.ts";
import { kanban } from "./plugins/kanban/index.ts";
import { links } from "./plugins/links/index.ts";
import { math } from "./plugins/math/index.ts";
import { media } from "./plugins/media/index.ts";
import { stopwatch } from "./plugins/stopwatch.ts";
import { tables } from "./plugins/tables/index.ts";
import { timer } from "./plugins/timer.ts";
import { todos } from "./plugins/todos/index.tsx";
import { readOnly } from "./readOnly.ts";

/** A link's address: `/s/<token>`. */
const ADDRESS = /^\/s\/([A-Za-z0-9_-]{20,64})$/;

export const sharedToken = (pathname: string) => ADDRESS.exec(pathname)?.[1] ?? null;

/**
 * The plugins that draw a note's text. None of them needs the server, and the page gives them no way
 * to it: the one thing any asks for, the projects a todo's chip offers, is refused, and nobody here
 * can change a todo anyway.
 */
const DRAWING: readonly Plugin[] = [timer, stopwatch, kanban, media, html, gfm, todos, links, tables, math, codeBlocks, bullets, labelledReferences];

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const NOT_HERE = () => Promise.reject(new Error("A link's page asks nothing of a workspace"));

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

/**
 * The plugins that draw a note, started with no workspace behind them: every way to the server is
 * shut, what one keeps is forgotten with the page, and the only notes they know of are the ones the
 * open note links to that the link covers.
 */
function useDrawing(open: (noteId: string) => void) {
  const app = useRef<Pick<App, "notes" | "trashed" | "folders" | "noteId" | "openNote">>({ notes: [], trashed: [], folders: null, noteId: null, openNote: open });
  app.current.openNote = open;
  const [host] = useState(() => {
    const kept = new Map<string, unknown>();
    return createPluginHost({
      plugins: DRAWING,
      settings: {},
      write: () => {},
      mac: MAC,
      provide: (plugin) => ({
        workspace: { id: "", name: "", role: "guest" },
        app: () => app.current as App,
        perform: NOT_HERE,
        agents: { list: NOT_HERE, connect: NOT_HERE, disconnect: NOT_HERE },
        members: { invite: NOT_HERE, setRole: NOT_HERE, remove: NOT_HERE, leave: NOT_HERE, invites: NOT_HERE, revoke: NOT_HERE },
        sharing: { of: NOT_HERE, grant: NOT_HERE, link: NOT_HERE, revoke: NOT_HERE, setPrivate: NOT_HERE, all: NOT_HERE },
        storage: { get: (key) => kept.get(`${plugin.id}.${key}`), set: (key, value) => void kept.set(`${plugin.id}.${key}`, value) },
      }),
    });
  });
  useEffect(() => () => host.dispose(), [host]);
  const contributed = useSyncExternalStore(host.subscribe, host.contributions);
  const extensions = useMemo(() => usable(contributed.editorExtensions).taken, [contributed.editorExtensions]);
  /** Says which notes the open one links to that the link covers, so each such link is drawn with its title and opens. */
  const linksTo = (note: Results["shared.read"]) => {
    app.current.noteId = note.id;
    app.current.notes = note.links.flatMap((l) => (l.title === null ? [] : [{ id: l.id, title: l.title, state: l.state ?? "live" } as NoteSummary]));
    host.notesChanged();
  };
  return { embeds: contributed.embeds, extensions, linksTo };
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
  const { embeds, extensions, linksTo } = useDrawing((id) => void (location.hash = id));
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
        extensions: [readOnly, added, markdown({ base: markdownLanguage }), noteHighlighting, embedding, embedsAre(embeds), EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": "Note text" })],
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
