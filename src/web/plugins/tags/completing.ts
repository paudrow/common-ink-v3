import { isTagName, nameKey, type CompletionItem, type ListedTag } from "../../plugin-api.ts";
import { pointed } from "../lib/pointing.ts";

const MOST_OFFERED = 50;
/** How many tags `#` lists alone, before anything is typed after it. */
const ALONE = 8;

/**
 * What `#` offers for what was typed after it: the tag named that, ignoring case, then the tags with
 * a word starting with each word typed, those that start with all of it first, and otherwise those
 * on the most notes first. Nothing once what was typed can't be a tag's name. `#` alone offers the
 * tags on the most notes. Where no tag is named what was typed, it offers last to create that tag,
 * which writes it as typed: a tag is made by being written. That waits to be picked on purpose, so
 * Enter after a new tag is a new line.
 */
export function tagItems(typed: string, tags: readonly ListedTag[]): CompletionItem[] {
  // A mark that can't be in a tag, as a full stop after one, ends it: Enter there is the member's own.
  if (typed && !isTagName(typed)) return [];
  const used = tags.toSorted((a, b) => (b.inside ?? b.notes) - (a.inside ?? a.notes));
  const exact = tags.find((tag) => nameKey(tag.name) === nameKey(typed));
  const found = typed ? [...(exact ? [exact] : []), ...pointed(used, typed, (tag) => tag.name).filter((tag) => tag !== exact)].slice(0, MOST_OFFERED) : used.slice(0, ALONE);
  const items = found.map((tag): CompletionItem => ({ label: `#${tag.name}`, ...(tag.description && { description: tag.description }), insert: `#${tag.name}`, tone: "accent" }));
  return !typed || exact ? items : [...items, { kind: "new", label: `Create #${typed}`, description: "New tag", insert: `#${typed}` }];
}
