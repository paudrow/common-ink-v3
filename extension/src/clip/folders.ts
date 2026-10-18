export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
  access: "view" | "edit";
  noteCount: number;
  uploadCount: number;
}

export interface FolderList {
  unsortedId: string | null;
  folders: readonly Folder[];
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
}

export function filterFolders(list: FolderList, query: string): readonly Folder[] {
  const editable = list.folders.filter((folder) => folder.access === "edit");
  const needle = fold(query.trim());
  if (!needle) {
    const unsorted = editable.filter((folder) => folder.id === list.unsortedId);
    const rest = editable.filter((folder) => folder.id !== list.unsortedId).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
    return [...unsorted, ...rest];
  }
  return editable.filter((folder) => fold(folder.path).includes(needle));
}

export function defaultFolder(list: FolderList, last: { workspaceId: string; folderId: string } | null, workspaceId: string): string | null {
  const editable = new Set(list.folders.filter((folder) => folder.access === "edit").map((folder) => folder.id));
  if (last && last.workspaceId === workspaceId && editable.has(last.folderId)) return last.folderId;
  if (list.unsortedId && editable.has(list.unsortedId)) return list.unsortedId;
  return list.folders.find((folder) => editable.has(folder.id))?.id ?? null;
}

export function defaultWorkspace(workspaces: readonly Workspace[], lastId: string | null): string | null {
  if (lastId && workspaces.some((workspace) => workspace.id === lastId)) return lastId;
  return workspaces.length === 1 ? workspaces[0]!.id : (workspaces[0]?.id ?? null);
}

function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}
