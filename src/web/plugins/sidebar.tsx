import { useCallback, useRef, useState } from "react";
import { Icon, carry, useDismiss, type Opened, type PageInfo, type Plugin, type Standing, type ViewProps } from "../plugin-api.ts";
import { ContextMenu } from "./lib/Menu.tsx";

const ROLE_LABEL: Record<Standing, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer", guest: "Guest" };

function Sidebar({ app }: ViewProps) {
  const under = (nav: PageInfo["nav"]) => app.pages.filter((p) => p.nav === nav);
  // It opens on arriving at a page that is under it, however that page was reached, so the page the member is on is marked in the
  // list. Closed by hand, it stays closed until they arrive at such a page again.
  const on = under("more").find((p) => p.path === app.path || app.path.startsWith(`${p.path}/`))?.id ?? null;
  const [was, setWas] = useState(on);
  const [more, setMore] = useState(on !== null);
  if (on !== was) {
    setWas(on);
    if (on !== null) setMore(true);
  }
  const open = app.sidebarOpen;
  const links = (nav: PageInfo["nav"]) => under(nav).map((page) => <PageLink key={page.id} app={app} page={page} labelled={open} />);
  const pages = (
    <>
      {links("primary")}
      <button type="button" className="mode more-toggle" aria-expanded={more} aria-label={open ? undefined : more ? "Less" : "More"} title={open ? undefined : more ? "Less" : "More"} onClick={() => setMore(!more)}>
        <Icon name="chevron" />
        {open && <span>{more ? "Less" : "More"}</span>}
      </button>
      {more && links("more")}
    </>
  );
  // Closed, it is a narrow bar with an icon for each thing the open sidebar lists, in the same order.
  if (!open)
    return (
      <nav className="rail" aria-label="Sidebar bar">
        <img src="/favicon.svg" alt="" width={18} height={18} className="rail-brand" />
        <NewNote app={app} />
        {pages}
        {app.sectionNames.map((section) => (
          <button key={section.id} type="button" className="icon-button" aria-label={section.label} title={section.label} onClick={app.toggleSidebar}>
            <Icon name={section.icon} />
          </button>
        ))}
      </nav>
    );
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <WorkspaceMenu app={app} />
      <NewNote app={app} />
      <nav aria-label="Modes" className="modes">
        {pages}
      </nav>
      {app.sections}
    </aside>
  );
}

/**
 * Makes a note where `app.createNote` puts one: in the folder whose list is in front, or the open
 * note's folder, or Unsorted. A viewer has no such button. Whoever may write somewhere and not here
 * is shown it with the reason, so it doesn't come and go as they move between folders.
 */
function NewNote({ app }: ViewProps) {
  if (!app.canEdit) return null;
  const folder = app.folderId && app.folders?.byId.get(app.folderId);
  const where = folder ? folder.name : "Unsorted";
  const refused = app.canCreateNote ? null : folder ? `You can read ${folder.name}, and not add notes to it` : "Open a folder you can change to add a note to it";
  const title = refused ?? `New note in ${where}`;
  const create = () => {
    if (!refused) app.createNote().catch((err: Error) => app.notify({ message: err.message }));
  };
  if (!app.sidebarOpen)
    return (
      <button type="button" className="icon-button new-note" aria-label="New note" aria-disabled={!!refused} title={title} onClick={create}>
        <Icon name="plus" />
      </button>
    );
  return (
    <button type="button" className="button new-note" aria-disabled={!!refused} title={title} onClick={create}>
      <Icon name="plus" />
      New note
    </button>
  );
}

/**
 * A page's link. Clicked, it goes there; dragged to the editor area, the page is dropped in a group
 * as a tab is; and where the editor area has splits its menu opens the page in one.
 */
function PageLink({ app, page, labelled }: ViewProps & { page: PageInfo; labelled?: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const tab: Opened = { kind: "page", id: page.id, path: page.path };
  const { openBeside } = app;
  return (
    <>
      <a
        href={page.path}
        className="mode"
        aria-current={page.path === app.path || app.path.startsWith(`${page.path}/`) ? "page" : undefined}
        aria-label={labelled ? undefined : page.label}
        title={labelled ? undefined : page.label}
        draggable
        onDragStart={(e) => carry(e.dataTransfer, tab)}
        onContextMenu={(e) => {
          if (!openBeside) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          app.go(page.path);
        }}
      >
        {page.icon && <Icon name={page.icon} />}
        {labelled && <span>{page.label}</span>}
      </a>
      {menu && openBeside && (
        <ContextMenu
          label={`${page.label} actions`}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Open in a split right", action: () => openBeside(tab, "right") },
            { label: "Open in a split down", action: () => openBeside(tab, "down") },
          ]}
        />
      )}
    </>
  );
}

function WorkspaceMenu({ app }: ViewProps) {
  const { me, workspace } = app;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open ? close : null, ref);
  return (
    <div className="workspace-menu" ref={ref}>
      <button
        type="button"
        className="workspace-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          // A workspace the member was invited to since the app loaded is in the list by the time they look for it.
          if (!open) app.reloadWorkspaces();
          setOpen(!open);
        }}
      >
        <img src="/favicon.svg" alt="" width={20} height={20} />
        <span className="workspace-text">
          <span className="workspace-name">{workspace.name}</span>
          <span className="workspace-role">{ROLE_LABEL[workspace.role]}</span>
        </span>
      </button>
      {open && (
        <div role="menu" aria-label="Workspaces" className="menu">
          <p className="menu-note">Signed in as {me.email}</p>
          {app.workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={w.id === workspace.id}
              onClick={() => {
                close();
                if (w.id !== workspace.id) app.switchWorkspace(w.id);
              }}
            >
              <span>{w.name}</span>
              <span className="menu-hint">{ROLE_LABEL[w.role]}</span>
            </button>
          ))}
          <hr />
          {app.pages
            .filter((p) => p.nav === "menu")
            .map((page) => (
              <button
                key={page.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  close();
                  app.go(page.path);
                }}
              >
                {page.label}
              </button>
            ))}
          <button type="button" role="menuitem" onClick={app.signOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export const sidebar: Plugin = {
  id: "sidebar",
  name: "Sidebar",
  description: "The column on the left: the workspace menu, the links to pages, and what other plugins put under them.",
  icon: "sidebar",
  activate(host) {
    host.views.register("column", { id: "sidebar", component: Sidebar });
  },
};
