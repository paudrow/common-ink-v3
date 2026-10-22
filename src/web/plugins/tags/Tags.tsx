import { useEffect, useId, useState, useSyncExternalStore, type MouseEvent } from "react";
import { ALL_NOTES, draggableAs, isTagName, nameKey, type App, type ListedTag, type Opened, type PluginHost } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { NoteFinder, type keeping } from "../noteList.tsx";
import { DeleteTagDialog } from "./Deleting.tsx";
import { listReducer, taggedQuery } from "../noteListView.ts";
import { addressOf } from "../search/request.ts";
import { MANAGE_PATH, TAGS_PAGE, TAGS_PATH, tagOfPath, tagPath } from "./path.ts";

/** The workspace's tags as the plugin last read them, and a count that goes up each time the notes have changed and settled. */
export interface TagStore {
  subscribe(listener: () => void): () => void;
  /** Null until they have been read once. */
  tags(): readonly ListedTag[] | null;
  /** Whether there are tags after the ones read, which `more` reads. */
  more(): (() => void) | null;
  /** Whether the server said it hasn't read every note yet, so tags and their notes may be missing. They are read again until it has. */
  indexing(): boolean;
  /** Why the last read of the tags failed, until one is read. */
  unread(): string | null;
  /** Reads the tags again if the last read failed. */
  wanted(): void;
  version(): number;
  /** Reads the tags again, as after a description was said or a tag renamed, done once they are read. */
  reload(): Promise<void>;
  /** Asks Settings' Tags to bring one tag's row into view with the keyboard on it, or to rename it, the next time it is drawn. */
  ask(request: TagRequest): void;
  /** What was asked, once. */
  take(): TagRequest | null;
}

/** What a tag's menu or card asks of its row in Settings' Tags: the row, being renamed when `kind` is "rename". */
export interface TagRequest {
  name: string;
  kind: "rename" | null;
}

/** How many tags the sidebar lists before it leaves the rest to the page of every tag. */
const MOST_IN_SECTION = 12;
function StillIndexing({ store }: { store: TagStore }) {
  const indexing = useSyncExternalStore(store.subscribe, store.indexing);
  return indexing ? (
    <p className="search-status" role="status">
      Still indexing notes. Results may be missing some.
    </p>
  ) : null;
}

export const going = (app: App, path: string) => ({
  href: path,
  onClick(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    app.go(path);
  },
});

const tagTab = (name: string) => ({ kind: "page", id: TAGS_PAGE, path: tagPath(name) }) satisfies Opened;

/** What a tag's menu offers, as a folder's does: to open its page, in a split too where there are splits, to go to its row in Settings, and for whoever may, to rename it there or delete it. */
function tagMenu(app: App, store: TagStore, name: string, remove: () => void): MenuItem[] {
  const tab = tagTab(name);
  const { openBeside } = app;
  const toRow = (request: TagRequest) => () => {
    store.ask(request);
    app.go(MANAGE_PATH);
  };
  return [
    { label: "Open", icon: "tag", action: () => app.go(tab.path) },
    ...(openBeside
      ? [
          { label: "Open in a split right", icon: "split" as const, action: () => openBeside(tab, "right") },
          { label: "Open in a split down", icon: "splitDown" as const, action: () => openBeside(tab, "down") },
        ]
      : []),
    { label: "Manage tags", icon: "settings", action: toRow({ name, kind: null }) },
    ...(describes(app)
      ? [
          { label: "Rename tag", icon: "edit" as const, action: toRow({ name, kind: "rename" }) },
          { label: "Delete tag", icon: "trash" as const, action: remove },
        ]
      : []),
  ];
}

/**
 * Each tag, which opens its page. `described` shows each one's description under it, where there is room for it.
 * A right-click, Shift+F10 or the menu key opens its menu, and it drags to the editor area, as a folder's row does.
 */
function TagLinks({ host, app, store, tags, labelledBy, described = false }: { host: PluginHost; app: App; store: TagStore; tags: readonly ListedTag[]; labelledBy: string; described?: boolean }) {
  const [menu, setMenu] = useState<{ name: string; x: number; y: number; from: HTMLElement } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <>
      <ul className="tag-rows" aria-labelledby={labelledBy}>
        {tags.map((tag) => (
          <li key={tag.name}>
            <a
              className="tag-row"
              data-tag={tag.name}
              data-tag-card="beside"
              aria-current={app.path === tagPath(tag.name) ? "page" : undefined}
              {...going(app, tagPath(tag.name))}
              {...draggableAs(tagTab(tag.name))}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ name: tag.name, x: e.clientX, y: e.clientY, from: e.currentTarget });
              }}
              onKeyDown={(e) => {
                if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
                // From the keyboard the menu opens under the row.
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                setMenu({ name: tag.name, x: box.left, y: box.bottom, from: e.currentTarget });
              }}
            >
              <span className="tag-name">#{tag.name}</span>
              <span className="count" aria-label={`${tag.inside ?? tag.notes} ${(tag.inside ?? tag.notes) === 1 ? "note" : "notes"}`}>
                {tag.inside ?? tag.notes}
              </span>
            </a>
            {described && tag.description && <p className="tag-row-description">{tag.description}</p>}
          </li>
        ))}
        {menu && (
          <ContextMenu
            label={`#${menu.name} actions`}
            x={menu.x}
            y={menu.y}
            items={tagMenu(app, store, menu.name, () => setDeleting(menu.name))}
            onClose={() => {
              // An item that goes somewhere takes the keyboard there after this.
              if (menu.from.isConnected) menu.from.focus();
              setMenu(null);
            }}
          />
        )}
      </ul>
      {deleting && <DeleteTagDialog host={host} app={app} store={store} name={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

/** Who may say what a tag is for, rename it and delete it: a member who may change things, and not a guest, whom the server refuses. */
export const describes = (app: App) => app.workspace.role === "admin" || app.workspace.role === "editor";

/**
 * The sidebar's section: each tag with how many notes have it, which opens the tag's page. A tag made
 * ahead that no note has yet is left to the page of every tag and Settings: there is nothing to open.
 */
export function TagSection({ host, app, store }: { host: PluginHost; app: App; store: TagStore }) {
  const ids = useId();
  const every = useSyncExternalStore(store.subscribe, store.tags);
  const more = useSyncExternalStore(store.subscribe, store.more);
  // Coming back to the window asks again for tags that couldn't be read.
  useEffect(() => {
    const cameBack = () => document.visibilityState === "visible" && store.wanted();
    addEventListener("focus", cameBack);
    document.addEventListener("visibilitychange", cameBack);
    return () => {
      removeEventListener("focus", cameBack);
      document.removeEventListener("visibilitychange", cameBack);
    };
  }, [store]);
  if (!every) return null;
  const tags = every.filter((tag) => tag.notes > 0);
  return (
    <nav className="tags" aria-labelledby={`${ids}-label`}>
      <div className="section-head">
        <span id={`${ids}-label`}>Tags</span>
      </div>
      {tags && (tags.length ? <TagLinks host={host} app={app} store={store} tags={tags.slice(0, MOST_IN_SECTION)} labelledBy={`${ids}-label`} /> : <p className="tags-hint">Write #tag in a note to tag it.</p>)}
      {tags && (tags.length > MOST_IN_SECTION || more) && (
        <a className="tag-row tags-all" {...going(app, TAGS_PATH)} {...draggableAs({ kind: "page", id: TAGS_PAGE, path: TAGS_PATH })}>
          {more ? "All tags" : `All ${every.length} tags`}
        </a>
      )}
    </nav>
  );
}

/** How each tag's list was left, kept by the tag ignoring case. */
export type TagLists = ReturnType<typeof keeping>;

/**
 * The notes with one tag: a folder's list, with its search bar and cards, of the notes with the tag,
 * the tag held in the search field as a folder is. The tag is whatever the address says, drawn as
 * text. One that can't be a tag's name has no notes, and nothing is asked.
 */
function TagNotes({ host, app, store, lists, tag }: { host: PluginHost; app: App; store: TagStore; lists: TagLists; tag: string }) {
  const ids = useId();
  const key = nameKey(tag);
  const version = useSyncExternalStore(store.subscribe, store.version);
  const view = useSyncExternalStore(lists.subscribe, () => lists.of(key).view);
  if (!isTagName(tag))
    return (
      <section className="search-page" aria-labelledby={`${ids}-heading`}>
        <h1 id={`${ids}-heading`}>#{tag}</h1>
        <p className="search-status">No notes have #{tag}.</p>
      </section>
    );
  return (
    <NoteFinder
      app={app}
      host={host}
      folderId={ALL_NOTES}
      tag={tag}
      readNote={app.readNote}
      snippets
      view={view}
      act={(action) => lists.set(key, listReducer(lists.of(key).view, action))}
      kept={lists.of(key)}
      again={version}
      onWiden={() => app.go(addressOf(taggedQuery(tag, lists.of(key).view.query)))}
    />
  );
}

/** Every tag, at `/tags`. */
function AllTags({ host, app, store }: { host: PluginHost; app: App; store: TagStore }) {
  const ids = useId();
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  const more = useSyncExternalStore(store.subscribe, store.more);
  const unread = useSyncExternalStore(store.subscribe, store.unread);
  return (
    <section className="search-page" aria-labelledby={`${ids}-heading`}>
      <div className="tags-head">
        <h1 id={`${ids}-heading`}>Tags</h1>
        <a className="button small" {...going(app, MANAGE_PATH)}>
          Manage tags
        </a>
      </div>
      <StillIndexing store={store} />
      {unread && (
        <p className="search-status" role="alert">
          {unread}{" "}
          <button type="button" className="found-more" onClick={store.wanted}>
            Try again
          </button>
        </p>
      )}
      {tags && !tags.length && <p className="search-status">No tags yet. Write #tag anywhere in a note to tag it.</p>}
      {tags && tags.length > 0 && <TagLinks host={host} app={app} store={store} tags={tags} labelledBy={`${ids}-heading`} described />}
      {more && (
        <div className="search-more">
          <button type="button" className="found-more" onClick={more}>
            Show more
          </button>
        </div>
      )}
    </section>
  );
}

export function TagsPage({ host, app, store, lists }: { host: PluginHost; app: App; store: TagStore; lists: TagLists }) {
  const tag = tagOfPath(app.path);
  useEffect(() => store.wanted(), [store, tag]);
  // A page of its own for each tag, so one tag's notes are never shown under another's name.
  return tag === null ? <AllTags host={host} app={app} store={store} /> : <TagNotes key={tag} host={host} app={app} store={store} lists={lists} tag={tag} />;
}
