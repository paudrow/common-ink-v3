import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { DraftSummary, PluginRecord } from "../core/plugins.ts";
import { allPages } from "../core/allPages.ts";
import type { MeHere, Note, NoteSummary, Results, WorkspaceSummary } from "../core/protocol.ts";
import { summarize } from "../core/markdown.ts";
import { noteIdFromPath, notePath } from "../core/slug.ts";
import { ApiError, connectAgent, disconnectAgent, editAgent, listAgents, perform, readUpload, sendUpload, signOut, uploadAddress } from "./api.ts";
import { Drawn } from "./Drawn.tsx";
import { usable } from "./editorExtensions.ts";
import { folderTree } from "./folders.ts";
import { Icon } from "./icons.tsx";
import { InspectorBar, InspectorPanel, type Subject } from "./Inspector.tsx";
import type { Showing } from "./inspected.ts";
import { layoutOf, reduce, restored, showing, type Side, type SideAction } from "./inspectorState.ts";
import { advance, chordFor, chordLabel, chordOf, isModifier, pressing, typed } from "./keybindings.ts";
import { lastChange, relisted, withChanged } from "./knownNotes.ts";
import { LOOK_SETTINGS, lookOf } from "./look.ts";
import { NoteEditor, type SaveShown } from "./NoteEditor.tsx";
import { MarkdownReader } from "./MarkdownReader.tsx";
import { NoteReader } from "./NoteReader.tsx";
import { cursorIn, onNoteMoves, putCursor } from "./openNotes.ts";
import { stacked, type Told } from "./notices.ts";
import { ALL_NOTES, SHARED_WITH_ME, folderTitle, type App, type Embed, type Folders, type Notice, type Opened, type Plugin } from "./plugin-api.ts";
import { createPluginHost, type Host } from "./pluginHost.ts";
import { BUILT_INS } from "./plugins/index.ts";
import { Plugins } from "./Plugins.tsx";
import { createInstaller, loadAgain } from "./pluginRuntime.ts";
import { referredUploads } from "./referredUploads.ts";
import { ResizeHandle } from "./resize.tsx";
import { folderPath, keepsATab, pageAt, routeOf, type Navigate, type Place } from "./router.ts";
import { documentOf } from "./settings.ts";
import { ROOT as SETTINGS, Settings, type Account } from "./Settings.tsx";
import { SETTINGS_FILE, SettingsFile } from "./SettingsFile.tsx";
import { AGENTS_FILE, AgentsFile } from "./AgentsFile.tsx";
import { createAgentsFileStore } from "./agentsFileStore.ts";
import type { SettingsStore } from "./settingsStore.ts";
import { forgetAll } from "./stash.ts";
import { isBoolean, isString, readStored, useStored, writeStored } from "./stored.ts";
import { isOpen, openInAnotherTab } from "./openNotes.ts";
import { commitTyping, onFiled, onLost, performInSync, recover, saveAll, saveNow, undoOrRedo } from "./sync.ts";
import { retryAfter } from "./retry.ts";
import { ago, useNow } from "./time.ts";
import { Toasts } from "./Toasts.tsx";
import { useDevice } from "./useDevice.ts";
import { KeyRow, NewNoteButton, TopBar, upFrom } from "./Phone.tsx";
import { keptTravels, samePlace, stepped, travelled, type Travel, type Travels } from "./travels.ts";

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
const inSettings = (path: string) => path === SETTINGS || path.startsWith(`${SETTINGS}/`);
const placeAt = (address: string): Place => {
  const cut = address.indexOf("?");
  const path = cut < 0 ? address : address.slice(0, cut);
  return { path, query: cut < 0 ? "" : address.slice(cut), state: null, route: routeOf(path) };
};
const HOME = placeAt("/");

/** What a tab kept on the Settings page from before they opened over the window shows. */
function SettingsMoved({ go }: { go: (path: string) => void }) {
  return (
    <p className="notice">
      Settings open over the window now, wherever you are.{" "}
      <button type="button" className="button small" onClick={() => go(SETTINGS)}>
        Open settings
      </button>
    </p>
  );
}
/** Where a page that gives no order is placed: after every page that gives one. */
const UNPLACED = Number.MAX_SAFE_INTEGER;
/** How often the notes changed since the last look are listed, and the ones in Trash, so an agent's or another member's change to a note or to its state shows up. */
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
  const listed = notes.filter((n) => n.state === "live" && (folderId === ALL_NOTES || n.folderId === (folderId === SHARED_WITH_ME ? null : folderId)));
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

/**
 * The app holds every note the member can see, so it asks for each page in turn, as many to a page
 * as a page holds. A note changed while it pages may be missed, and the next ask for those changed
 * since the latest it knows finds it.
 */
const everyNote = (workspaceId: string, updatedSince?: number) => allPages((after) => perform(workspaceId, { type: "note.list", includeArchived: true, updatedSince, limit: 1000, after }), (page) => page.notes);
const everyTrashed = (workspaceId: string) => allPages((after) => perform(workspaceId, { type: "trash.list", limit: 500, after }), (page) => page.notes);

/** The person signed in, as Settings shows them, in the workspace open now. */
function accountOf(me: MeHere, workspaceId: string): Account {
  const here = me.workspaces.find((w) => w.id === workspaceId);
  return {
    email: me.person.email,
    // Every session ends, this one with them, so the page is read again signed out.
    signOutEverywhere: (agents) =>
      perform(workspaceId, { type: "member.signOut", memberId: me.person.id, agents }).then(() => {
        forgetAll();
        location.assign("/");
      }),
    deletion: () => perform(workspaceId, { type: "account.read" }),
    // The session's person is gone, so the page is read again signed out, as after signing out everywhere.
    deleteAccount: (confirm) =>
      perform(workspaceId, { type: "account.delete", confirm }).then(() => {
        forgetAll();
        location.assign("/");
      }),
    workspace: here?.role === "admin" ? { name: here.name, delete: (confirm) => perform(workspaceId, { type: "workspace.delete", confirm }).then(() => location.assign("/")) } : null,
  };
}

export function Workspace({ me, workspace, settings, place: at, navigate: navigateTo, onSwitch, noteIsHere, reloadWorkspaces }: Props) {
  /** The address under /settings when the settings are open over the window. */
  const settingsPath = inSettings(at.path) ? at.path : null;
  /**
   * What the window shows: the address's, or with the settings open, what was in front when they
   * opened, which stays as it was under them. What the editor area puts in front meanwhile, as it does
   * at `/` on a page opened at a settings address, is kept here and not put in the address.
   */
  const under = useRef<Place>(settingsPath ? HOME : at);
  if (!settingsPath) under.current = at;
  const [, redraw] = useState(0);
  const place = settingsPath ? under.current : at;
  const { route } = place;
  const workspaceId = workspace.id;
  const { role } = workspace;
  const canEdit = role !== "viewer";
  const now = useNow();
  const [tree, setTree] = useState<Folders | null>(null);
  /** Every note in the workspace the member can see, in every state: live, archived, and in Trash. */
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  /** What the app is telling the member, such as that a note was moved to Trash. Each has its own identity, so a timer set for one never takes the next away. */
  const [told, tell] = useState<readonly Told[]>([]);
  const toldCount = useRef(0);
  const [listVersion, setListVersion] = useState(0);
  /** In focus the tab in front of the focused group fills the window, over everything else, which stays as it is underneath. Which group that is, the layout already says. */
  const [focusMode, setFocusMode] = useStored(FOCUS_KEY, isBoolean, false);
  const [sidebarOpen, setSidebarOpen] = useStored(SIDEBAR_KEY, isBoolean, true);
  const device = useDevice();
  /** A phone shows one screen at a time. */
  const { phone } = device;
  /** Whether the sidebar is the screen in front on a phone. Going anywhere puts what is there in front instead. */
  const [sidebarInFront, setSidebarInFront] = useState(false);
  /** Going anywhere, even where the member already is, puts it in front of the sidebar. */
  const navigate = useCallback<Navigate>(
    (path, options) => {
      setSidebarInFront(false);
      navigateTo(path, options);
    },
    [navigateTo],
  );
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
  /** What each open note's editor says of saving its note, for the bottom bar to say of the note in front. */
  const [saving, setSaving] = useState<ReadonlyMap<string, { noteId: string; shown: SaveShown }>>(() => new Map());

  const byId = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  /** The notes a listing may cover, and the ones in Trash, which none does. */
  const kept = useMemo(() => notes && notes.filter((n) => n.state !== "trashed"), [notes]);
  const trashed = useMemo(() => (notes ?? []).filter((n) => n.state === "trashed"), [notes]);
  const routeNoteId = route.kind === "note" ? route.id : null;
  const current = (routeNoteId && byId.get(routeNoteId)) || null;
  const routeFolderId = route.kind === "folder" ? route.id : null;
  /** The folder in front: the one whose list is open, or the open note's. A note whose folder the member can't see is among the ones shared with them. */
  const frontFolderId = routeFolderId ?? (current ? (current.folderId ?? SHARED_WITH_ME) : null);

  const appNow = useRef<App>(null!);
  /** What each read of a note said of the uploads it refers to, which is what an embed of one is drawn from. */
  const [referred] = useState(referredUploads);
  /** What the app's own commands do, as of the latest render. */
  const inner = useRef<{ goBy: (by: -1 | 1) => void; step: (type: "note.undo" | "note.redo") => void; save: () => void; toggleFocus: () => void; toggleSidebar: () => void; toggleInspector: () => void }>(null!);
  /** The workspace's record of its plugins, as last read. Null until it has been. */
  const [record, setRecord] = useState<PluginRecord | null>(null);
  const recordNow = useRef(record);
  recordNow.current = record;
  /** What the Plugins page is drawn with, which the page is handed fresh on each drawing of the app. */
  /** Counts each asking and each answer taken, so an answer to an older asking never replaces a newer one. */
  const recordAsked = useRef(0);
  const takeRecord = useCallback((now: PluginRecord) => {
    recordAsked.current++;
    setRecord(now);
  }, []);
  /** The member's own drafts of plugins, as last read. */
  const [drafts, setDrafts] = useState<readonly DraftSummary[]>([]);
  const pluginsPage = useRef({ record, onRecord: takeRecord, drafts, onDrafts: setDrafts });
  pluginsPage.current = { record, onRecord: takeRecord, drafts, onDrafts: setDrafts };
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  const reread = useRef(() => {});
  const relist = useRef(() => {});
  const [installer] = useState(() =>
    createInstaller({
      workspaceId,
      dev: me.dev,
      record: () => recordNow.current,
      drafts: () => draftsNow.current,
      reread: () => reread.current(),
      changed: () => relist.current(),
      // Code that ran in the page is ended only by loading the app again. What is typed is sent first.
      ended: () => loadAgain(saveAll),
    }),
  );
  const panel = useRef<HTMLElement>(null);
  const inspectorBar = useRef<HTMLElement>(null);
  const panelId = useId();
  const [host] = useState(() => {
    let created: Host;
    const account = accountOf(me, workspaceId);
    const agentsFile = createAgentsFileStore({
      read: () => perform(workspaceId, { type: "agentsFile.read" }),
      write: (text, on) => perform(workspaceId, { type: "agentsFile.write", text, ...on }),
    });
    const PluginsPage = ({ app }: { app: App }) => <Plugins host={created} store={settings} workspaceId={workspaceId} personId={me.person.id} adminElsewhere={me.workspaces.some((w) => w.id !== workspaceId && w.role === "admin")} mac={MAC} {...pluginsPage.current} path={app.path} go={app.go} folders={app.folders} />;
    /** What the app itself adds, through the registry the plugins use. It can't be turned off. */
    const core: Plugin = {
      id: "core",
      name: "Common Ink",
      settings: {
        theme: { type: "string", default: "system", enum: ["system", "light", "dark"], title: "Theme", description: "Light or dark, or system to follow this device." },
        ...LOOK_SETTINGS,
        keyboardPluginsOnTouch: {
          type: "boolean",
          default: false,
          title: "Keyboard plugins without a keyboard",
          description: "On a touch screen, plugins that need a keyboard, such as Vim mode, are off until one is connected. Turn this on to keep them on.",
        },
      },
      activate(h) {
        h.commands.register({ id: "notes.all", title: "Open All notes", group: "Navigation", run: () => h.app().openFolder(ALL_NOTES) });
        if (canEdit) {
          h.commands.register({ id: "note.new", title: "New note", group: "Notes", run: () => void h.app().createNote().catch(() => {}) });
          h.commands.register({ id: "history.undo", title: "Undo", keys: ["mod+z"], group: "Editor", leaveToFields: true, run: () => inner.current.step("note.undo") });
          h.commands.register({ id: "note.save", title: "Save now", keys: ["mod+s"], group: "Notes", run: () => inner.current.save() });
          h.commands.register({ id: "history.redo", title: "Redo", keys: ["mod+shift+z", "mod+y"], group: "Editor", leaveToFields: true, run: () => inner.current.step("note.redo") });
        }
        // A browser's own keys for Back and Forward. On a Mac they take ⌘[ and ⌘] from a note, where they would indent, as Tab and Shift+Tab do;
        // elsewhere Ctrl+[ is vim's Escape, so they are Alt and the arrows there.
        h.commands.register({ id: "nav.back", title: "Go back", keys: [MAC ? "mod+[" : "alt+arrowleft"], group: "Navigation", run: () => inner.current.goBy(-1) });
        h.commands.register({ id: "nav.forward", title: "Go forward", keys: [MAC ? "mod+]" : "alt+arrowright"], group: "Navigation", run: () => inner.current.goBy(1) });
        h.commands.register({ id: "view.toggleFocus", title: "Toggle focus", keys: ["mod+."], group: "Navigation", run: () => inner.current.toggleFocus() });
        h.commands.register({ id: "view.toggleSidebar", title: "Toggle sidebar", keys: ["mod+\\"], group: "Navigation", run: () => inner.current.toggleSidebar() });
        h.commands.register({ id: "view.toggleInspector", title: "Toggle inspector", group: "Navigation", run: () => inner.current.toggleInspector() });
      },
    };
    /** Kept apart from the rest so their links and commands come after the plugins', where the others come before. */
    const pages: Plugin = {
      id: "plugins",
      name: "Plugins",
      activate(h) {
        // At an address under /settings they are drawn over the window, and this page is never: see `under`. A tab kept on it from before is told so.
        h.views.register("page", { id: "settings", path: SETTINGS, label: "Settings", nav: "menu", command: { id: "go.settings", title: "Go to settings (UI)" }, component: ({ app }) => <SettingsMoved go={app.go} /> });
        // Its command is `settings.openJson`, so a key a member bound to that opens it.
        h.views.register("page", { id: "settings-json", path: SETTINGS_FILE, label: "Settings (JSON)", command: { id: "settings.openJson", title: "Go to settings (JSON)" }, component: () => <SettingsFile store={settings} host={created} /> });
        h.views.register("page", { id: "agents-file", path: AGENTS_FILE, label: "Agents file", command: { id: "go.agents-file", title: "Go to agents file" }, component: () => <AgentsFile store={agentsFile} host={created} canEdit={role === "admin" || role === "editor"} /> });
        h.views.register("page", { id: "plugins", path: "/plugins", label: "Plugins", icon: "plugin", nav: "more", component: PluginsPage });
      },
    };
    created = createPluginHost({
      // A test puts plugins on the page before the app loads, to try what the host refuses a plugin it doesn't trust. Only where the
      // Worker says tests run: production never reads it. A workspace's own plugins never run in the page: see `remote/`.
      plugins: [core, ...BUILT_INS, ...((me.dev && (window as { __INK_FIXTURE_PLUGINS__?: Plugin[] }).__INK_FIXTURE_PLUGINS__) || []), pages],
      builtIn: [core, ...BUILT_INS, pages].map((p) => p.id),
      required: [core.id, pages.id],
      // Fixture plugins are a test's, and stand for anyone's: they are not among these.
      trusted: [core, ...BUILT_INS, pages],
      settings: documentOf(settings.text()) ?? {},
      // The member's own controls come through here: the Settings and Plugins pages, and the commands that turn a plugin on or off.
      write: (key, value) => settings.set(key, value),
      mac: MAC,
      device,
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
          signOut: (memberId, agents) => perform(workspaceId, { type: "member.signOut", memberId, agents }).then(() => {}),
          invites: () => perform(workspaceId, { type: "invite.list" }),
          revoke: (inviteId) => perform(workspaceId, { type: "invite.revoke", id: inviteId }).then(() => {}),
        },
        sharing: {
          of: (on) => perform(workspaceId, { type: "grant.list", ...on }),
          grant: (on, to, access) => perform(workspaceId, { type: "grant.set", ...on, ...(typeof to === "string" ? { email: to } : to), access }),
          link: (on, link) => perform(workspaceId, { type: "grant.link", ...on, link }),
          revoke: (grantId) => perform(workspaceId, { type: "grant.revoke", id: grantId }).then(() => {}),
          setPrivate: (on, isPrivate) => perform(workspaceId, typeof on === "string" ? { type: "note.setPrivate", id: on, private: isPrivate } : { type: "upload.setPrivate", id: on.uploadId, private: isPrivate }),
          all: () => perform(workspaceId, { type: "grant.list" }).then((all) => all.grants),
        },
        uploads: {
          referred: referred.get,
          onReferred: referred.subscribe,
          learn: referred.learn,
          address: (id) => uploadAddress(workspaceId, id),
          tabAddress: (id) => (me.setup.fileSite ? `${uploadAddress(workspaceId, id)}?open=tab` : null),
          bytes: (id, upTo) => readUpload(uploadAddress(workspaceId, id), upTo),
          send: (file, as, onProgress, onStarted) => sendUpload(workspaceId, file, as, onProgress, onStarted),
        },
        storage: {
          // By member too: two people who share a browser and a workspace don't share what a plugin keeps, such as which notes are open.
          get: (key) => readStored(`ink.plugin.${plugin.id}.${workspaceId}.${me.person.id}.${key}`, isAnything),
          // Null keeps nothing, so nothing is left under the key: what a plugin takes out takes no room.
          set: (key, value) => (value === null || value === undefined ? localStorage.removeItem(`ink.plugin.${plugin.id}.${workspaceId}.${me.person.id}.${key}`) : writeStored(`ink.plugin.${plugin.id}.${workspaceId}.${me.person.id}.${key}`, value)),
        },
      }),
    });
    // The app's own plugins that run shut off are there from the first drawing, as the ones compiled in are, for a guest too, who is told no record.
    created.setInstalled(installer.list());
    return created;
  });
  useEffect(() => {
    let last: string | null = null;
    const read = () => {
      // Once the member's settings are read the plugins are told so even when nothing differs from what they had, as a plugin waiting to change one is.
      const now = `${settings.status().kind === "loading" ? "loading" : "read"} ${settings.text()}`;
      if (now === last) return;
      last = now;
      host.settingsChanged(documentOf(settings.text()) ?? {});
    };
    read();
    return settings.subscribe(read);
  }, [host, settings]);
  // A guest has no record of plugins, and keeps no drafts: each would be refused, and a refusal reads again who the member is.
  const guest = role === "guest";
  const readRecord = useCallback(() => {
    if (guest) return;
    const asked = ++recordAsked.current;
    perform(workspaceId, { type: "plugin.list" }).then(
      (now) => asked === recordAsked.current && setRecord(now),
      () => {},
    );
  }, [workspaceId, guest]);
  useEffect(readRecord, [readRecord]);
  reread.current = readRecord;
  // Drafts that couldn't be read are read again with the record: until they are, a draft set running is not what runs.
  const draftsUnread = useRef(false);
  const readDrafts = useCallback(() => {
    if (guest) return;
    void perform(workspaceId, { type: "draft.list" }).then(
      (mine) => {
        draftsUnread.current = false;
        setDrafts(mine.drafts);
      },
      () => void (draftsUnread.current = true),
    );
  }, [workspaceId, guest]);
  useEffect(readDrafts, [readDrafts]);
  relist.current = () => host.setInstalled(installer.list());
  useEffect(() => host.setInstalled(installer.list()), [host, installer, record, drafts]);
  const contributed = useSyncExternalStore(host.subscribe, host.contributions);
  /** The page the address names: the one at exactly that address, or else the one whose path it is under. */
  const routePage = route.kind === "page" ? pageAt(contributed.views.page, route.path) : undefined;
  /** A page that only leads somewhere else is no tab: it has the editor area's place while it finds where to go. */
  const passing = routePage?.transient ? routePage : undefined;
  const address = place.path + place.query;
  const editorArea = contributed.views.editor.at(-1);
  /**
   * The tab the editor area has in front at an address that names no page: one kept on a page that
   * has gone since, as when its plugin was turned off. It is still that tab, so it is drawn in its
   * row under that page's name and can be closed there.
   */
  const lostPageId = () => {
    const kept = route.kind === "page" ? editorArea?.returnsTo?.() : null;
    return kept?.kind === "page" && kept.path === address ? kept.id : undefined;
  };
  const routePageId = passing ? undefined : (routePage?.id ?? lostPageId());
  /** An address no page is at is opened like one, under its own path as the id no page has, so it says so in a tab beside the ones that are open and never in their place. */
  const nowhere = route.kind === "page" && !routePage && keepsATab(place.path);
  const opened = useMemo<Opened | null>(
    () => (routeNoteId ? { kind: "note", id: routeNoteId } : routeFolderId ? { kind: "folder", id: routeFolderId } : routePageId || nowhere ? { kind: "page", id: routePageId ?? place.path, path: address } : null),
    [routeNoteId, routeFolderId, routePageId, nowhere, address],
  );
  useEffect(() => () => host.dispose(), [host]);
  /** Each embed as registered, but telling the host when it throws while being drawn. One is made per embed, so a drawn embed isn't redrawn when something else changes. */
  const [guarded] = useState(() => new WeakMap<Embed, Embed>());
  const embeds = useMemo(
    () =>
      contributed.embeds.map((embed) => {
        if ("claims" in embed || !embed.render) return embed;
        const guard: Embed = guarded.get(embed) ?? {
          ...embed,
          render(el, written) {
            try {
              return embed.render!(el, written);
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
  const memberSettings = contributed.settings;
  const look = useMemo(
    () => lookOf(memberSettings.values, (key) => Object.hasOwn(memberSettings.document, key) && !memberSettings.problems.some((p) => p.key === key && p.kind === "invalid")),
    [memberSettings],
  );
  const lookKey = JSON.stringify(look);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    for (const [name, value] of Object.entries(look)) root.setProperty(name, value);
    return () => Object.keys(look).forEach((name) => root.removeProperty(name));
    // Set again only when a value differs, not for every new copy of the settings.
  }, [lookKey]);
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

  /**
   * How many first listings of the folders, and of the notes, have failed in a row. A listing that
   * fails once there is one, as a request can under load, is asked for again at the next refresh, and
   * leaves what was listed as it was. Until there is one, it is asked for again sooner, waiting longer each time.
   */
  const [unlisted, setUnlisted] = useState({ folders: 0, notes: 0 });
  const failedFirst = (what: "folders" | "notes") => setUnlisted((was) => ({ ...was, [what]: was[what] + 1 }));
  const listedTree = useRef(tree);
  listedTree.current = tree;
  const loadFolders = useCallback(
    () =>
      perform(workspaceId, { type: "folder.list" }).then(
        (r) => setTree(folderTree(r)),
        () => !listedTree.current && failedFirst("folders"),
      ),
    [workspaceId],
  );
  useEffect(() => void loadFolders(), [loadFolders]);

  useEffect(() => {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (here !== me.timeZone) perform(workspaceId, { type: "timeZone.record", timeZone: here }).catch(() => {});
  }, [workspaceId, me.timeZone]);

  const listedNotes = useRef(notes);
  listedNotes.current = notes;
  /** Notes loaded, saved, or created since the last listing was asked for, which its answer can't know. */
  const learned = useRef(new Map<string, NoteSummary>());
  /** Notes that were read before the listing arrived. The note is drawn from its own read, and what is said above it (its breadcrumbs) needs its summary, so it is held here until the listing can say it. */
  const [early, setEarly] = useState<ReadonlyMap<string, NoteSummary>>(new Map());
  useEffect(() => {
    let live = true;
    const since = (learned.current = new Map());
    Promise.all([everyNote(workspaceId), everyTrashed(workspaceId)]).then(
      ([kept, trash]) => {
        if (!live) return;
        const { notes: listed, gone: lost } = relisted(kept, trash, listedNotes.current, since);
        const there = new Set(listed.map((n) => n.id));
        setGone((was) => {
          const now = [...was, ...lost].filter((id) => !there.has(id));
          return now.length === was.size && !lost.length ? was : new Set(now);
        });
        setNotes(listed);
      },
      () => live && !listedNotes.current && failedFirst("notes"),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, listVersion]);
  useEffect(() => {
    if (!unlisted.folders || tree) return;
    const timer = setTimeout(loadFolders, retryAfter(unlisted.folders));
    return () => clearTimeout(timer);
  }, [unlisted.folders, tree, loadFolders]);
  useEffect(() => {
    if (!unlisted.notes || notes) return;
    const timer = setTimeout(() => setListVersion((v) => v + 1), retryAfter(unlisted.notes));
    return () => clearTimeout(timer);
  }, [unlisted.notes, notes]);

  const refresh = useCallback(async () => {
    setListVersion((v) => v + 1);
    await loadFolders();
  }, [loadFolders]);

  // A recurring todo checked off anywhere in the app is filed on a daily note, which may be new, in a folder that may be new.
  useEffect(() => onFiled(refresh), [refresh]);

  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      readRecord();
      if (draftsUnread.current) readDrafts();
    };
    const timer = setInterval(again, REFRESH_ALL_MS);
    addEventListener("focus", again);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", again);
    };
  }, [refresh, readRecord, readDrafts]);

  useEffect(() => {
    const relist = async () => {
      const known = listedNotes.current;
      if (document.visibilityState !== "visible" || !known) return;
      // A note moved to Trash since is in no listing but Trash's own.
      const [changed, trash] = await Promise.all([
        everyNote(workspaceId, lastChange(known)).catch(() => []),
        everyTrashed(workspaceId).catch(() => []),
      ]);
      setNotes((all) => all && withChanged([...changed, ...trash], all));
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
      // A read says what the note's uploads are, before the editor that draws them is made.
      if ("uploads" in note) referred.learn((note as Results["note.read"]).uploads);
      const summary = summaryOf(note);
      // Before the app goes to a note it has just made, so it doesn't stop to ask where the note is.
      noteIsHere(note.id, workspaceId);
      learned.current.set(note.id, summary);
      if (!listedNotes.current) setEarly((was) => new Map(was).set(note.id, summary));
      setNotes((all) => all && [summary, ...all.filter((n) => n.id !== note.id)]);
      setGone((was) => (was.has(note.id) ? new Set([...was].filter((id) => id !== note.id)) : was));
      if (location.pathname.startsWith("/note/") && location.pathname.endsWith(note.id)) navigate(notePath(note), { replace: true });
    },
    [navigate, noteIsHere, workspaceId, referred],
  );

  /** A save was refused because its note is in Trash, which the app hadn't heard. It reads the note, and sends the typing after all if the note is back by then. */
  const learnTrashed = useCallback(
    (noteId: string) =>
      void perform(workspaceId, { type: "note.read", id: noteId }).then(
        (note) => {
          remember(note);
          if (note.state !== "trashed") void saveNow(noteId);
        },
        () => {},
      ),
    [workspaceId, remember],
  );

  const byIdNow = useRef(byId);
  byIdNow.current = byId;
  const show = useCallback(
    (tab: Opened | null, how: { replace?: boolean; move?: boolean } = {}) => {
      if (inSettings(location.pathname)) {
        const path = !tab ? "/" : tab.kind === "folder" ? folderPath(tab.id) : tab.kind === "page" ? tab.path : pathTo(byIdNow.current, tab.id);
        under.current = placeAt(path);
        return redraw((n) => n + 1);
      }
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
    perform(workspaceId, { type: "history.list", noteIds: [currentId], diffs: false, limit: 100 }).then(
      ({ changes }) => {
        const theirs = changes.find((c) => c.author.kind !== "member" || c.author.personId !== me.person.id);
        if (live) setOthers({ noteId: currentId, revision: theirs?.revision ?? 0 });
      },
      // Unchecked, so the member's own next change looks again.
      () => {
        if (live) checked.current = null;
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, currentId, currentRevision, me.person.id]);
  const unseen = !!current && others?.noteId === current.id && others.revision > (seen[current.id] ?? 0);

  const toggleFocus = useCallback(() => setFocusMode((on) => !on), [setFocusMode]);
  const toggleSidebar = useCallback(() => (phone ? setSidebarInFront((front) => !front) : setSidebarOpen((open) => !open)), [phone, setSidebarOpen]);
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
  const openNote = (noteId: string, options: { preview?: boolean; focus?: boolean; background?: boolean; here?: boolean } = {}) => {
    const area = host.contributions().views.editor.at(-1);
    const here = options.here ? { here: true } : {};
    if (options.background && area?.open) return area.open({ kind: "note", id: noteId }, { preview: false, background: true, ...here });
    setToFocus(options.focus ? noteId : null);
    if (area?.open) area.open({ kind: "note", id: noteId }, { preview: options.preview ?? false, ...here });
    else show({ kind: "note", id: noteId });
  };
  const openFolder = (folderId: string, options: { preview?: boolean } = {}) => {
    const area = host.contributions().views.editor.at(-1);
    if (area?.open) area.open({ kind: "folder", id: folderId }, { preview: options.preview ?? true });
    else show({ kind: "folder", id: folderId });
  };

  const openBeside = (tab: Opened, side: "right" | "down") => host.contributions().views.editor.at(-1)?.split?.(tab, side);

  /** Where the member has been, kept in this browser, which Go back and Go forward walk. Settings is a place to change things from and no place in it. */
  const travelsKey = `ink.travels.${workspaceId}.${me.person.id}`;
  const travels = useRef<Travels>(null!);
  travels.current ??= keptTravels(readStored(travelsKey, isAnything));
  const travel = useCallback(
    (step: Travel | Travels) => {
      const next = "type" in step ? travelled(travels.current, step) : step;
      if (next === travels.current) return;
      travels.current = next;
      writeStored(travelsKey, next);
    },
    [travelsKey],
  );
  /** What is in front: at `/`, the tab the editor area goes to there, or else the home page, which is drawn at that address. */
  const homeId = contributed.views.page.find((p) => p.home)?.id;
  const atHome = route.kind === "home" ? (editorArea?.returnsTo?.() ?? (homeId ? { kind: "page", id: homeId, path: "/" } : null)) : null;
  const homeKey = atHome && `${atHome.kind} ${atHome.id} ${atHome.kind === "page" ? atHome.path : ""}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inFront = useMemo<Opened | null>(() => opened ?? atHome, [opened, homeKey]);
  const inHistory = inFront && !(inFront.kind === "page" && inFront.id === "settings") ? inFront : null;
  useEffect(() => {
    if (!inHistory) return;
    const leaving = travels.current.stops[travels.current.at]?.place;
    travel({ type: "arrive", place: inHistory, left: leaving?.kind === "note" ? cursorIn(leaving.id) : null });
  }, [inHistory, travel]);
  useEffect(
    () =>
      onNoteMoves({
        jumped: (noteId, { from, to }) => travel({ type: "jump", noteId, from, to }),
        changed: (noteId, changes) => travel({ type: "edit", noteId, map: (at) => changes.mapPos(at) }),
      }),
    [travel],
  );
  const canGo = (place: Opened) =>
    place.kind === "note"
      ? (byId.get(place.id)?.state ?? "trashed") !== "trashed"
      : place.kind === "folder"
        ? !tree || folderTitle(tree, place.id) !== null
        : contributed.views.page.some((p) => p.id === place.id);
  /** Goes back (-1) or forward (1) through where the member has been: to another note, list or page, or to where the cursor was in a note. */
  const goBy = (by: -1 | 1) => {
    // With the settings open the member is away from the place under them, as on any page left out of the history: Back closes them and
    // returns there, and Forward closes them and goes on.
    const front = settingsPath ? null : inFront;
    const here = front?.kind === "note" ? cursorIn(front.id) : null;
    const was = travels.current.at;
    const next = stepped(travels.current, by, front, here, canGo);
    if (settingsPath) navigate(under.current.path + under.current.query, { replace: true });
    if (next === travels.current || (settingsPath && next.at === was)) return;
    travel(next);
    const { place, cursor } = next.stops[next.at]!;
    if (place.kind === "note") {
      if (cursor !== null) putCursor(place.id, cursor);
      if (!samePlace(place, inFront)) openNote(place.id, { preview: true, focus: true });
    } else if (place.kind === "folder") openFolder(place.id, { preview: true });
    else {
      const area = host.contributions().views.editor.at(-1);
      if (area?.open) area.open(place, { preview: true });
      else show(place);
    }
  };

  const createNote = async (folderId?: string, { open = true }: { open?: boolean } = {}) => {
    const note = await perform(workspaceId, { type: "note.create", folderId: (folderId === undefined ? newNoteFolderId : folderForNew(folderId)) ?? undefined });
    void loadFolders();
    remember(note);
    if (open) openNote(note.id);
    return note.id;
  };

  /** A note no tab holds now. One the member made and never wrote in is removed, once what was typed in it is sent and its editor has gone: the server decides, and refuses any other. */
  const left = (noteId: string) => {
    const note = byIdNow.current.get(noteId);
    if (!note || note.title !== "" || note.access !== "edit" || note.state === "trashed") return;
    setTimeout(() => {
      if (isOpen(noteId)) return;
      void commitTyping([noteId])
        .then(async () => (isOpen(noteId) || (await openInAnotherTab(noteId)) ? null : perform(workspaceId, { type: "note.discard", id: noteId })))
        .then(
          (done) => {
            if (!done) return;
            setNotes((all) => all && all.filter((n) => n.id !== noteId));
            learned.current.delete(noteId);
          },
          () => {},
        );
    });
  };
  /** Without an editor area that says which notes it holds, a note is left when the address goes elsewhere. */
  const lastRouteNote = useRef(routeNoteId);
  useEffect(() => {
    const was = lastRouteNote.current;
    lastRouteNote.current = routeNoteId;
    if (!editorArea && was && was !== routeNoteId) actions.left(was);
  });

  const moveNote = useCallback(
    async (id: string, folderId: string) => {
      const moved = summaryOf(await perform(workspaceId, { type: "note.move", id, folderId }));
      setNotes((all) => all && all.map((n) => (n.id === id ? moved : n)));
      refresh();
    },
    [workspaceId, refresh],
  );

  const step = (type: "note.undo" | "note.redo") => {
    if (!routeNoteId) {
      // Text that is no note, such as the settings JSON, has its editor's own history and no other.
      const editor = document.activeElement instanceof HTMLElement ? EditorView.findFromDOM(document.activeElement) : null;
      if (editor) (type === "note.undo" ? undo : redo)(editor);
      return;
    }
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

  inner.current = { goBy, step, save: () => routeNoteId && void saveNow(routeNoteId), toggleFocus, toggleSidebar, toggleInspector };

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
      // A press in a plugin frame is the frame's to give back. Handling it here as well would step back twice.
      if (e.target instanceof HTMLIFrameElement) return;
      // A press in the keyboard shortcuts table's recorder is a key to write down, and one in a drawing's editor is Excalidraw's, not one to run.
      if (e.target instanceof Element && e.target.closest("[data-records-keys], [data-keeps-keys]")) return;
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
  // Back and Forward arrive without going through `navigate`.
  useEffect(() => setSidebarInFront(false), [place.path, place.query]);
  useLayoutEffect(() => host.deviceChanged({ phone: device.phone, touch: device.touch, keyboard: device.keyboard }), [host, device.phone, device.touch, device.keyboard]);
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
    left,
    saveNote: async (noteId: string) => saveNow(noteId),
    markSeen,
    toggleOverlay: (id: string, state?: unknown) => setOverlay((open) => (open?.id === id ? null : { id, state })),
    notify: (notice: Notice) => {
      const id = ++toldCount.current;
      tell((shown) => stacked(shown, { id, notice: { ...notice } }));
      return () => tell((shown) => shown.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    },
    openTabs: () => {
      const area = host.contributions().views.editor.at(-1);
      return area?.tabs ? area.tabs() : appNow.current.opened ? [{ opened: appNow.current.opened, pane: 1 }] : [];
    },
    recent: () => travels.current.recent,
    toggleSidebar,
    togglePanel,
    inspect: (_: Showing | null) => {},
    setFocus: setFocusMode,
    switchWorkspace: onSwitch,
    reloadWorkspaces: () => void reloadWorkspaces(),
    signOut: () => void signOut().then(() => location.assign("/")),
  });
  // Before any editor reads its note, so the read includes what an earlier page kept for it.
  useLayoutEffect(() => {
    const stop = onLost(workspaceId, ({ noteId, text, why, dismiss }) => {
      const title = summarize(text).title || "Untitled";
      // It holds the only copy of what was typed, so it goes only by its own buttons.
      const lost: Notice = {
        message: why === "inTrash" ? `${title} is in Trash, so it wasn't saved as you left it.` : `${title} wasn't saved as you left it.`,
        icon: why === "inTrash" ? "trash" : "flag",
        stays: true,
        keeps: true,
        action: [
          { label: "Copy", run: () => navigator.clipboard.writeText(text).then(() => ({ ...lost, message: `Copied ${title} as you left it.` }), () => lost) },
          {
            label: "Open note",
            run: () => {
              actions.openNote(noteId);
              return lost;
            },
          },
          { label: "Dismiss", run: () => dismiss() },
        ],
      };
      actions.notify(lost);
    });
    recover(workspaceId, me.person.id);
    return stop;
  }, [actions, workspaceId, me.person.id]);
  const app: App = {
    me: me.person,
    workspace,
    workspaces: me.workspaces,
    canEdit,
    canCreateNote,
    path: place.path,
    query: place.query,
    pageState: place.state,
    opened,
    noteId: routeNoteId,
    note: current,
    unseen,
    notes: kept,
    trashed,
    folders: tree,
    listingFailed: (unlisted.notes > 0 && !notes) || (unlisted.folders > 0 && !tree),
    folderId: frontFolderId,
    focus: focusMode,
    // On a phone the sidebar is a screen of its own, drawn whole whenever it is in front.
    sidebarOpen: phone || sidebarOpen,
    pages: contributed.views.page.toSorted((a, b) => (a.order ?? UNPLACED) - (b.order ?? UNPLACED)),
    sections: null,
    sectionNames: contributed.views.section.flatMap(({ id, label, icon }) => (label && icon ? [{ id, label, icon }] : [])),
    sectionsOpening: () => null,
    readNote: () => null,
    readMarkdown: (text) => <MarkdownReader text={text} />,
    overlay: overlay?.id ?? null,
    ...actions,
    openBeside: contributed.views.editor.at(-1)?.split ? actions.openBeside : null,
  };
  appNow.current = app;
  const page = route.kind === "page" ? contributed.views.page.find((p) => p.path === route.path) : undefined;
  /** The bottom bar's items, lowest order first. Sorting keeps those of one order as the plugins added them. */
  const bar = useMemo(() => [...contributed.views.bar].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [contributed.views.bar]);
  const tools = useMemo(() => [...contributed.views.tool].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)), [contributed.views.tool]);
  const saved = [...saving.values()].findLast((s) => s.noteId === routeNoteId)?.shown;
  const shownOverlay = contributed.views.overlay.find((o) => o.id === overlay?.id);
  /** What the app tells the member, drawn inside the settings while they are open, where it is above them. */
  const toasts = <Toasts told={told} onGone={(id) => tell((shown) => shown.filter((t) => t.id !== id))} />;
  const overlayDrawn = shownOverlay && <Drawn key={shownOverlay.id} host={host} view={shownOverlay} close={closeOverlay} state={overlay?.state} />;

  /** The sections, each told when it opens something if the place they are drawn in wants to know. */
  const sections = (opened?: () => void, only?: string) =>
    contributed.views.section.flatMap((section) => {
      if (only !== undefined && section.id !== only) return [];
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
      return name === null ? { kind: "nothing" } : { kind: "folder", folderId: routeFolderId, name, notes: notes.filter((n) => n.state === "live" && (routeFolderId === ALL_NOTES || n.folderId === routeFolderId)) };
    }
    const shows = routePageId ? said.get(routePageId) : undefined;
    if (!shows) return { kind: "nothing" };
    if (!notes) return null;
    if (shows.kind === "notes") return { kind: "notes", label: shows.label, notes: shows.noteIds.flatMap((id) => byId.get(id) ?? []) };
    const note = byId.get(shows.noteId);
    return note ? { kind: "note", note } : { kind: "nothing" };
  })();

  const summaryFor = (noteId: string) => byId.get(noteId) ?? (notes ? undefined : early.get(noteId));
  const renderNote = (noteId: string, { onEdit, focus, onFocused, behind }: { onEdit?: () => void; focus?: boolean; onFocused?: () => void; behind?: boolean } = {}) => {
    const note = summaryFor(noteId);
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
        focus={(toFocus === noteId && !behind) || !!focus}
        onFocused={() => {
          setToFocus(null);
          onFocused?.();
        }}
        access={note?.access}
        state={note?.state}
        gone={gone.has(noteId)}
        onRejected={(why) => (why === "inTrash" ? learnTrashed(noteId) : refresh())}
        embeds={embeds}
        completions={contributed.completions}
        onContributionFailed={host.fail}
        extensions={extensions}
        onExtensionRefused={host.fail}
        marks={note && contributed.views.mark.map((mark) => <Drawn key={mark.id} host={host} view={mark} note={note} />)}
        onSaveShown={(editor, shown) =>
          setSaving((was) => {
            const next = new Map(was);
            if (shown) next.set(editor, { noteId, shown });
            else next.delete(editor);
            return next;
          })
        }
        live={
          focusMode &&
          !phone &&
          bar
            .filter((item) => item.live)
            .map((item) => (
              <span key={item.id} className="bar-item" data-bar-item={item.id}>
                <Drawn host={host} view={item} />
              </span>
            ))
        }
        above={
          note &&
          contributed.views.notice.map((notice) => (
            <Drawn key={notice.id} host={host} view={notice} note={note} />
          ))
        }
      />
    );
  };

  /** An open note's own buttons at its top right, before Focus: those the plugins put in the `tool` slot, lowest order first. */
  const renderNoteTools = (noteId: string) => {
    const note = summaryFor(noteId);
    if (!note || !tools.length) return null;
    return (
      <span className="note-tools">
        {tools.map((tool) => (
          <Drawn key={tool.id} host={host} view={tool} note={note} />
        ))}
      </span>
    );
  };

  const readNote = (noteId: string) => (
    <NoteReader key={noteId} workspaceId={workspaceId} noteId={noteId} revision={byId.get(noteId)?.revision} embeds={embeds} extensions={extensions} onRead={(note) => referred.learn(note.uploads)} />
  );
  app.readNote = readNote;
  const folderView = contributed.views.folder.at(-1);
  const renderFolder = (folderId: string) => {
    const plain = <FolderNotes folderId={folderId} folders={tree} notes={kept} pathOf={(id) => pathTo(byId, id)} onOpen={(id) => openNote(id, { preview: true })} />;
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
    const cut = path.indexOf("?");
    const at = { path: cut < 0 ? path : path.slice(0, cut), query: cut < 0 ? "" : path.slice(cut), pageState: here ? place.state : null };
    return (
      <div className="page-pane" key={page.tabAt ? `${page.id} ${page.tabAt(at.path).key}` : page.id}>
        <Drawn host={host} view={page} as={(app) => ({ ...app, ...at, opened: { kind: "page", id: pageId, path }, noteId: null, note: null, unseen: false, folderId: null, inspect: inspectFor(pageId) })} />
      </div>
    );
  };
  const home = contributed.views.page.find((p) => p.home);
  const empty = <p className="notice">Pick a note, or start a new one.</p>;
  /**
   * What the address names alone, for when no plugin fills the editor area or the one that does
   * throws. At `/` it is every note, so there is a way to a note whatever is turned off.
   */
  const loneEditor = (
    <div className="groups" data-focus-mode={(focusMode && !phone) || undefined}>
      <section className="group" data-front="">
        {!phone && (
          <div className="tab-row">
            {routeNoteId && renderNoteTools(routeNoteId)}
            <button type="button" className="icon-button focus-button" aria-label="Focus" title={`${focusMode ? "Leave focus" : "Focus"} (${shortcut("view.toggleFocus")})`} aria-pressed={focusMode} onClick={toggleFocus}>
              <Icon name="focus" />
            </button>
          </div>
        )}
        <div className="group-body">
          {routeNoteId ? renderNote(routeNoteId) : routeFolderId ? renderFolder(routeFolderId) : opened?.kind === "page" ? renderPage(opened.id, opened.path) : home ? renderPage(home.id, "/") : renderFolder(ALL_NOTES)}
        </div>
      </section>
    </div>
  );

  /** Focus is of a group, and the way out of it is in that group. With none drawn the window stays whole, so nothing is hidden with no way back. */
  const focusable = (!!editorArea || !passing) && !phone;

  const up = upFrom(route, current ? current.folderId : routeNoteId ? undefined : null, tree);
  const goUp = () => (up.to === "sidebar" ? setSidebarInFront(true) : navigate(folderPath(up.folderId)));
  const frontTitle = route.kind === "note" ? null : routeFolderId ? ((tree && folderTitle(tree, routeFolderId)) ?? "") : ((page ?? home)?.label ?? "");
  const inspector = inspectorViews.length > 0 && (
    <>
      {shownView && <InspectorPanel ref={panel} id={panelId} host={host} view={shownView} subject={subject} pinned={side.pinned} onPin={() => act({ type: "pin" })} />}
      <InspectorBar ref={inspectorBar} views={inspectorViews} app={app} shown={shownPanel} panelId={panelId} onPick={togglePanel} />
    </>
  );

  const account = accountOf(me, workspaceId);

  return (
    <div className="app" data-phone={phone || undefined} data-sidebar-in-front={(phone && sidebarInFront) || undefined} data-keys={(phone && device.covered > 0) || undefined} data-focus-mode={(focusMode && focusable) || undefined} data-bar={(!phone && (bar.length > 0 || !!saved)) || undefined} style={{ "--sidebar-width": `${sidebarWidth}px`, "--inspector-width": `${inspectorWidth}px`, "--covered": `${device.covered}px` } as CSSProperties}>
      {(!phone || sidebarInFront) &&
        contributed.views.column.map((column) => (
          <Drawn key={column.id} host={host} view={column} />
        ))}
      {!phone && contributed.views.column.length > 0 && (
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

      <main className="main" aria-label="Editor" inert={(phone && sidebarInFront) || undefined}>
        {phone && (
          <TopBar
            up={up}
            onUp={goUp}
            title={frontTitle}
            tools={routeNoteId && renderNoteTools(routeNoteId)}
            inspector={inspectorViews.length > 0 ? { open: layout !== "closed", toggle: toggleInspector } : null}
            failed={saved?.failed ? saved.label : null}
          />
        )}
        {passing && (
          <div className="passing">
            <Drawn key={passing.id} host={host} view={passing} />
          </div>
        )}
        {/* The editor area stays as it is under a page that only leads somewhere else, out of sight, so no open editor or embed is made again. */}
        {editorArea ? (
          <div className="editor-area" data-under={passing ? "" : undefined}>
            <Drawn key={editorArea.id} host={host} view={editorArea} renderNote={renderNote} renderNoteTools={renderNoteTools} renderFolder={renderFolder} renderPage={renderPage} empty={empty} fallback={loneEditor} />
          </div>
        ) : (
          !passing && loneEditor
        )}
      </main>

      {phone && layout !== "closed" && (
        // The inspector is a sheet from the bottom on a phone, its panels as tabs along its top, with the page still in view above it.
        <>
          <div className="phone-scrim" aria-hidden="true" onPointerDown={() => act({ type: "fold", folded: true })} />
          <div className="phone-sheet">{inspector}</div>
        </>
      )}
      {phone && !sidebarInFront && !settingsPath && !device.covered && canEdit && <NewNoteButton onCreate={() => void createNote().catch((err: Error) => app.notify({ message: err.message }))} refused={canCreateNote ? null : "Open a folder you can change to add a note to it"} />}
      {phone && device.covered > 0 && <KeyRow covered={device.covered} run={(id) => host.run(id)} has={(id) => contributed.commands.some((c) => c.id === id)} />}
      {!phone && inspectorViews.length > 0 && (
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
          {inspector}
        </>
      )}
      {!phone && (bar.length > 0 || saved) && (
        <div className="bar" role="group" aria-label="Bottom bar">
          {(["left", "right"] as const).map((side) => (
            <div key={side} className="bar-side" data-side={side}>
              {side === "right" && saved && (
                <span className="bar-item save-state" role="status" data-failed={saved.failed || undefined}>
                  {saved.label}
                </span>
              )}
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
      {settingsPath && (
        <Settings
          host={host}
          store={settings}
          mac={MAC}
          path={settingsPath}
          go={navigate}
          storage={() => perform(workspaceId, { type: "upload.storage" })}
          exportPlan={() => perform(workspaceId, { type: "export.plan" })}
          account={account}
          folders={tree}
          onClose={() => navigate(under.current.path + under.current.query, { replace: true })}
        >
          {overlayDrawn}
          {toasts}
        </Settings>
      )}
      {!settingsPath && overlayDrawn}
      {!settingsPath && toasts}
    </div>
  );
}
