import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Icon, draggableAs, useDismiss, type App, type Opened, type PageInfo, type Plugin, type Standing, type ViewProps } from "../plugin-api.ts";
import { ContextMenu } from "./lib/Menu.tsx";
import { arrive, goes, listOf, step } from "./lib/rows.ts";

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
  /** The section shown over the page from the closed bar, if any. */
  const [picking, setPicking] = useState<App["sectionNames"][number] | null>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => setPicking(null), []);
  if ((open || app.focus) && picking) setPicking(null);
  const links = (nav: PageInfo["nav"]) => under(nav).map((page) => <PageLink key={page.id} app={app} page={page} labelled={open} />);
  const pages = (
    <>
      {links("primary")}
      <button type="button" className="mode more-toggle" data-row data-row-toggle aria-expanded={more} aria-label={open ? undefined : more ? "Less" : "More"} title={open ? undefined : more ? "Less" : "More"} onClick={() => setMore(!more)}>
        <Icon name="chevron" />
        {open && <span>{more ? "Less" : "More"}</span>}
      </button>
      {more && links("more")}
    </>
  );
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (!e.defaultPrevented && listOf(target) === e.currentTarget && step(e, e.currentTarget)) e.preventDefault();
    // Right opens More out and Left shuts it, as they do a folder.
    else if (target.matches("[data-row-toggle]") && target.ariaExpanded === { ArrowRight: "false", ArrowLeft: "true" }[e.key]) {
      e.preventDefault();
      target.click();
    } else if (e.key === "Enter" && !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) && e.target instanceof Element && goes(e.target)) arrive();
  };
  // Closed, it is a narrow bar with an icon for each thing the open sidebar lists, in the same order.
  if (!open)
    return (
      <nav className="rail" aria-label="Sidebar bar">
        <img src="/favicon.svg" alt="" width={18} height={18} className="rail-brand" />
        <NewNote app={app} />
        {pages}
        {app.sectionNames.map((section) => (
          <button
            key={section.id}
            ref={picking?.id === section.id ? pickerButton : undefined}
            type="button"
            className="icon-button"
            aria-label={section.label}
            title={section.label}
            aria-haspopup="dialog"
            aria-expanded={picking?.id === section.id}
            onClick={() => setPicking(picking?.id === section.id ? null : section)}
          >
            <Icon name={section.icon} />
          </button>
        ))}
        {picking && <Picker app={app} section={picking} anchor={pickerButton} onClose={closePicker} />}
      </nav>
    );
  return (
    // One list from the pages through the folders to the tags, whose rows the arrow keys go through. Enter on a link or a folder
    // opens it and goes there with the keyboard.
    <aside className="sidebar" aria-label="Sidebar" data-list data-beside onKeyDown={onKey}>
      <WorkspaceMenu app={app} />
      <NewNote app={app} />
      <nav aria-label="Modes" className="modes">
        {pages}
      </nav>
      {app.sections}
    </aside>
  );
}

/** How long the picker stays once something is opened from it, so the second click of a double click still lands on its row. */
const LINGER_MS = 300;
const EDGE = 8;

/**
 * One of the sidebar's sections over the page beside its bar, for picking a folder or a tag while
 * the sidebar is closed. It takes no room: nothing under it moves. It goes once something is opened from it, on
 * Escape, and on a press outside it, and the cursor goes back to the button that opened it.
 */
function Picker({ app, section, anchor, onClose }: ViewProps & { section: App["sectionNames"][number]; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  /** A row being dragged out of it to the editor area, which it then lets the pointer through to. */
  const [dragging, setDragging] = useState(false);
  useDismiss(onClose, ref, anchor);
  const opened = useCallback(() => setLeaving(true), []);
  useLayoutEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(onClose, LINGER_MS);
    return () => clearTimeout(timer);
  }, [leaving, onClose]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const button = anchor.current;
    const place = () => {
      const top = button?.getBoundingClientRect().top ?? EDGE;
      el.style.top = `${Math.max(EDGE, Math.min(top, innerHeight - EDGE - el.offsetHeight))}px`;
    };
    place();
    (el.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? el.querySelector<HTMLElement>("[tabindex], button, a[href]"))?.focus();
    // It is taller once a folder in it is opened out, and may then need to start higher to fit.
    const sized = new ResizeObserver(place);
    sized.observe(el);
    addEventListener("resize", place);
    return () => {
      sized.disconnect();
      removeEventListener("resize", place);
      if (button?.isConnected && (el.contains(document.activeElement) || document.activeElement === document.body)) button.focus();
    };
  }, [anchor]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={section.label}
      className="sidebar-picker"
      data-leaving={leaving || undefined}
      data-dragging={dragging || undefined}
      // Not as the drag starts: what is dragged is drawn from the row as it is then.
      onDragStart={() => setTimeout(() => setDragging(true))}
      onDragEnd={onClose}
      // The cursor taken out of it, as by Tab, leaves nothing floating over the page behind it.
      onBlur={(e) => e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== anchor.current && onClose()}
    >
      {app.sectionsOpening(opened, section.id)}
    </div>
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
  // The folder is read as the drag starts, and the note is made only once it is dropped.
  const dragged = refused ? {} : draggableAs({ kind: "new note", ...(app.folderId ? { folderId: app.folderId } : {}) });
  if (!app.sidebarOpen)
    return (
      <button type="button" className="icon-button new-note" aria-label="New note" aria-disabled={!!refused} title={title} onClick={create} {...dragged}>
        <Icon name="plus" />
      </button>
    );
  return (
    <button type="button" className="button new-note" aria-disabled={!!refused} title={title} onClick={create} {...dragged}>
      <Icon name="plus" />
      New note
    </button>
  );
}

/**
 * A page's link. Clicked, it goes there; dragged to the editor area, the page is dropped in a group
 * as a tab is, or for a page that only leads somewhere, as Today does, where it leads; and where the
 * editor area has splits its menu opens the page in one.
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
        data-row
        aria-current={page.path === app.path || app.path.startsWith(`${page.path}/`) || (page.home && app.path === "/") ? "page" : undefined}
        aria-label={labelled ? undefined : page.label}
        title={labelled ? undefined : page.label}
        {...(page.transient === true ? {} : draggableAs(tab))}
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
            { label: "Open in a split right", icon: "split", action: () => openBeside(tab, "right") },
            { label: "Open in a split down", icon: "splitDown", action: () => openBeside(tab, "down") },
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
