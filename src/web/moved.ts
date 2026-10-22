/** Addresses that moved, to where they are now. A link or a bookmark kept from before arrives at the new one. */
const MOVED: Readonly<Record<string, string>> = {
  // The settings JSON was a view of Settings, and is a document of its own in a tab.
  "/settings/json": "/settings.json",
};

/** `to` with its path where it is now, and its query and fragment as they were. */
export function movedTo(to: string): string {
  const cut = to.search(/[?#]/);
  const path = cut < 0 ? to : to.slice(0, cut);
  return Object.hasOwn(MOVED, path) ? MOVED[path] + (cut < 0 ? "" : to.slice(cut)) : to;
}
