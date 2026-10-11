import { useCallback, useRef, useState, type ReactNode } from "react";
import type { Me, Role, WorkspaceSummary } from "../core/protocol.ts";
import { signOut } from "./api.ts";
import { useDismiss } from "./dismiss.ts";
import { carry } from "./dragged.ts";
import type { Opened } from "./editorLayout.ts";
import { Icon } from "./icons.tsx";
import { ContextMenu } from "./Menu.tsx";
import { MODES, modePath, type ModeId } from "./modes.ts";
import { AGENTS_PATH } from "./router.ts";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

interface Props {
  me: Me;
  workspace: WorkspaceSummary;
  activeMode: ModeId | null;
  onSwitch: (workspaceId: string) => void;
  onGo: (path: string) => void;
  /** Opens a mode's page in a group of its own, beside or under the one in front. */
  onSplit: (page: Opened, side: "right" | "down") => void;
  /** Makes a note in the folder in front, named by `newNoteIn`, or in Unsorted. Left out for a viewer, who has no such button. */
  onNewNote?: () => void;
  newNoteIn: string;
  /** Closed, it is a narrow bar with an icon for each thing the open sidebar lists, in the same order. */
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}

type Mode = (typeof MODES)[number];
const pageOf = (mode: Mode): Opened => ({ kind: "page", id: mode.id, path: modePath(mode.id) });

export function Sidebar({ me, workspace, activeMode, onSwitch, onGo, onSplit, onNewNote, newNoteIn, open, onOpen, children }: Props) {
  // It opens on arriving at a mode that is under it, however that mode was reached, so the mode the member is on is marked in the
  // list. Closed by hand, it stays closed until they arrive at such a mode again.
  const on = MODES.find((m) => !m.primary && m.id === activeMode)?.id ?? null;
  const [was, setWas] = useState(on);
  const [more, setMore] = useState(on !== null);
  if (on !== was) {
    setWas(on);
    if (on !== null) setMore(true);
  }
  const [menu, setMenu] = useState<{ mode: Mode; x: number; y: number } | null>(null);
  const link = (mode: Mode) => <ModeLink key={mode.id} mode={mode} active={mode.id === activeMode} onGo={onGo} labelled={open} onMenu={(x, y) => setMenu({ mode, x, y })} />;
  const modes = (
    <>
      {MODES.filter((m) => m.primary).map(link)}
      <button type="button" className="mode more-toggle" aria-expanded={more} aria-label={open ? undefined : more ? "Less" : "More"} title={open ? undefined : more ? "Less" : "More"} onClick={() => setMore(!more)}>
        <Icon name="chevron" />
        {open && <span>{more ? "Less" : "More"}</span>}
      </button>
      {more && MODES.filter((m) => !m.primary).map(link)}
      {menu && (
        <ContextMenu
          label={`${menu.mode.label} actions`}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Open in a split right", action: () => onSplit(pageOf(menu.mode), "right") },
            { label: "Open in a split down", action: () => onSplit(pageOf(menu.mode), "down") },
          ]}
        />
      )}
    </>
  );
  if (!open)
    return (
      <nav className="rail" aria-label="Sidebar bar">
        <img src="/favicon.svg" alt="" width={18} height={18} className="rail-brand" />
        {onNewNote && (
          <button type="button" className="icon-button new-note" aria-label="New note" title={`New note in ${newNoteIn}`} onClick={onNewNote}>
            <Icon name="plus" />
          </button>
        )}
        {modes}
        <button type="button" className="icon-button" aria-label="Folders" title="Folders" onClick={onOpen}>
          <Icon name="folders" />
        </button>
      </nav>
    );
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <WorkspaceMenu me={me} workspace={workspace} onSwitch={onSwitch} onGo={onGo} />
      {onNewNote && (
        <button type="button" className="button new-note" title={`New note in ${newNoteIn}`} onClick={onNewNote}>
          <Icon name="plus" />
          New note
        </button>
      )}
      <nav aria-label="Modes" className="modes">
        {modes}
      </nav>
      {children}
    </aside>
  );
}

/** A mode's link. Clicked, it goes there; dragged to the editor area, its page is dropped in a group as a tab is. */
function ModeLink({ mode, active, onGo, labelled, onMenu }: { mode: Mode; active: boolean; onGo: (path: string) => void; labelled?: boolean; onMenu: (x: number, y: number) => void }) {
  const path = modePath(mode.id);
  return (
    <a
      href={path}
      className="mode"
      aria-current={active ? "page" : undefined}
      aria-label={labelled ? undefined : mode.label}
      title={labelled ? undefined : mode.label}
      draggable
      onDragStart={(e) => carry(e.dataTransfer, pageOf(mode))}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onGo(path);
      }}
    >
      <Icon name={mode.icon} />
      {labelled && <span>{mode.label}</span>}
    </a>
  );
}

function WorkspaceMenu({ me, workspace, onSwitch, onGo }: { me: Me; workspace: WorkspaceSummary; onSwitch: (workspaceId: string) => void; onGo: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open ? close : null, ref);
  return (
    <div className="workspace-menu" ref={ref}>
      <button type="button" className="workspace-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <img src="/favicon.svg" alt="" width={20} height={20} />
        <span className="workspace-text">
          <span className="workspace-name">{workspace.name}</span>
          <span className="workspace-role">{ROLE_LABEL[workspace.role]}</span>
        </span>
      </button>
      {open && (
        <div role="menu" aria-label="Workspaces" className="menu">
          <p className="menu-note">Signed in as {me.person.email}</p>
          {me.workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={w.id === workspace.id}
              onClick={() => {
                close();
                if (w.id !== workspace.id) onSwitch(w.id);
              }}
            >
              <span>{w.name}</span>
              <span className="menu-hint">{ROLE_LABEL[w.role]}</span>
            </button>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onGo(AGENTS_PATH);
            }}
          >
            Agents
          </button>
          <button type="button" role="menuitem" onClick={() => signOut().then(() => location.assign("/"))}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
