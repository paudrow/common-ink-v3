import { readableName } from "../../plugin-api.ts";
import { namable, sameName } from "../lib/pointing.ts";

/**
 * The title `@` offers to create a note with, for what was typed after it: those words, with a letter
 * in them. Null where they can't be a name, or a note listed is already titled so, ignoring case.
 */
export function newTitle(typed: string, titles: readonly string[]): string | null {
  const title = readableName(typed.replace(/\s+/g, " "));
  if (!namable(typed) || !/\p{L}/u.test(title)) return null;
  return titles.some((t) => sameName(t, title)) ? null : title;
}
