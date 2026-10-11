import type { SearchMatch } from "./protocol.ts";
import { nameKey } from "./todos.ts";

/** What a search asks for, read from what was typed. */
export interface SearchQuery {
  /** Each a run of words to find together, in order: one word, the words of one such as `foo-bar`, or a quoted phrase. The last word of each may be the start of a longer one. */
  terms: string[][];
  /** Tags the note must have, as they are matched: `#name`. */
  tags: string[];
  /** Projects a todo of the note must be in, as they are matched: `+name`. */
  projects: string[];
}

const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text: string) => text.match(WORD) ?? [];

/**
 * Reads a search as typed: words, "quoted phrases", `#tag` and `+project`. Nothing else in it means
 * anything, so no character typed is ever handed on as syntax. A quote left open reads as words.
 */
export function parseQuery(typed: string): SearchQuery {
  const query: SearchQuery = { terms: [], tags: [], projects: [] };
  for (const [, phrase, marked, name, rest] of typed.matchAll(/"([^"]*)"|(?<![^\s])([#+])([\p{L}\p{N}_-]+)(?![^\s])|([^\s"]+)/gu)) {
    if (marked === "#") query.tags.push(nameKey(name!));
    else if (marked === "+") query.projects.push(nameKey(name!));
    else if (phrase !== undefined) {
      if (wordsOf(phrase).length) query.terms.push(wordsOf(phrase));
    } else if (wordsOf(rest!).length) query.terms.push(wordsOf(rest!));
  }
  return query;
}

export const isEmpty = (query: SearchQuery) => !query.terms.length && !query.tags.length && !query.projects.length;

/**
 * The terms as the full-text index is asked for them: each a quoted string, which the index reads
 * as words and nothing else, with `*` so its last word matches the start of a longer one. A term
 * holds only letters and digits, so there is no quote in it to close the string early.
 */
const termsOf = (terms: readonly string[][]) => terms.map((words) => `"${words.join(" ")}"*`).join(" ");
/** A workspace's id is letters and digits, so it is one word to the index and has no quote in it. */
const within = (workspaceId: string) => `workspace : "${workspaceId.replace(/[^a-z0-9]/g, "")}"`;

/** In the notes of one workspace, which the index is asked for first so it walks no other's. */
export const matchOf = (workspaceId: string, terms: readonly string[][]) => `${within(workspaceId)} AND {title text} : (${termsOf(terms)})`;

/** The same, matched in the title alone. */
export const titleMatchOf = (workspaceId: string, terms: readonly string[][]) => `${within(workspaceId)} AND title : (${termsOf(terms)})`;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const START = "(?<![\\p{L}\\p{N}])";

/** What finds the query's matches in a line, to mark them. Accents are told apart here, as the index doesn't: a match it can't find is left unmarked. */
function finder(query: SearchQuery): RegExp | null {
  const parts = [
    ...query.terms.map((words) => `${START}${words.map(escaped).join("[^\\p{L}\\p{N}]+")}`),
    ...query.tags.map((tag) => `(?<![^\\s])#${escaped(tag)}(?![\\p{L}\\p{N}_-])`),
    ...query.projects.map((project) => `(?<![^\\s])\\+${escaped(project)}(?![\\p{L}\\p{N}_-])`),
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
