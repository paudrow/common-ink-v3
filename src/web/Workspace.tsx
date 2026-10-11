import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Me, Note, NoteSummary, WorkspaceSummary } from "../core/protocol.ts";
import { noteIdFromPath, notePath } from "../core/slug.ts";
import { ApiError, perform } from "./api.ts";
import { createCommands, type Command } from "./commands.ts";
import { useDismiss } from "./dismiss.ts";
import { EditorGroups } from "./EditorGroups.tsx";
import { EMPTY_LAYOUT, editorReducer, focusedNoteId, isEditorLayout, type CloseScope, type EditorAction, type EditorLayout, type Group } from "./editorLayout.ts";
import { folderTree, pathName, type FolderTree as Tree } from "./folders.ts";
import { FolderTree } from "./FolderTree.tsx";
import { HistoryMode } from "./History.tsx";
import { Icon } from "./icons.tsx";
import { INSPECTOR_TABS, Inspector, InspectorPanel, UNSEEN, type InspectorTab } from "./Inspector.tsx";
import { FIELD_COMMANDS, KEYBINDINGS, chordFor, chordLabel, chordOf } from "./keybindings.ts";
import { MODES, modePath, type ModeId } from "./modes.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { NoteList } from "./NoteList.tsx";
import { Palette } from "./Palette.tsx";
import type { Navigate, Route } from "./router.ts";
import { ModeLink, Sidebar } from "./Sidebar.tsx";
import { Soon } from "./Soon.tsx";
import { isBoolean, readStored, useStored, writeStored } from "./stored.ts";
import { undoOrRedo } from "./sync.ts";
import { ago, useNow } from "./time.ts";

type Popover = { side: "left" } | { side: "right"; tab: InspectorTab };
/** Writing mode collapses both sides to rails; a rail opens its panel as a popover over the editor. */
type Layout = { writing: false } | { writing: true; popover: Popover | null };

const BROWSING: Layout = { writing: false };
const WRITING: Layout = { writing: true, popover: null };
const WRITING_KEY = "ink.writing";
const INSPECTOR_KEY = "ink.inspector";
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** How often the notes changed since the last look are listed, so an agent's or another member's change shows up. */
const REFRESH_MS = 5000;

const isRevisions = (v: unknown): v is Record<string, number> => typeof v === "object" && v !== null && Object.values(v).every((n) => typeof n === "number");
const inField = (el: EventTarget | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;

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
  const [chosenFolderId, selectFolder] = useState<string | null>(null);
  /** Every note in the workspace, for the note list, tab titles, and quick open. */
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [layout, setLayout] = useState<Layout>(() => (readStored(WRITING_KEY, isBoolean) ? WRITING : BROWSING));
  const [inspectorOpen, setInspectorOpen] = useStored(INSPECTOR_KEY, isBoolean, true);
  const [editor, setEditor] = useStored(`ink.editor.${workspaceId}`, isEditorLayout, EMPTY_LAYOUT);
  const [commands] = useState(createCommands);
  const [palette, setPalette] = useState<"commands" | "notes" | null>(null);
  /** An undo or redo that didn't happen, and why, shown on its note until the member's next step. */
  const [stuck, setStuck] = useState<{ noteId: string; message: string } | null>(null);

  const selectedFolderId = tree && chosenFolderId && !tree.byId.has(chosenFolderId) ? null : chosenFolderId;
  const byId = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const routeNoteId = route.kind === "note" ? route.id : null;
  const current = (routeNoteId && byId.get(routeNoteId)) || null;

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
  /** The URL names the focused group's active note, so every change to the layout goes through here. */
  const showEditor = useCallback(
    (next: EditorLayout, replace = false) => {
      shown.current.editor = next;
      setEditor(next);
      const id = focusedNoteId(next);
      if (!id) navigate("/");
      else if (noteIdFromPath(location.pathname) !== id) navigate(pathTo(shown.current.byId, id), { replace });
    },
    [setEditor, navigate],
  );
  /** Moving between notes already open isn't a step Back should retrace, so only an open or a close adds to the browser's history. */
  const dispatch = useCallback(
    (action: EditorAction) => showEditor(editorReducer(shown.current.editor, action), action.type === "focus" || action.type === "activate"),
    [showEditor],
  );

  /** A note opened from somewhere other than the note list, which turns to the note's folder once that's known. */
  const [revealId, reveal] = useState(routeNoteId);
  useEffect(() => {
    const note = revealId ? byId.get(revealId) : undefined;
    if (!note) return;
    selectFolder(note.folderId);
    reveal(null);
  }, [revealId, byId]);

  useEffect(() => {
    if (!routeNoteId || focusedNoteId(shown.current.editor) === routeNoteId) return;
    dispatch({ type: "open", noteId: routeNoteId, preview: true });
    reveal(routeNoteId);
  }, [routeNoteId, dispatch]);

  useEffect(() => {
    const id = focusedNoteId(shown.current.editor);
    if (route.kind === "home" && id) navigate(pathTo(shown.current.byId, id), { replace: true });
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

  const closePopover = useCallback(() => setLayout((l) => (l.writing ? WRITING : l)), []);
  const toggleWriting = useCallback(() => setLayout((l) => (l.writing ? BROWSING : WRITING)), []);
  const togglePopover = (p: Popover) => setLayout((l) => (l.writing ? { writing: true, popover: popoverKey(l.popover) === popoverKey(p) ? null : p } : l));
  const toggleInspector = () => (layout.writing ? togglePopover({ side: "right", tab: "info" }) : setInspectorOpen(!inspectorOpen));
  const closePalette = useCallback(() => setPalette(null), []);

  useEffect(() => writeStored(WRITING_KEY, layout.writing), [layout.writing]);

  const go = (path: string) => {
    navigate(path);
    closePopover();
  };

  const openNote = (noteId: string, preview: boolean) => {
    dispatch({ type: "open", noteId, preview });
    closePopover();
  };

  const createNote = async () => {
    const note = await perform(workspaceId, { type: "note.create", folderId: selectedFolderId ?? undefined });
    void loadFolders();
    remember(note);
    reveal(note.id);
    openNote(note.id, false);
  };

  const moveNote = useCallback(
    async (id: string, folderId: string) => {
      const moved = summaryOf(await perform(workspaceId, { type: "note.move", id, folderId }));
      setNotes((all) => all && all.map((n) => (n.id === id ? moved : n)));
      refresh();
    },
    [workspaceId, refresh],
  );

  const latest = useRef({ createNote, toggleInspector, go, routeNoteId });
  latest.current = { createNote, toggleInspector, go, routeNoteId };
  useEffect(() => {
    const show = (which: "commands" | "notes") => () => setPalette((p) => (p === which ? null : which));
    const onTab = (action: (tab: { groupId: string; noteId: string }) => EditorAction) => () => {
      const noteId = focusedNoteId(shown.current.editor);
      if (noteId) dispatch(action({ groupId: shown.current.editor.focusedGroupId, noteId }));
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
      { id: "commands.show", title: "Show all commands", run: show("commands") },
      { id: "view.toggleWritingMode", title: "Toggle writing mode", run: toggleWriting },
      { id: "view.toggleInspector", title: "Toggle inspector", run: () => latest.current.toggleInspector() },
      { id: "tab.keep", title: "Keep tab open", run: onTab((tab) => ({ type: "pin", ...tab })) },
      ...CLOSES.map(({ scope, id, title }) => ({ id, title, run: onTab((tab) => ({ type: "close", scope, ...tab })) })),
      { id: "editor.splitRight", title: "Split editor right", run: onTab((tab) => ({ type: "split", side: "right", ...tab })) },
      ...MODES.map((mode) => ({ id: `go.${mode.id}`, title: `Go to ${mode.label}`, run: () => latest.current.go(modePath(mode.id)) })),
    ];
    const unregister = all.map((command) => commands.register(command));
    return () => unregister.forEach((off) => off());
  }, [commands, canEdit, dispatch, toggleWriting, workspaceId, remember]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const commandId = KEYBINDINGS[chordOf(e)];
      if (!commandId || (FIELD_COMMANDS.has(commandId) && inField(e.target))) return;
      if (commands.run(commandId)) e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [commands]);

  const titleOf = (noteId: string) => (notes ? byId.get(noteId)?.title || "Untitled" : "");
  const listed = useMemo(() => notes && (selectedFolderId ? notes.filter((n) => n.folderId === selectedFolderId) : notes), [notes, selectedFolderId]);

  const folders = tree && (
    <FolderTree
      workspaceId={workspaceId}
      tree={tree}
      role={workspace.role}
      selectedId={selectedFolderId}
      onSelect={selectFolder}
      onChanged={refresh}
      onMoveNote={moveNote}
    />
  );
  const noteList = (
    <NoteList
      heading={selectedFolderId && tree ? (tree.byId.get(selectedFolderId)?.name ?? "") : "All notes"}
      notes={listed}
      openId={current?.id ?? null}
      canEdit={canEdit}
      onNew={createNote}
      onOpen={(note, keep) => openNote(note.id, !keep)}
    />
  );
  const panelProps = current &&
    tree && {
      workspaceId,
      note: current,
      tree,
      canEdit,
      onMove: (id: string, folderId: string) => moveNote(id, folderId).then(() => selectFolder(folderId)),
      unseen,
      onSeen: markSeen,
      onChanged: remember,
    };
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
          dispatch({ type: "pin", groupId: group.id, noteId });
        }}
        notice={stuck?.noteId === noteId ? stuck.message : null}
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
        actions={
          group === editor.groups.at(-1) && (
            <>
              {!layout.writing && (
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

  const popoverRef = useRef<HTMLDivElement>(null);
  const leftRail = useRef<HTMLElement>(null);
  const rightRail = useRef<HTMLElement>(null);
  const popover = layout.writing ? layout.popover : null;
  const popoverTab = popover?.side === "right" ? INSPECTOR_TABS.find((t) => t.id === popover.tab)! : null;
  useDismiss(popover ? closePopover : null, popoverRef, leftRail, rightRail);

  return (
    <div className="app" data-writing={layout.writing || undefined}>
      {layout.writing ? (
        <nav ref={leftRail} className="rail" aria-label="Left rail">
          <img src="/favicon.svg" alt="" width={18} height={18} className="rail-brand" />
          <button type="button" className="icon-button" aria-label="Folders" aria-pressed={popover?.side === "left"} onClick={() => togglePopover({ side: "left" })}>
            <Icon name="folders" />
          </button>
          {MODES.filter((m) => m.primary).map((mode) => (
            <ModeLink key={mode.id} mode={mode} active={mode.id === activeMode} onGo={go} />
          ))}
        </nav>
      ) : (
        <>
          <Sidebar me={me} workspace={workspace} activeMode={activeMode} onSwitch={onSwitch} onGo={go}>
            {folders}
          </Sidebar>
          {noteList}
        </>
      )}

      <main className="main" aria-label="Editor">
        {route.kind === "mode" &&
          (route.mode === "history" ? (
            <HistoryMode workspaceId={workspaceId} personId={me.person.id} notes={notes ?? []} canEdit={canEdit} onOpenNote={(id) => openNote(id, false)} onChanged={remember} />
          ) : (
            <ModeView mode={route.mode} />
          ))}
        {route.kind === "missing" && <p className="notice">There's nothing at this address.</p>}
        {(route.kind === "note" || route.kind === "home") && <EditorGroups layout={editor} titleOf={titleOf} dispatch={dispatch} renderNote={renderNote} />}
      </main>

      {layout.writing ? (
        <nav ref={rightRail} className="rail" aria-label="Right rail">
          {INSPECTOR_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="icon-button"
              aria-label={tab.label}
              title={tab.label}
              aria-pressed={popoverKey(popover) === tab.id}
              aria-description={tab.id === "history" && unseen ? UNSEEN : undefined}
              disabled={!panelProps}
              onClick={() => togglePopover({ side: "right", tab: tab.id })}
            >
              <Icon name={tab.icon} />
              {tab.id === "history" && unseen && <span className="unseen-dot" />}
            </button>
          ))}
        </nav>
      ) : (
        panelProps && inspectorOpen && <Inspector {...panelProps} />
      )}

      {popover?.side === "left" && (
        <div ref={popoverRef} className="popover left" role="dialog" aria-label="Folders">
          <div className="popover-folders">{folders}</div>
          {noteList}
        </div>
      )}
      {popoverTab && panelProps && (
        <div ref={popoverRef} className="popover right" role="dialog" aria-label={popoverTab.label}>
          <h2>{popoverTab.label}</h2>
          <InspectorPanel tab={popoverTab.id} {...panelProps} />
        </div>
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
          onPick={(id) => {
            reveal(id);
            openNote(id, false);
          }}
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
