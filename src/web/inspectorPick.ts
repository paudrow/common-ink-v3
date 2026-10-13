/**
 * The id of the inspector view shown to a person who has picked none: Info. Showing a note's
 * History counts its changes as seen, so History is never the tab shown unasked.
 */
export const UNPICKED = "info";

interface Tab {
  id: string;
  label: string;
  /** Present on a tab that is flagged while it holds something unseen. Showing such a tab counts that as seen. */
  badge?: unknown;
}

/**
 * The inspector tab that shows, of `views`, the ones for what is in front: the one the member last
 * picked, or the one of the same name where what is in front has its own, as a folder has its own
 * Info. Where it has neither, the pick is as it was for the next thing that has it, and what shows
 * is the first tab with no badge: a tab with one, as History has, counts what it flags as seen by
 * being shown, so it is shown unasked only when it is all there is. `all` is every tab there is.
 */
export function pickView<V extends Tab>(all: readonly V[], views: readonly V[], picked: string | null): V | undefined {
  const id = picked ?? UNPICKED;
  const label = all.find((v) => v.id === id)?.label;
  return views.find((v) => v.id === id) ?? views.find((v) => v.label === label) ?? views.find((v) => !v.badge) ?? views[0];
}
