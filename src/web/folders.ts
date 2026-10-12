import type { ListedFolder, Results } from "../core/protocol.ts";

/** A workspace's folders, indexed for drawing the tree and naming a folder's path. */
export interface FolderTree {
  unsortedId: string;
  byId: ReadonlyMap<string, ListedFolder>;
  /** Children in display order; at the top level, Unsorted comes first. */
  childrenOf: (parentId: string | null) => readonly ListedFolder[];
}

export function folderTree({ unsortedId, folders }: Results["folder.list"]): FolderTree {
  const children = new Map<string | null, ListedFolder[]>();
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? [];
    if (folder.id === unsortedId) siblings.unshift(folder);
    else siblings.push(folder);
    children.set(folder.parentId, siblings);
  }
  return { unsortedId, byId: new Map(folders.map((f) => [f.id, f])), childrenOf: (id) => children.get(id) ?? [] };
}

/** What stands for a folder where the notes listed are every note the member can see. */
export const ALL_NOTES = "all";

/** What a folder's list is called. Null for a folder that isn't there, or that the member can't see. */
export const folderTitle = (tree: FolderTree, folderId: string): string | null => (folderId === ALL_NOTES ? "All notes" : (tree.byId.get(folderId)?.name ?? null));

/** The folder and its ancestors, outermost first. */
export function pathOf(tree: FolderTree, id: string): ListedFolder[] {
  const path: ListedFolder[] = [];
  for (let folder = tree.byId.get(id); folder; folder = folder.parentId ? tree.byId.get(folder.parentId) : undefined) path.unshift(folder);
  return path;
}

export const pathName = (tree: FolderTree, id: string) =>
  pathOf(tree, id)
    .map((f) => f.name)
    .join(" / ");
