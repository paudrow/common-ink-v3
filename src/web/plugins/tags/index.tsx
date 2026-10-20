import type { ListedTag, Plugin } from "../../plugin-api.ts";
import { tagDrawing } from "./drawing.ts";
import { TAGS_PATH, tagPath } from "./path.ts";
import { TagSection, TagsPage, type TagStore } from "./Tags.tsx";

/** How long the notes are left to settle before the tags are read again, so typing doesn't ask once a save. */
const SETTLE_MS = 1000;
/** How long before the tags are read again when the server answered while still indexing. Each read indexes more. */
const INDEXING_PAUSE_MS = 1500;
/** How many tags a read lists, and the most it lists read again after Show more. They are tag.list's own. */
const PAGE = 200;
const MOST = 1000;

/**
 * Tags. A `#tag` anywhere in a note tags the note. The sidebar lists the workspace's tags with how
 * many notes have each, a tag's page lists its notes, and a tag in a note is drawn as one.
 */
export const tags: Plugin = {
  id: "tags",
  name: "Tags",
  description: "A #tag in a note tags it: the sidebar lists every tag, and each has a page of its notes.",
  icon: "tag",
  activate(host) {
    let listed: readonly ListedTag[] | null = null;
    /** Reads the tags after the ones listed, while there are more. */
    let more: (() => void) | null = null;
    let indexing = false;
    let version = 0;
    let again: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<() => void>();
    const tell = () => listeners.forEach((listener) => listener());

    /** What a read of the tags says, from the start or after the ones listed: the tags after are read only on asking. */
    const take = (mine: number, answer: { tags: readonly ListedTag[]; next: string | null; indexing: boolean }, after: readonly ListedTag[]) => {
      if (mine !== version) return;
      listed = [...after, ...answer.tags];
      indexing = answer.indexing;
      const next = answer.next;
      more =
        next === null
          ? null
          : () => {
              more = null;
              tell();
              const reading = version;
              host.perform({ type: "tag.list", limit: PAGE, after: next }).then(
                (page) => take(reading, page, listed ?? []),
                () => {},
              );
            };
      if (indexing) again = setTimeout(read, INDEXING_PAUSE_MS);
      tell();
    };

    const read = () => {
      const mine = ++version;
      clearTimeout(again);
      tell();
      // Read again, as many tags are read as were listed, so the ones Show more brought stay.
      host.perform({ type: "tag.list", limit: Math.min(MOST, Math.max(PAGE, listed?.length ?? 0)) }).then(
        (answer) => take(mine, answer, []),
        () => {},
      );
    };

    const store: TagStore = {
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      tags: () => listed,
      more: () => more,
      indexing: () => indexing,
      version: () => version,
    };

    // A note's tags are in its text, so they can have changed whenever a note has: written, archived, trashed, or put back.
    let summary: string | null = null;
    let settling: ReturnType<typeof setTimeout> | undefined;
    const offNotes = host.onItems(() => {
      const notes = host.app().notes;
      if (!notes) return;
      const now = notes.map((n) => `${n.id}:${n.revision}:${n.state}`).join(",");
      if (now === summary) return;
      const first = summary === null;
      summary = now;
      clearTimeout(settling);
      if (first) read();
      else settling = setTimeout(read, SETTLE_MS);
    });

    host.views.register("section", { id: "tags", label: "Tags", icon: "tag", component: ({ app }) => <TagSection app={app} store={store} /> });
    host.views.register("page", { id: "tags", path: TAGS_PATH, label: "Tags", component: ({ app }) => <TagsPage host={host} app={app} store={store} /> });
    host.editorExtensions.register({ id: "tags", extension: tagDrawing((name) => host.app().go(tagPath(name))) });

    return () => {
      offNotes();
      clearTimeout(settling);
      clearTimeout(again);
      // An answer still on its way is for a plugin that is off, and asks nothing more.
      version++;
    };
  },
};
