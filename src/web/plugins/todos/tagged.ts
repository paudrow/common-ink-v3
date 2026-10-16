import { nameKey, parseQuery, printQuery, type Query, type QueryNode, type SortKey } from "../../plugin-api.ts";

/** The terms every todo a query lists answers: its AND's at the top, or the query alone. */
export const conjuncts = (where: QueryNode | null): QueryNode[] => (where === null ? [] : where.kind === "and" ? where.of : [where]);

const isTag = (node: QueryNode, name: string) => node.kind === "filter" && node.key === "tag" && node.cmp === "=" && nameKey(node.value) === nameKey(name);

/** The tags a todos query narrows the list to: those every todo it lists must have, as `#money` or `tag:money` at its top. */
export function narrowedTo(text: string): string[] {
  const read = parseQuery(text, "todos");
  if (!read.ok) return [];
  const tags = conjuncts(read.query.where).flatMap((node) => (node.kind === "filter" && node.key === "tag" && node.cmp === "=" ? [node.value] : []));
  return tags.filter((tag, i) => tags.findIndex((other) => nameKey(other) === nameKey(tag)) === i);
}

// A tag's name is letters, digits, `_`, `/` and `-`, and `-` may not be escaped in a `u` expression.
const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The query with a tag's chip pressed: the tag taken off where the query narrows to it, and `#name`
 * added at its end where it doesn't. What was typed is kept as typed where that reads as the same
 * query, and is otherwise written the one way the query is printed.
 */
export function toggledTag(text: string, name: string): string {
  const typed = text.trim();
  const read = parseQuery(typed, "todos");
  if (!read.ok) return `${typed} #${name}`.trim();
  const query = read.query;
  const same = (candidate: string, wanted: Query) => {
    const again = parseQuery(candidate, "todos");
    return again.ok && printQuery(again.query) === printQuery(wanted);
  };
  const terms = conjuncts(query.where);
  if (terms.some((node) => isTag(node, name))) {
    const left = terms.filter((node) => !isTag(node, name));
    const wanted: Query = { ...query, where: left.length === 0 ? null : left.length === 1 ? left[0]! : { kind: "and", of: left } };
    const cut = typed
      .replace(new RegExp(`(^|\\s)(#|tag:)${escaped(name)}(?=\\s|$)`, "giu"), " ")
      .replace(/\s+/g, " ")
      .trim();
    return same(cut, wanted) ? cut : printQuery(wanted);
  }
  const tag: QueryNode = { kind: "filter", key: "tag", cmp: "=", value: nameKey(name) };
  const wanted: Query = { ...query, where: query.where ? { kind: "and", of: [...terms, tag] } : tag };
  const added = `${typed} #${name}`.trim();
  return same(added, wanted) ? added : printQuery(wanted);
}

/**
 * The query with its order changed to `sort:` the word, or to no `sort:` for null: any `sort:` typed is
 * taken off and the word written at its end. What was typed is kept as typed where that reads as the
 * same query, and is otherwise written the one way the query is printed.
 */
export function withSort(text: string, sort: SortKey | null): string {
  const typed = text.trim();
  const cut = typed.replace(/(^|\s)sort:\S*/giu, " ").replace(/\s+/g, " ").trim();
  const added = sort ? `${cut} sort:${sort}`.trim() : cut;
  const read = parseQuery(typed, "todos");
  if (!read.ok) return added;
  const again = parseQuery(added, "todos");
  const wanted: Query = { ...read.query, sort };
  return again.ok && printQuery(again.query) === printQuery(wanted) ? added : printQuery(wanted);
}
