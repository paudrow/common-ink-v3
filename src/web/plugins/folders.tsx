import { useCallback, useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, NOTE_DRAG, SHARED_WITH_ME, type Folders as Tree, type ListedFolder, type Plugin, type PluginHost, type PluginOp, type Standing } from "../plugin-api.ts";
import { useKept } from "./lib/kept.ts";
import { listable } from "./lib/listable.ts";
import { ContextMenu } from "./lib/Menu.tsx";
import { SHARE_COMMAND, SHARE_OVERLAY } from "./sharing/Summary.tsx";

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((id) => typeof id === "string");

type Editing = { kind: "create"; parentId: string | null } | { kind: "rename"; id: string };
type Menu = { folder: ListedFolder; x: number; y: number };

const indent = (depth: number) => ({ "--depth": depth }) as CSSProperties;

interface Props {
  host: PluginHost;
  tree: Tree;
  role: Standing;
  /** How many notes were shared with a guest who can't see the folders they are in. They get a row of their own. */
  loose: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  onMoveNote: (noteId: string, folderId: string) => Promise<void>;
  /** Opens the Share dialog for a folder. Left out when there is none to open. */
  onShare?: (folderId: string) => void;
}

function FolderTree({ host, tree, role, loose, selectedId, onSelect, onChanged, onMoveNote, onShare }: Props) {
  const ids = useId();
  const [expandedList, setExpanded] = useKept(host.storage, "expanded", isStrings, []);
  const expanded = new Set(expandedList);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [error, setError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const canEdit = role !== "viewer";
  /** A guest has no place at the top of the workspace to put a folder. */
  const member = role !== "guest";
  /** The folder the server said the member may share, asked when its menu opens. */
  const [shareable, setShareable] = useState<string | null>(null);
  const menuFolderId = menu?.folder.id;
  useEffect(() => {
    if (!menuFolderId || !onShare) return;
    let live = true;
    host.sharing.of({ folderId: menuFolderId }).then(
      (sharing) => live && sharing.canShare && setShareable(menuFolderId),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [host, menuFolderId, !onShare]);

  const expand = (id: string) => setExpanded((list) => (list.includes(id) ? list : [...list, id]));
  const collapse = (id: string) => setExpanded((list) => list.filter((x) => x !== id));

  useEffect(() => {
    if (!selectedId || selectedId === SHARED_WITH_ME) return;
    const ancestors = tree.pathOf(selectedId)
      .slice(0, -1)
      .map((f) => f.id);
    setExpanded((list) => (ancestors.every((id) => list.includes(id)) ? list : [...new Set([...list, ...ancestors])]));
  }, [selectedId, tree, setExpanded]);

  async function attempt(work: () => Promise<unknown>): Promise<boolean> {
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function run(op: PluginOp) {
    if (await attempt(() => host.perform(op))) {
      setEditing(null);
      onChanged();
    }
  }

  const startCreate = (parentId: string | null) => {
    setError(null);
    if (parentId) expand(parentId);
    setEditing({ kind: "create", parentId });
  };

  const cancelEdit = () => {
    setError(null);
    setEditing(null);
  };

  const nameRow = (key: string, depth: number, initial: string, commit: (name: string) => void) => (
    <div key={key} className="folder-row editing" style={indent(depth)}>
      <span className="chevron" />
      <NameInput initial={initial} onCommit={commit} onCancel={cancelEdit} />
    </div>
  );

  const rows: ReactNode[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of tree.childrenOf(parentId)) {
      const open = expanded.has(folder.id);
      const hasChildren = tree.childrenOf(folder.id).length > 0;
      const choose = () => {
        onSelect(folder.id);
        expand(folder.id);
      };
      if (editing?.kind === "rename" && editing.id === folder.id) {
        rows.push(nameRow(folder.id, depth, folder.name, (name) => run({ type: "folder.rename", id: folder.id, name })));
      } else {
        rows.push(
          <div
            key={folder.id}
            role="treeitem"
            className="folder-row"
            data-drop={dropTarget === folder.id || undefined}
            style={indent(depth)}
            aria-level={depth}
            aria-selected={folder.id === selectedId}
            aria-expanded={hasChildren ? open : undefined}
            aria-labelledby={`${ids}-${folder.id}`}
            aria-describedby={`${ids}-${folder.id}-count`}
            tabIndex={folder.id === selectedId ? 0 : -1}
            onClick={choose}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              choose();
            }}
            onContextMenu={(e) => {
              if (folder.access !== "edit") return;
              e.preventDefault();
              setMenu({ folder, x: e.clientX, y: e.clientY });
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(NOTE_DRAG)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(folder.id);
            }}
            onDragLeave={() => setDropTarget((id) => (id === folder.id ? null : id))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              const noteId = e.dataTransfer.getData(NOTE_DRAG);
              if (noteId) void attempt(() => onMoveNote(noteId, folder.id));
            }}
          >
            {hasChildren ? (
              <button
                type="button"
                className="chevron"
                data-open={open || undefined}
                tabIndex={-1}
                aria-label={`${open ? "Collapse" : "Expand"} ${folder.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (open) collapse(folder.id);
                  else expand(folder.id);
                }}
              >
                <Icon name="chevron" />
              </button>
            ) : (
              <span className="chevron" />
            )}
            <span className="folder-name" id={`${ids}-${folder.id}`}>
              {folder.name}
            </span>
            <span className="count" id={`${ids}-${folder.id}-count`}>
              {folder.noteCount}
            </span>
            {folder.access === "edit" && (
              <button
                type="button"
                className="row-actions"
                tabIndex={-1}
                aria-label={`Actions for ${folder.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const box = e.currentTarget.getBoundingClientRect();
                  setMenu({ folder, x: box.left, y: box.bottom + 2 });
                }}
              >
                <Icon name="more" />
              </button>
            )}
          </div>,
        );
      }
      if (editing?.kind === "create" && editing.parentId === folder.id) {
        rows.push(nameRow("new", depth + 1, "", (name) => run({ type: "folder.create", name, parentId: folder.id })));
      }
      if (open) visit(folder.id, depth + 1);
    }
  };
  visit(null, 1);
  if (editing?.kind === "create" && editing.parentId === null) rows.push(nameRow("new", 1, "", (name) => run({ type: "folder.create", name })));

  return (
    <div className="folders">
      <div className="section-head">
        <span id={`${ids}-label`}>Folders</span>
        {canEdit && member && (
          <button type="button" className="icon-button" aria-label="New folder" title="New folder" onClick={() => startCreate(null)}>
            <Icon name="plus" />
          </button>
        )}
      </div>
      <div role="tree" aria-labelledby={`${ids}-label`} className="tree">
        {rows}
        {loose > 0 && (
          <div
            role="treeitem"
            className="folder-row"
            style={indent(1)}
            aria-level={1}
            aria-selected={selectedId === SHARED_WITH_ME}
            aria-label="Shared with me"
            tabIndex={selectedId === SHARED_WITH_ME ? 0 : -1}
            onClick={() => onSelect(SHARED_WITH_ME)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelect(SHARED_WITH_ME);
            }}
          >
            <span className="chevron" />
            <span className="folder-name">Shared with me</span>
            <span className="count">{loose}</span>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {menu && (
        <ContextMenu
          label={`${menu.folder.name} actions`}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: "New folder inside", action: () => startCreate(menu.folder.id) },
            ...(onShare && shareable === menu.folder.id ? [{ label: "Share", action: () => onShare(menu.folder.id) }] : []),
            ...(menu.folder.id === tree.unsortedId
              ? []
              : [
                  {
                    label: "Rename",
                    action: () => {
                      setError(null);
                      setEditing({ kind: "rename", id: menu.folder.id });
                    },
                  },
                  ...(role === "admin" ? [{ label: "Delete", action: () => run({ type: "folder.delete", id: menu.folder.id }) }] : []),
                ]),
          ]}
        />
      )}
    </div>
  );
}

function NameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="name-input"
      aria-label="Folder name"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (value.trim() && value.trim() !== initial) onCommit(value.trim());
          else onCancel();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    />
  );
}

export const folders: Plugin = {
  id: "folders",
  name: "Folders",
  activate(host) {
    host.views.register("section", {
      id: "folders",
      component: ({ app }) =>
        app.folders && (
          <FolderTree
            host={host}
            tree={app.folders}
            role={app.workspace.role}
            loose={listable(app.notes ?? [], false).filter((n) => n.folderId === null).length}
            selectedId={app.folderId}
            onSelect={app.selectFolder}
            onChanged={app.refresh}
            onMoveNote={app.moveNote}
            onShare={host.commands.list().some((c) => c.id === SHARE_COMMAND) ? (folderId) => app.toggleOverlay(SHARE_OVERLAY, { folderId }) : undefined}
          />
        ),
    });
  },
};
