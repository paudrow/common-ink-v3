import { useEffect, useId, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useNow, type App, type ListedTag, type NoteSummary, type PluginHost } from "../../plugin-api.ts";
import { FoundNote, IncludeArchived, opening, reasonOf } from "../lib/FoundNote.tsx";
import { TAGS_PATH, tagOfPath, tagPath } from "./path.ts";

/** The workspace's tags as the plugin last read them, and a count that goes up each time the notes have changed and settled. */
export interface TagStore {
  subscribe(listener: () => void): () => void;
  /** Null until they have been read once. */
  tags(): readonly ListedTag[] | null;
  /** Whether the server said it hasn't read every note yet, so tags and their notes may be missing. They are read again until it has. */
  indexing(): boolean;
  version(): number;
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

const going = (app: App, path: string) => ({
  href: path,
  onClick(e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    app.go(path);
  },
});

function TagLinks({ app, tags, labelledBy }: { app: App; tags: readonly ListedTag[]; labelledBy: string }) {
  return (
    <ul className="tag-rows" aria-labelledby={labelledBy}>
      {tags.map((tag) => (
        <li key={tag.name}>
          <a className="tag-row" aria-current={app.path === tagPath(tag.name) ? "page" : undefined} {...going(app, tagPath(tag.name))}>
            <span className="tag-name">#{tag.name}</span>
            <span className="count" aria-label={`${tag.notes} ${tag.notes === 1 ? "note" : "notes"}`}>
              {tag.notes}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The sidebar's section: each tag with how many notes have it, which opens the tag's page. */
export function TagSection({ app, store }: { app: App; store: TagStore }) {
  const ids = useId();
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  if (!tags) return null;
  return (
    <nav className="tags" aria-labelledby={`${ids}-label`}>
      <div className="section-head">
        <span id={`${ids}-label`}>Tags</span>
      </div>
      {tags && (tags.length ? <TagLinks app={app} tags={tags.slice(0, MOST_IN_SECTION)} labelledBy={`${ids}-label`} /> : <p className="tags-hint">Write #tag in a note to tag it.</p>)}
      {tags && tags.length > MOST_IN_SECTION && (
        <a className="tag-row tags-all" {...going(app, TAGS_PATH)}>
          All {tags.length} tags
        </a>
      )}
    </nav>
  );
}

type Listing = { notes: readonly NoteSummary[] | null; problem: string | null };

/** The notes with one tag. The tag is whatever the address says, drawn as text and asked of the server as a name. */
function TagNotes({ host, app, store, tag }: { host: PluginHost; app: App; store: TagStore; tag: string }) {
  const now = useNow();
  const version = useSyncExternalStore(store.subscribe, store.version);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [{ notes, problem }, setListing] = useState<Listing>({ notes: null, problem: null });

  useEffect(() => {
    let stale = false;
    host.perform({ type: "note.list", tag, includeArchived }).then(
      (listed) => !stale && setListing({ notes: listed, problem: null }),
      (err: unknown) => !stale && setListing({ notes: null, problem: reasonOf(err) }),
    );
    return () => {
      stale = true;
    };
  }, [host, tag, includeArchived, version]);

  return (
    <section className="search-page" aria-label={`Tag ${tag}`}>
      <h1>#{tag}</h1>
      <div className="search-tools">
        <IncludeArchived checked={includeArchived} onChange={setIncludeArchived} />
      </div>
      <StillIndexing store={store} />
      {problem && (
        <p className="search-status" role="alert">
          {problem}
        </p>
      )}
      {notes && !notes.length && <p className="search-status">No notes have #{tag}. {includeArchived ? "Archived notes were included." : "Archived notes are left out unless you include them."}</p>}
      {notes && notes.length > 0 && (
        <ul className="found-list" aria-label={`Notes with #${tag}`}>
          {notes.map((note) => (
            <li key={note.id}>
              <a className="found-note" {...opening(app, note)}>
                <FoundNote app={app} note={note} now={now} />
                {note.snippet && <span className="found-line">{note.snippet}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every tag, at `/tags`. */
function AllTags({ app, store }: { app: App; store: TagStore }) {
  const ids = useId();
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  return (
    <section className="search-page" aria-labelledby={`${ids}-heading`}>
      <h1 id={`${ids}-heading`}>Tags</h1>
      <StillIndexing store={store} />
      {tags && !tags.length && <p className="search-status">No tags yet. Write #tag anywhere in a note to tag it.</p>}
      {tags && tags.length > 0 && <TagLinks app={app} tags={tags} labelledBy={`${ids}-heading`} />}
    </section>
  );
}

export function TagsPage({ host, app, store }: { host: PluginHost; app: App; store: TagStore }) {
  const tag = tagOfPath(app.path);
  // A page of its own for each tag, so one tag's notes are never shown under another's name.
  return tag === null ? <AllTags app={app} store={store} /> : <TagNotes key={tag} host={host} app={app} store={store} tag={tag} />;
}
