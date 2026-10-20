// Run by node, as the scripts are: a module in their imports that plain node can't strip fails here, not in someone's shell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [path.join(import.meta.dirname, "../../scripts", script), ...args], { encoding: "utf8", env: { ...process.env, INK_TOKEN: "" } });

test("ink loads and prints its help", () => {
  const ink = run("ink.ts", "--help");
  assert.doesNotMatch(ink.stderr, /ERR_|SyntaxError/);
  assert.equal(ink.status, 0, ink.stderr);
  assert.match(ink.stdout, /Set INK_URL/);
});

test("try-note loads and asks for its arguments", () => {
  const tryNote = run("try-note.ts");
  assert.doesNotMatch(tryNote.stderr, /ERR_|SyntaxError/);
  assert.equal(tryNote.status, 1);
  assert.match(tryNote.stderr, /usage: --url <app url>/);
});

test("redo-deletions loads and asks for its arguments", () => {
  const redo = run("redo-deletions.ts");
  assert.doesNotMatch(redo.stderr, /ERR_|SyntaxError/);
  assert.equal(redo.status, 1);
  assert.match(redo.stderr, /usage: node scripts\/redo-deletions.ts \[--since <ISO time>\]/);
  const bad = run("redo-deletions.ts", "--account", "Ada");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Not an id: Ada/);
});
