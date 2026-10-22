import type { QueryNode } from "../../plugin-api.ts";

/** A query with every filter `drop` names taken out, so a new choice replaces the last. */
export function without(node: QueryNode | null, drop: (filter: Extract<QueryNode, { kind: "filter" }>) => boolean): QueryNode | null {
  if (!node) return null;
  if (node.kind === "text") return node;
  if (node.kind === "filter") return drop(node) ? null : node;
  if (node.kind === "not") {
    const of = without(node.of, drop);
    return of ? { kind: "not", of } : null;
  }
  const of = node.of.flatMap((child) => {
    const next = without(child, drop);
    return next ? [next] : [];
  });
  if (of.length === 0) return null;
  if (of.length === 1) return of[0]!;
  return { kind: node.kind, of };
}
