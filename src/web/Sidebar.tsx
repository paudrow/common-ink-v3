import { useCallback, useRef, useState, type ReactNode } from "react";
import type { Me, Role, WorkspaceSummary } from "../core/protocol.ts";
import { signOut } from "./api.ts";
import { useDismiss } from "./dismiss.ts";
import { Icon } from "./icons.tsx";
import { MODES, modePath, type ModeId } from "./modes.ts";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

interface Props {
  me: Me;
  workspace: WorkspaceSummary;
  activeMode: ModeId | null;
  onSwitch: (workspaceId: string) => void;
  onGo: (path: string) => void;
  /** Makes a note in the folder in front, named by `newNoteIn`, or in Unsorted. Left out for a viewer, who has no such button. */
  onNewNote?: () => void;
  newNoteIn: string;
  children: ReactNode;
}

export function Sidebar({ me, workspace, activeMode, onSwitch, onGo, onNewNote, newNoteIn, children }: Props) {
  const [more, setMore] = useState(false);
  const link = (mode: (typeof MODES)[number]) => <ModeLink key={mode.id} mode={mode} active={mode.id === activeMode} onGo={onGo} labelled />;
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <WorkspaceMenu me={me} workspace={workspace} onSwitch={onSwitch} />
      {onNewNote && (
        <button type="button" className="button new-note" title={`New note in ${newNoteIn}`} onClick={onNewNote}>
          <Icon name="plus" />
          New note
        </button>
      )}
      <nav aria-label="Modes" className="modes">
        {MODES.filter((m) => m.primary).map(link)}
        <button type="button" className="mode" aria-expanded={more} onClick={() => setMore(!more)}>
          <Icon name="more" />
          <span>More</span>
        </button>
        {more && MODES.filter((m) => !m.primary).map(link)}
      </nav>
      {children}
    </aside>
  );
}

export function ModeLink({ mode, active, onGo, labelled }: { mode: (typeof MODES)[number]; active: boolean; onGo: (path: string) => void; labelled?: boolean }) {
  const path = modePath(mode.id);
  return (
    <a
      href={path}
      className="mode"
      aria-current={active ? "page" : undefined}
      aria-label={labelled ? undefined : mode.label}
      title={labelled ? undefined : mode.label}
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

function WorkspaceMenu({ me, workspace, onSwitch }: { me: Me; workspace: WorkspaceSummary; onSwitch: (workspaceId: string) => void }) {
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
          <button type="button" role="menuitem" onClick={() => signOut().then(() => location.assign("/"))}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
