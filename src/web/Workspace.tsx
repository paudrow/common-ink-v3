import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Me, Note, NoteSummary, WorkspaceSummary } from "../core/protocol.ts";
import { notePath } from "../core/slug.ts";
import { perform } from "./api.ts";
import { folderTitle, folderTree, pathName, type FolderTree as Tree } from "./folders.ts";
import { FolderTree } from "./FolderTree.tsx";
import { Icon } from "./icons.tsx";
import { Inspector, viewsFor, type Subject } from "./Inspector.tsx";
import { MODES, type ModeId } from "./modes.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { FolderList, type Kept } from "./NoteList.tsx";
import { INITIAL_VIEW, notesIn } from "./noteListView.ts";
import { NoteReader } from "./NoteReader.tsx";
import { ResizeHandle } from "./resize.tsx";
import { folderPath, type Navigate, type Route } from "./router.ts";
import { Sidebar } from "./Sidebar.tsx";
import { Soon } from "./Soon.tsx";
import { isBoolean, useStored } from "./stored.ts";
import { ago, useNow } from "./time.ts";

const WRITING_KEY = "ink.writing";
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
  /** Writing mode shows the editor area and neither side, whichever of them is open. */
  const [writing, setWriting] = useStored(WRITING_KEY, isBoolean, false);
  const [sidebarOpen, setSidebarOpen] = useStored(SIDEBAR_KEY, isBoolean, true);
  const [inspectorOpen, setInspectorOpen] = useStored(INSPECTOR_KEY, isBoolean, true);
  /** The inspector's tab the member last picked for each kind of thing it can be about. */
  const [picked, setPicked] = useState<Partial<Record<Subject["kind"], string>>>({});
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === ".") setWriting((w) => !w);
      else if (e.key === "\\") setSidebarOpen((open) => !open);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [setWriting, setSidebarOpen]);

  /** A new note goes in the folder asked for, or else the folder in front, when that is a folder; otherwise in Unsorted. */
  const createNote = async (folderId?: string) => {
    const asked = folderId ?? frontFolderId;
    const note = await perform(workspaceId, { type: "note.create", folderId: asked && tree?.byId.has(asked) ? asked : undefined });
    void loadFolders();
    remember(note);
    navigate(notePath(note));
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
      onOpen={(id) => navigate(folderPath(id))}
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
    navigate(path);
  };
  const activeMode = route.kind === "mode" ? route.mode : null;

  /** What is in front, for the inspector to be about. Null while it loads. */
  const subject = ((): Subject | null => {
    if (route.kind === "note") return current && tree ? { kind: "note", note: current, tree, canEdit, onMove: moveNote } : null;
    if (route.kind !== "folder") return { kind: "page" };
    if (!tree || !notes) return null;
    const name = folderTitle(tree, route.id);
    return name === null ? { kind: "page" } : { kind: "folder", name, notes: notesIn(notes, route.id) };
  })();
  const pick = (viewId: string) => subject && setPicked((p) => ({ ...p, [subject.kind]: viewId }));

  /** The buttons that act on the window and on no one note, in a row along the top of the editor area: the sidebar's at its left end, beside the sidebar, and the inspector's and writing mode's at its right. */
  const controls = (
    <div className="window-controls" role="group" aria-label="Window">
      {!writing && (
        <button type="button" className="icon-button" aria-label="Sidebar" title="Sidebar (⌘\)" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>
          <Icon name="sidebar" />
        </button>
      )}
      <span className="window-controls-end">
        {!writing && (
          <button type="button" className="icon-button" aria-label="Inspector" title="Inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>
            <Icon name="inspector" />
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Writing mode" title="Writing mode (⌘.)" aria-pressed={writing} onClick={() => setWriting(!writing)}>
          <Icon name="writing" />
        </button>
      </span>
    </div>
  );

  return (
    <div className="app" data-writing={writing || undefined} style={{ "--sidebar-width": `${sidebarWidth}px`, "--inspector-width": `${inspectorWidth}px` } as CSSProperties}>
      {!writing && (
        <>
          <Sidebar
            me={me}
            workspace={workspace}
            activeMode={activeMode}
            onSwitch={onSwitch}
            onGo={navigate}
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

      {!writing &&
        (inspectorOpen ? (
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
            <Inspector subject={subject} picked={subject ? picked[subject.kind] : undefined} onPick={pick} />
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
                onClick={() => {
                  pick(v.id);
                  setInspectorOpen(true);
                }}
              >
                <Icon name={v.icon} />
              </button>
            ))}
          </nav>
        ))}
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
