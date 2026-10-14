import { useCallback, useEffect, useId, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { ALL_NOTES, Icon, NOTE_DRAG, SHARED_WITH_ME, carry, type Folders as Tree, type ListedFolder, type Plugin, type PluginHost, type PluginOp, type Standing } from "../plugin-api.ts";
import { useKept } from "./lib/kept.ts";
import { ContextMenu } from "./lib/Menu.tsx";
import { SHARE_COMMAND, SHARE_OVERLAY } from "./sharing/Summary.tsx";

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((id) => typeof id === "string");

type Editing = { kind: "create"; parentId: string | null } | { kind: "rename"; id: string };
/** A row's menu. `folder` is left out for a row that is a list and no folder, which can be opened and not changed. */
type Menu = { id: string; name: string; folder?: ListedFolder; x: number; y: number };

const indent = (depth: number) => ({ "--depth": depth }) as CSSProperties;

interface Props {
  host: PluginHost;
  tree: Tree;
  role: Standing;
  /** How many notes were shared with a guest who can't see the folders they are in. They get a row of their own. */
  loose: number;
  /** How many notes there are in all, for the row that lists every one. */
  total: number;
  /** The folder in front, which is marked. */
  selectedId: string | null;
  /** A single click opens a folder's list as a preview; a double click keeps it open. */
  onOpen: (id: string, keep: boolean) => void;
  /** Opens a folder's list in a split, right of or under what is in front. Null where the editor area has no splits. */
  onSplit: ((id: string, side: "right" | "down") => void) | null;
  onChanged: () => void;
  onMoveNote: (noteId: string, folderId: string) => Promise<void>;
  /** Opens the Share dialog for a folder. Left out when there is none to open. */
  onShare?: (folderId: string) => void;
}

function FolderTree({ host, tree, role, loose, total, selectedId, onOpen, onSplit, onChanged, onMoveNote, onShare }: Props) {
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
  const menuFolderId = menu?.folder?.id;
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

  /** Dragged to the editor area, a row's list is dropped in a group as a tab is. */
  const dragged = (id: string) => ({ draggable: true, onDragStart: (e: DragEvent) => carry(e.dataTransfer, { kind: "folder", id }) });

  /** A row that stands for a list of notes and isn't a folder: nothing is dropped on it, and its menu only opens it. */
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
      tabIndex={selectedId === id || (id === ALL_NOTES && !(selectedId && (tree.byId.has(selectedId) || (selectedId === SHARED_WITH_ME && loose > 0)))) ? 0 : -1}
      {...dragged(id)}
      onClick={() => onOpen(id, false)}
      onDoubleClick={() => onOpen(id, true)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ id, name, x: e.clientX, y: e.clientY });
      }}
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
            {...dragged(folder.id)}
            onClick={choose}
            onDoubleClick={() => onOpen(folder.id, true)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              choose();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: folder.id, name: folder.name, folder, x: e.clientX, y: e.clientY });
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
            <button
                type="button"
                className="row-actions"
                tabIndex={-1}
                aria-label={`Actions for ${folder.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const box = e.currentTarget.getBoundingClientRect();
                  setMenu({ id: folder.id, name: folder.name, folder, x: box.left, y: box.bottom + 2 });
                }}
              >
                <Icon name="more" />
              </button>
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

  /** The arrow keys move through the rows, Home and End go to the first and last, and Right and Left open a folder out and shut it. */
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = e.target;
    if (!(row instanceof HTMLElement) || row.role !== "treeitem" || e.altKey || e.ctrlKey || e.metaKey) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const at = rows.indexOf(row);
    const to = { ArrowDown: rows[at + 1], ArrowUp: rows[at - 1], Home: rows[0], End: rows.at(-1) }[e.key];
    const turns = { ArrowRight: "false", ArrowLeft: "true" }[e.key];
    // Right on a folder that is open goes into it, and Left on a row inside one goes to the folder it is in.
    const parent = rows.slice(0, at).findLast((r) => Number(r.ariaLevel) < Number(row.ariaLevel));
    const through = e.key === "ArrowRight" ? (row.ariaExpanded === "true" ? rows[at + 1] : undefined) : e.key === "ArrowLeft" && row.ariaExpanded !== "true" ? parent : undefined;
    if (to ?? through) (to ?? through)!.focus();
    else if (turns && row.ariaExpanded === turns) row.querySelector<HTMLElement>("[data-row-toggle]")?.click();
    else if (!(e.key in { ArrowDown: 0, ArrowUp: 0 })) return;
    e.preventDefault();
  };

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
      <div role="tree" aria-labelledby={`${ids}-label`} className="tree" onKeyDown={move}>
        {rows}
        {loose > 0 && listRow(SHARED_WITH_ME, "Shared with me", loose)}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {menu && (
        <ContextMenu
          label={`${menu.name} actions`}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            ...(onSplit
              ? [
                  { label: "Open in a split right", action: () => onSplit(menu.id, "right") },
                  { label: "Open in a split down", action: () => onSplit(menu.id, "down") },
                ]
              : []),
            ...(menu.folder?.access === "edit" ? [{ label: "New folder inside", action: () => startCreate(menu.id) }] : []),
            ...(onShare && menu.folder && shareable === menu.id ? [{ label: "Share", action: () => onShare(menu.id) }] : []),
            ...(menu.folder?.access !== "edit" || menu.id === tree.unsortedId
              ? []
              : [
                  {
                    label: "Rename",
                    action: () => {
                      setError(null);
                      setEditing({ kind: "rename", id: menu.id });
                    },
                  },
                  ...(role === "admin" ? [{ label: "Delete", action: () => run({ type: "folder.delete", id: menu.id }) }] : []),
                ]),
          ]}
        />
      )}
    </div>
  );
}

function NameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  /** Ended from the keyboard, the cursor goes back to the tree's rows, where the arrow keys are. */
  const toRows = (field: HTMLElement) => field.closest('[role="tree"]')?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
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
          toRows(e.currentTarget);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
          toRows(e.currentTarget);
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
      component: ({ app }) => {
        const live = app.notes ?? [];
        return (
          app.folders && (
          <FolderTree
            host={host}
            tree={app.folders}
            role={app.workspace.role}
            loose={live.filter((n) => n.folderId === null).length}
            total={live.length}
            selectedId={app.folderId}
            onOpen={(id, keep) => app.openFolder(id, { preview: !keep })}
            onSplit={app.openBeside && ((id, side) => app.openBeside?.({ kind: "folder", id }, side))}
            onChanged={app.refresh}
            onMoveNote={app.moveNote}
            onShare={host.commands.list().some((c) => c.id === SHARE_COMMAND) ? (folderId) => app.toggleOverlay(SHARE_OVERLAY, { folderId }) : undefined}
          />
          )
        );
      },
    });
  },
};
