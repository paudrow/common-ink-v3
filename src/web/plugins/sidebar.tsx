import { useCallback, useRef, useState } from "react";
import { Icon, useDismiss, type PageInfo, type Plugin, type Role, type ViewProps } from "../plugin-api.ts";

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

function Sidebar({ app }: ViewProps) {
  const [more, setMore] = useState(false);
  const links = (nav: PageInfo["nav"]) => app.pages.filter((p) => p.nav === nav).map((page) => <PageLink key={page.id} app={app} page={page} labelled />);
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <WorkspaceMenu app={app} />
      <nav aria-label="Modes" className="modes">
        {links("primary")}
        <button type="button" className="mode" aria-expanded={more} onClick={() => setMore(!more)}>
          <Icon name="more" />
          <span>More</span>
        </button>
        {more && links("more")}
      </nav>
      {app.sections}
    </aside>
  );
}

function PageLink({ app, page, labelled }: ViewProps & { page: PageInfo; labelled?: boolean }) {
  return (
    <a
      href={page.path}
      className="mode"
      aria-current={page.path === app.path ? "page" : undefined}
      aria-label={labelled ? undefined : page.label}
      title={labelled ? undefined : page.label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        app.go(page.path);
      }}
    >
      {page.icon && <Icon name={page.icon} />}
      {labelled && <span>{page.label}</span>}
    </a>
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
      <button type="button" className="workspace-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
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
  activate(host) {
    host.views.register("column", { id: "sidebar", component: Sidebar });
    host.views.register("rail", {
      id: "pages",
      component: ({ app }) => (
        <>
          {app.pages
            .filter((p) => p.nav === "primary")
            .map((page) => (
              <PageLink key={page.id} app={app} page={page} />
            ))}
        </>
      ),
    });
  },
};
