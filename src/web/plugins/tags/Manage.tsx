import { useState, useSyncExternalStore } from "react";
import { MAX_TAG_DESCRIPTION, isTagName, nameKey, type App, type PluginHost } from "../../plugin-api.ts";
import { ManageTable, type Done, type ManageActions, type ManageItem } from "../lib/ManageTable.tsx";
import { DeleteTagDialog } from "./Deleting.tsx";
import { TAGS_PAGE, tagPath } from "./path.ts";
import { confirmation, notes, renamedWords, undoRename } from "./renaming.ts";
import { describes, type TagStore } from "./Tags.tsx";
import { inside, lastPart, parentOf, tagTree, type TagNode } from "./tree.ts";

const NOT_A_NAME = "That isn't a tag's name: letters, digits, _, / and -, with something besides digits.";

/**
 * Settings' Tags: every tag as a tree, `#project/alpha` inside `#project`, with what it is for and
 * how many notes have it or a tag inside it, said for the agents that choose tags and the people
 * resting on one. An admin or an editor says it here, renames a tag, moves it inside another, which
 * renames it, and makes one ahead that no note has yet. A rename that changes notes says what it
 * will change first, and Undo in the notice after takes it back. Deleting a tag asks first too, in
 * a dialog, with Undo after. A viewer and a guest read it and are given nothing to change.
 */
export function ManageTags({ host, app, store }: { host: PluginHost; app: App; store: TagStore }) {
  const tags = useSyncExternalStore(store.subscribe, store.tags);
  const more = useSyncExternalStore(store.subscribe, store.more);
  const indexing = useSyncExternalStore(store.subscribe, store.indexing);
  const may = describes(app);
  /** What a tag's menu or card asked for when it brought the member here. */
  const [asked] = useState(() => store.take());
  /** The tag Delete is asking about, and what to tell the table once it is answered. */
  const [deleting, setDeleting] = useState<{ name: string; answer: (gone: boolean) => void } | null>(null);
  if (!tags) return null;

  const nodes = new Map<string, TagNode>();
  const itemOf = (node: TagNode, depth: number): ManageItem => {
    nodes.set(node.key, node);
    const own = node.tag?.notes ?? 0;
    const all = node.tag?.inside ?? own;
    return {
      key: node.key,
      name: lastPart(node.name),
      label: depth ? lastPart(node.name) : `#${node.name}`,
      path: `#${node.name}`,
      description: node.tag?.description ?? "",
      notes: all,
      notesTitle: node.tag?.inside === undefined ? undefined : `${notes(own)} tagged #${node.name} itself, ${all} counting the tags inside it`,
      dragged: { kind: "page", id: TAGS_PAGE, path: tagPath(node.name) },
      may: { rename: may, describe: may, add: may, move: may, delete: may },
      children: node.children.map((child) => itemOf(child, depth + 1)),
    };
  };
  const roots = tagTree(tags).map((node) => itemOf(node, 0));
  const nameOf = (item: ManageItem) => nodes.get(item.key)!.name;

  /** Renames `from` to `to`, and the tags inside it with it: at once when no note changes, and otherwise once the member has read what will. */
  const renaming = async (from: string, to: string): Promise<Done> => {
    if (from === to) return { key: nameKey(to) };
    const plan = await host.perform({ type: "tag.rename", name: from, to, preview: true });
    const run = async () => {
      const done = await host.perform({ type: "tag.rename", name: from, to });
      await store.reload();
      app.notify({
        message: renamedWords(done),
        icon: "tag",
        action: {
          label: "Undo",
          run: () =>
            undoRename(host, done).then(
              async (notice) => (await store.reload(), notice),
              (err: unknown) => ({ message: err instanceof Error ? err.message : "The rename couldn't be undone." }),
            ),
        },
      });
      return nameKey(to);
    };
    if (!plan.renamed.length && !plan.skipped) return { key: await run() };
    return { confirm: { message: confirmation(plan), ...(plan.renamed.length ? { action: `Rename in ${notes(plan.renamed.length)}`, run } : {}) } };
  };

  const actions: ManageActions = {
    open: (item) => app.go(tagPath(nameOf(item))),
    rename: (item, name) => renaming(nameOf(item), inside(parentOf(nameOf(item)), name)),
    async describe(item, description) {
      await host.perform({ type: "tag.describe", name: nameOf(item), description });
      await store.reload();
    },
    async add(parent, name) {
      const tag = inside(parent && nameOf(parent), name);
      // Made ahead, a tag is one described with nothing, which would take away what is said of one there already: asked of the server, which knows the tags past the ones read.
      if ((await host.perform({ type: "tag.list", name: tag, includeArchived: true, limit: 1 })).tags.length) throw new Error(`#${tag} is already a tag.`);
      await host.perform({ type: "tag.describe", name: tag, description: "" });
      await store.reload();
      return nameKey(tag);
    },
    move: (item, to) => renaming(nameOf(item), inside(to && nameOf(to), item.name)),
    canMove: (item, to) => (to === null ? item.key.includes("/") : to.key !== item.key && !to.key.startsWith(`${item.key}/`) && to.key !== parentOf(item.key)),
    movedPath: (item, to) => `#${inside(to && nameOf(to), item.name)}`,
    problem: (name, parent) => (isTagName(inside(parent && nameOf(parent), name)) ? null : NOT_A_NAME),
    delete: (item) => new Promise((answer) => setDeleting({ name: nameOf(item), answer })),
  };

  return (
    <>
      <p className="soon">
        {may ? "Say when to use each tag. Agents choose tags by it, and it shows when you rest on a tag." : "What each tag is for. Agents choose tags by it. Admins and editors write it."}
      </p>
      {indexing && (
        <p className="soon" role="status">
          Still indexing notes. Some tags may be missing.
        </p>
      )}
      {!tags.length && <p className="soon">{may ? "No tags yet. Write #tag anywhere in a note to tag it, or make one here." : "No tags yet. Write #tag anywhere in a note to tag it."}</p>}
      {(tags.length > 0 || may) && (
        <ManageTable
          label="Tags"
          column="Tag"
          noun="tag"
          notesHeading="Notes with this tag or any tag inside it"
          adding={{ top: "New tag", inside: "New tag inside" }}
          icon="tag"
          roots={roots}
          top={may}
          partial={more !== null}
          describing={(item) => `When to use ${item.path}`}
          maxDescription={MAX_TAG_DESCRIPTION}
          actions={actions}
          opening={asked && { key: nameKey(asked.name), kind: may ? asked.kind : null }}
        />
      )}
      {more && (
        <button type="button" className="button small" onClick={more}>
          Show more
        </button>
      )}
      {deleting && (
        <DeleteTagDialog
          host={host}
          app={app}
          store={store}
          name={deleting.name}
          onClose={(gone) => {
            setDeleting(null);
            deleting.answer(gone);
          }}
        />
      )}
    </>
  );
}
