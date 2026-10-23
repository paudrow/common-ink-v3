import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NoteSummary, Results } from "../core/protocol.ts";
import { readUpload } from "./api.ts";
import { usable } from "./editorExtensions.ts";
import { folderTree } from "./folders.ts";
import type { App, Plugin } from "./plugin-api.ts";
import { createPluginHost } from "./pluginHost.ts";
import { bullets } from "./plugins/bullets/index.ts";
import { codeBlocks } from "./plugins/code/index.ts";
import { dates } from "./plugins/dates/index.tsx";
import { gfm } from "./plugins/gfm/index.ts";
import { html } from "./plugins/html/index.ts";
import { kanban } from "./plugins/kanban/index.ts";
import { labelledReferences } from "./plugins/lib/references.tsx";
import { links } from "./plugins/links/index.ts";
import { math } from "./plugins/math/index.ts";
import { media } from "./plugins/media/index.ts";
import { mentions } from "./plugins/mentions/index.tsx";
import { stopwatch } from "./plugins/stopwatch.ts";
import { tables } from "./plugins/tables/index.ts";
import { timer } from "./plugins/timer.ts";
import { todos } from "./plugins/todos/index.tsx";
import { uploadDrawing } from "./plugins/uploads/index.tsx";
import { referredUploads } from "./referredUploads.ts";

/**
 * The plugins that draw a note's text. None of them needs the server, and the page gives them no way
 * to it: who is in the workspace, the one thing any asks for, is refused. So a mention is the name
 * the note writes and nothing more.
 */
const DRAWING: readonly Plugin[] = [timer, stopwatch, kanban, media, uploadDrawing, html, gfm, todos, links, mentions, dates, tables, math, codeBlocks, bullets, labelledReferences];

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const NOT_HERE = () => Promise.reject(new Error("Text drawn here asks nothing of a workspace"));
/** No folder is known here, so a link to one reads as unavailable and goes nowhere. */
const NO_FOLDERS = folderTree({ unsortedId: null, folders: [] });

/**
 * The plugins that draw a note, started with no workspace behind them: every way to the server is
 * shut, what one keeps is forgotten with the page, and the only notes they know of are the ones
 * `linksTo` names. An upload's bytes are asked for at `address`, and only for an upload `linksTo`
 * said the text may show. HTML in the text runs only when the reader presses Run. This is how a
 * link's page draws its note, and how the app draws markdown that isn't a note, such as a file's.
 */
export function useDrawing(address: (uploadId: string) => string, open: (noteId: string) => void) {
  const app = useRef<Pick<App, "notes" | "trashed" | "folders" | "noteId" | "openNote">>({ notes: [], trashed: [], folders: NO_FOLDERS, noteId: null, openNote: open });
  app.current.openNote = open;
  const [referred] = useState(referredUploads);
  const [host] = useState(() => {
    const kept = new Map<string, unknown>();
    return createPluginHost({
      plugins: DRAWING,
      trusted: DRAWING,
      // Whoever reads here has no settings of theirs: HTML in what is drawn runs only when they press Run.
      settings: { "html.run": "ask first" },
      write: () => false,
      mac: MAC,
      provide: (plugin) => ({
        workspace: { id: "", name: "", role: "guest" },
        app: () => app.current as App,
        perform: NOT_HERE,
        agents: { list: NOT_HERE, connect: NOT_HERE, edit: NOT_HERE, disconnect: NOT_HERE },
        members: { invite: NOT_HERE, setRole: NOT_HERE, remove: NOT_HERE, leave: NOT_HERE, signOut: NOT_HERE, invites: NOT_HERE, revoke: NOT_HERE },
        sharing: { of: NOT_HERE, grant: NOT_HERE, link: NOT_HERE, revoke: NOT_HERE, setPrivate: NOT_HERE, all: NOT_HERE },
        uploads: { referred: (id) => referred.get(id) ?? null, onReferred: referred.subscribe, learn: () => {}, address, tabAddress: () => null, bytes: (id, upTo) => readUpload(address(id), upTo), send: NOT_HERE },
        storage: { get: (key) => kept.get(`${plugin.id}.${key}`), set: (key, value) => void kept.set(`${plugin.id}.${key}`, value) },
      }),
    });
  });
  useEffect(() => () => host.dispose(), [host]);
  const contributed = useSyncExternalStore(host.subscribe, host.contributions);
  const extensions = useMemo(() => usable(contributed.editorExtensions).taken, [contributed.editorExtensions]);
  /** Says which notes the open one links to that the reader may open, so each such link is drawn with its title and opens, and which uploads it may show. */
  const linksTo = (note: Results["shared.read"]) => {
    referred.learn(note.uploads);
    app.current.noteId = note.id;
    app.current.notes = note.links.flatMap((l) => (l.title === null ? [] : [{ id: l.id, title: l.title, state: l.state ?? "live" } as NoteSummary]));
    host.notesChanged();
  };
  return { embeds: contributed.embeds, extensions, linksTo };
}
