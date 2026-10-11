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
import { lastChange, relisted, withChanged } from "./knownNotes.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { NoteReader } from "./NoteReader.tsx";
import { ALL_NOTES, SHARED_WITH_ME, folderTitle, type App, type Embed, type Folders, type Notice, type Opened, type Plugin } from "./plugin-api.ts";
import { createPluginHost, type Host } from "./pluginHost.ts";
import { BUILT_INS } from "./plugins/index.ts";
import { Plugins } from "./Plugins.tsx";
import { folderPath, type Navigate, type Place } from "./router.ts";
import { documentOf } from "./settings.ts";
import { Settings } from "./Settings.tsx";
import type { SettingsStore } from "./settingsStore.ts";
import { isBoolean, readStored, useStored, writeStored } from "./stored.ts";
import { onFiled, performInSync, saveNow, undoOrRedo } from "./sync.ts";
import { ago, useNow } from "./time.ts";

type Popover = { side: "left" } | { side: "right"; tab: string };
/** Writing mode collapses both sides to rails; a rail opens its panel as a popover over the editor. */
type Layout = { writing: false } | { writing: true; popover: Popover | null };

const BROWSING: Layout = { writing: false };
const WRITING: Layout = { writing: true, popover: null };
const WRITING_KEY = "ink.writing";
const INSPECTOR_KEY = "ink.inspector";
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
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

const popoverKey = (p: Popover | null) => (p ? (p.side === "left" ? "left" : p.tab) : null);

const summaryOf = ({ text: _, ...summary }: Note): NoteSummary => summary;

const pathTo = (byId: ReadonlyMap<string, NoteSummary>, id: string) => {
  const note = byId.get(id);
  return note ? notePath(note) : `/note/${id}`;
};

/** How long a notice stays when the member does nothing about it. Long enough to read it and reach its button. */
const NOTICE_MS = 10_000;

/** Functions that stay the same from one render to the next, each calling the latest one it was handed. */
function useLatest<T extends Record<string, (...args: never[]) => unknown>>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  return useState(() => Object.fromEntries(Object.keys(fns).map((name) => [name, (...args: never[]) => latest.current[name]!(...args)])) as T)[0];
}

/** A notice at the foot of the app. It waits while the pointer or the keyboard is on it, so its button can be reached. */
function Toast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const [held, hold] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (held || notice.stays) return;
    const timer = setTimeout(() => close.current(), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, held]);
  const { action } = notice;
  return (
    <div className="toast" role="group" aria-label="Notice" onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)} onFocus={() => hold(true)} onBlur={() => hold(false)}>
      <span>{notice.message}</span>
      {action && (
        <button
          type="button"
          className="button small"
          onClick={() => {
            onClose();
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
      <button type="button" className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
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
      <ul>
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
  const { role } = workspace;
  const canEdit = role !== "viewer";
  const now = useNow();
  const [tree, setTree] = useState<Folders | null>(null);
  /** Every note in the workspace the member can see, in every state: live, archived, and in Trash. */
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  /** What the app is telling the member, such as that a note was moved to Trash. Each has its own identity, so a timer set for one never takes the next away. */
  const [told, tell] = useState<Notice | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [layout, setLayout] = useState<Layout>(() => (readStored(WRITING_KEY, isBoolean) ? WRITING : BROWSING));
  const [inspectorOpen, setInspectorOpen] = useStored(INSPECTOR_KEY, isBoolean, true);
  const [overlay, setOverlay] = useState<{ id: string; state: unknown } | null>(null);
  /** Notes the member could see that a later listing left out: hidden from them, or gone. An editor still open on one stops showing it. */
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  /** An undo or redo that didn't happen, and why, shown on its note until the member's next step. */
  const [stuck, setStuck] = useState<{ noteId: string; message: string } | null>(null);

  const byId = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  /** The notes a listing may cover, and the ones in Trash, which none does. */
  const kept = useMemo(() => notes && notes.filter((n) => n.state !== "trashed"), [notes]);
  const trashed = useMemo(() => (notes ?? []).filter((n) => n.state === "trashed"), [notes]);
  const routeNoteId = route.kind === "note" ? route.id : null;
  const current = (routeNoteId && byId.get(routeNoteId)) || null;
  const routeFolderId = route.kind === "folder" ? route.id : null;
  const opened = useMemo<Opened | null>(() => (routeNoteId ? { kind: "note", id: routeNoteId } : routeFolderId ? { kind: "folder", id: routeFolderId } : null), [routeNoteId, routeFolderId]);
  /** The folder in front: the one whose list is open, or the open note's. A note whose folder the member can't see is among the ones shared with them. */
  const frontFolderId = routeFolderId ?? (current ? (current.folderId ?? SHARED_WITH_ME) : null);

  const appNow = useRef<App>(null!);
  const lastNoteId = useRef<string | null>(null);
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
        h.commands.register({ id: "notes.all", title: "Open All notes", run: () => h.app().openFolder(ALL_NOTES) });
        if (canEdit) {
          h.commands.register({ id: "note.new", title: "New note", run: () => void h.app().createNote().catch(() => {}) });
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
      // Fixture plugins are a test's, and stand for anyone's: they are not among these.
      trusted: [core, ...BUILT_INS, pages],
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
        sharing: {
          of: (on) => perform(workspaceId, { type: "grant.list", ...on }),
          grant: (on, to, access) => perform(workspaceId, { type: "grant.set", ...on, ...(typeof to === "string" ? { email: to } : to), access }),
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

  const listedNotes = useRef(notes);
  listedNotes.current = notes;
  /** Notes loaded, saved, or created since the last listing was asked for, which its answer can't know. */
  const learned = useRef(new Map<string, NoteSummary>());
  useEffect(() => {
    let live = true;
    const since = (learned.current = new Map());
    Promise.all([perform(workspaceId, { type: "note.list", includeArchived: true }), perform(workspaceId, { type: "trash.list" })]).then(([kept, trash]) => {
      if (!live) return;
      const { notes: listed, gone: lost } = relisted(kept, trash, listedNotes.current, since);
      const there = new Set(listed.map((n) => n.id));
      setGone((was) => {
        const now = [...was, ...lost].filter((id) => !there.has(id));
        return now.length === was.size && !lost.length ? was : new Set(now);
      });
      setNotes(listed);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, listVersion]);

  const refresh = useCallback(() => {
    void loadFolders();
    setListVersion((v) => v + 1);
  }, [loadFolders]);

  // A recurring todo checked off anywhere in the app is filed on a daily note, which may be new, in a folder that may be new.
  useEffect(() => onFiled(refresh), [refresh]);

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
      // A note moved to Trash since is in no listing but Trash's own.
      const [changed, trash] = await Promise.all([
        perform(workspaceId, { type: "note.list", includeArchived: true, updatedSince: lastChange(known) }).catch(() => []),
        perform(workspaceId, { type: "trash.list" }).catch(() => []),
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
    (tab: Opened | null, { replace = false }: { replace?: boolean } = {}) => {
      if (!tab) navigate("/");
      else if (tab.kind === "folder") navigate(folderPath(tab.id), { replace });
      // A note's address may be written with an older title, and is still the note's.
      else if (noteIdFromPath(location.pathname) !== tab.id) navigate(pathTo(byIdNow.current, tab.id), { replace });
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

  const closePopover = useCallback(() => setLayout((l) => (l.writing ? WRITING : l)), []);
  const toggleWriting = useCallback(() => setLayout((l) => (l.writing ? BROWSING : WRITING)), []);
  const togglePopover = (p: Popover) => setLayout((l) => (l.writing ? { writing: true, popover: popoverKey(l.popover) === popoverKey(p) ? null : p } : l));
  const toggleInspector = () => {
    const last = host.contributions().views.inspector.at(-1);
    if (!layout.writing) setInspectorOpen(!inspectorOpen);
    else if (last) togglePopover({ side: "right", tab: last.id });
  };
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

  useEffect(() => writeStored(WRITING_KEY, layout.writing), [layout.writing]);

  const go = (path: string, options: { state?: unknown; replace?: boolean } = {}) => {
    navigate(path, options);
    closePopover();
  };

  /** The note whose editor is to take the cursor once it is there. */
  const [toFocus, setToFocus] = useState<string | null>(null);
  const openNote = (noteId: string, options: { preview?: boolean; focus?: boolean; background?: boolean } = {}) => {
    const area = host.contributions().views.editor.at(-1);
    if (options.background && area?.open) return area.open({ kind: "note", id: noteId }, { preview: false, background: true });
    setToFocus(options.focus ? noteId : null);
    if (area?.open) area.open({ kind: "note", id: noteId }, { preview: options.preview ?? false });
    else show({ kind: "note", id: noteId });
    closePopover();
  };
  const openFolder = (folderId: string, options: { preview?: boolean } = {}) => {
    const area = host.contributions().views.editor.at(-1);
    if (area?.open) area.open({ kind: "folder", id: folderId }, { preview: options.preview ?? true });
    else show({ kind: "folder", id: folderId });
    closePopover();
  };

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
    openFolder,
    folderPath,
    show,
    createNote,
    moveNote,
    noteChanged: remember,
    refresh,
    saveNote: (noteId: string) => void saveNow(noteId),
    markSeen,
    toggleOverlay: (id: string, state?: unknown) => setOverlay((open) => (open?.id === id ? null : { id, state })),
    notify: (notice: Notice) => tell({ ...notice }),
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
    query: place.query,
    pageState: place.state,
    opened,
    noteId: routeNoteId,
    note: current,
    unseen,
    notes: kept,
    trashed,
    folders: tree,
    folderId: frontFolderId,
    writing: layout.writing,
    pages: contributed.views.page.toSorted((a, b) => (a.order ?? UNPLACED) - (b.order ?? UNPLACED)),
    sections: null,
    readNote: () => null,
    overlay: overlay?.id ?? null,
    ...actions,
  };
  appNow.current = app;
  const page = route.kind === "page" ? contributed.views.page.find((p) => p.path === route.path) ?? contributed.views.page.find((p) => route.path.startsWith(`${p.path}/`)) : undefined;
  const shownOverlay = contributed.views.overlay.find((o) => o.id === overlay?.id);

  const editorArea = contributed.views.editor.at(-1);
  app.sections = contributed.views.section.map((section) => <Drawn key={section.id} host={host} view={section} />);
  const inspectorTabs = contributed.views.inspector;
  /**
   * The note the inspector is about, once there is enough to show it: the note in front, and while a
   * folder's list is in front the note that was in front before it. So the inspector keeps its place
   * and the list keeps its width when the member goes between a list and the notes opened from it.
   */
  if (routeNoteId) lastNoteId.current = routeNoteId;
  else if (!routeFolderId) lastNoteId.current = null;
  const inspected = tree && (current ?? ((routeFolderId && lastNoteId.current && byId.get(lastNoteId.current)) || null));

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
        access={note?.access}
        state={note?.state}
        gone={gone.has(noteId)}
        onRejected={(why) => (why === "inTrash" ? learnTrashed(noteId) : refresh())}
        embeds={embeds}
        completions={contributed.completions}
        onContributionFailed={host.fail}
        extensions={extensions}
        onExtensionRefused={host.fail}
        meta={
          note && (
            <>
              <span className="crumbs">{tree?.pathName(note.folderId)}</span>
              {note.private && (
                <span className="private-mark">
                  <Icon name="lock" /> Private
                </span>
              )}
              {note.access === "view" && canEdit && <span className="private-mark">View only</span>}
              {contributed.views.mark.map((mark) => (
                <Drawn key={mark.id} host={host} view={mark} note={note} />
              ))}
              <span>
                edited {ago(note.updatedAt, now)} by {note.updatedBy.name}
              </span>
            </>
          )
        }
        above={
          note &&
          contributed.views.notice.map((notice) => (
            <Drawn key={notice.id} host={host} view={notice} note={note} />
          ))
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

  const readNote = (noteId: string) => (
    <NoteReader key={noteId} workspaceId={workspaceId} noteId={noteId} revision={byId.get(noteId)?.revision} embeds={embeds} extensions={extensions} />
  );
  app.readNote = readNote;
  const folderView = contributed.views.folder.at(-1);
  const renderFolder = (folderId: string) => {
    const plain = <FolderNotes folderId={folderId} folders={tree} notes={kept} pathOf={(id) => pathTo(byId, id)} onOpen={(id) => openNote(id, { preview: true })} />;
    return folderView ? <Drawn key={folderId} host={host} view={folderView} folderId={folderId} readNote={readNote} fallback={plain} /> : plain;
  };

  /**
   * What the address names alone, for when no plugin fills the editor area or the one that does
   * throws. At `/` it is every note, so there is a way to a note whatever is turned off.
   */
  const loneEditor = (
    <div className="groups">
      <section className="group">
        <div className="group-body">{routeNoteId ? renderNote(routeNoteId, { corner: true }) : renderFolder(routeFolderId ?? ALL_NOTES)}</div>
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
          {contributed.views.section.length > 0 && (
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
        {route.kind !== "page" && (editorArea ? <Drawn key={editorArea.id} host={host} view={editorArea} renderNote={renderNote} renderFolder={renderFolder} fallback={loneEditor} /> : loneEditor)}
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
      {shownOverlay && <Drawn key={shownOverlay.id} host={host} view={shownOverlay} close={closeOverlay} state={overlay?.state} />}
      {/* Always there, so a screen reader is told when a notice arrives in it. */}
      <div className="toasts" aria-live="polite">
        {told && <Toast notice={told} onClose={() => tell((now) => (now === told ? null : now))} />}
      </div>
    </div>
  );
}
