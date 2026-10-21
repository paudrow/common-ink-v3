import { useId, useState, useSyncExternalStore, type MouseEvent } from "react";
import { ALL_NOTES, isTagName, nameKey, type App, type ListedTag, type Opened, type PluginHost } from "../../plugin-api.ts";
import { ContextMenu, type MenuItem } from "../lib/Menu.tsx";
import { NoteFinder, type keeping } from "../noteList.tsx";
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
  version(): number;
  /** Reads the tags again, as after a description was said or a tag renamed. */
  reload(): void;
  /** Asks Settings' Tags to open one tag's row, to say what it is for, the next time it is drawn. */
  ask(request: TagRequest): void;
  /** What was asked, once. */
  take(): TagRequest | null;
}

/** What a tag's menu asks of its row in Settings' Tags. */
export interface TagRequest {
  name: string;
  kind: "describe";
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

/** What a tag's menu offers, as a folder's does: to open its page, in a split too where there are splits, and for whoever may, to describe it. */
function tagMenu(app: App, store: TagStore, name: string): MenuItem[] {
  const tab: Opened = { kind: "page", id: TAGS_PAGE, path: tagPath(name) };
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
    ...(describes(app) ? [{ label: "Describe tag", icon: "edit" as const, action: toRow({ name, kind: "describe" }) }] : []),
  ];
}

/**
 * Each tag, which opens its page. `described` shows each one's description under it, where there is room for it.
 * A right-click, Shift+F10 or the menu key opens its menu, as a folder's row does.
 */
function TagLinks({ app, store, tags, labelledBy, described = false }: { app: App; store: TagStore; tags: readonly ListedTag[]; labelledBy: string; described?: boolean }) {
  const [menu, setMenu] = useState<{ name: string; x: number; y: number; from: HTMLElement } | null>(null);
  return (
    <ul className="tag-rows" aria-labelledby={labelledBy}>
      {tags.map((tag) => (
        <li key={tag.name}>
          <a
            className="tag-row"
            data-tag={tag.name}
            data-tag-card="beside"
            aria-current={app.path === tagPath(tag.name) ? "page" : undefined}
            {...going(app, tagPath(tag.name))}
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
            <span className="count" aria-label={`${tag.notes} ${tag.notes === 1 ? "note" : "notes"}`}>
              {tag.notes}
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
          items={tagMenu(app, store, menu.name)}
          onClose={() => {
            // An item that goes somewhere takes the keyboard there after this.
            if (menu.from.isConnected) menu.from.focus();
            setMenu(null);
          }}
        />
      )}
    </ul>
  );
}

/** Who may say what a tag is for, and rename it: a member who may change things, and not a guest, whom the server refuses. */
export const describes = (app: App) => app.workspace.role === "admin" || app.workspace.role === "editor";

/**
 * The sidebar's section: each tag with how many notes have it, which opens the tag's page. A tag made
 * ahead that no note has yet is left to the page of every tag and Settings: there is nothing to open.
 */
export function TagSection({ app, store }: { app: App; store: TagStore }) {
  const ids = useId();
  const every = useSyncExternalStore(store.subscribe, store.tags);
  const more = useSyncExternalStore(store.subscribe, store.more);
  if (!every) return null;
  const tags = every.filter((tag) => tag.notes > 0);
  return (
    <nav className="tags" aria-labelledby={`${ids}-label`}>
      <div className="section-head">
        <span id={`${ids}-label`}>Tags</span>
      </div>
      {tags && (tags.length ? <TagLinks app={app} store={store} tags={tags.slice(0, MOST_IN_SECTION)} labelledBy={`${ids}-label`} /> : <p className="tags-hint">Write #tag in a note to tag it.</p>)}
      {tags && (tags.length > MOST_IN_SECTION || more) && (
        <a className="tag-row tags-all" {...going(app, TAGS_PATH)}>
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
function AllTags({ app, store }: { app: App; store: TagStore }) {
  const ids = useId();
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  const more = useSyncExternalStore(store.subscribe, store.more);
  return (
    <section className="search-page" aria-labelledby={`${ids}-heading`}>
      <div className="tags-head">
        <h1 id={`${ids}-heading`}>Tags</h1>
        <a className="button small" {...going(app, MANAGE_PATH)}>
          Manage tags
        </a>
      </div>
      <StillIndexing store={store} />
      {tags && !tags.length && <p className="search-status">No tags yet. Write #tag anywhere in a note to tag it.</p>}
      {tags && tags.length > 0 && <TagLinks app={app} store={store} tags={tags} labelledBy={`${ids}-heading`} described />}
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
  // A page of its own for each tag, so one tag's notes are never shown under another's name.
  return tag === null ? <AllTags app={app} store={store} /> : <TagNotes key={tag} host={host} app={app} store={store} lists={lists} tag={tag} />;
}
