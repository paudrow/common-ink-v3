// Run by node: the drill drives wrangler against local D1, which the Workers test pool can't.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.join(import.meta.dirname, "../../scripts/restore-drill.ts");
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("the local half of the restore drill copies a database the runbook's way, and the checks see the marker", () => {
  const drill = run();
  assert.equal(drill.status, 0, drill.stderr);
  assert.match(drill.stdout, /scratch matches source on every check/);
  assert.match(drill.stdout, /rows in people: 2 -> 3/);
  assert.match(drill.stdout, /The local half of the restore drill passed\.\n$/);
});

test("compare names each check that differs, and exits 1", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "restore-compare-"));
  try {
    const checks = (people: number, quickCheck: string, latest: number) => [
      { results: [{ people, notes: 4 }] },
      { results: [{ quick_check: quickCheck }] },
      { results: [] },
      { results: [{ latest_change: latest, latest_upload: null }] },
      { results: [{ restore_drill_markers: 0 }] },
    ];
    const [before, after, same] = ["before.json", "after.json", "same.json"].map((f) => path.join(dir, f)) as [string, string, string];
    writeFileSync(before, JSON.stringify(checks(3, "ok", 1760000000000)));
    writeFileSync(after, JSON.stringify(checks(2, "ok", 1750000000000)));
    writeFileSync(same, JSON.stringify(checks(3, "ok", 1760000000000)));

    const differ = run("compare", before, after);
    assert.equal(differ.status, 1);
    assert.equal(
      differ.stdout,
      "rows in people: 3 -> 2\nSELECT (SELECT max(created_at) FROM changes) AS latest_change, (SELECT max(created_at) FROM uploads) AS latest_upload: " +
        '[{"latest_change":1760000000000,"latest_upload":null}] -> [{"latest_change":1750000000000,"latest_upload":null}]\n',
    );

    const agree = run("compare", before, same);
    assert.equal(agree.status, 0);
    assert.equal(agree.stdout, "No differences.\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
