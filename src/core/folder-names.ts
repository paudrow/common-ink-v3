/** What two folder names in one parent must not share: the name ignoring case, in every script. */
export const nameKey = (name: string) => name.normalize("NFC").toLowerCase();

/** What a lookup by name matches: the name ignoring case and accents, so "cafe" finds "Café". */
const looseKey = (name: string) => name.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();

interface Placed {
  id: string;
  name: string;
  parentId: string | null;
}

/** Each folder's path, its name after those of the folders it is in, as far up as the one asking can see. */
export function pathsOf(folders: readonly Placed[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const pathOf = (folder: Placed, depth = 0): string => {
    const known = paths.get(folder.id);
    if (known !== undefined) return known;
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    const path = parent && depth < folders.length ? `${pathOf(parent, depth + 1)}/${folder.name}` : folder.name;
    paths.set(folder.id, path);
    return path;
  };
  for (const folder of folders) pathOf(folder);
  return paths;
}

/** A path as it is matched: its names trimmed, and empty ones, as from a leading or doubled /, left out. */
const namesIn = (path: string) => path.split("/").map((name) => name.trim()).filter(Boolean);

/**
 * The folders at `path`, such as "Projects/Skills", matched as written, then ignoring case, then
 * ignoring accents too: the first of those that matches any folder decides, so "skills" finds
 * "Skills" unless there is also a "skills".
 */
export function atPath<T extends { path: string }>(folders: readonly T[], path: string): T[] {
  const wanted = namesIn(path);
  if (!wanted.length) return [];
  for (const key of [(name: string) => name, nameKey, looseKey]) {
    const target = wanted.map(key).join("/");
    const found = folders.filter((folder) => namesIn(folder.path).map(key).join("/") === target);
    if (found.length) return found;
  }
  return [];
}
