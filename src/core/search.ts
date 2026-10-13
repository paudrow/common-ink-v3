import type { SearchMatch } from "./protocol.ts";

/** What a search looks for that can be shown in a note's lines: `soughtIn` in query.ts reads it from a query. */
export interface SearchQuery {
  /** Each a run of words to find together, in order: one word, the words of one such as `foo-bar`, or a quoted phrase. The last word of each may be the start of a longer one. */
  terms: string[][];
  /** Tags as they are matched: `#name`. */
  tags: string[];
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const START = "(?<![\\p{L}\\p{N}])";

/** What finds the query's matches in a line, to mark them. Accents are told apart here, as the index doesn't: a match it can't find is left unmarked. */
function finder(query: SearchQuery): RegExp | null {
  const parts = [
    ...query.terms.map((words) => `${START}${words.map(escaped).join("[^\\p{L}\\p{N}]+")}`),
    ...query.tags.map((tag) => `(?<![^\\s])#${escaped(tag)}(?![\\p{L}\\p{N}_-])`),
  ];
  return parts.length ? new RegExp(parts.join("|"), "giu") : null;
}

const MAX_MATCHES = 3;
const MAX_LINE = 200;
const LEAD = 40;

/** The first few lines of `text` the query matches, each with where. A long line is cut to the part around its first match. */
export function matchesIn(text: string, query: SearchQuery): SearchMatch[] {
  const find = finder(query);
  const matches: SearchMatch[] = [];
  if (!find) return matches;
  for (const [line, written] of text.split("\n").entries()) {
    const marks = [...written.matchAll(find)].map((m): [number, number] => [m.index, m.index + m[0].length]);
    if (!marks.length) continue;
    const from = written.length > MAX_LINE ? Math.max(0, marks[0]![0] - LEAD) : 0;
    const shown = written.slice(from, from + MAX_LINE);
    matches.push({
      line,
      text: shown,
      marks: marks.map(([a, b]): [number, number] => [a - from, Math.min(b - from, shown.length)]).filter(([a, b]) => a >= 0 && a < b),
    });
    if (matches.length === MAX_MATCHES) break;
  }
  return matches;
}
