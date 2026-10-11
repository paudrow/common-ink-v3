export interface Rewrite {
  from: number;
  to: number;
  insert: string;
}

/**
 * The one replacement that turns `before` into `after`, with `before` at `at` in the note, or none
 * when they are the same. It covers only the characters that differ, so typing elsewhere and other
 * people's changes merge around it.
 */
export function replacing(before: string, after: string, at: number): Rewrite | undefined {
  if (before === after) return undefined;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: at + start, to: at + before.length - end, insert: after.slice(start, after.length - end) };
}
