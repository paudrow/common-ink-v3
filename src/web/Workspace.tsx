import { useCallback, useEffect, useRef, useState } from "react";
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
import { NoteList } from "./NoteList.tsx";
import type { Navigate, Route } from "./router.ts";
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

const popoverKey = (p: Popover | null) => (p ? (p.side === "left" ? "left" : p.tab) : null);

/** A folder's notes as last listed; `folderId` null lists every note. */
type Listing = { folderId: string | null; notes: NoteSummary[] };

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
  const [chosenFolderId, selectFolder] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [openNote, setOpenNote] = useState<NoteSummary | null>(null);
  const [layout, setLayout] = useState<Layout>(() => (readStored(WRITING_KEY, isBoolean) ? WRITING : BROWSING));
  const [inspectorOpen, setInspectorOpen] = useStored(INSPECTOR_KEY, isBoolean, true);

  const selectedFolderId = tree && chosenFolderId && !tree.byId.has(chosenFolderId) ? null : chosenFolderId;
  const current = route.kind === "note" && openNote?.id === route.id ? openNote : null;

  const loadFolders = useCallback(() => perform(workspaceId, { type: "folder.list" }).then((r) => setTree(folderTree(r))), [workspaceId]);
  useEffect(() => void loadFolders(), [loadFolders]);

  useEffect(() => {
    let live = true;
    perform(workspaceId, { type: "note.list", folderId: selectedFolderId ?? undefined }).then((notes) => live && setListing({ folderId: selectedFolderId, notes }));
    return () => {
      live = false;
    };
  }, [workspaceId, selectedFolderId, listVersion]);

  const refresh = useCallback(() => {
    void loadFolders();
    setListVersion((v) => v + 1);
  }, [loadFolders]);

  const remember = useCallback(
    (note: Note) => {
      const summary = summaryOf(note);
      setOpenNote((n) => (n?.id === note.id ? summary : n));
      setListing((l) => {
        if (!l) return l;
        const others = l.notes.filter((n) => n.id !== note.id);
        return { ...l, notes: l.folderId === null || l.folderId === note.folderId ? [summary, ...others] : others };
      });
      if (location.pathname.startsWith("/note/") && location.pathname.endsWith(note.id)) navigate(notePath(note), { replace: true });
    },
    [navigate],
  );

  const opened = useCallback(
    (note: Note) => {
      setOpenNote(summaryOf(note));
      remember(note);
      selectFolder(note.folderId);
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

  const createNote = async () => {
    const note = await perform(workspaceId, { type: "note.create", folderId: selectedFolderId ?? undefined });
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
      selectedId={selectedFolderId}
      onSelect={selectFolder}
      onChanged={refresh}
      onMoveNote={moveNote}
    />
  );
  const noteList = (
    <NoteList
      heading={selectedFolderId && tree ? (tree.byId.get(selectedFolderId)?.name ?? "") : "All notes"}
      notes={listing?.folderId === selectedFolderId ? listing.notes : null}
      openId={current?.id ?? null}
      canEdit={canEdit}
      onNew={createNote}
      onOpen={(note) => go(notePath(note))}
    />
  );
  const panelProps = current && tree && { note: current, tree, canEdit, onMove: (id: string, folderId: string) => moveNote(id, folderId).then(() => selectFolder(folderId)) };
  const activeMode = route.kind === "mode" ? route.mode : null;

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
        {route.kind === "note" && (
          <NoteEditor
            key={route.id}
            workspaceId={workspaceId}
            noteId={route.id}
            onLoaded={opened}
            onSaved={remember}
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
            actions={
              <>
                {!layout.writing && (
                  <button type="button" className="icon-button" aria-label="Inspector" title="Inspector" aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>
                    <Icon name="inspector" />
                  </button>
                )}
                <button type="button" className="icon-button" aria-label="Writing mode" title="Writing mode (⌘.)" aria-pressed={layout.writing} onClick={toggleWriting}>
                  <Icon name="writing" />
                </button>
              </>
            }
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
