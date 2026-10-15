const inOrder = (text: string, letters: string) => {
  let from = 0;
  for (const letter of letters) {
    from = text.indexOf(letter, from) + 1;
    if (!from) return false;
  }
  return true;
};

/**
 * The items whose text matches what was typed, ignoring case: those that start with it, then those
 * that contain it, then those with its letters in order. Items that tie keep the order they came in.
 */
export function matching<T>(items: readonly T[], typed: string, textOf: (item: T) => string): T[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return [...items];
  const ranked: T[][] = [[], [], []];
  for (const item of items) {
    const text = textOf(item).toLowerCase();
    const rank = text.startsWith(needle) ? 0 : text.includes(needle) ? 1 : inOrder(text, needle) ? 2 : -1;
    if (rank >= 0) ranked[rank]!.push(item);
  }
  return ranked.flat();
}

/**
 * The items a menu at the cursor offers for what was typed, ignoring case: those whose text starts
 * with it, then those with a word that does, a word being what is between spaces or between marks such as a hyphen. Letters inside a word or scattered through the text
 * offer nothing, so an ordinary word typed after the menu's trigger is left as it was typed.
 */
export function starting<T>(items: readonly T[], typed: string, textOf: (item: T) => string): T[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return [...items];
  const ranked: T[][] = [[], []];
  for (const item of items) {
    const text = textOf(item).toLowerCase();
    const rank = text.startsWith(needle) ? 0 : [...text.split(/\s+/), ...text.split(/[^\p{L}\p{N}]+/u)].some((word) => word.startsWith(needle)) ? 1 : -1;
    if (rank >= 0) ranked[rank]!.push(item);
  }
  return ranked.flat();
}
