import { useCallback, useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { ALL_NOTES, Icon, NOTE_DRAG, type Folders as Tree, type ListedFolder, type OpInput, type Plugin, type PluginHost, type Role } from "../plugin-api.ts";
import { useKept } from "./lib/kept.ts";
import { ContextMenu } from "./lib/Menu.tsx";

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((id) => typeof id === "string");

type Editing = { kind: "create"; parentId: string | null } | { kind: "rename"; id: string };
type Menu = { folder: ListedFolder; x: number; y: number };

const indent = (depth: number) => ({ "--depth": depth }) as CSSProperties;

interface Props {
  host: PluginHost;
  tree: Tree;
  role: Role;
  /** How many notes there are in all, for the row that lists every one. */
  total: number;
  /** The folder in front, which is marked. */
  selectedId: string | null;
  /** A single click opens a folder's list as a preview; a double click keeps it open. */
  onOpen: (id: string, keep: boolean) => void;
  onChanged: () => void;
  onMoveNote: (noteId: string, folderId: string) => Promise<void>;
}

function FolderTree({ host, tree, role, total, selectedId, onOpen, onChanged, onMoveNote }: Props) {
  const ids = useId();
  const [expandedList, setExpanded] = useKept(host.storage, "expanded", isStrings, []);
  const expanded = new Set(expandedList);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [error, setError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const canEdit = role !== "viewer";

  const expand = (id: string) => setExpanded((list) => (list.includes(id) ? list : [...list, id]));
  const collapse = (id: string) => setExpanded((list) => list.filter((x) => x !== id));

  useEffect(() => {
    if (!selectedId || !tree.byId.has(selectedId)) return;
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

  async function run(op: OpInput) {
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

  /** A row that stands for a list of notes and isn't a folder: nothing is dropped on it, and it has no menu. */
  const listRow = (id: string, name: string, count: number) => (
    <div
      key={id}
      role="treeitem"
      className="folder-row"
      style={indent(1)}
      aria-level={1}
      aria-selected={selectedId === id}
      aria-labelledby={`${ids}-${id}`}
      aria-describedby={`${ids}-${id}-count`}
      tabIndex={selectedId === id || (id === ALL_NOTES && !(selectedId && tree.byId.has(selectedId))) ? 0 : -1}
      onClick={() => onOpen(id, false)}
      onDoubleClick={() => onOpen(id, true)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen(id, false);
      }}
    >
      <span className="chevron" />
      <span className="folder-name" id={`${ids}-${id}`}>
        {name}
      </span>
      <span className="count" id={`${ids}-${id}-count`}>
        {count}
      </span>
    </div>
  );

  const rows: ReactNode[] = [listRow(ALL_NOTES, "All notes", total)];
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of tree.childrenOf(parentId)) {
      const open = expanded.has(folder.id);
      const hasChildren = tree.childrenOf(folder.id).length > 0;
      const choose = () => {
        onOpen(folder.id, false);
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
            onDoubleClick={() => onOpen(folder.id, true)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              choose();
            }}
            onContextMenu={(e) => {
              if (!canEdit) return;
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
                data-row-toggle
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
            {canEdit && (
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
        {canEdit && (
          <button type="button" className="icon-button" aria-label="New folder" title="New folder" onClick={() => startCreate(null)}>
            <Icon name="plus" />
          </button>
        )}
      </div>
      <div role="tree" aria-labelledby={`${ids}-label`} className="tree">
        {rows}
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
  description: "The folder tree in the sidebar, where notes are filed, moved and found.",
  icon: "folders",
  activate(host) {
    host.views.register("section", {
      id: "folders",
      component: ({ app }) =>
        app.folders && (
          <FolderTree
            host={host}
            tree={app.folders}
            role={app.workspace.role}
            total={(app.notes ?? []).length}
            selectedId={app.folderId}
            onOpen={(id, keep) => app.openFolder(id, { preview: !keep })}
            onChanged={app.refresh}
            onMoveNote={app.moveNote}
          />
        ),
    });
  },
};
