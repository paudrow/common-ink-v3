// A Preview with its own D1 database, for a pull request or a branch. CI runs it on every push to a PR.
//
//   npm run preview -- --name pr-12 [--message <sha>]   create or update it, and print its URL
//   npm run preview -- --name pr-12 --delete            delete the Preview and its database
//
// With GITHUB_OUTPUT set, the URLs are also written there: `url` always serves the Preview's latest
// deployment, and `deployment_url` serves only this one, so tests can't reach an older build.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parse } from "jsonc-parser";

const { values } = parseArgs({ options: { name: { type: "string" }, message: { type: "string" }, delete: { type: "boolean", default: false } } });
const name = values.name;
if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("--name takes lowercase letters, digits, and dashes, such as pr-12");

const GENERATED = "wrangler.preview.json";
const config = parse(readFileSync("wrangler.jsonc", "utf8"));
const database = `${config.name}-${name}`;

const wrangler = (args: string[], options: { quiet?: boolean } = {}) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", options.quiet ? "pipe" : "inherit"], env: { ...process.env, CI: "1" } });

const findDatabase = () => (JSON.parse(wrangler(["d1", "list", "--json"], { quiet: true })) as { name: string; uuid: string }[]).find((d) => d.name === database);

if (values.delete) {
  wrangler(["preview", "delete", "--name", name, "--skip-confirmation"]);
  if (findDatabase()) wrangler(["d1", "delete", database, "--skip-confirmation"]);
  console.log(`Deleted Preview ${name} and database ${database}.`);
  process.exit(0);
}

let db = findDatabase();
if (!db) {
  wrangler(["d1", "create", database]);
  db = findDatabase();
  if (!db) throw new Error(`created ${database}, but it isn't listed`);
}
const binding = { ...config.d1_databases[0], database_name: database, database_id: db.uuid };

const previews = { d1_databases: [binding], vars: { DEV_SIGN_IN: "1" } };
writeFileSync(GENERATED, JSON.stringify({ ...config, d1_databases: [binding], previews }, null, 2));
const secrets = path.join(tmpdir(), `ink-preview-${process.pid}.json`);
writeFileSync(secrets, JSON.stringify({ SESSION_SECRET: randomBytes(32).toString("hex") }), { mode: 0o600 });
try {
  wrangler(["d1", "migrations", "apply", database, "--remote", "-c", GENERATED]);
  execFileSync("npx", ["vite", "build"], { stdio: "inherit" });
  const out = wrangler(["preview", "-c", GENERATED, "--name", name, "--secrets-file", secrets, "--json", ...(values.message ? ["--message", values.message] : [])]);
  const result = JSON.parse(out.slice(out.indexOf("{"))) as { preview: { urls: Record<string, string> }; deployment: { urls: Record<string, string> } };
  const url = Object.values(result.preview.urls)[0];
  const deploymentUrl = Object.values(result.deployment.urls)[0];
  if (!url || !deploymentUrl) throw new Error(`no Preview URLs in wrangler's output:\n${out}`);
  console.log(`${url}\nThis deployment only: ${deploymentUrl}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\ndeployment_url=${deploymentUrl}\n`);
} finally {
  rmSync(secrets, { force: true });
  rmSync(GENERATED, { force: true });
}
