// Builds the commonink package's one file and runs it as `npx commonink` would, with nothing of this checkout beside it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const ROOT = join(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "commonink-"));
const ink = join(dir, "ink.js");

before(() => {
  execFileSync(process.execPath, [join(ROOT, "cli/build.ts")], { cwd: ROOT, stdio: "ignore" });
  copyFileSync(join(ROOT, "cli/dist/ink.js"), ink);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) => {
  const { INK_TOKEN: _, ...env } = process.env;
  const { status, stdout, stderr } = spawnSync(process.execPath, [ink, ...args], { cwd: dir, env, encoding: "utf8" });
  return { status, stdout, stderr };
};

test("help says how to use ink, and exits 0", () => {
  const { status, stdout, stderr } = run("help");
  assert.deepEqual([status, stderr], [0, ""]);
  assert.match(stdout, /^Usage: ink \[--workspace ID\] <command>\n/);
  assert.match(stdout, /\n {2}folder-find PATH +the folder at a path/);
});

test("a command without INK_TOKEN says to set it, and exits 2", () => {
  assert.deepEqual(run("notes"), { status: 2, stdout: "ink: Set INK_TOKEN to an agent token from Common Ink\n", stderr: "" });
});

test("syntax needs no token", () => {
  const { status, stdout } = run("syntax", "todos");
  assert.equal(status, 0);
  assert.match(stdout, /due:/);
});

test("starts with a shebang, so npm can link it as a command", () => {
  assert.equal(readFileSync(ink, "utf8").split("\n")[0], "#!/usr/bin/env node");
});
