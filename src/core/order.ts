// Imports nothing: query.ts orders by these, and scripts/ink.ts loads query.ts under plain node.

/** One part of an order: an expression of the listed row, said in SQL, and which way it runs. */
export interface OrderKey {
  expression: string;
  direction: "asc" | "desc";
}

/** How a list is ordered, the first key first. The last key is unique to each row, so no two rows tie and a page ends at one row. */
export type Order = readonly OrderKey[];

export const asc = (expression: string): OrderKey => ({ expression, direction: "asc" });
export const desc = (expression: string): OrderKey => ({ expression, direction: "desc" });
