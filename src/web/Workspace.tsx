import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { Me, Note, NoteSummary, WorkspaceSummary } from "../core/protocol.ts";
import { noteIdFromPath, notePath } from "../core/slug.ts";
import { ApiError, connectAgent, disconnectAgent, listAgents, perform, signOut } from "./api.ts";
import { useDismiss } from "./dismiss.ts";
import { Drawn } from "./Drawn.tsx";
import { usable } from "./editorExtensions.ts";
import { folderTree } from "./folders.ts";
import { Icon } from "./icons.tsx";
import { Inspector } from "./Inspector.tsx";
import { chordFor, chordLabel, chordOf } from "./keybindings.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import type { App, Embed, Folders, Plugin } from "./plugin-api.ts";
import { createPluginHost, type Host } from "./pluginHost.ts";
import { BUILT_INS } from "./plugins/index.ts";
import { Plugins } from "./Plugins.tsx";
import type { Navigate, Place } from "./router.ts";
import { documentOf } from "./settings.ts";
import { Settings } from "./Settings.tsx";
import type { SettingsStore } from "./settingsStore.ts";
import { isBoolean, readStored, useStored, writeStored } from "./stored.ts";
import { performInSync, saveNow, undoOrRedo } from "./sync.ts";
import { ago, useNow } from "./time.ts";

type Popover = { side: "left" } | { side: "right"; tab: string };
/** Writing mode collapses both sides to rails; a rail opens its panel as a popover over the editor. */
type Layout = { writing: false } | { writing: true; popover: Popover | null };

const BROWSING: Layout = { writing: false };
const WRITING: Layout = { writing: true, popover: null };
const WRITING_KEY = "ink.writing";
const INSPECTOR_KEY = "ink.inspector";
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** How often the notes changed since the last look are listed, so an agent's or another member's change shows up. */
const REFRESH_MS = 5000;

const isAnything = (_: unknown): _ is unknown => true;
const isRevisions = (v: unknown): v is Record<string, number> => typeof v === "object" && v !== null && Object.values(v).every((n) => typeof n === "number");
/** A note's editor is not one: undo there is the app's, through the note's history. */
const inField = (el: EventTarget | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable && !el.closest(".note"));

const popoverKey = (p: Popover | null) => (p ? (p.side === "left" ? "left" : p.tab) : null);

const summaryOf = ({ text: _, ...summary }: Note): NoteSummary => summary;

const pathTo = (byId: ReadonlyMap<string, NoteSummary>, id: string) => {
  const note = byId.get(id);
  return note ? notePath(note) : `/note/${id}`;
};

/**
 * A listing can answer after a save or a new note it was sent before. A note learned since it was
 * sent stays, and one already known at a later revision is kept.
 */
function newest(listed: NoteSummary[], known: NoteSummary[] | null, learned: ReadonlyMap<string, NoteSummary>) {
  const byId = new Map([...(known ?? []), ...learned.values()].map((n) => [n.id, n]));
  const listedIds = new Set(listed.map((n) => n.id));
  const fresh = listed.map((n) => {
    const mine = byId.get(n.id);
    return mine && mine.revision > n.revision ? mine : n;
  });
  return [...[...learned.values()].filter((n) => !listedIds.has(n.id)), ...fresh];
}

/** Functions that stay the same from one render to the next, each calling the latest one it was handed. */
function useLatest<T extends Record<string, (...args: never[]) => unknown>>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  return useState(() => Object.fromEntries(Object.keys(fns).map((name) => [name, (...args: never[]) => latest.current[name]!(...args)])) as T)[0];
}

interface Props {
  me: Me;
  workspace: WorkspaceSummary;
  /** The member's settings in this workspace. */
  settings: SettingsStore;
  place: Place;
  navigate: Navigate;
  onSwitch: (workspaceId: string) => void;
  /** Told of each note this workspace has, so its address is known to lead here. */
  noteIsHere: (noteId: string, workspaceId: string) => void;
  /** Reads again which workspaces the person is in, and their role in each. */
  reloadWorkspaces: () => Promise<void>;
}

export function Workspace({ me, workspace, settings, place, navigate, onSwitch, noteIsHere, reloadWorkspaces }: Props) {
  const { route } = place;
  const workspaceId = workspace.id;
  const canEdit = workspace.role !== "viewer";
  const now = useNow();
  const [tree, setTree] = useState<Folders | null>(null);
  const [chosenFolderId, selectFolder] = useState<string | null>(null);
  /** Every note in the workspace, for the note list, tab titles, and quick open. */
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [layout, setLayout] = useState<Layout>(() => (readStored(WRITING_KEY, isBoolean) ? WRITING : BROWSING));
  const [inspectorOpen, setInspectorOpen] = useStored(INSPECTOR_KEY, isBoolean, true);
  const [overlay, setOverlay] = useState<string | null>(null);
  /** An undo or redo that didn't happen, and why, shown on its note until the member's next step. */
  const [stuck, setStuck] = useState<{ noteId: string; message: string } | null>(null);

  const selectedFolderId = tree && chosenFolderId && !tree.byId.has(chosenFolderId) ? null : chosenFolderId;
  const byId = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const routeNoteId = route.kind === "note" ? route.id : null;
  const current = (routeNoteId && byId.get(routeNoteId)) || null;

  const appNow = useRef<App>(null!);
  /** What the app's own commands do, as of the latest render. */
  const inner = useRef<{ step: (type: "note.undo" | "note.redo") => void; save: () => void; toggleWriting: () => void; toggleInspector: () => void }>(null!);
  const [host] = useState(() => {
    let created: Host;
    const PluginsPage = () => <Plugins plugins={useSyncExternalStore(created.subscribe, created.contributions).plugins} onToggle={created.setEnabled} />;
    /** What the app itself adds, through the registry the plugins use. It can't be turned off. */
    const core: Plugin = {
      id: "core",
      name: "Common Ink",
      settings: {
        theme: { type: "string", default: "system", enum: ["system", "light", "dark"], title: "Theme", description: "Light or dark, or system to follow this device." },
        editorTextSize: { type: "integer", default: 100, minimum: 75, maximum: 200, title: "Editor text size", description: "The size of a note's text, as a percentage." },
      },
      activate(h) {
        if (canEdit) {
          h.commands.register({ id: "note.new", title: "New note", run: () => h.app().createNote() });
          h.commands.register({ id: "history.undo", title: "Undo", keys: ["mod+z"], leaveToFields: true, run: () => inner.current.step("note.undo") });
          h.commands.register({ id: "note.save", title: "Save now", keys: ["mod+s"], run: () => inner.current.save() });
          h.commands.register({ id: "history.redo", title: "Redo", keys: ["mod+shift+z", "mod+y"], leaveToFields: true, run: () => inner.current.step("note.redo") });
        }
        h.commands.register({ id: "view.toggleWritingMode", title: "Toggle writing mode", keys: ["mod+."], run: () => inner.current.toggleWriting() });
        h.commands.register({ id: "view.toggleInspector", title: "Toggle inspector", run: () => inner.current.toggleInspector() });
      },
    };
    /** Kept apart from the rest so their links and commands come after the plugins', where the others come before. */
    const pages: Plugin = {
      id: "plugins",
      name: "Plugins",
      activate(h) {
        h.views.register("page", { id: "settings", path: "/settings", label: "Settings", nav: "menu", component: () => <Settings host={created} store={settings} mac={MAC} /> });
        h.views.register("page", { id: "plugins", path: "/plugins", label: "Plugins", nav: "menu", component: PluginsPage });
      },
    };
    created = createPluginHost({
      // A test puts plugins on the page before the app loads. Loading a member's own plugins is another matter.
      plugins: [core, ...BUILT_INS, ...((window as { __INK_FIXTURE_PLUGINS__?: Plugin[] }).__INK_FIXTURE_PLUGINS__ ?? []), pages],
      required: [core.id, pages.id],
      settings: documentOf(settings.text()) ?? {},
      // The member's own controls come through here: the Settings and Plugins pages, and the commands that turn a plugin on or off.
      write: (key, value) => void settings.set(key, value),
      mac: MAC,
      provide: (plugin) => ({
        workspace,
        app: () => appNow.current,
        // Made for the one plugin that asked, so this is where its permissions will be checked. The server records the member as the author.
        perform: (op) => performInSync(workspaceId, op),
        agents: { list: listAgents, connect: connectAgent, disconnect: (id) => disconnectAgent(id).then(() => {}) },
        members: {
          invite: (email, as) => perform(workspaceId, { type: "member.invite", email, as }),
          setRole: (memberId, as) => perform(workspaceId, { type: "member.setRole", memberId, as }),
          remove: (memberId) => perform(workspaceId, { type: "member.remove", memberId }).then(() => {}),
          leave: () => perform(workspaceId, { type: "member.leave" }).then(() => {}),
          invites: () => perform(workspaceId, { type: "invite.list" }),
          revoke: (inviteId) => perform(workspaceId, { type: "invite.revoke", id: inviteId }).then(() => {}),
        },
        storage: {
          // By member too: two people who share a browser and a workspace don't share what a plugin keeps, such as which notes are open.
          get: (key) => readStored(`ink.plugin.${plugin.id}.${workspaceId}.${me.person.id}.${key}`, isAnything),
          set: (key, value) => writeStored(`ink.plugin.${plugin.id}.${workspaceId}.${me.person.id}.${key}`, value),
        },
      }),
    });
    return created;
  });
  useEffect(() => {
    let last: string | null = null;
    const read = () => {
      if (settings.text() === last) return;
      last = settings.text();
      host.settingsChanged(documentOf(last) ?? {});
    };
    read();
    return settings.subscribe(read);
  }, [host, settings]);
  const contributed = useSyncExternalStore(host.subscribe, host.contributions);
  useEffect(() => () => host.dispose(), [host]);
  /** Each embed as registered, but telling the host when it throws while being drawn. One is made per embed, so a drawn embed isn't redrawn when something else changes. */
  const [guarded] = useState(() => new WeakMap<Embed, Embed>());
  const embeds = useMemo(
    () =>
      contributed.embeds.map((embed) => {
        const guard: Embed = guarded.get(embed) ?? {
          ...embed,
          render(el, written) {
            try {
              return embed.render(el, written);
            } catch (err) {
              host.fail(embed, err);
              throw err;
            }
          },
        };
        guarded.set(embed, guard);
        return guard;
      }),
    [host, guarded, contributed.embeds],
  );
  /** The editor extensions that can go to editors. A value CodeMirror won't take is left out and held against its plugin, where it would have stopped every editor. */
  const { taken: extensions, refused } = useMemo(() => usable(contributed.editorExtensions), [contributed.editorExtensions]);
  useEffect(() => {
    for (const [added, err] of refused) host.fail(added, err);
  }, [host, refused]);
  const theme = contributed.settings.values["core.theme"] as string;
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    return () => void delete document.documentElement.dataset.theme;
  }, [theme]);
  const shortcut = (commandId: string) => {
    const chord = chordFor(commandId, contributed.keybindings);
    return chord && chordLabel(chord, MAC);
  };

  const loadFolders = useCallback(() => perform(workspaceId, { type: "folder.list" }).then((r) => setTree(folderTree(r))), [workspaceId]);
  useEffect(() => void loadFolders(), [loadFolders]);

  /** Notes loaded, saved, or created since the last listing was asked for, which its answer can't know. */
  const learned = useRef(new Map<string, NoteSummary>());
  useEffect(() => {
    let live = true;
    const since = (learned.current = new Map());
    perform(workspaceId, { type: "note.list" }).then((all) => live && setNotes((known) => newest(all, known, since)));
    return () => {
      live = false;
    };
  }, [workspaceId, listVersion]);

  const refresh = useCallback(() => {
    void loadFolders();
    setListVersion((v) => v + 1);
  }, [loadFolders]);

  const listedNotes = useRef(notes);
  listedNotes.current = notes;
  useEffect(() => {
    const relist = async () => {
      const known = listedNotes.current;
      if (document.visibilityState !== "visible" || !known) return;
      const changed = await perform(workspaceId, { type: "note.list", updatedSince: Math.max(0, ...known.map((n) => n.updatedAt)) }).catch(() => []);
      const later = changed.filter((n) => (known.find((k) => k.id === n.id)?.revision ?? -1) < n.revision);
      if (later.length) setNotes((all) => all && [...newest(later, all, new Map()), ...all.filter((n) => !later.some((l) => l.id === n.id))]);
    };
    const timer = setInterval(relist, REFRESH_MS);
    document.addEventListener("visibilitychange", relist);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", relist);
    };
  }, [workspaceId]);

  useEffect(() => {
    for (const note of notes ?? []) noteIsHere(note.id, workspaceId);
  }, [notes, noteIsHere, workspaceId]);

  const remember = useCallback(
    (note: Note) => {
      const summary = summaryOf(note);
      // Before the app goes to a note it has just made, so it doesn't stop to ask where the note is.
      noteIsHere(note.id, workspaceId);
      learned.current.set(note.id, summary);
      setNotes((all) => all && [summary, ...all.filter((n) => n.id !== note.id)]);
      if (location.pathname.startsWith("/note/") && location.pathname.endsWith(note.id)) navigate(notePath(note), { replace: true });
    },
    [navigate, noteIsHere, workspaceId],
  );

  const byIdNow = useRef(byId);
  byIdNow.current = byId;
  /** The note the app last went to itself, which tells that step apart from Back, a link, or a typed address. */
  const wentTo = useRef<string | null>(null);
  const showNote = useCallback(
    (id: string | null, { replace = false }: { replace?: boolean } = {}) => {
      if (!id) {
        wentTo.current = null;
        navigate("/");
      } else if (noteIdFromPath(location.pathname) !== id) {
        wentTo.current = id;
        navigate(pathTo(byIdNow.current, id), { replace });
      }
    },
    [navigate],
  );
  /** A note opened from somewhere other than the note list, which turns to the note's folder once that's known. */
  const [revealId, reveal] = useState<string | null>(null);
  useEffect(() => {
    const note = revealId ? byId.get(revealId) : undefined;
    if (!note) return;
    selectFolder(note.folderId);
    reveal(null);
  }, [revealId, byId]);

  useEffect(() => {
    if (routeNoteId && routeNoteId !== wentTo.current) reveal(routeNoteId);
    // Good for the one step: the same note reached again by Back or Forward wasn't the app's doing.
    wentTo.current = null;
  }, [routeNoteId]);

  /** The latest revision of each note the member has been shown the changes up to. It is kept in this browser. */
  const [seen, setSeen] = useStored(`ink.seen.${workspaceId}.${me.person.id}`, isRevisions, {});
  const markSeen = useCallback((noteId: string, revision: number) => setSeen((s) => ((s[noteId] ?? 0) >= revision ? s : { ...s, [noteId]: revision })), [setSeen]);
  /** The open note's latest change by anyone but the member, such as their agent. */
  const [others, setOthers] = useState<{ noteId: string; revision: number } | null>(null);
  const currentId = current?.id;
  const currentRevision = current?.revision;
  const byMe = current?.updatedBy.kind === "member" && current.updatedBy.personId === me.person.id;
  const checked = useRef<{ noteId: string; revision: number } | null>(null);
  useEffect(() => {
    if (!currentId || currentRevision === undefined) return;
    const last = checked.current;
    checked.current = { noteId: currentId, revision: currentRevision };
    // The member's own next change can't be someone else's, so there is nothing new to look for.
    if (last?.noteId === currentId && currentRevision === last.revision + 1 && byMe) return;
    let live = true;
    perform(workspaceId, { type: "history.list", noteIds: [currentId], diffs: false, limit: 100 }).then(({ changes }) => {
      const theirs = changes.find((c) => c.author.kind !== "member" || c.author.personId !== me.person.id);
      if (live) setOthers({ noteId: currentId, revision: theirs?.revision ?? 0 });
    });
    return () => {
      live = false;
    };
  }, [workspaceId, currentId, currentRevision, me.person.id]);
  const unseen = !!current && others?.noteId === current.id && others.revision > (seen[current.id] ?? 0);

  const closePopover = useCallback(() => setLayout((l) => (l.writing ? WRITING : l)), []);
  const toggleWriting = useCallback(() => setLayout((l) => (l.writing ? BROWSING : WRITING)), []);
  const togglePopover = (p: Popover) => setLayout((l) => (l.writing ? { writing: true, popover: popoverKey(l.popover) === popoverKey(p) ? null : p } : l));
  const toggleInspector = () => {
    const last = host.contributions().views.inspector.at(-1);
    if (!layout.writing) setInspectorOpen(!inspectorOpen);
    else if (last) togglePopover({ side: "right", tab: last.id });
  };
  const closeOverlay = useCallback(() => setOverlay(null), []);

  useEffect(() => writeStored(WRITING_KEY, layout.writing), [layout.writing]);

  const go = (path: string, options: { state?: unknown } = {}) => {
    navigate(path, options);
    closePopover();
  };

  /** The note whose editor is to take the cursor once it is there. */
  const [toFocus, setToFocus] = useState<string | null>(null);
  const openNote = (noteId: string, options: { preview?: boolean; reveal?: boolean; focus?: boolean } = {}) => {
    if (options.reveal) reveal(noteId);
    setToFocus(options.focus ? noteId : null);
    const area = host.contributions().views.editor.at(-1);
    if (area?.open) area.open(noteId, { preview: options.preview ?? false });
    else showNote(noteId);
    closePopover();
  };

  const createNote = async () => {
    const note = await perform(workspaceId, { type: "note.create", folderId: selectedFolderId ?? undefined });
    void loadFolders();
    remember(note);
    openNote(note.id, { reveal: true });
  };

  const moveNote = useCallback(
    async (id: string, folderId: string) => {
      const moved = summaryOf(await perform(workspaceId, { type: "note.move", id, folderId }));
      setNotes((all) => all && all.map((n) => (n.id === id ? moved : n)));
      refresh();
    },
    [workspaceId, refresh],
  );

  const step = (type: "note.undo" | "note.redo") => {
    if (!routeNoteId) return;
    undoOrRedo(workspaceId, { type, id: routeNoteId }).then(
      (note) => {
        setStuck(null);
        if (note) remember(note);
      },
      (err: Error) => setStuck({ noteId: routeNoteId, message: err instanceof ApiError ? err.message : `Couldn't ${type === "note.undo" ? "undo" : "redo"}. Common Ink can't be reached.` }),
    );
  };
  inner.current = { step, save: () => routeNoteId && void saveNow(routeNoteId), toggleWriting, toggleInspector };

  useEffect(() => {
    // A keybinding is the app's before it is an editor's: CodeMirror leaves alone a key press that was already taken.
    const onKey = (e: KeyboardEvent) => {
      const { keybindings, commands } = host.contributions();
      const command = commands.find((c) => c.id === keybindings[chordOf(e, MAC)]);
      if (!command || (inField(e.target) && command.leaveToFields) || command.when?.() === false) return;
      if (host.run(command.id)) e.preventDefault();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [host]);
  useEffect(() => host.navigated(), [host, place.path]);
  useEffect(() => host.notesChanged(), [host, notes]);

  const actions = useLatest({
    go,
    notePath: (noteId: string) => pathTo(byId, noteId),
    openNote,
    showNote,
    createNote: () => void createNote(),
    selectFolder,
    moveNote,
    noteChanged: remember,
    refresh,
    markSeen,
    toggleOverlay: (id: string) => setOverlay((open) => (open === id ? null : id)),
    switchWorkspace: onSwitch,
    reloadWorkspaces: () => void reloadWorkspaces(),
    signOut: () => void signOut().then(() => location.assign("/")),
  });
  const app: App = {
    me: me.person,
    workspace,
    workspaces: me.workspaces,
    canEdit,
    path: place.path,
    pageState: place.state,
    noteId: routeNoteId,
    note: current,
    unseen,
    notes,
    folders: tree,
    folderId: selectedFolderId,
    writing: layout.writing,
    pages: contributed.views.page,
    sections: null,
    overlay,
    ...actions,
  };
  appNow.current = app;
  const page = route.kind === "page" ? contributed.views.page.find((p) => p.path === route.path) : undefined;
  const shownOverlay = contributed.views.overlay.find((o) => o.id === overlay);

  const editorArea = contributed.views.editor.at(-1);
  app.sections = contributed.views.section.map((section) => <Drawn key={section.id} host={host} view={section} />);
  /** What the left popover of writing mode holds, in place of the columns there is no room for. */
  const popoverColumns = contributed.views.column.filter((c) => c.popover);
  const inspectorTabs = contributed.views.inspector;
  /** The note the inspector is about, once there is enough to show it. */
  const inspected = tree && current;

  const renderNote = (noteId: string, { onEdit, corner }: { onEdit?: () => void; corner?: boolean } = {}) => {
    const note = byId.get(noteId);
    return (
      <NoteEditor
        key={noteId}
        workspaceId={workspaceId}
        noteId={noteId}
        onLoaded={remember}
        onSaved={remember}
        revision={note?.revision}
        onEdit={() => {
          if (stuck) setStuck(null);
          onEdit?.();
        }}
        notice={stuck?.noteId === noteId ? stuck.message : null}
        focus={toFocus === noteId}
        onFocused={() => setToFocus(null)}
        canEdit={canEdit}
        embeds={embeds}
        completions={contributed.completions}
        onContributionFailed={host.fail}
        extensions={extensions}
        onExtensionRefused={host.fail}
        meta={
          note && (
            <>
              <span className="crumbs">{tree?.pathName(note.folderId)}</span>
              <span>
                edited {ago(note.updatedAt, now)} by {note.updatedBy.name}
              </span>
            </>
          )
        }
        actions={
          corner && (
            <>
              {!layout.writing && inspectorTabs.length > 0 && (
                <button type="button" className="icon-button" aria-label="Inspector" title="Inspector" aria-pressed={inspectorOpen} onClick={toggleInspector}>
                  <Icon name="inspector" />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label="Writing mode"
                title={`Writing mode (${shortcut("view.toggleWritingMode")})`}
                aria-pressed={layout.writing}
                onClick={toggleWriting}
              >
                <Icon name="writing" />
              </button>
            </>
          )
        }
      />
    );
  };

  /** The open note alone, for when no plugin fills the editor area or the one that does throws. */
  const loneEditor = (
    <div className="groups">
      <section className="group">
        <div className="group-body">{routeNoteId ? renderNote(routeNoteId, { corner: true }) : <p className="notice">Pick a note, or start a new one.</p>}</div>
      </section>
    </div>
  );

  const popoverRef = useRef<HTMLDivElement>(null);
  const leftRail = useRef<HTMLElement>(null);
  const rightRail = useRef<HTMLElement>(null);
  const popover = layout.writing ? layout.popover : null;
  const popoverTab = popover?.side === "right" ? inspectorTabs.find((t) => t.id === popover.tab) : undefined;
  useDismiss(popover ? closePopover : null, popoverRef, leftRail, rightRail);

  return (
    <div className="app" data-writing={layout.writing || undefined} data-bar={contributed.views.bar.length > 0 || undefined} style={{ "--editor-text-scale": (contributed.settings.values["core.editorTextSize"] as number) / 100 } as CSSProperties}>
      {layout.writing ? (
        <nav ref={leftRail} className="rail" aria-label="Left rail">
          <img src="/favicon.svg" alt="" width={18} height={18} className="rail-brand" />
          {(contributed.views.section.length > 0 || popoverColumns.length > 0) && (
            <button type="button" className="icon-button" aria-label="Folders" aria-pressed={popover?.side === "left"} onClick={() => togglePopover({ side: "left" })}>
              <Icon name="folders" />
            </button>
          )}
          {contributed.views.rail.map((item) => (
            <Drawn key={item.id} host={host} view={item} />
          ))}
        </nav>
      ) : (
        contributed.views.column.map((column) => <Drawn key={column.id} host={host} view={column} />)
      )}

      <main className="main" aria-label="Editor">
        {page && <Drawn key={page.id} host={host} view={page} />}
        {route.kind === "page" && !page && <p className="notice">There's nothing at this address.</p>}
        {route.kind !== "page" && (editorArea ? <Drawn key={editorArea.id} host={host} view={editorArea} renderNote={renderNote} fallback={loneEditor} /> : loneEditor)}
      </main>

      {layout.writing ? (
        <nav ref={rightRail} className="rail" aria-label="Right rail">
          {inspectorTabs.map((tab) => {
            const badge = tab.badge?.(app) ?? null;
            return (
              <button
                key={tab.id}
                type="button"
                className="icon-button"
                aria-label={tab.label}
                title={tab.label}
                aria-pressed={popoverKey(popover) === tab.id}
                aria-description={badge ?? undefined}
                disabled={!inspected}
                onClick={() => togglePopover({ side: "right", tab: tab.id })}
              >
                <Icon name={tab.icon} />
                {badge && <span className="unseen-dot" />}
              </button>
            );
          })}
        </nav>
      ) : (
        inspectorOpen &&
        (inspected ? (
          <Inspector host={host} tabs={inspectorTabs} app={app} note={inspected} />
        ) : (
          // A note can be read before the notes and folders are listed. The inspector's place is held until they are, so the note doesn't open wide and then narrow.
          routeNoteId && !(notes && tree) && inspectorTabs.length > 0 && <aside className="inspector" aria-hidden />
        ))
      )}

      {popover?.side === "left" && (
        <div ref={popoverRef} className="popover left" role="dialog" aria-label="Folders">
          <div className="popover-folders">{app.sections}</div>
          {popoverColumns.map((column) => (
            <Drawn key={column.id} host={host} view={column} />
          ))}
        </div>
      )}
      {popoverTab && inspected && (
        <div ref={popoverRef} className="popover right" role="dialog" aria-label={popoverTab.label}>
          <h2>{popoverTab.label}</h2>
          <Drawn key={popoverTab.id} host={host} view={popoverTab} note={inspected} />
        </div>
      )}
      {contributed.views.bar.length > 0 && (
        <div className="bar" role="group" aria-label="Bottom bar">
          {contributed.views.bar.map((item) => (
            <Drawn key={item.id} host={host} view={item} />
          ))}
        </div>
      )}
      {shownOverlay && <Drawn key={shownOverlay.id} host={host} view={shownOverlay} close={closeOverlay} />}
    </div>
  );
}
