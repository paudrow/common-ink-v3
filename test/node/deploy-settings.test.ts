// Run by node: the production deploy step in .github/workflows/ci.yml, run with a stand-in for npm.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/** The script of the workflow's Deploy step, as GitHub runs it. */
function deployScript(): string {
  const lines = readFileSync(path.join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8").split("\n");
  const step = lines.findIndex((line) => line.trim() === "- name: Deploy");
  const run = lines.findIndex((line, i) => i > step && line.trim() === "run: |");
  assert.ok(step >= 0 && run >= 0, "ci.yml has no Deploy step with a run: | script");
  const indent = lines[run + 1]!.length - lines[run + 1]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** What the Deploy step hands `npm run deploy`, and what it logs, with `settings` as the workflow's env. */
function deploy(settings: Record<string, string>): { args: string[]; log: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-"));
  const npm = path.join(dir, "npm");
  writeFileSync(npm, `#!/bin/bash\nprintf '%s\\n' "$@" > "${dir}/args"\n`);
  chmodSync(npm, 0o755);
  const log = execFileSync("bash", ["-e", "-c", deployScript()], {
    env: { PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir, ALLOWED_EMAILS: "ada@example.com", PRODUCTION_DOMAIN: "ink.example", GOOGLE_CLIENT_ID: "client", ...settings },
    encoding: "utf8",
  });
  return { args: readFileSync(path.join(dir, "args"), "utf8").trim().split("\n"), log };
}

test("the deploy hands production the clipper's extension IDs, so the clipper can sign in", () => {
  const { args } = deploy({ CLIPPER_EXTENSION_IDS: "fcppkekegajpfdoilfhhohoilkbleiih" });
  assert.ok(args.includes("CLIPPER_EXTENSION_IDS:fcppkekegajpfdoilfhhohoilkbleiih"), args.join(" "));
});

test("without extension IDs the deploy warns that no clipper can sign in, and sets none", () => {
  const { args, log } = deploy({});
  assert.ok(!args.some((arg) => arg.startsWith("CLIPPER_EXTENSION_IDS")), args.join(" "));
  assert.match(log, /::warning::.*CLIPPER_EXTENSION_IDS/);
});
