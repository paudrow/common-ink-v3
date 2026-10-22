import { useEffect, useState, useSyncExternalStore, type MouseEvent } from "react";
import { nameKey, type App, type ListedTag, type PluginHost } from "../../plugin-api.ts";
import { hoverCards, type HoverCards } from "../lib/hoverCard.tsx";
import { MANAGE_PATH, tagPath } from "./path.ts";
import { describes, going, type TagStore } from "./Tags.tsx";

export type { Showing } from "../lib/hoverCard.tsx";
export type TagCards = HoverCards;

/**
 * The card a tag shows while it is pointed at or has the keyboard, wherever it is drawn: anything
 * marked `data-tag` with the tag's name, as a tag in a note, a todo's chip and the sidebar's rows are.
 * It says how many notes have the tag and what it is for. With nothing said, it asks whoever may say
 * it to, with a link to its row in Settings, and shows anyone else the name and count alone.
 */
export const tagCards = (host: PluginHost, store: TagStore): TagCards => hoverCards("tag", (name, close) => <TagCard host={host} store={store} name={name} onClose={close} />);

/** The tag as the plugin last read it, or as the server says it alone when it is past the tags read. Undefined until known. */
function useTag(host: PluginHost, store: TagStore, name: string): ListedTag | null | undefined {
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  const listed = tags?.find((t) => nameKey(t.name) === nameKey(name));
  const [asked, setAsked] = useState<ListedTag | null | undefined>(undefined);
  useEffect(() => {
    if (listed || !tags) return;
    let live = true;
    host.perform({ type: "tag.list", name, includeArchived: true, limit: 1 }).then(
      ({ tags }) => live && setAsked(tags[0] ?? null),
      () => live && setAsked(null),
    );
    return () => {
      live = false;
    };
  }, [host, name, !!listed, !!tags]);
  return listed ?? asked;
}

function TagCard({ host, store, name, onClose }: { host: PluginHost; store: TagStore; name: string; onClose: () => void }) {
  const tag = useTag(host, store, name);
  const app: App = host.app();
  const shownName = tag?.name ?? name;
  // A tag's notes are those of the tags inside it too, as its page lists them.
  const count = tag?.inside ?? tag?.notes ?? 0;
  const leave = (path: string, before?: () => void) => {
    const link = going(app, path);
    return {
      ...link,
      onClick(e: MouseEvent) {
        // Only a plain click goes there here; a modified one opens a new tab, which asks nothing of this one's Settings.
        if (!(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) before?.();
        link.onClick(e);
        onClose();
      },
    };
  };
  return (
    <>
      <div className="hover-card-head">
        <a className="hover-card-name" {...leave(tagPath(shownName))}>
          #{shownName}
        </a>
        {tag !== undefined && <span className="hover-card-count">{`${count} ${count === 1 ? "note" : "notes"}`}</span>}
      </div>
      {tag?.description ? (
        <p className="hover-card-description">{tag.description}</p>
      ) : (
        tag !== undefined && describes(app) && <p className="hover-card-none">No description yet. Add one to help AI use #{shownName} right.</p>
      )}
      {tag !== undefined && describes(app) && (
        <a className="hover-card-manage" {...leave(MANAGE_PATH, () => store.ask({ name: shownName, kind: null }))}>
          Manage tags
        </a>
      )}
    </>
  );
}
