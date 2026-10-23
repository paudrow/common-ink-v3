// Run by node, whose patterns backtrack as a browser's do: workerd, which runs test/core, gives up on
// a pattern that backtracks too long and finishes it another way, so a slow one passes there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../../src/core/markdown.ts";
import { oneLine, serializeTable } from "../../src/web/plugins/tables/table.ts";

const N = 60_000;

/** How long `read` takes, in whole ms. */
function took(read: () => unknown): number {
  const start = performance.now();
  read();
  return Math.round(performance.now() - start);
}

test("a heading's closing #s are cut in one pass, however many #s come before its last word", () => {
  assert.ok(took(() => summarize(`# ${"#".repeat(N)}x`)) < 50);
  assert.deepEqual(
    ["# Title ##  ", "# C#", "# Title #", "# Title#", "#   spaced", "# ##", "# a #\t#", "# a\t##"].map((text) => summarize(text).title),
    ["Title", "C#", "Title", "Title#", "spaced", "", "a #", "a"],
  );
});

test("a table's cell is put on one line in one pass, however many spaces it holds", () => {
  const cell = `${" ".repeat(N)}x`;
  assert.ok(took(() => oneLine(cell)) < 50);
  assert.ok(took(() => serializeTable({ aligns: [null], rows: [["a"], [cell]] })) < 50);
  assert.equal(oneLine(" a \n  b\t\n\nc  d "), " a b c  d ");
});
