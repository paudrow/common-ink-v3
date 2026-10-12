import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Me, Note, NoteSummary, WorkspaceSummary } from "../core/protocol.ts";
import { notePath } from "../core/slug.ts";
import { perform } from "./api.ts";
import { useDismiss } from "./dismiss.ts";
import { folderTree, pathName, type FolderTree as Tree } from "./folders.ts";
import { FolderTree } from "./FolderTree.tsx";
import { Icon } from "./icons.tsx";
import { INSPECTOR_TABS, Inspector, InspectorPanel, type InspectorTab } from "./Inspector.tsx";
import { MODES, type ModeId } from "./modes.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { FolderList, type Kept } from "./NoteList.tsx";
import { INITIAL_VIEW } from "./noteListView.ts";
import { NoteReader } from "./NoteReader.tsx";
import { ResizeHandle } from "./resize.tsx";
import { folderPath, type Navigate, type Route } from "./router.ts";
import { ModeLink, Sidebar } from "./Sidebar.tsx";
import { Soon } from "./Soon.tsx";
import { isBoolean, readStored, useStored, writeStored } from "./stored.ts";
import { ago, useNow } from "./time.ts";

type Popover = { side: "left" } | { side: "right"; tab: InspectorTab };
/** Writing mode collapses both sides to rails; a rail opens its panel as a popover over the editor. */
type Layout = { writing: false } | { writing: true; popover: Popover | null };

const BROWSING: Layout = { writing: false };
const WRITING: Layout = { writing: true, popover: null };
const WRITING_KEY = "ink.writing";
const INSPECTOR_KEY = "ink.inspector";
/** How wide the sidebar and the inspector start, and how far a member can drag each. */
const SIDEBAR = { start: 216, min: 150, max: 480 };
const INSPECTOR = { start: 300, min: 180, max: 600 };
/** How far an arrow key moves the edge of one. */
const WIDTH_STEP = 16;
type Widths = { sidebar?: number; inspector?: number };
const isWidths = (v: unknown): v is Widths => typeof v === "object" && v !== null && Object.values(v).every((n) => typeof n === "number" && n > 0);
const within = ({ min, max }: { min: number; max: number }, width: number) => Math.min(max, Math.max(min, width));

const popoverKey = (p: Popover | null) => (p ? (p.side === "left" ? "left" : p.tab) : null);

const summaryOf = ({ text: _, ...summary }: Note): NoteSummary => summary;

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
  /** Every note the member can see. A folder's list is the ones in it. */
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [openNote, setOpenNote] = useState<NoteSummary | null>(null);
  /** How each folder's list was left, so coming back to one finds it as it was. */
  const [keptLists] = useState(() => new Map<string, Kept>());
  /** The note whose editor is to take the cursor once it is there. */
  const [toFocus, setToFocus] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(() => (readStored(WRITING_KEY, isBoolean) ? WRITING : BROWSING));
  const [inspectorOpen, setInspectorOpen] = useStored(INSPECTOR_KEY, isBoolean, true);
  /** How wide the member dragged the sidebar and the inspector. Kept in this browser, as the layout is: a width suits the screen it was set on. */
  const [widths, setWidths] = useStored<Widths>(`ink.widths.${me.person.id}`, isWidths, {});
  const sidebarWidth = within(SIDEBAR, widths.sidebar ?? SIDEBAR.start);
  const inspectorWidth = within(INSPECTOR, widths.inspector ?? INSPECTOR.start);

  const byId = useMemo(() => new Map((notes ?? []).map((n) => [n.id, n])), [notes]);
  const current = route.kind === "note" && openNote?.id === route.id ? openNote : null;
  /** The folder in front: the one whose list is showing, or the folder of the note that is open. */
  const frontFolderId = route.kind === "folder" ? route.id : (current?.folderId ?? null);

  const loadFolders = useCallback(() => perform(workspaceId, { type: "folder.list" }).then((r) => setTree(folderTree(r))), [workspaceId]);
  useEffect(() => void loadFolders(), [loadFolders]);

  useEffect(() => {
    let live = true;
    perform(workspaceId, { type: "note.list" }).then((all) => live && setNotes(all));
    return () => {
      live = false;
    };
  }, [workspaceId, listVersion]);

  const refresh = useCallback(() => {
    void loadFolders();
    setListVersion((v) => v + 1);
  }, [loadFolders]);

  const remember = useCallback(
    (note: Note) => {
      const summary = summaryOf(note);
      setOpenNote((n) => (n?.id === note.id ? summary : n));
      setNotes((all) => all && [summary, ...all.filter((n) => n.id !== note.id)]);
      if (location.pathname.startsWith("/note/") && location.pathname.endsWith(note.id)) navigate(notePath(note), { replace: true });
    },
    [navigate],
  );

  const opened = useCallback(
    (note: Note) => {
      setOpenNote(summaryOf(note));
      remember(note);
    },
    [remember],
  );

  const closePopover = useCallback(() => setLayout((l) => (l.writing ? WRITING : l)), []);
  const toggleWriting = useCallback(() => setLayout((l) => (l.writing ? BROWSING : WRITING)), []);
  const togglePopover = (p: Popover) => setLayout((l) => (l.writing ? { writing: true, popover: popoverKey(l.popover) === popoverKey(p) ? null : p } : l));

  useEffect(() => writeStored(WRITING_KEY, layout.writing), [layout.writing]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "." || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      toggleWriting();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [toggleWriting]);

  const go = (path: string) => {
    navigate(path);
    closePopover();
  };

  /** A new note goes in the folder asked for, or else the folder in front, when that is a folder; otherwise in Unsorted. */
  const createNote = async (folderId?: string) => {
    const asked = folderId ?? frontFolderId;
    const note = await perform(workspaceId, { type: "note.create", folderId: asked && tree?.byId.has(asked) ? asked : undefined });
    void loadFolders();
    remember(note);
    go(notePath(note));
  };

  const moveNote = useCallback(
    async (id: string, folderId: string) => {
      const moved = summaryOf(await perform(workspaceId, { type: "note.move", id, folderId }));
      setOpenNote((n) => (n?.id === id ? moved : n));
      refresh();
    },
    [workspaceId, refresh],
  );

  const folders = tree && (
    <FolderTree
      workspaceId={workspaceId}
      tree={tree}
      role={workspace.role}
      total={(notes ?? []).length}
      selectedId={frontFolderId}
      onOpen={(id) => go(folderPath(id))}
      onChanged={refresh}
      onMoveNote={moveNote}
    />
  );
  const keptFor = (folderId: string) => {
    if (!keptLists.has(folderId)) keptLists.set(folderId, { view: INITIAL_VIEW, scrollTop: 0 });
    return keptLists.get(folderId)!;
  };
  /** A note opened from a folder's list takes the list's place, with the cursor in it. ⌘-click leaves the list in front and opens the note in a tab of the browser's. */
  const openFromList = (noteId: string, how: "preview" | "keep" | "behind") => {
    const note = byId.get(noteId);
    if (!note) return;
    const path = notePath(note);
    if (how === "behind") return void window.open(path, "_blank");
    setToFocus(noteId);
    go(path);
  };
  const panelProps = current && tree && { note: current, tree, canEdit, onMove: moveNote };
  const activeMode = route.kind === "mode" ? route.mode : null;

  /** The buttons that act on the window and on no one note. The editor area puts them at its top right corner, out of any note's bar. */
  const controls = (
    <div className="window-controls" role="group" aria-label="Window">
      {!layout.writing && (
        <button type="button" className="icon-button" aria-label="Inspector" title="Inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>
          <Icon name="inspector" />
        </button>
      )}
      <button type="button" className="icon-button" aria-label="Writing mode" title="Writing mode (⌘.)" aria-pressed={layout.writing} onClick={toggleWriting}>
        <Icon name="writing" />
      </button>
    </div>
  );

  const popoverRef = useRef<HTMLDivElement>(null);
  const leftRail = useRef<HTMLElement>(null);
  const rightRail = useRef<HTMLElement>(null);
  const popover = layout.writing ? layout.popover : null;
  const popoverTab = popover?.side === "right" ? INSPECTOR_TABS.find((t) => t.id === popover.tab)! : null;
  useDismiss(popover ? closePopover : null, popoverRef, leftRail, rightRail);

  return (
    <div className="app" data-writing={layout.writing || undefined} style={{ "--sidebar-width": `${sidebarWidth}px`, "--inspector-width": `${inspectorWidth}px` } as CSSProperties}>
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
          <Sidebar
            me={me}
            workspace={workspace}
            activeMode={activeMode}
            onSwitch={onSwitch}
            onGo={go}
            onNewNote={canEdit ? () => void createNote() : undefined}
            newNoteIn={(frontFolderId && tree?.byId.get(frontFolderId)?.name) || "Unsorted"}
          >
            {folders}
          </Sidebar>
          <ResizeHandle
            label="Resize sidebar"
            orientation="vertical"
            value={sidebarWidth}
            {...SIDEBAR}
            step={WIDTH_STEP}
            onChange={(sidebar) => setWidths((w) => ({ ...w, sidebar }))}
            onReset={() => setWidths(({ sidebar: _, ...w }) => w)}
          />
        </>
      )}

      <main className="main" aria-label="Editor">
        {controls}
        {route.kind === "note" && (
          <NoteEditor
            key={route.id}
            workspaceId={workspaceId}
            noteId={route.id}
            onLoaded={opened}
            onSaved={remember}
            focus={toFocus === route.id}
            onFocused={() => setToFocus(null)}
            meta={
              current && (
                <>
                  <span className="crumbs">{tree && pathName(tree, current.folderId)}</span>
                  <span>
                    edited {ago(current.updatedAt, now)} by {current.updatedBy.name}
                  </span>
                </>
              )
            }
          />
        )}
        {route.kind === "folder" && (
          <FolderList
            key={route.id}
            folderId={route.id}
            tree={tree}
            notes={notes}
            openId={null}
            canEdit={canEdit}
            readNote={(noteId) => <NoteReader key={noteId} workspaceId={workspaceId} noteId={noteId} revision={byId.get(noteId)?.revision} />}
            kept={keptFor(route.id)}
            onNew={(id) => void createNote(id)}
            onOpen={openFromList}
          />
        )}
        {route.kind === "mode" && <ModeView mode={route.mode} />}
        {route.kind === "home" && <p className="notice">Pick a note, or start a new one.</p>}
        {route.kind === "missing" && <p className="notice">There's nothing at this address.</p>}
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
              disabled={!panelProps}
              onClick={() => togglePopover({ side: "right", tab: tab.id })}
            >
              <Icon name={tab.icon} />
            </button>
          ))}
        </nav>
      ) : (
        panelProps &&
        inspectorOpen && (
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
            <Inspector {...panelProps} />
          </>
        )
      )}

      {popover?.side === "left" && (
        <div ref={popoverRef} className="popover left" role="dialog" aria-label="Folders">
          <div className="popover-folders">{folders}</div>
        </div>
      )}
      {popoverTab && panelProps && (
        <div ref={popoverRef} className="popover right" role="dialog" aria-label={popoverTab.label}>
          <h2>{popoverTab.label}</h2>
          <InspectorPanel tab={popoverTab.id} {...panelProps} />
        </div>
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
