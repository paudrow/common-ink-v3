import { filterOf, parseQuery, printQuery, wordsOf, type Cmp, type FilterKey, type Query, type QueryIn, type QueryNode, type QueryScope, type SortKey } from "../../plugin-api.ts";

/**
 * A query as the builder shows it: a condition a row, all of them to hold or any of them. It is the
 * query's own tree laid flat, so only a query that is flat can be shown: words and filters, each as
 * it is or negated, joined by AND alone or by OR alone.
 */
export interface Row {
  /** A filter, or `text` for words to find. */
  key: FilterKey | "text";
  not: boolean;
  cmp: Cmp;
  /** What is typed or picked. For words it is the words, and more than one is a phrase. Empty until the row is filled in. */
  value: string;
  /** The far end of a range, for a row that is between two values. */
  to?: string;
}

export interface Built {
  rows: Row[];
  match: "all" | "any";
  in: QueryIn[];
  sort: SortKey | null;
}

export const NEW_ROW: Row = { key: "text", not: false, cmp: "=", value: "" };

function rowOf(node: QueryNode): Row | null {
  if (node.kind === "not") {
    const row = rowOf(node.of);
    return row && { ...row, not: true };
  }
  if (node.kind === "text") return { key: "text", not: false, cmp: "=", value: node.words.join(" ") };
  if (node.kind === "filter") return { key: node.key, not: false, cmp: node.cmp, value: node.value, ...(node.to !== undefined && { to: node.to }) };
  return null;
}

/** The rows a query is, or null for one rows can't say: a group inside a group, or AND and OR together. */
export function builtOf(query: Query): Built | null {
  const { where } = query;
  const nodes = !where ? [] : where.kind === "and" || where.kind === "or" ? where.of : [where];
  const rows = nodes.map(rowOf);
  if (rows.some((row) => row === null)) return null;
  return { rows: rows as Row[], match: where?.kind === "or" ? "any" : "all", in: query.in, sort: query.sort };
}

/** A row as the term it was typed to be, before the language has read it, or null for one not filled in yet. */
function typedOf(row: Row): QueryNode | null {
  let node: QueryNode;
  if (row.key === "text") {
    const words = wordsOf(row.value);
    if (!words.length) return null;
    node = { kind: "text", words, phrase: words.length > 1 };
  } else {
    if (!row.value.trim() || (row.to !== undefined && !row.to.trim())) return null;
    node = { kind: "filter", key: row.key, cmp: row.to === undefined ? row.cmp : "=", value: row.value.trim(), ...(row.to !== undefined && { to: row.to.trim() }) };
  }
  return row.not ? { kind: "not", of: node } : node;
}

/**
 * What a row says: its term written out and read back by the language, so a value means in a row
 * what it means typed in the bar, `Money` and `#money` the tag `money`. It is null for a row not
 * filled in yet, and `why` for one the language can't read, in the language's own words.
 */
export function termOf(row: Row, scope: QueryScope): { node: QueryNode } | { why: string } | null {
  const typed = typedOf(row);
  if (!typed) return row.key === "text" && row.value.trim() ? { why: "There are no letters or digits here to look for" } : null;
  const read = parseQuery(printQuery({ where: typed, in: [], sort: null }), scope);
  if (!read.ok) return { why: read.error.message };
  const node = read.query.where;
  // A value with a space where none is read, such as a day and a word, is two terms and no row.
  if (!node || rowOf(node)?.key !== row.key) return { why: `This isn't one ${row.key === "text" ? "term" : `${row.key}:`} as the query language reads it` };
  return { node };
}

/** Whether a row says something the language reads, in a scope. A row that doesn't yet is kept by the builder and left out of the query. */
export const filled = (row: Row, scope: QueryScope): boolean => "node" in (termOf(row, scope) ?? {});

/** The query the filled rows are. */
export function queryOf(built: Built, scope: QueryScope): Query {
  const nodes = built.rows.flatMap((row) => {
    const term = termOf(row, scope);
    return term && "node" in term ? [term.node] : [];
  });
  return { where: nodes.length > 1 ? { kind: built.match === "any" ? "or" : "and", of: nodes } : (nodes[0] ?? null), in: built.in, sort: built.sort };
}

/** A row set to another field, keeping what of it the field can take. */
export function withKey(row: Row, key: Row["key"]): Row {
  const compares = key !== "text" && filterOf(key).compares;
  return { key, not: row.not, cmp: compares ? row.cmp : "=", value: "" };
}

export type BuilderEvent =
  /** The bar's text is now this, typed or put there by something other than the builder. */
  | { type: "read"; text: string }
  | { type: "add" }
  | { type: "remove"; at: number }
  | { type: "set"; at: number; row: Row }
  | { type: "match"; match: Built["match"] }
  | { type: "in"; in: QueryIn[] }
  | { type: "sort"; sort: SortKey | null };

/**
 * The builder at one moment. `built` is null while the bar holds a query rows can't say, or one
 * that can't be read: the text is then left exactly as it is. `text` is the query the rows are,
 * which is what the bar is set to after each change.
 */
export interface Builder {
  scope: QueryScope;
  text: string;
  built: Built | null;
  /** Why there are no rows, when there are none to show. */
  unshown: "nested" | "unread" | null;
}

const BLANK: Built = { rows: [], match: "all", in: [], sort: null };

export function readBuilder(scope: QueryScope, text: string): Builder {
  const parsed = parseQuery(text, scope);
  if (!parsed.ok) return { scope, text, built: null, unshown: "unread" };
  const built = builtOf(parsed.query);
  return { scope, text, built, unshown: built ? null : "nested" };
}

export function builderReducer(state: Builder, event: BuilderEvent): Builder {
  if (event.type === "read") {
    if (event.text === state.text) return state;
    const read = readBuilder(state.scope, event.text);
    // Rows not yet filled in are no part of the text, so they stay through a change to it.
    const waiting = state.built?.rows.filter((row) => !filled(row, state.scope)) ?? [];
    return read.built ? { ...read, built: { ...read.built, rows: [...read.built.rows, ...waiting] } } : read;
  }
  const had = state.built ?? BLANK;
  // A query rows can't say is never rewritten by them.
  if (!state.built && state.text.trim()) return state;
  const built: Built =
    event.type === "add"
      ? { ...had, rows: [...had.rows, NEW_ROW] }
      : event.type === "remove"
        ? { ...had, rows: had.rows.filter((_, i) => i !== event.at) }
        : event.type === "set"
          ? { ...had, rows: had.rows.map((row, i) => (i === event.at ? event.row : row)) }
          : event.type === "match"
            ? { ...had, match: event.match }
            : event.type === "in"
              ? { ...had, in: event.in }
              : { ...had, sort: event.sort };
  return { scope: state.scope, text: printQuery(queryOf(built, state.scope)), built, unshown: null };
}
