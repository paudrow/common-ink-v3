import { COMPLETION_KINDS } from "./plugin-api.ts";

/** The heading an item's group is shown under, and where the group goes among the others: lower first. */
export interface Group {
  heading: string;
  rank: number;
}

/** Whether an item of `kind` is left for the member to pick on purpose, never highlighted by the list of itself. */
export const waits = (kind: string | undefined) => COMPLETION_KINDS.some((k) => k.kind === kind && "waits" in k && k.waits);

/**
 * Items in the order a list shows them: those of no kind first, then each kind's in the order of
 * {@link COMPLETION_KINDS}, and within each as they were given. An item of a kind is told its group
 * where the list holds more than one kind, which is when the groups are headed. A kind that isn't a
 * row there is taken as none.
 */
export function grouped<T>(items: readonly T[], kindOf: (item: T) => string | undefined): { item: T; group?: Group }[] {
  const ranked = items.map((item) => ({ item, rank: COMPLETION_KINDS.findIndex((k) => k.kind === kindOf(item)) })).toSorted((a, b) => a.rank - b.rank);
  const headed = new Set(ranked.flatMap(({ rank }) => (rank < 0 ? [] : [rank]))).size > 1;
  return ranked.map(({ item, rank }) => (headed && rank >= 0 ? { item, group: { heading: COMPLETION_KINDS[rank]!.heading, rank } } : { item }));
}
