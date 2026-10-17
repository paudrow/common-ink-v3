import type { Folders } from "../../plugin-api.ts";

/** Where a folder can go: inside the folder with this id, or null for the top of the workspace. */
export type Place = string | null;

/**
 * Whether the member may move folder `id` to `place`, as the server decides it: they can edit the
 * folder, the folder it is in and where it goes, it isn't Unsorted, it doesn't go inside itself or a folder in it, and it
 * isn't there already. `top` is whether they have the top of the workspace, which a guest hasn't;
 * without it, nor may they move a folder that sits there for them, among folders they can't see.
 */
export function canMove(tree: Folders, id: string, place: Place, top: boolean): boolean {
  const folder = tree.byId.get(id);
  if (!folder || folder.access !== "edit" || id === tree.unsortedId || folder.parentId === place) return false;
  if (folder.parentId === null ? !top : tree.byId.get(folder.parentId)?.access !== "edit") return false;
  if (place === null) return top;
  const into = tree.byId.get(place);
  return into?.access === "edit" && !tree.pathOf(place).some((f) => f.id === id);
}

/** Every place folder `id` can go, the top first and then the folders in tree order. */
export function placesFor(tree: Folders, id: string, top: boolean): Place[] {
  const places: Place[] = [];
  const visit = (parentId: string | null) => {
    for (const folder of tree.childrenOf(parentId)) {
      if (canMove(tree, id, folder.id, top)) places.push(folder.id);
      visit(folder.id);
    }
  };
  visit(null);
  return canMove(tree, id, null, top) ? [null, ...places] : places;
}

/** The folders that can go somewhere, in tree order. */
export function movable(tree: Folders, top: boolean): string[] {
  const found: string[] = [];
  const visit = (parentId: string | null) => {
    for (const folder of tree.childrenOf(parentId)) {
      if (placesFor(tree, folder.id, top).length) found.push(folder.id);
      visit(folder.id);
    }
  };
  visit(null);
  return found;
}
