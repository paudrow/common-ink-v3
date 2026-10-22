import type { Folders, ListedFolder } from "../../plugin-api.ts";
import { namable, pointed, startsWords } from "../lib/pointing.ts";

/**
 * The folders `@` offers for what was typed after it. Without a slash, those with a word of their
 * name starting with each word typed, as for notes. With one, it is a path: the last part is matched
 * so against the folder's name, and each part before it, in order, against the folders it is in, so
 * `proj/gar` finds Projects/Garden. A last part left empty, as in `proj/`, is every folder inside.
 */
export function foldersAt(typed: string, folders: Folders): ListedFolder[] {
  const all = [...folders.byId.values()];
  if (!typed.includes("/")) return pointed(all, typed, (folder) => folder.name);
  if (!namable(typed)) return [];
  const parts = typed.split("/");
  const last = parts.pop()!;
  const inside = (folder: ListedFolder) => {
    let at = 0;
    for (const above of folders.pathOf(folder.id).slice(0, -1)) if (at < parts.length && startsWords(parts[at]!, [above.name])) at++;
    return at === parts.length;
  };
  const found = all.filter(inside);
  return last.trim() ? pointed(found, last, (folder) => folder.name) : found;
}
