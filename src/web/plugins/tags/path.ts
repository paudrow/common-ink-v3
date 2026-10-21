export const TAGS_PATH = "/tags";
/** The id of the page at that address. Each tag's page is a tab of that page, one of its own at each tag's address. */
export const TAGS_PAGE = "tags";
/** Where every tag is managed: the Tags section of Settings, which the Tags plugin adds. */
export const SETTINGS_ID = "tags";
export const MANAGE_PATH = `/settings/${SETTINGS_ID}`;

/** Where a tag's page is. A tag may hold `/`, which stays a `/` in its address. */
export const tagPath = (name: string) => `${TAGS_PATH}/${name.split("/").map(encodeURIComponent).join("/")}`;

/** The tag an address names, or null for the page of every tag and for an address that isn't written as one. */
export function tagOfPath(path: string): string | null {
  if (!path.startsWith(`${TAGS_PATH}/`)) return null;
  try {
    return decodeURIComponent(path.slice(TAGS_PATH.length + 1)) || null;
  } catch {
    return null;
  }
}
