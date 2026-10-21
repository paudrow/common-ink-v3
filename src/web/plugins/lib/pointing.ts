import type { CompletionKind } from "../../plugin-api.ts";

/**
 * How many of each kind of thing `@` lists alone, before anything is typed after it: the people, the
 * member first, the notes edited last, the latest uploads and the next events. Typing narrows each.
 */
export const AT_ALONE = { person: 3, note: 3, upload: 2, event: 2 } as const satisfies Partial<Record<CompletionKind, number>>;

/** A name is a few words. More than this after an `@` is prose that happens to follow one. */
const MOST_WORDS = 4;

// Accents are left out of the comparison, so "zoe" finds Zoë.
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const wordsOf = (text: string) => plain(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether what was typed after `@` can be the start of a name: a few words, with no bracket or bar. */
export const namable = (typed: string) => !/[[\]|]/.test(typed) && typed.trim().split(/\s+/).length <= MOST_WORDS;

/** Whether every word typed starts a word of one of `texts`, ignoring case and accents. */
export function startsWords(typed: string, texts: readonly string[]): boolean {
  const words = texts.flatMap(wordsOf);
  return wordsOf(typed).every((word) => words.some((w) => w.startsWith(word)));
}

/**
 * What `@` offers of one kind of thing for what was typed after it: the items whose text has a word
 * starting with each word typed, those whose text starts with all of it first, and otherwise in the
 * order given. Nothing for no word typed, or for what can't be a name.
 */
export function pointed<T>(items: readonly T[], typed: string, textOf: (item: T) => string): T[] {
  if (!wordsOf(typed).length || !namable(typed)) return [];
  const start = plain(typed.trim());
  const found = items.filter((item) => startsWords(typed, [textOf(item)]));
  return [...found.filter((item) => plain(textOf(item)).startsWith(start)), ...found.filter((item) => !plain(textOf(item)).startsWith(start))];
}
