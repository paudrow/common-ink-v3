// Runs `npm run site` in a folder of its own, so a site/ made to be wrong is never the real one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "../..");
const [node, ...args] = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts.site!.split(" ");

/** The generator run on a site/ of `files`, as `npm run site` runs it: its exit code, what it said, and what it wrote. */
function generate(files: Record<string, string>, ...flags: string[]): Promise<{ code: number | null; said: string; wrote: string | null }> {
  const dir = mkdtempSync(join(tmpdir(), "ink-site-"));
  mkdirSync(join(dir, "src/worker/site"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, "site", path, ".."), { recursive: true });
    writeFileSync(join(dir, "site", path), text);
  }
  const child = spawn(node!, [...args.map((arg) => (arg.endsWith(".ts") ? join(ROOT, arg) : arg)), ...flags], { cwd: dir });
  let said = "";
  child.stdout.on("data", (chunk) => (said += chunk));
  child.stderr.on("data", (chunk) => (said += chunk));
  return new Promise((resolve) =>
    child.on("close", (code) => {
      let wrote: string | null = null;
      try {
        wrote = readFileSync(join(dir, "src/worker/site/pages.gen.ts"), "utf8");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, said, wrote });
    }),
  );
}

const NAV = JSON.stringify([{ group: "Start here", pages: ["index", "cli"] }]);
const PAGES = { "docs/index.md": "# Getting started\n\nHello.\n", "docs/cli.md": "# The ink command\n\nRun it.\n\n<!-- generated:cli-usage -->\n" };

describe("the site's generator", { concurrency: true }, () => {
  test("writes each doc in the order of nav.json, with a generated section filled in", async () => {
    const { code, said, wrote } = await generate({ "docs/nav.json": NAV, ...PAGES });
    assert.equal(code, 0, said);
    const docs = wrote!.slice(wrote!.indexOf("export const DOCS"));
    assert.deepEqual([...docs.matchAll(/"slug": "([^"]*)"/g)].map((m) => m[1]), ["index", "cli"]);
    assert.match(docs, /<pre><code>Usage: ink \[--workspace ID\] &lt;command&gt;/);
  });

  test("fails, naming the page, when nav.json names a page there is no file for", async () => {
    const { code, said, wrote } = await generate({ "docs/nav.json": JSON.stringify([{ group: "Start here", pages: ["index", "cli", "gone"] }]), ...PAGES });
    assert.equal(code, 1);
    assert.match(said, /site\/docs\/nav\.json names gone\.md, which site\/docs\/ doesn't have/);
    assert.equal(wrote, null);
  });

  test("fails when nav.json names a page twice, or there is no index.md for /docs", async () => {
    const twice = await generate({ "docs/nav.json": JSON.stringify([{ group: "A", pages: ["index", "cli"] }, { group: "B", pages: ["cli"] }]), ...PAGES }, "--check");
    assert.deepEqual([twice.code, /names cli more than once/.test(twice.said)], [1, true]);
    const { "docs/index.md": _, ...noIndex } = PAGES;
    const bare = await generate({ "docs/nav.json": JSON.stringify([{ group: "A", pages: ["cli"] }]), ...noIndex }, "--check");
    assert.deepEqual([bare.code, /site\/docs\/ needs index\.md, the page at \/docs/.test(bare.said)], [1, true]);
  });

  test("fails, naming the file, when a page is in no group of nav.json", async () => {
    const { code, said } = await generate({ "docs/nav.json": NAV, ...PAGES, "docs/extra.md": "# Extra\n\nMore.\n" }, "--check");
    assert.equal(code, 1);
    assert.match(said, /site\/docs\/extra\.md is in no group of site\/docs\/nav\.json/);
  });

  test("fails on a generated section that has no name it knows", async () => {
    const { code, said } = await generate({ "docs/nav.json": NAV, ...PAGES, "docs/cli.md": "# The ink command\n\nRun it.\n\n<!-- generated:cli-usages -->\n" }, "--check");
    assert.equal(code, 1);
    assert.match(said, /site\/docs\/cli\.md: no generated section is named "cli-usages"\. There are cli-usage, mcp-tools, search-syntax\./);
  });

  test("fails on a generated section that is not on a line of its own", async () => {
    const { code, said } = await generate({ "docs/nav.json": NAV, ...PAGES, "docs/cli.md": "# The ink command\n\nRun it. <!-- generated:cli-usage -->\n" }, "--check");
    assert.equal(code, 1);
    assert.match(said, /site\/docs\/cli\.md: a <!-- generated:NAME --> is filled in only on a line of its own\./);
  });
});
