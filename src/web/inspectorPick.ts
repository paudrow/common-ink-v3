/** The tab a member who has picked none is shown. */
export const UNPICKED = "info";

interface Tab {
  id: string;
  label: string;
  /** Present on a tab that is marked while it holds something unseen. Showing such a tab counts that as seen. */
  mark?: unknown;
}

/**
 * The inspector tab that shows, of `views`, the ones for what is in front: the one the member last
 * picked, or the one of the same name where what is in front has its own, as a folder has its own
 * Info. Where it has neither, the pick is as it was for the next thing that has it, and what shows
 * is the first tab with no mark: a tab with one, as History has, counts what it marks as seen by
 * being shown, so it is shown unasked only when it is all there is. `all` is every tab there is.
 */
export function pickView<V extends Tab>(all: readonly V[], views: readonly V[], picked: string | null): V | undefined {
  const id = picked ?? UNPICKED;
  const label = all.find((v) => v.id === id)?.label;
  return views.find((v) => v.id === id) ?? views.find((v) => v.label === label) ?? views.find((v) => !v.mark) ?? views[0];
}
