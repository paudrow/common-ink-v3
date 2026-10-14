import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { EditorView } from "@codemirror/view";
import type { MeHere, Note, NoteSummary, WorkspaceSummary } from "../core/protocol.ts";
import { noteIdFromPath, notePath } from "../core/slug.ts";
import { ApiError, connectAgent, disconnectAgent, editAgent, listAgents, perform, signOut } from "./api.ts";
import { Drawn } from "./Drawn.tsx";
import { usable } from "./editorExtensions.ts";
import { folderTree } from "./folders.ts";
import { Icon } from "./icons.tsx";
import { InspectorBar, InspectorPanel, type Subject } from "./Inspector.tsx";
import type { Showing } from "./inspected.ts";
import { layoutOf, reduce, restored, showing, type Side, type SideAction } from "./inspectorState.ts";
import { advance, chordFor, chordLabel, chordOf, isModifier, pressing, typed } from "./keybindings.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { NoteReader } from "./NoteReader.tsx";
import { ALL_NOTES, SHARED_WITH_ME, folderTitle, type App, type Embed, type Folders, type Opened, type Plugin } from "./plugin-api.ts";
import { createPluginHost, type Host } from "./pluginHost.ts";
import { BUILT_INS } from "./plugins/index.ts";
import { Plugins } from "./Plugins.tsx";
import { ResizeHandle } from "./resize.tsx";
import { folderPath, keepsATab, type Navigate, type Place } from "./router.ts";
import { documentOf } from "./settings.ts";
import { Settings } from "./Settings.tsx";
import type { SettingsStore } from "./settingsStore.ts";
import { isBoolean, isString, readStored, useStored, writeStored } from "./stored.ts";
import { performInSync, saveNow, undoOrRedo } from "./sync.ts";
import { ago, useNow } from "./time.ts";

const FOCUS_KEY = "ink.focus";
const SIDEBAR_KEY = "ink.sidebar";
/**
 * The panel the inspector's command opens for a member who has used none. It is not History, which
 * counts a note's changes as seen by being shown.
 */
const FIRST_PANEL = "info";
/** How wide the sidebar starts, and how far a member can drag it. */
const SIDEBAR = { start: 216, min: 150, max: 480 };
/** The inspector's panel. Its bar is beside it, so pinned at its start the two take the 300px the inspector always took. */
const INSPECTOR = { start: 256, min: 180, max: 600 };
/** How wide the bar of icons is that the sidebar folds to. The inspector's bar is beside its panel, which folds to nothing. */
const BAR = 44;
/** How far an arrow key moves the edge of one. */
const WIDTH_STEP = 16;
type Widths = { sidebar?: number; inspector?: number };
const isWidths = (v: unknown): v is Widths => typeof v === "object" && v !== null && Object.values(v).every((n) => typeof n === "number" && n > 0);
const within = ({ min, max }: { min: number; max: number }, width: number) => Math.min(max, Math.max(min, width));
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** Where a page that gives no order is placed: after every page that gives one. */
const UNPLACED = Number.MAX_SAFE_INTEGER;
/** How often the notes changed since the last look are listed, so an agent's or another member's change shows up. */
const REFRESH_MS = 5000;
/**
 * How often every note and folder is listed again. A note that was hidden from the member, or that
 * they may no longer change, is not a change to the note, so only a whole listing shows it.
 */
const REFRESH_ALL_MS = 15_000;

const isAnything = (_: unknown): _ is unknown => true;
const isRevisions = (v: unknown): v is Record<string, number> => typeof v === "object" && v !== null && Object.values(v).every((n) => typeof n === "number");
/** A note's editor is not one: undo there is the app's, through the note's history. */
const inField = (el: EventTarget | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable && !el.closest(".note"));

/** How long the first keys of a sequence wait for the rest. */
/** What acts on Enter or Space itself when it has focus and isn't a field. A bare key bound to a command is left to it. */
const PRESSED = 'button, summary, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="option"], [role="treeitem"], [role^="menuitem"]';
const TAKES = { enter: `${PRESSED}, a[href], [role="link"]`, space: PRESSED };
const SEQUENCE_MS = 1500;
/** A list that takes focus itself and moves its own cursor with its own keys, as History's list of changes does. */
const OWN_KEYS = '[role="listbox"][tabindex], [role="tree"][tabindex], [data-list][tabindex]';
const hasOwnKeys = (el: EventTarget | null) => el instanceof Element && (el.closest<HTMLElement>(OWN_KEYS)?.tabIndex ?? -1) >= 0;


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

/** A folder's notes by title, for when no plugin lists them. */
function FolderNotes({ folderId, folders, notes, pathOf, onOpen }: { folderId: string; folders: Folders | null; notes: readonly NoteSummary[] | null; pathOf: (noteId: string) => string; onOpen: (noteId: string) => void }) {
  if (!folders || !notes) return null;
  const title = folderTitle(folders, folderId);
  if (title === null) return <p className="notice">This folder doesn't exist, or you can't see it.</p>;
  const listed = notes.filter((n) => folderId === ALL_NOTES || n.folderId === (folderId === SHARED_WITH_ME ? null : folderId));
  return (
    <section className="folder-notes" aria-label={title}>
      <h1>{title}</h1>
      {listed.length === 0 && <p className="empty">No notes in this folder.</p>}
      <ul data-list>
        {listed.map((note) => (
          <li key={note.id}>
            <a
              href={pathOf(note.id)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(note.id);
              }}
            >
              {note.title || "Untitled"}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Props {
  me: MeHere;
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
  const { role } = workspace;
  const canEdit = role !== "viewer";
  const now = useNow();
  const [tree, setTree] = useState<Folders | null>(null);
  /** Every note in the workspace, for the note list, tab titles, and quick open. */
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [listVersion, setListVersion] = useState(0);
  /** In focus the tab in front of the focused group fills the window, over everything else, which stays as it is underneath. Which group that is, the layout already says. */
  const [focusMode, setFocusMode] = useStored(FOCUS_KEY, isBoolean, false);
  const [sidebarOpen, setSidebarOpen] = useStored(SIDEBAR_KEY, isBoolean, true);
  /**
   * The inspector as the member last had it, kept in this browser as the widths are: which panel,
   * whether it shows, and whether it is pinned. It begins closed and unpinned. A member from before
   * panels could be pinned never chose to pin one, so they begin the same, with the tab they had
   * picked as the panel last used. The key is not `ink.inspector.<id>`, which earlier builds wrote
   * pinned on a first visit without the member choosing it.
   */
  const sideKey = `ink.inspectorPanel.${me.person.id}`;
  const [side, setSide] = useState<Side>(() =>
    restored(readStored(sideKey, isAnything), { panel: readStored(`ink.inspectorTab.${me.person.id}`, isString) ?? FIRST_PANEL, open: false, pinned: false }),
  );
  useEffect(() => writeStored(sideKey, side), [sideKey, side]);
  /** What each page that is drawn says it is showing, by the page's id. */
  const [said, setSaid] = useState<ReadonlyMap<string, Showing>>(new Map());
  /** How wide the member dragged the sidebar and the inspector. Kept in this browser, as the layout is: a width suits the screen it was set on. */
  const [widths, setWidths] = useStored<Widths>(`ink.widths.${me.person.id}`, isWidths, {});
  const sidebarWidth = within(SIDEBAR, widths.sidebar ?? SIDEBAR.start);
  const inspectorWidth = within(INSPECTOR, widths.inspector ?? INSPECTOR.start);
  const [overlay, setOverlay] = useState<{ id: string; state: unknown } | null>(null);
  /** Notes the member could see that a later listing left out: hidden from them, or gone. An editor still open on one stops showing it. */
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  /** An undo or redo that didn't happen, and why, shown on its note until the member's next step. */
  const [stuck, setStuck] = useState<{ noteId: string; message: string } | null>(null);

  const byId = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const routeNoteId = route.kind === "note" ? route.id : null;
  const current = (routeNoteId && byId.get(routeNoteId)) || null;
  const routeFolderId = route.kind === "folder" ? route.id : null;
  /** The folder in front: the one whose list is open, or the open note's. A note whose folder the member can't see is among the ones shared with them. */
  const frontFolderId = routeFolderId ?? (current ? (current.folderId ?? SHARED_WITH_ME) : null);

  const appNow = useRef<App>(null!);
  /** What the app's own commands do, as of the latest render. */
  const inner = useRef<{ step: (type: "note.undo" | "note.redo") => void; save: () => void; toggleFocus: () => void; toggleSidebar: () => void; toggleInspector: () => void }>(null!);
  const panel = useRef<HTMLElement>(null);
  const inspectorBar = useRef<HTMLElement>(null);
  const panelId = useId();
  const [host] = useState(() => {
    let created: Host;
    const PluginsPage = ({ app }: { app: App }) => <Plugins host={created} store={settings} mac={MAC} path={app.path} go={app.go} />;
    /** What the app itself adds, through the registry the plugins use. It can't be turned off. */
    const core: Plugin = {
      id: "core",
      name: "Common Ink",
      settings: {
        theme: { type: "string", default: "system", enum: ["system", "light", "dark"], title: "Theme", description: "Light or dark, or system to follow this device." },
        editorTextSize: { type: "integer", default: 100, minimum: 75, maximum: 200, title: "Editor text size", description: "The size of a note's text, as a percentage." },
      },
      activate(h) {
        h.commands.register({ id: "notes.all", title: "Open All notes", run: () => h.app().openFolder(ALL_NOTES) });
        if (canEdit) {
          h.commands.register({ id: "note.new", title: "New note", run: () => void h.app().createNote().catch(() => {}) });
          h.commands.register({ id: "history.undo", title: "Undo", keys: ["mod+z"], leaveToFields: true, run: () => inner.current.step("note.undo") });
          h.commands.register({ id: "note.save", title: "Save now", keys: ["mod+s"], run: () => inner.current.save() });
          h.commands.register({ id: "history.redo", title: "Redo", keys: ["mod+shift+z", "mod+y"], leaveToFields: true, run: () => inner.current.step("note.redo") });
        }
        h.commands.register({ id: "view.toggleFocus", title: "Toggle focus", keys: ["mod+."], run: () => inner.current.toggleFocus() });
        h.commands.register({ id: "view.toggleSidebar", title: "Toggle sidebar", keys: ["mod+\\"], run: () => inner.current.toggleSidebar() });
        h.commands.register({ id: "view.toggleInspector", title: "Toggle inspector", run: () => inner.current.toggleInspector() });
      },
    };
    /** Kept apart from the rest so their links and commands come after the plugins', where the others come before. */
    const pages: Plugin = {
      id: "plugins",
      name: "Plugins",
      activate(h) {
        h.views.register("page", { id: "settings", path: "/settings", label: "Settings", nav: "menu", component: ({ app }) => <Settings host={created} store={settings} mac={MAC} path={app.path} go={app.go} /> });
        h.views.register("page", { id: "plugins", path: "/plugins", label: "Plugins", icon: "plugin", nav: "more", component: PluginsPage });
      },
    };
    created = createPluginHost({
      // A test puts plugins on the page before the app loads. Loading a member's own plugins is another matter.
      plugins: [core, ...BUILT_INS, ...((window as { __INK_FIXTURE_PLUGINS__?: Plugin[] }).__INK_FIXTURE_PLUGINS__ ?? []), pages],
      builtIn: [core, ...BUILT_INS, pages].map((p) => p.id),
      required: [core.id, pages.id],
      // Fixture plugins are a test's, and stand for anyone's: they are not among these.
      trusted: [core, ...BUILT_INS, pages],
      settings: documentOf(settings.text()) ?? {},
      // The member's own controls come through here: the Settings and Plugins pages, and the commands that turn a plugin on or off.
      write: (key, value) => void settings.set(key, value),
      mac: MAC,
      embedSite: me.setup.embedSite,
      provide: (plugin) => ({
        workspace,
        app: () => appNow.current,
        // Made for the one plugin that asked, so this is where its permissions will be checked. The server records the member as the author.
        perform: (op) => performInSync(workspaceId, op),
        agents: { list: listAgents, connect: connectAgent, edit: editAgent, disconnect: (id) => disconnectAgent(id).then(() => {}) },
        members: {
          invite: (email, as) => perform(workspaceId, { type: "member.invite", email, as }),
          setRole: (memberId, as) => perform(workspaceId, { type: "member.setRole", memberId, as }),
          remove: (memberId) => perform(workspaceId, { type: "member.remove", memberId }).then(() => {}),
          leave: () => perform(workspaceId, { type: "member.leave" }).then(() => {}),
          invites: () => perform(workspaceId, { type: "invite.list" }),
          revoke: (inviteId) => perform(workspaceId, { type: "invite.revoke", id: inviteId }).then(() => {}),
        },
        sharing: {
          of: (on) => perform(workspaceId, { type: "grant.list", ...on }),
          grant: (on, email, access) => perform(workspaceId, { type: "grant.set", ...on, email, access }),
          link: (on, link) => perform(workspaceId, { type: "grant.link", ...on, link }),
          revoke: (grantId) => perform(workspaceId, { type: "grant.revoke", id: grantId }).then(() => {}),
          setPrivate: (noteId, isPrivate) => perform(workspaceId, { type: "note.setPrivate", id: noteId, private: isPrivate }),
          all: () => perform(workspaceId, { type: "grant.list" }).then((all) => all.grants),
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
  /** The page the address names: the one at exactly that address, or else the one whose path it is under. */
  const routePage = route.kind === "page" ? (contributed.views.page.find((p) => p.path === route.path) ?? contributed.views.page.find((p) => route.path.startsWith(`${p.path}/`))) : undefined;
  /** A page that only leads somewhere else is no tab: it has the editor area's place while it finds where to go. */
  const passing = routePage?.transient ? routePage : undefined;
  const routePageId = passing ? undefined : routePage?.id;
  const address = place.path;
  /** An address no page is at is opened like one, under its own path as the id no page has, so it says so in a tab beside the ones that are open and never in their place. */
  const nowhere = route.kind === "page" && !routePage && keepsATab(address);
  const opened = useMemo<Opened | null>(
    () => (routeNoteId ? { kind: "note", id: routeNoteId } : routeFolderId ? { kind: "folder", id: routeFolderId } : routePageId || nowhere ? { kind: "page", id: routePageId ?? address, path: address } : null),
    [routeNoteId, routeFolderId, routePageId, nowhere, address],
  );
  useEffect(() => () => host.dispose(), [host]);
  /** Each embed as registered, but telling the host when it throws while being drawn. One is made per embed, so a drawn embed isn't redrawn when something else changes. */
  const [guarded] = useState(() => new WeakMap<Embed, Embed>());
  const embeds = useMemo(
    () =>
      contributed.embeds.map((embed) => {
        if ("claims" in embed) return embed;
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

  // A listing that fails, as a request can under load, is asked for again at the next refresh, and leaves what was listed as it was.
  const loadFolders = useCallback(
    () =>
      perform(workspaceId, { type: "folder.list" }).then(
        (r) => setTree(folderTree(r)),
        () => {},
      ),
    [workspaceId],
  );
  useEffect(() => void loadFolders(), [loadFolders]);

  const listedNotes = useRef(notes);
  listedNotes.current = notes;
  /** Notes loaded, saved, or created since the last listing was asked for, which its answer can't know. */
  const learned = useRef(new Map<string, NoteSummary>());
  useEffect(() => {
    let live = true;
    const since = (learned.current = new Map());
    perform(workspaceId, { type: "note.list" }).then(
      (all) => {
        if (!live) return;
        const known = listedNotes.current;
        const listed = newest(all, known, since);
        const there = new Set(listed.map((n) => n.id));
        const lost = (known ?? []).filter((n) => !there.has(n.id)).map((n) => n.id);
        setGone((was) => {
          const now = [...was, ...lost].filter((id) => !there.has(id));
          return now.length === was.size && !lost.length ? was : new Set(now);
        });
        setNotes(listed);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [workspaceId, listVersion]);

  const refresh = useCallback(() => {
    void loadFolders();
    setListVersion((v) => v + 1);
  }, [loadFolders]);

  useEffect(() => {
    const again = () => document.visibilityState === "visible" && refresh();
    const timer = setInterval(again, REFRESH_ALL_MS);
    addEventListener("focus", again);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", again);
    };
  }, [refresh]);

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
      setGone((was) => (was.has(note.id) ? new Set([...was].filter((id) => id !== note.id)) : was));
      if (location.pathname.startsWith("/note/") && location.pathname.endsWith(note.id)) navigate(notePath(note), { replace: true });
    },
    [navigate, noteIsHere, workspaceId],
  );

  const byIdNow = useRef(byId);
  byIdNow.current = byId;
  const show = useCallback(
    (tab: Opened | null, how: { replace?: boolean; move?: boolean } = {}) => {
      if (!tab) navigate("/");
      else if (tab.kind === "folder") navigate(folderPath(tab.id), how);
      else if (tab.kind === "page") navigate(tab.path, how);
      // A note's address may be written with an older title, and is still the note's.
      else if (noteIdFromPath(location.pathname) !== tab.id) navigate(pathTo(byIdNow.current, tab.id), how);
    },
    [navigate],
  );

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

  const toggleFocus = useCallback(() => setFocusMode((on) => !on), [setFocusMode]);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), [setSidebarOpen]);
  /** Whether the next panel to show takes the cursor, and the next to close gives it back: so for the keys and the icons, and not for a press elsewhere or the edge. */
  const byHand = useRef(false);
  const act = useCallback(
    (action: SideAction, hand = false) => {
      byHand.current = hand;
      setSide((was) => reduce(was, action, host.contributions().views.inspector.map((v) => v.id)));
    },
    [host],
  );
  const toggleInspector = useCallback(() => act({ type: "toggle" }, true), [act]);
  const togglePanel = useCallback((viewId: string) => act({ type: "pick", panel: viewId }, true), [act]);
  const closeOverlay = useCallback(() => setOverlay(null), []);

  /**
   * Where a new note goes: the folder asked for, or else the folder in front, when that is a folder
   * the member can see; otherwise Unsorted. Null where there is no such place for this person, as
   * for a guest looking at what was shared with them.
   */
  const folderForNew = (asked: string | null) => (asked === SHARED_WITH_ME ? null : ((asked && tree?.byId.has(asked) ? asked : tree?.unsortedId) ?? null));
  const newNoteFolderId = folderForNew(frontFolderId);
  /** The server says of each folder what the person may do in it, so nothing here is worked out from their role. */
  const canCreateNote = !!newNoteFolderId && tree?.byId.get(newNoteFolderId)?.access === "edit";

  const go = navigate;
  /** The note whose editor is to take the cursor once it is there, unless the member has put it somewhere else by then. */
  const [toFocus, setToFocus] = useState<string | null>(null);
  useEffect(() => {
    if (toFocus === null) return;
    const elsewhere = () => setToFocus(null);
    addEventListener("focusin", elsewhere, true);
    return () => removeEventListener("focusin", elsewhere, true);
  }, [toFocus]);
  const openNote = (noteId: string, options: { preview?: boolean; focus?: boolean; background?: boolean } = {}) => {
    const area = host.contributions().views.editor.at(-1);
    if (options.background && area?.open) return area.open({ kind: "note", id: noteId }, { preview: false, background: true });
    setToFocus(options.focus ? noteId : null);
    if (area?.open) area.open({ kind: "note", id: noteId }, { preview: options.preview ?? false });
    else show({ kind: "note", id: noteId });
  };
  const openFolder = (folderId: string, options: { preview?: boolean } = {}) => {
    const area = host.contributions().views.editor.at(-1);
    if (area?.open) area.open({ kind: "folder", id: folderId }, { preview: options.preview ?? true });
    else show({ kind: "folder", id: folderId });
  };

  const openBeside = (tab: Opened, side: "right" | "down") => host.contributions().views.editor.at(-1)?.split?.(tab, side);

  const createNote = async (folderId?: string) => {
    const note = await perform(workspaceId, { type: "note.create", folderId: (folderId === undefined ? newNoteFolderId : folderForNew(folderId)) ?? undefined });
    void loadFolders();
    remember(note);
    openNote(note.id);
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
  const panels = useMemo(() => contributed.views.inspector.map((v) => v.id), [contributed.views.inspector]);
  const shownPanel = showing(side, panels);
  const layout = layoutOf(side, panels);

  /** What last had focus outside the inspector, which is where the cursor goes back to. */
  const outside = useRef<HTMLElement | null>(null);
  /** Whether the cursor was last in a dialog over the window, such as the command palette. */
  const inDialog = useRef(false);
  useEffect(() => {
    const within = (el: EventTarget | null) => el instanceof Node && (!!panel.current?.contains(el) || !!inspectorBar.current?.contains(el));
    /** A dialog over the window, such as the command palette, is a step on the way back and not elsewhere: a panel's command run from it can close the panel. */
    const over = (el: EventTarget | null) => el instanceof Element && !!el.closest('[role="dialog"]');
    const temporary = layout === "temporary";
    // A panel over the page goes when the member goes elsewhere: a press or the cursor outside it and its bar, or Escape that nothing in it had a use for.
    const onFocus = (e: FocusEvent) => {
      const fromDialog = inDialog.current;
      inDialog.current = over(e.target);
      if (within(e.target) || inDialog.current) return;
      if (e.target instanceof HTMLElement) outside.current = e.target;
      // The cursor given back by a palette as it closes is not the member going elsewhere.
      if (temporary && !fromDialog) act({ type: "dismiss" });
    };
    const onPress = (e: PointerEvent) => {
      if (!within(e.target) && !over(e.target)) act({ type: "dismiss" });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !(within(e.target) || e.target === document.body)) return;
      e.preventDefault();
      act({ type: "dismiss" }, true);
    };
    addEventListener("focusin", onFocus, true);
    if (temporary) {
      addEventListener("pointerdown", onPress, true);
      addEventListener("keydown", onKey);
    }
    return () => {
      removeEventListener("focusin", onFocus, true);
      removeEventListener("pointerdown", onPress, true);
      removeEventListener("keydown", onKey);
    };
  }, [layout, act]);
  const wasShown = useRef(shownPanel);
  useLayoutEffect(() => {
    if (wasShown.current === shownPanel) return;
    wasShown.current = shownPanel;
    if (!byHand.current) return;
    byHand.current = false;
    // After the frame, so a palette the command was run from has put the cursor back where it was first.
    if (shownPanel !== null)
      return void requestAnimationFrame(() => document.activeElement?.closest('[role="dialog"]') || panel.current?.focus({ preventScroll: true }));
    const at = document.activeElement;
    // Closed from the palette, the cursor is given back now, as the palette would give it back to the panel, which is gone.
    const to = outside.current;
    if (!((!at || at === document.body || inspectorBar.current?.contains(at) || at.closest('[role="dialog"]')) && to?.isConnected)) return;
    // A note's editor is given the cursor by its view, which puts it back where it was in the text: focus alone can put it at the start.
    const editor = EditorView.findFromDOM(to);
    if (editor) editor.focus();
    else to.focus({ preventScroll: true });
  }, [shownPanel]);
  // Focus shows neither the bar nor a panel, so one that lay over the page is not there on leaving it.
  useEffect(() => {
    if (focusMode) act({ type: "dismiss" });
  }, [focusMode, act]);

  /** One per page, the same each time, so a page that says what it shows says it once. */
  const [tellers] = useState(() => new Map<string, (showing: Showing | null) => void>());
  const inspectFor = (pageId: string) => {
    const made =
      tellers.get(pageId) ??
      ((showing: Showing | null) =>
        setSaid((was) => {
          if (JSON.stringify(was.get(pageId) ?? null) === JSON.stringify(showing)) return was;
          const next = new Map(was);
          if (showing) next.set(pageId, showing);
          else next.delete(pageId);
          return next;
        }));
    tellers.set(pageId, made);
    return made;
  };

  inner.current = { step, save: () => routeNoteId && void saveNow(routeNoteId), toggleFocus, toggleSidebar, toggleInspector };

  useEffect(() => {
    // A keybinding is the app's before it is anyone else's: a key press that was taken reaches no editor and no row's own handler.
    let pending = "";
    /** What had focus when the sequence was begun. */
    let begunAt: EventTarget | null = null;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    /** A sequence is given up when the member goes elsewhere or waits, so its first keys take nothing from what is pressed next. */
    const giveUp = () => {
      pending = "";
      clearTimeout(waiting);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || isModifier(e.key)) return;
      // A press in the keyboard shortcuts table's recorder is a key to write down, not one to run.
      if (e.target instanceof Element && e.target.closest("[data-records-keys]")) return;
      const { keybindings, commands } = host.contributions();
      const chord = chordOf(e, MAC);
      const begun = pending;
      giveUp();
      const press = pressing(chord);
      const pressesIt = press !== null && e.target instanceof Element && e.target.matches(TAKES[press]);
      const commandFor = (keys: string) => commands.find((c) => c.id === keybindings[keys]);
      const ready = Object.keys(keybindings).filter((keys) => {
        if (keys !== chord && !keys.startsWith(`${chord} `) && !(begun && keys.startsWith(`${begun} `))) return false;
        const command = commandFor(keys)!;
        // Keys that would type are left to what is being typed in, unless their command says for itself when it runs.
        if (!command.when && typed(keys) && (inField(e.target) || (e.target instanceof HTMLElement && e.target.isContentEditable))) return false;
        // Enter and Space are a button's, a link's or a checkbox's own while it has focus.
        if (!command.when && pressesIt && (keys === chord || keys.startsWith(`${chord} `))) return false;
        return !(inField(e.target) && command.leaveToFields) && command.when?.() !== false;
      });
      const next = advance(begun, chord, ready);
      if (!next) return;
      if (next === "dropped") {
        // A key that finishes nothing is dropped only where the sequence was begun. Anywhere else it is that place's key, and so it is in a list with keys of its own.
        if (e.target !== begunAt || hasOwnKeys(e.target)) return;
      } else if ("pending" in next) {
        pending = next.pending;
        begunAt = e.target;
        waiting = setTimeout(giveUp, SEQUENCE_MS);
      } else if (!host.run(commandFor(next.run)!.id)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    addEventListener("focusin", giveUp, true);
    addEventListener("pointerdown", giveUp, true);
    return () => {
      giveUp();
      removeEventListener("keydown", onKey, true);
      removeEventListener("focusin", giveUp, true);
      removeEventListener("pointerdown", giveUp, true);
    };
  }, [host]);
  useEffect(() => host.navigated(), [host, place.path]);
  useEffect(() => host.notesChanged(), [host, notes]);

  const actions = useLatest({
    go,
    notePath: (noteId: string) => pathTo(byId, noteId),
    openNote,
    openFolder,
    openBeside,
    folderPath,
    show,
    createNote,
    moveNote,
    noteChanged: remember,
    refresh,
    markSeen,
    toggleOverlay: (id: string, state?: unknown) => setOverlay((open) => (open?.id === id ? null : { id, state })),
    toggleSidebar,
    togglePanel,
    inspect: (_: Showing | null) => {},
    setFocus: setFocusMode,
    switchWorkspace: onSwitch,
    reloadWorkspaces: () => void reloadWorkspaces(),
    signOut: () => void signOut().then(() => location.assign("/")),
  });
  const app: App = {
    me: me.person,
    workspace,
    workspaces: me.workspaces,
    canEdit,
    canCreateNote,
    path: place.path,
    pageState: place.state,
    opened,
    noteId: routeNoteId,
    note: current,
    unseen,
    notes,
    folders: tree,
    folderId: frontFolderId,
    focus: focusMode,
    sidebarOpen,
    pages: contributed.views.page.toSorted((a, b) => (a.order ?? UNPLACED) - (b.order ?? UNPLACED)),
    sections: null,
    sectionsOpening: () => null,
    readNote: () => null,
    overlay: overlay?.id ?? null,
    ...actions,
    openBeside: contributed.views.editor.at(-1)?.split ? actions.openBeside : null,
  };
  appNow.current = app;
  const page = route.kind === "page" ? contributed.views.page.find((p) => p.path === route.path) : undefined;
  const editorArea = contributed.views.editor.at(-1);
  /** The bottom bar's items, lowest order first. Sorting keeps those of one order as the plugins added them. */
  const bar = useMemo(() => [...contributed.views.bar].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [contributed.views.bar]);
  const shownOverlay = contributed.views.overlay.find((o) => o.id === overlay?.id);

  /** The sections, each told when it opens something if the place they are drawn in wants to know. */
  const sections = (opened?: () => void) =>
    contributed.views.section.map((section) => {
      const telling = <A extends unknown[]>(open: (...args: A) => void) => (...args: A) => (open(...args), opened?.());
      const as = (its: App): App => ({ ...its, openNote: telling(its.openNote), openFolder: telling(its.openFolder), openBeside: its.openBeside && telling(its.openBeside), go: telling(its.go) });
      return <Drawn key={section.id} host={host} view={section} as={opened && as} />;
    });
  app.sections = contributed.views.section.length === 0 ? null : sections();
  app.sectionsOpening = sections;
  const inspectorViews = contributed.views.inspector;
  const shownView = inspectorViews.find((v) => v.id === shownPanel);
  /** What is in front, for the inspector to be about. Null while it loads. */
  const subject = ((): Subject | null => {
    if (routeNoteId) return current && tree ? { kind: "note", note: current } : null;
    if (routeFolderId) {
      if (!tree || !notes) return null;
      const name = folderTitle(tree, routeFolderId);
      return name === null ? { kind: "nothing" } : { kind: "folder", folderId: routeFolderId, name, notes: notes.filter((n) => routeFolderId === ALL_NOTES || n.folderId === routeFolderId) };
    }
    const shows = routePageId ? said.get(routePageId) : undefined;
    if (!shows) return { kind: "nothing" };
    if (!notes) return null;
    if (shows.kind === "notes") return { kind: "notes", label: shows.label, notes: shows.noteIds.flatMap((id) => byId.get(id) ?? []) };
    const note = byId.get(shows.noteId);
    return note ? { kind: "note", note } : { kind: "nothing" };
  })();

  const renderNote = (noteId: string, { onEdit, focus, onFocused }: { onEdit?: () => void; focus?: boolean; onFocused?: () => void } = {}) => {
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
        focus={toFocus === noteId || !!focus}
        onFocused={() => {
          setToFocus(null);
          onFocused?.();
        }}
        access={note?.access}
        gone={gone.has(noteId)}
        onRejected={refresh}
        embeds={embeds}
        completions={contributed.completions}
        onContributionFailed={host.fail}
        extensions={extensions}
        onExtensionRefused={host.fail}
        meta={
          // Both are there from the start, empty until they are known, so the bar is as tall while they load as after.
          <>
            <span className="crumbs" title={(note && tree?.pathName(note.folderId)) || undefined}>
              {note && tree?.pathName(note.folderId)}
            </span>
            {note?.private && (
              <span className="private-mark">
                <Icon name="lock" /> Private
              </span>
            )}
            {note?.access === "view" && canEdit && <span className="private-mark">View only</span>}
            <span>{note && `edited ${ago(note.updatedAt, now)} by ${note.updatedBy.name}`}</span>
          </>
        }
      />
    );
  };

  const readNote = (noteId: string) => (
    <NoteReader key={noteId} workspaceId={workspaceId} noteId={noteId} revision={byId.get(noteId)?.revision} embeds={embeds} extensions={extensions} />
  );
  app.readNote = readNote;
  const folderView = contributed.views.folder.at(-1);
  const renderFolder = (folderId: string) => {
    const plain = <FolderNotes folderId={folderId} folders={tree} notes={notes} pathOf={(id) => pathTo(byId, id)} onOpen={(id) => openNote(id, { preview: true })} />;
    return folderView ? <Drawn key={folderId} host={host} view={folderView} folderId={folderId} readNote={readNote} fallback={plain} /> : plain;
  };

  /**
   * A page as it is at `path`, which may be another address than the app's: a page in one half of a
   * split stays where it was while the member works in the other. So it is told its own address,
   * and that no note or folder is in front, as when it had the editor area to itself.
   */
  const renderPage = (pageId: string, path: string) => {
    const page = contributed.views.page.find((p) => p.id === pageId);
    if (!page) return <p className="notice">There's nothing at this address.</p>;
    const here = routePageId === pageId && path === address;
    const at = { path, pageState: here ? place.state : null };
    return (
      <div className="page-pane" key={page.id}>
        <Drawn host={host} view={page} as={(app) => ({ ...app, ...at, opened: { kind: "page", id: pageId, path }, noteId: null, note: null, unseen: false, folderId: null, inspect: inspectFor(pageId) })} />
      </div>
    );
  };
  const empty = <p className="notice">Pick a note, or start a new one.</p>;
  /**
   * What the address names alone, for when no plugin fills the editor area or the one that does
   * throws. At `/` it is every note, so there is a way to a note whatever is turned off.
   */
  const loneEditor = (
    <div className="groups" data-focus-mode={focusMode || undefined}>
      <section className="group" data-front="">
        <div className="tab-row">
          <button type="button" className="icon-button focus-button" aria-label="Focus" title={`${focusMode ? "Leave focus" : "Focus"} (${shortcut("view.toggleFocus")})`} aria-pressed={focusMode} onClick={toggleFocus}>
            <Icon name="focus" />
          </button>
        </div>
        <div className="group-body">
          {routeNoteId ? renderNote(routeNoteId) : routeFolderId ? renderFolder(routeFolderId) : opened?.kind === "page" ? renderPage(opened.id, opened.path) : renderFolder(ALL_NOTES)}
        </div>
      </section>
    </div>
  );

  /** Focus is of a group, and the way out of it is in that group. With none drawn the window stays whole, so nothing is hidden with no way back. */
  const focusable = !!editorArea || !passing;

  return (
    <div className="app" data-focus-mode={(focusMode && focusable) || undefined} data-bar={bar.length > 0 || undefined} style={{ "--editor-text-scale": (contributed.settings.values["core.editorTextSize"] as number) / 100, "--sidebar-width": `${sidebarWidth}px`, "--inspector-width": `${inspectorWidth}px` } as CSSProperties}>
      {contributed.views.column.map((column) => (
        <Drawn key={column.id} host={host} view={column} />
      ))}
      {contributed.views.column.length > 0 && (
        <ResizeHandle
          label="Resize sidebar"
          orientation="vertical"
          value={sidebarWidth}
          {...SIDEBAR}
          step={WIDTH_STEP}
          onChange={(sidebar) => setWidths((w) => ({ ...w, sidebar }))}
          onReset={() => setWidths(({ sidebar: _, ...w }) => w)}
          fold={{ folded: !sidebarOpen, size: BAR, onFold: (folded) => setSidebarOpen(!folded) }}
        />
      )}

      <main className="main" aria-label="Editor">
        {passing && (
          <div className="passing">
            <Drawn key={passing.id} host={host} view={passing} />
          </div>
        )}
        {/* The editor area stays as it is under a page that only leads somewhere else, out of sight, so no open editor or embed is made again. */}
        {editorArea ? (
          <div className="editor-area" data-under={passing ? "" : undefined}>
            <Drawn key={editorArea.id} host={host} view={editorArea} renderNote={renderNote} renderFolder={renderFolder} renderPage={renderPage} empty={empty} fallback={loneEditor} />
          </div>
        ) : (
          !passing && loneEditor
        )}
      </main>

      {inspectorViews.length > 0 && (
        <>
          <ResizeHandle
            label="Resize inspector"
            orientation="vertical"
            value={inspectorWidth}
            {...INSPECTOR}
            step={WIDTH_STEP}
            perPixel={() => -1}
            onChange={(inspector) => setWidths((w) => ({ ...w, inspector }))}
            onReset={() => setWidths(({ inspector: _, ...w }) => w)}
            fold={{ folded: layout !== "pinned", size: 0, onFold: (folded) => act({ type: "fold", folded }) }}
          />
          {shownView && <InspectorPanel ref={panel} id={panelId} host={host} view={shownView} subject={subject} pinned={side.pinned} onPin={() => act({ type: "pin" })} />}
          <InspectorBar ref={inspectorBar} views={inspectorViews} app={app} shown={shownPanel} panelId={panelId} onPick={togglePanel} />
        </>
      )}
      {bar.length > 0 && (
        <div className="bar" role="group" aria-label="Bottom bar">
          {(["left", "right"] as const).map((side) => (
            <div key={side} className="bar-side" data-side={side}>
              {bar
                .filter((item) => (item.side ?? "left") === side)
                .map((item) => (
                  <span key={item.id} className="bar-item" data-bar-item={item.id}>
                    <Drawn host={host} view={item} />
                  </span>
                ))}
            </div>
          ))}
        </div>
      )}
      {shownOverlay && <Drawn key={shownOverlay.id} host={host} view={shownOverlay} close={closeOverlay} state={overlay?.state} />}
    </div>
  );
}
