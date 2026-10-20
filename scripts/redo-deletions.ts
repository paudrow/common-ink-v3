// Makes deletions of accounts and workspaces again after the database is restored to a time before them (docs/runbooks/restore.md).
//
//   node scripts/redo-deletions.ts --since 2026-10-19T14:05:00Z      every deletion kept from then on
//   node scripts/redo-deletions.ts --account <id> --workspace <id>   these, each flag as often as needed
//
// It puts the request in the uploads bucket with wrangler, signed in as you, then asks the Worker at
// --url (https://commonink.app) to carry it out and prints what became of each id. The request's name
// is random, and the Worker carries out only a request it finds in the bucket, so no secret is needed.
// Running it again is safe: an id already gone answers `gone`.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse } from "jsonc-parser";

const USAGE = "usage: node scripts/redo-deletions.ts [--since <ISO time>] [--account <id>]... [--workspace <id>]... [--url <app url>]";

const { values } = parseArgs({
  options: {
    since: { type: "string" },
    account: { type: "string", multiple: true, default: [] },
    workspace: { type: "string", multiple: true, default: [] },
    url: { type: "string", default: "https://commonink.app" },
  },
});
const since = values.since === undefined ? null : Date.parse(values.since);
const bad = [...values.account, ...values.workspace].filter((id) => !/^[a-z0-9]{12}$/.test(id));
if ((since === null && !values.account.length && !values.workspace.length) || Number.isNaN(since) || bad.length) {
  console.error(bad.length ? `Not an id: ${bad.join(", ")}\n${USAGE}` : USAGE);
  process.exit(1);
}

const url = new URL(values.url);
const local = ["localhost", "127.0.0.1"].includes(url.hostname);
const bucket = parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).r2_buckets[0].bucket_name as string;
const name = randomBytes(32).toString("hex");

execFileSync("npx", ["wrangler", "r2", "object", "put", `${bucket}/redo-deletions/${name}.json`, local ? "--local" : "--remote", "--pipe", "--content-type", "application/json"], {
  input: JSON.stringify({ accounts: values.account, workspaces: values.workspace, since }),
  stdio: ["pipe", "ignore", "inherit"],
});

const res = await fetch(new URL(`/redo-deletions/${name}`, url), { method: "POST" });
const body = (await res.json()) as { kind: string; id: string; redone: string }[] | { message?: string; error: string };
if (!res.ok || !Array.isArray(body)) {
  console.error(`The Worker answered ${res.status}: ${JSON.stringify(body)}. Run this again: a deletion made already answers gone.`);
  process.exit(1);
}
for (const { kind, id, redone } of body) console.log(`${kind} ${id}: ${redone}`);
if (!body.length) console.log("Nothing to delete again.");
if (body.some((d) => d.redone.startsWith("refused"))) process.exitCode = 1;
