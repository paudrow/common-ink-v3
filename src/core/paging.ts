import type { Order, OrderKey } from "./order.ts";
import { OpError } from "./protocol.ts";

type Value = string | number | null;

/** What a statement that lists one page of an order says, besides what it lists. */
export interface Paging {
  /** The ORDER BY, without the words. */
  orderBy: string;
  /** The condition that holds of the rows after the cursor's, or of every row when there is none. */
  where: string;
  /** Each key's value, to select beside the row so the last row's can be the next cursor. */
  keys: string;
  /** The page of `rows`, read with a LIMIT one more than `limit`, and the cursor of the page after, or null on the last. */
  page<R>(rows: R[], limit: number): { page: R[]; next: string | null };
}

const keyName = (i: number) => `page_key_${i}`;

/**
 * Pages through `order`, starting after the row the cursor `after` was made from. SQLite compares
 * rows of values as one, which can't say a key that runs the other way or one that is null, so the
 * row after is said key by key: the same as the cursor's on every key before this one, and after it
 * on this one. A null sorts first ascending and last descending, as SQLite orders it.
 */
export function paging(order: Order, after: string | undefined, bind: (value: string | number) => string): Paging {
  const values = after === undefined ? null : read(after, order.length);
  const same = (key: OrderKey, value: Value) => (value === null ? `(${key.expression}) IS NULL` : `(${key.expression}) IS ${bind(value)}`);
  const beyond = (key: OrderKey, value: Value): string | null => {
    if (key.direction === "asc") return value === null ? `(${key.expression}) IS NOT NULL` : `(${key.expression}) > ${bind(value)}`;
    return value === null ? null : `((${key.expression}) < ${bind(value)} OR (${key.expression}) IS NULL)`;
  };
  const either = values
    ? order.flatMap((key, i) => {
        const past = beyond(key, values[i]!);
        return past === null ? [] : [[...order.slice(0, i).map((k, j) => same(k, values[j]!)), past].join(" AND ")];
      })
    : [];
  return {
    orderBy: order.map((key) => `${key.expression} ${key.direction.toUpperCase()}`).join(", "),
    where: values ? (either.length ? `(${either.map((one) => `(${one})`).join(" OR ")})` : "0") : "1",
    keys: order.map((key, i) => `${key.expression} AS ${keyName(i)}`).join(", "),
    page(rows, limit) {
      const page = rows.slice(0, limit);
      const last = rows.length > limit ? (page.at(-1) as Record<string, Value>) : null;
      return { page, next: last && write(order.map((_, i) => last[keyName(i)]!)) };
    },
  };
}

const NOT_A_CURSOR = "after is not a next this list gave: start again without it";

function write(values: Value[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A cursor is the client's to hand back, so it is read as anything else a client sends: as many values as the order has keys, each a string, a number or null. */
function read(cursor: string, keys: number): Value[] {
  let values: unknown;
  try {
    const bytes = Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    values = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new OpError("invalid", NOT_A_CURSOR);
  }
  const scalar = (v: unknown) => v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
  if (!Array.isArray(values) || values.length !== keys || !values.every(scalar)) throw new OpError("invalid", NOT_A_CURSOR);
  return values as Value[];
}
