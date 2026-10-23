import { readableName, type Folders, type ListedFolder } from "../../plugin-api.ts";
import { namable, pointed, sameName, startsWords } from "../lib/pointing.ts";

/** The longest name a folder may have, as folder.create takes it. */
const MOST_NAME = 100;

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

/**
 * The folder `@` offers to create for what was typed after it: a name, made at the top, or a path,
 * `Projects/Garden`, whose parts already there from the top down, ignoring case, are used again and
 * the rest made inside them. `parts` is each name, and `there` the folders of the first of them that
 * are there. Null where every part is there, or a part is no folder's name: empty, without a letter
 * or a digit, or too long.
 */
export function newFolderPath(typed: string, folders: Folders): { parts: string[]; there: ListedFolder[] } | null {
  if (!namable(typed)) return null;
  const parts = typed.split("/").map((part) => readableName(part.replace(/\s+/g, " ")));
  if (parts.some((part) => !/[\p{L}\p{N}]/u.test(part) || part.length > MOST_NAME)) return null;
  const there: ListedFolder[] = [];
  for (const part of parts) {
    const found = folders.childrenOf(there.at(-1)?.id ?? null).find((folder) => sameName(folder.name, part));
    if (!found) return { parts, there };
    there.push(found);
  }
  return null;
}
