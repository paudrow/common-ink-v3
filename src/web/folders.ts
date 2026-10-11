import type { ListedFolder, Results } from "../core/protocol.ts";
import type { Folders } from "./plugin-api.ts";

export function folderTree({ unsortedId, folders }: Results["folder.list"]): Folders {
  const children = new Map<string | null, ListedFolder[]>();
  for (const folder of folders) {
    const siblings = children.get(folder.parentId) ?? [];
    if (folder.id === unsortedId) siblings.unshift(folder);
    else siblings.push(folder);
    children.set(folder.parentId, siblings);
  }
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id: string | null) => {
    const path: ListedFolder[] = [];
    for (let folder = id ? byId.get(id) : undefined; folder; folder = folder.parentId ? byId.get(folder.parentId) : undefined) path.unshift(folder);
    return path;
  };
  return {
    unsortedId,
    byId,
    childrenOf: (id) => children.get(id) ?? [],
    pathOf,
    pathName: (id) =>
      id === null
        ? "Shared with me"
        : pathOf(id)
            .map((f) => f.name)
            .join(" / "),
  };
}
