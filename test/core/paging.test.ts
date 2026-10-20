import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { binder } from "../../src/core/operations.ts";
import { asc, desc, type Order } from "../../src/core/order.ts";
import { paging } from "../../src/core/paging.ts";

const ROWS: [id: string, a: number | null, b: string | null][] = [
  ["r1", 2, "pear"],
  ["r2", null, "apple"],
  ["r3", 2, "Apple"],
  ["r4", 1, null],
  ["r5", 2, "apple"],
  ["r6", null, null],
  ["r7", 1, "fig"],
  ["r8", 2, "APPLE"],
];

/** One page of the rows in `order`, read as an operation reads one. */
async function page(order: Order, limit: number, after?: string) {
  const binds: (string | number | null)[] = [];
  const bind = binder(binds);
  const pages = paging(order, after, bind);
  const { results } = await env.DB.prepare(`SELECT ${pages.keys}, id FROM paging_rows WHERE ${pages.where} ORDER BY ${pages.orderBy} LIMIT ${bind(limit + 1)}`)
    .bind(...binds)
    .all<{ id: string }>();
  const { page: rows, next } = pages.page(results, limit);
  return { ids: rows.map((r) => r.id), next };
}

/** Every page, from the first until one says there is none after it. */
async function walk(order: Order, limit: number) {
  const pages: string[][] = [];
  for (let after: string | undefined; ; ) {
    const { ids, next } = await page(order, limit, after);
    pages.push(ids);
    if (next === null) return pages;
    after = next;
  }
}

const cursor = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("paging an order", () => {
  beforeAll(async () => {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS paging_rows (id TEXT PRIMARY KEY, a INTEGER, b TEXT)").run();
    await env.DB.batch(ROWS.map(([id, a, b]) => env.DB.prepare("INSERT OR REPLACE INTO paging_rows (id, a, b) VALUES (?, ?, ?)").bind(id, a, b)));
  });

  it("walks keys that run both ways and hold nulls, a tie under a collation broken by the unique key, every row once and in order", async () => {
    const order = [desc("a"), asc("b COLLATE NOCASE"), asc("id")];
    // Descending puts a null last, ascending puts it first; Apple, apple and APPLE are one value to NOCASE.
    const all = ["r3", "r5", "r8", "r1", "r4", "r7", "r6", "r2"];
    expect((await walk(order, 100)).flat()).toEqual(all);
    for (const limit of [1, 2, 3]) expect((await walk(order, limit)).flat(), `${limit} a page`).toEqual(all);
    expect(await walk(order, 3)).toEqual([["r3", "r5", "r8"], ["r1", "r4", "r7"], ["r6", "r2"]]);
  });

  it("walks the other way round as well", async () => {
    const order = [asc("a"), desc("b COLLATE NOCASE"), desc("id")];
    const all = ["r2", "r6", "r7", "r4", "r1", "r8", "r5", "r3"];
    for (const limit of [1, 2, 5]) expect((await walk(order, limit)).flat(), `${limit} a page`).toEqual(all);
  });

  it("says there is no page after the last, even when the last page is full", async () => {
    expect(await page([asc("id")], 8)).toEqual({ ids: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"], next: null });
    expect((await page([asc("id")], 7)).next).not.toBeNull();
  });

  it("starts after whatever row a well-formed cursor names, as one the list gave would", async () => {
    expect((await page([desc("a"), asc("b COLLATE NOCASE"), asc("id")], 10, cursor([2, "APPLE", "r4"]))).ids).toEqual(["r5", "r8", "r1", "r4", "r7", "r6", "r2"]);
    expect((await page([desc("a"), asc("b COLLATE NOCASE"), asc("id")], 10, cursor([null, null, "r6"]))).ids).toEqual(["r2"]);
    expect((await page([desc("a"), asc("id")], 10, cursor([null, "zz"]))).ids).toEqual([]);
  });

  it("refuses a cursor that isn't one, in words, as invalid", async () => {
    const order = [desc("a"), asc("b COLLATE NOCASE"), asc("id")];
    const said = async (after: string) =>
      page(order, 2, after).then(
        () => "read",
        (err: { code: string; message: string }) => `${err.code}: ${err.message}`,
      );
    const refused = "invalid: after is not a next this list gave: start again without it";
    for (const forged of ["not a cursor!", "", cursor({ a: 1 }), cursor([2, "pear"]), cursor([2, "pear", "r1", "r9"]), cursor([2, { b: 1 }, "r1"]), cursor([2, ["x"], "r1"]), cursor([true, "pear", "r1"]), "W1tdLA", btoa("\xff\xfe[1]")]) {
      expect(await said(forged), forged).toBe(refused);
    }
    expect(await said(cursor([2, "pear", "r1"]))).toBe("read");
  });
});
