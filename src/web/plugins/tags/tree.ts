import { nameKey, type ListedTag } from "../../plugin-api.ts";

/** A tag in the tree of tags, which `/` nests: `#project/alpha` is inside `#project`. */
export interface TagNode {
  /** Its whole name in lower case, which matches it. */
  key: string;
  /** Its whole name as written. */
  name: string;
  /** The tag as listed, or null for one no note has and nothing is said of, which is there for the tags inside it. */
  tag: ListedTag | null;
  children: TagNode[];
}

/** The tags as a tree, each inside the tag its name starts with. One that isn't listed is made for the tags inside it, named as the first of them writes it. */
export function tagTree(tags: readonly ListedTag[]): TagNode[] {
  const roots: TagNode[] = [];
  const byKey = new Map<string, TagNode>();
  const nodeOf = (parts: string[]): TagNode => {
    const name = parts.join("/");
    const key = nameKey(name);
    const found = byKey.get(key);
    if (found) return found;
    const node: TagNode = { key, name, tag: null, children: [] };
    byKey.set(key, node);
    (parts.length > 1 ? nodeOf(parts.slice(0, -1)).children : roots).push(node);
    return node;
  };
  for (const tag of tags) {
    const node = nodeOf(tag.name.split("/"));
    node.tag = tag;
    node.name = tag.name;
  }
  return roots;
}

/** The last part of a tag's name, which its row shows inside the tag it is in. */
export const lastPart = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** The name of the tag `name` is inside, or null at the top. */
export const parentOf = (name: string) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : null);

/** The name `part` has inside the tag `parent`, or at the top for null. A `#` typed before it is left off. */
export const inside = (parent: string | null, part: string) => (parent === null ? "" : `${parent}/`) + part.replace(/^#/, "");
