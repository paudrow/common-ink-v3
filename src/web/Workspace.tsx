import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Me, Note, NoteSummary, WorkspaceSummary } from "../core/protocol.ts";
import { noteIdFromPath, notePath } from "../core/slug.ts";
import { ApiError, perform } from "./api.ts";
import { createCommands, type Command } from "./commands.ts";
import { EditorGroups, showTabMenu } from "./EditorGroups.tsx";
import { editorReducer, focused, keptLayout, same, type CloseScope, type EditorAction, type EditorLayout, type Group, type Opened } from "./editorLayout.ts";
import { ALL_NOTES, folderTitle, folderTree, pathName, type FolderTree as Tree } from "./folders.ts";
import { FolderTree } from "./FolderTree.tsx";
import { HistoryMode, type Scope } from "./History.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Inspector, markOf, viewsFor, type Subject } from "./Inspector.tsx";
import { FIELD_COMMANDS, KEYBINDINGS, advance, chordFor, chordLabel, chordOf, isModifier, typed } from "./keybindings.ts";
import { MODES, modePath, type ModeId } from "./modes.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { FolderList, type Kept } from "./NoteList.tsx";
import { INITIAL_VIEW, notesIn } from "./noteListView.ts";
import { NoteReader } from "./NoteReader.tsx";
import { Palette } from "./Palette.tsx";
import { ResizeHandle } from "./resize.tsx";
import { folderPath, type Navigate, type Route } from "./router.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Soon } from "./Soon.tsx";
import { isBoolean, useStored } from "./stored.ts";
import { undoOrRedo } from "./sync.ts";
import { ago, useNow } from "./time.ts";

const FOCUS_KEY = "ink.focus";
const SIDEBAR_KEY = "ink.sidebar";
const INSPECTOR_KEY = "ink.inspector";
/** How wide the sidebar and the inspector start, and how far a member can drag each. */
const SIDEBAR = { start: 216, min: 150, max: 480 };
const INSPECTOR = { start: 300, min: 180, max: 600 };
/** How far an arrow key moves the edge of one. */
const WIDTH_STEP = 16;
type Widths = { sidebar?: number; inspector?: number };
const isWidths = (v: unknown): v is Widths => typeof v === "object" && v !== null && Object.values(v).every((n) => typeof n === "number" && n > 0);
const within = ({ min, max }: { min: number; max: number }, width: number) => Math.min(max, Math.max(min, width));
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** How often the notes changed since the last look are listed, so an agent's or another member's change shows up. */
const REFRESH_MS = 5000;

const isRevisions = (v: unknown): v is Record<string, number> => typeof v === "object" && v !== null && Object.values(v).every((n) => typeof n === "number");
const inField = (el: EventTarget | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

/** A layout is kept as it was written, and read by `keptLayout`, which knows the shape it had before a folder could have a tab. */
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isAnything = (_: unknown): _ is unknown => true;

/** What a tab can hold besides a note and a folder's list: each mode. */
const PAGES: readonly { id: string; label: string; icon: IconName; path: string }[] = MODES.map((mode) => ({ id: mode.id, label: mode.label, icon: mode.icon, path: modePath(mode.id) }));


const summaryOf = ({ text: _, ...summary }: Note): NoteSummary => summary;

const pathTo = (byId: ReadonlyMap<string, NoteSummary>, id: string) => {
  const note = byId.get(id);
  return note ? notePath(note) : `/note/${id}`;
};

/** Where a tab lives: a folder's list at `/folder/<id>`, a page at its path, a note at its own address. */
const addressOf = (byId: ReadonlyMap<string, NoteSummary>, tab: Opened) => (tab.kind === "folder" ? folderPath(tab.id) : tab.kind === "page" ? tab.path : pathTo(byId, tab.id));

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

const shortcut = (commandId: string) => {
  const chord = chordFor(commandId);
  return chord && chordLabel(chord, MAC);
};

const CLOSES: { scope: CloseScope; id: string; title: string }[] = [
  { scope: "tab", id: "tab.close", title: "Close tab" },
  { scope: "others", id: "tab.closeOthers", title: "Close other tabs" },
  { scope: "left", id: "tab.closeLeft", title: "Close tabs to the left" },
  { scope: "right", id: "tab.closeRight", title: "Close tabs to the right" },
  { scope: "all", id: "tab.closeAll", title: "Close all tabs" },
];

interface Props {
  me: Me;
  workspace: WorkspaceSummary;
  route: Route;
  navigate: Navigate;
  onSwitch: (workspaceId: string) => void;
}

export function Workspace({ me, workspace, route, navigate, onSwitch }: Props) {
  const workspaceId = workspace.id;
  const canEdit = workspace.role !== "viewer";
  const now = useNow();
  const [tree, setTree] = useState<Tree | null>(null);
  /** Every note in the workspace, for a folder's list, tab titles, and quick open. */
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [listVersion, setListVersion] = useState(0);
  /** In focus the tab in front of the focused group fills the window, over everything else, which stays as it is underneath. Which group that is, the layout already says. */
  const [focusMode, setFocusMode] = useStored(FOCUS_KEY, isBoolean, false);
  const [sidebarOpen, setSidebarOpen] = useStored(SIDEBAR_KEY, isBoolean, true);
  const [inspectorOpen, setInspectorOpen] = useStored(INSPECTOR_KEY, isBoolean, true);
  /** The inspector's tab the member last picked, kept in this browser as the widths are. Only a pick changes it: what is in front shows it when it has it. */
  const [picked, setPicked] = useStored<string | null>(`ink.inspectorTab.${me.person.id}`, isStringOrNull, null);
  /** How wide the member dragged the sidebar and the inspector. Kept in this browser, as the layout is: a width suits the screen it was set on. */
  const [widths, setWidths] = useStored<Widths>(`ink.widths.${me.person.id}`, isWidths, {});
  const sidebarWidth = within(SIDEBAR, widths.sidebar ?? SIDEBAR.start);
  const inspectorWidth = within(INSPECTOR, widths.inspector ?? INSPECTOR.start);
  const [keptEditor, setEditor] = useStored<unknown>(`ink.editor.${workspaceId}`, isAnything, null);
  const editor = useMemo(() => keptLayout(keptEditor), [keptEditor]);
  /** How each folder's list was left, for as long as the app is open. */
  const [keptLists] = useState(() => new Map<string, Kept>());
  const [commands] = useState(createCommands);
  const [palette, setPalette] = useState<"commands" | "notes" | null>(null);
  /** An undo or redo that didn't happen, and why, shown on its note until the member's next step. */
  const [stuck, setStuck] = useState<{ noteId: string; message: string } | null>(null);

  const byId = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const routeNoteId = route.kind === "note" ? route.id : null;
  const current = (routeNoteId && byId.get(routeNoteId)) || null;
  const routeFolderId = route.kind === "folder" ? route.id : null;
  const routePage = route.kind === "mode" ? PAGES.find((p) => p.id === route.mode) : undefined;
  /** What the address names in the editor area: the note, the folder's list or the page in front. */
  const opened = useMemo<Opened | null>(
    () => (routeNoteId ? { kind: "note", id: routeNoteId } : routeFolderId ? { kind: "folder", id: routeFolderId } : routePage ? { kind: "page", id: routePage.id, path: routePage.path } : null),
    [routeNoteId, routeFolderId, routePage],
  );
  /** The folder in front: the one whose list is open, or the open note's. The folder tree marks it. */
  const frontFolderId = routeFolderId ?? current?.folderId ?? null;

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

  const remember = useCallback(
    (note: Note) => {
      const summary = summaryOf(note);
      learned.current.set(note.id, summary);
      setNotes((all) => all && [summary, ...all.filter((n) => n.id !== note.id)]);
      if (location.pathname.startsWith("/note/") && location.pathname.endsWith(note.id)) navigate(notePath(note), { replace: true });
    },
    [navigate],
  );

  const shown = useRef({ editor, byId });
  shown.current = { editor, byId };
  /** The URL names the focused group's active tab, so every change to the layout goes through here. */
  const showEditor = useCallback(
    (next: EditorLayout, move = false) => {
      shown.current.editor = next;
      setEditor(next);
      const tab = focused(next);
      if (!tab) navigate("/");
      // A note's address may be written with an older title, and is still the note's.
      else if (tab.kind !== "note" || noteIdFromPath(location.pathname) !== tab.id) navigate(addressOf(shown.current.byId, tab), { move });
    },
    [setEditor, navigate],
  );
  /**
   * Back retraces every open and close. Moving between tabs already open is one step however many moves it took, and never takes the place of an open.
   * A tab split off or sent to another group leaves focus, which shows one group: the member sees where it went.
   */
  const dispatch = useCallback(
    (action: EditorAction) => {
      const next = editorReducer(shown.current.editor, action);
      if ((action.type === "split" || action.type === "send") && next !== shown.current.editor) setFocusMode(false);
      if (action.type !== "resize") return showEditor(next, action.type === "focus" || action.type === "activate");
      // Dragging the edge of a split goes nowhere.
      shown.current.editor = next;
      setEditor(next);
    },
    [showEditor, setEditor, setFocusMode],
  );

  useEffect(() => {
    if (opened && !same(focused(shown.current.editor), opened)) dispatch({ type: "open", tab: opened, preview: true });
  }, [opened, dispatch]);

  useEffect(() => {
    const tab = focused(shown.current.editor);
    if (route.kind === "home" && tab) navigate(addressOf(shown.current.byId, tab), { replace: true });
  }, [route.kind, navigate]);

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

  /** Asked for on a group, focus turns to that group first, so what fills the window is its tab in front. */
  const toggleFocus = useCallback(
    (groupId?: string) => {
      if (groupId && groupId !== shown.current.editor.focusedGroupId) dispatch({ type: "focus", groupId });
      setFocusMode((on) => !on);
    },
    [dispatch, setFocusMode],
  );
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), [setSidebarOpen]);
  const toggleInspector = useCallback(() => setInspectorOpen((open) => !open), [setInspectorOpen]);
  const closePalette = useCallback(() => setPalette(null), []);

  const go = navigate;
  /** The notes the History page is narrowed to, when it was opened from a note's or a folder's History tab. */
  const [historyScope, setHistoryScope] = useState<Scope | null>(null);
  const openHistory = (scope: Scope | null) => {
    setHistoryScope(scope);
    go(modePath("history"));
  };

  /** The note whose editor is to take the cursor once it is there. */
  const [toFocus, setToFocus] = useState<string | null>(null);
  /**
   * Opens a note. A preview gives way to the next note previewed. `focus` puts the cursor in its
   * editor. `background` opens it in a tab of its own, which is kept, without leaving what is in front.
   */
  const openNote = (noteId: string, options: { preview?: boolean; focus?: boolean; background?: boolean } = {}) => {
    const tab: Opened = { kind: "note", id: noteId };
    if (options.background) return dispatch({ type: "open", tab, preview: false, background: true });
    setToFocus(options.focus ? noteId : null);
    dispatch({ type: "open", tab, preview: options.preview ?? false });
  };
  /** Opens a folder's list of notes. A preview, which it is unless kept, gives way to the next folder previewed and to no note. */
  const openFolder = (folderId: string, keep = false) => {
    dispatch({ type: "open", tab: { kind: "folder", id: folderId }, preview: !keep });
  };

  /** Opens a folder's list or a page in a group of its own, beside or under the one in front, as a tab's Split does. It is kept there. */
  const openBeside = (tab: Opened, side: "right" | "down") => dispatch({ type: "split", groupId: shown.current.editor.focusedGroupId, side, tab, keep: true });

  /** A new note goes in the folder asked for, or else the folder in front, when that is a folder; otherwise in Unsorted. */
  const createNote = async (folderId?: string) => {
    const asked = folderId ?? frontFolderId;
    const note = await perform(workspaceId, { type: "note.create", folderId: asked && tree?.byId.has(asked) ? asked : undefined });
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

  const latest = useRef({ createNote, openFolder, go, routeNoteId });
  latest.current = { createNote, openFolder, go, routeNoteId };
  useEffect(() => {
    const show = (which: "commands" | "notes") => () => setPalette((p) => (p === which ? null : which));
    const onTab = (action: (at: { groupId: string; tab: Opened }) => EditorAction) => () => {
      const tab = focused(shown.current.editor);
      if (tab) dispatch(action({ groupId: shown.current.editor.focusedGroupId, tab }));
    };
    const step = (type: "note.undo" | "note.redo") => () => {
      const id = latest.current.routeNoteId;
      if (!id) return;
      undoOrRedo(workspaceId, { type, id }).then(
        (note) => {
          setStuck(null);
          if (note) remember(note);
        },
        (err: Error) => setStuck({ noteId: id, message: err instanceof ApiError ? err.message : `Couldn't ${type === "note.undo" ? "undo" : "redo"}. Common Ink can't be reached.` }),
      );
    };
    const all: Command[] = [
      ...(canEdit
        ? [
            { id: "note.new", title: "New note", run: () => void latest.current.createNote() },
            { id: "history.undo", title: "Undo", run: step("note.undo") },
            { id: "history.redo", title: "Redo", run: step("note.redo") },
          ]
        : []),
      { id: "notes.quickOpen", title: "Go to note…", run: show("notes") },
      { id: "notes.all", title: "Open All notes", run: () => latest.current.openFolder(ALL_NOTES) },
      { id: "commands.show", title: "Show all commands", run: show("commands") },
      { id: "view.toggleFocus", title: "Toggle focus", run: () => toggleFocus() },
      { id: "view.toggleSidebar", title: "Toggle sidebar", run: toggleSidebar },
      { id: "view.toggleInspector", title: "Toggle inspector", run: toggleInspector },
      { id: "tab.keep", title: "Keep tab open", run: onTab((tab) => ({ type: "pin", ...tab })) },
      ...CLOSES.map(({ scope, id, title }) => ({ id, title, run: onTab((tab) => ({ type: "close", scope, ...tab })) })),
      { id: "editor.splitRight", title: "Split editor right", run: onTab((tab) => ({ type: "split", side: "right", ...tab })) },
      { id: "editor.splitDown", title: "Split editor down", run: onTab((tab) => ({ type: "split", side: "down", ...tab })) },
      { id: "tab.moveToNextGroup", title: "Move tab to next group", run: onTab((tab) => ({ type: "send", to: "next", ...tab })) },
      { id: "tab.moveToPreviousGroup", title: "Move tab to previous group", run: onTab((tab) => ({ type: "send", to: "previous", ...tab })) },
      { id: "tab.menu", title: "Show tab menu", run: showTabMenu },
      ...MODES.map((mode) => ({ id: `go.${mode.id}`, title: `Go to ${mode.label}`, run: () => latest.current.go(modePath(mode.id)) })),
    ];
    const unregister = all.map((command) => commands.register(command));
    return () => unregister.forEach((off) => off());
  }, [commands, canEdit, dispatch, toggleFocus, toggleSidebar, toggleInspector, workspaceId, remember]);

  useEffect(() => {
    let pending = "";
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || isModifier(e.key)) return;
      const chord = chordOf(e);
      const begun = pending;
      pending = "";
      const ready = Object.keys(KEYBINDINGS).filter((keys) => {
        if (keys !== chord && !keys.startsWith(`${chord} `) && !(begun && keys.startsWith(`${begun} `))) return false;
        // Keys that would type are left to what is being typed in.
        if (typed(keys) && (inField(e.target) || (e.target instanceof HTMLElement && e.target.isContentEditable))) return false;
        return !(inField(e.target) && FIELD_COMMANDS.has(KEYBINDINGS[keys]!));
      });
      const next = advance(begun, chord, ready);
      if (!next) return;
      if (next !== "dropped" && "pending" in next) pending = next.pending;
      else if (next !== "dropped" && !commands.run(KEYBINDINGS[next.run]!)) return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [commands]);

  const pageOf = (tab: Opened) => PAGES.find((p) => p.id === tab.id);
  const titleOf = (tab: Opened) =>
    tab.kind === "page" ? (pageOf(tab)?.label ?? "Page") : tab.kind === "folder" ? (tree ? (folderTitle(tree, tab.id) ?? "Folder") : "") : notes ? byId.get(tab.id)?.title || "Untitled" : "";
  const iconOf = (tab: Opened): IconName | undefined => (tab.kind === "folder" ? "folders" : tab.kind === "page" ? pageOf(tab)?.icon : undefined);

  const folders = tree && (
    <FolderTree
      workspaceId={workspaceId}
      tree={tree}
      role={workspace.role}
      total={(notes ?? []).length}
      selectedId={frontFolderId}
      onOpen={openFolder}
      onSplit={(id, side) => openBeside({ kind: "folder", id }, side)}
      onChanged={refresh}
      onMoveNote={moveNote}
    />
  );
  const keptFor = (folderId: string) => {
    if (!keptLists.has(folderId)) keptLists.set(folderId, { view: INITIAL_VIEW, scrollTop: 0 });
    return keptLists.get(folderId)!;
  };
  const renderFolder = (folderId: string) => (
    <FolderList
      key={folderId}
      folderId={folderId}
      tree={tree}
      notes={notes}
      openId={routeNoteId}
      canEdit={canEdit}
      readNote={(noteId) => <NoteReader key={noteId} workspaceId={workspaceId} noteId={noteId} revision={byId.get(noteId)?.revision} />}
      kept={keptFor(folderId)}
      onNew={(id) => void createNote(id)}
      onOpen={(noteId, how) => (how === "behind" ? openNote(noteId, { background: true }) : openNote(noteId, { preview: how === "preview", focus: true }))}
    />
  );
  /** What is in front, for the inspector to be about: the tab in front of the focused group. Null while it loads. */
  const subject = ((): Subject | null => {
    if (routeNoteId)
      return current && tree ? { kind: "note", workspaceId, me: me.person.id, note: current, tree, canEdit, onMove: moveNote, unseen, onSeen: markSeen, onReverted: refresh, onOpenNote: (id) => openNote(id), onOpenHistory: openHistory } : null;
    if (!routeFolderId) return { kind: "page" };
    if (!tree || !notes) return null;
    const name = folderTitle(tree, routeFolderId);
    if (name === null) return { kind: "page" };
    return { kind: "folder", workspaceId, me: me.person.id, name, notes: notesIn(notes, routeFolderId), whole: routeFolderId === ALL_NOTES, canEdit, onOpenNote: (id) => openNote(id), onReverted: refresh, onOpenHistory: openHistory };
  })();
  const pick = setPicked;
  const activeMode = route.kind === "mode" ? route.mode : null;

  const renderNote = (group: Group, noteId: string) => {
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
          dispatch({ type: "pin", groupId: group.id, tab: { kind: "note", id: noteId } });
        }}
        notice={stuck?.noteId === noteId ? stuck.message : null}
        focus={toFocus === noteId}
        onFocused={() => setToFocus(null)}
        meta={
          note && (
            <>
              <span className="crumbs">{tree && pathName(tree, note.folderId)}</span>
              <span>
                edited {ago(note.updatedAt, now)} by {note.updatedBy.name}
              </span>
            </>
          )
        }
      />
    );
  };

  const renderPage = (pageId: string) => {
    const mode = MODES.find((m) => m.id === pageId);
    return (
      <div className="page-pane" key={pageId}>
        {pageId === "history" ? (
          <HistoryMode workspaceId={workspaceId} me={me.person.id} notes={notes ?? []} canEdit={canEdit} scope={historyScope} onScope={setHistoryScope} onOpenNote={(id) => openNote(id)} onChanged={refresh} />
        ) : mode ? (
          <ModeView mode={mode.id} />
        ) : (
          <p className="notice">There's nothing at this address.</p>
        )}
      </div>
    );
  };
  const empty = <p className="notice">Pick a note, or start a new one.</p>;
  /** The buttons that act on the window and on no one note, together where the sidebar meets the editor area: before the first tab of the top left group. */
  const controls = (
    <div className="window-controls" role="group" aria-label="Window">
      <button type="button" className="icon-button" aria-label="Sidebar" title={`Sidebar (${shortcut("view.toggleSidebar")})`} aria-pressed={sidebarOpen} onClick={toggleSidebar}>
        <Icon name="sidebar" />
      </button>
      <button type="button" className="icon-button" aria-label="Inspector" title="Inspector" aria-pressed={inspectorOpen} onClick={toggleInspector}>
        <Icon name="inspector" />
      </button>
    </div>
  );

  return (
    <div className="app" data-focus-mode={focusMode || undefined} style={{ "--sidebar-width": `${sidebarWidth}px`, "--inspector-width": `${inspectorWidth}px` } as CSSProperties}>
      <Sidebar
        me={me}
        workspace={workspace}
        activeMode={activeMode}
        onSwitch={onSwitch}
        onGo={go}
        onSplit={openBeside}
        onNewNote={canEdit ? () => void createNote() : undefined}
        newNoteIn={(frontFolderId && tree?.byId.get(frontFolderId)?.name) || "Unsorted"}
        open={sidebarOpen}
        onOpen={() => setSidebarOpen(true)}
      >
        {folders}
      </Sidebar>
      {sidebarOpen && (
        <ResizeHandle
          label="Resize sidebar"
          orientation="vertical"
          value={sidebarWidth}
          {...SIDEBAR}
          step={WIDTH_STEP}
          onChange={(sidebar) => setWidths((w) => ({ ...w, sidebar }))}
          onReset={() => setWidths(({ sidebar: _, ...w }) => w)}
        />
      )}

      <main className="main" aria-label="Editor">
        {route.kind === "missing" && <p className="notice">There's nothing at this address.</p>}
        {route.kind !== "missing" && (
          <EditorGroups
            layout={editor}
            titleOf={titleOf}
            iconOf={iconOf}
            dispatch={dispatch}
            render={(group, tab) => (tab.kind === "folder" ? renderFolder(tab.id) : tab.kind === "page" ? renderPage(tab.id) : renderNote(group, tab.id))}
            empty={empty}
            controls={controls}
            focusMode={{ on: focusMode, keys: shortcut("view.toggleFocus"), toggle: toggleFocus }}
          />
        )}
      </main>

      {inspectorOpen ? (
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
          />
          <Inspector subject={subject} picked={picked} onPick={pick} />
        </>
      ) : (
        <nav className="rail" aria-label="Inspector bar">
          {viewsFor(subject).map((v) => (
            <button
              key={v.id}
              type="button"
              className="icon-button"
              aria-label={v.label}
              title={v.label}
              aria-description={markOf(v, subject)}
              onClick={() => {
                pick(v.id);
                setInspectorOpen(true);
              }}
            >
              <Icon name={v.icon} />
              {markOf(v, subject) && <span className="unseen-dot" />}
            </button>
          ))}
        </nav>
      )}
      {palette === "commands" && (
        <Palette
          key="commands"
          label="Commands"
          placeholder="Run a command"
          empty="No commands match."
          items={commands
            .list()
            .filter((c) => c.id !== "commands.show")
            .map((c) => ({ id: c.id, label: c.title, hint: shortcut(c.id) }))}
          onPick={(id) => commands.run(id)}
          onClose={closePalette}
        />
      )}
      {palette === "notes" && (
        <Palette
          key="notes"
          label="Go to note"
          placeholder="Find a note by its title"
          empty={notes?.length ? "No notes match." : notes ? "There are no notes yet." : "Loading notes…"}
          items={(notes ?? []).map((n) => ({ id: n.id, label: n.title || "Untitled", hint: tree ? pathName(tree, n.folderId) : undefined }))}
          onPick={(id) => openNote(id)}
          onClose={closePalette}
        />
      )}
    </div>
  );
}

function ModeView({ mode }: { mode: ModeId }) {
  const { label, issue } = MODES.find((m) => m.id === mode)!;
  return (
    <section className="mode-view">
      <h1>{label}</h1>
      <Soon issue={issue}>{label} arrives with</Soon>
    </section>
  );
}
