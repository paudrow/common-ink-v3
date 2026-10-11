// Writes a PR's "Try in this PR" note into a running Common Ink, from the section of the PR body
// between <!-- try --> and <!-- /try -->. Run again after the PR adds more; it rewrites the note.
//
//   node scripts/try-note.ts --url http://localhost:5203 --pr 25
//   node scripts/try-note.ts --url http://localhost:5199 --file try.md
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const TITLE = "# Try in this PR";

const { values } = parseArgs({ options: { url: { type: "string" }, pr: { type: "string" }, file: { type: "string" } } });
if (!values.url || (!values.pr && !values.file)) throw new Error("usage: --url <app url> (--pr <number> | --file <markdown>)");
const url = values.url.replace(/\/$/, "");

function sectionOf(body: string): string {
  const section = /<!-- try -->([\s\S]*?)<!-- \/try -->/.exec(body)?.[1]?.trim();
  if (!section) throw new Error("The PR body has no <!-- try --> ... <!-- /try --> section");
  return section;
}

const source = values.file ? readFileSync(values.file, "utf8") : sectionOf(execFileSync("gh", ["pr", "view", values.pr!, "--json", "body", "--jq", ".body"], { encoding: "utf8" }));
const text = source.startsWith(TITLE) ? source : `${TITLE}\n\n${source.replace(/^#\s+Try in this PR\s*\n/, "")}`;

const me = (await (await fetch(`${url}/api/me`)).json()) as { workspaces: { id: string }[] };
const workspace = me.workspaces[0]?.id;
if (!workspace) throw new Error(`${url} has no workspace for the dev user`);

async function op<T>(body: object): Promise<T> {
  const res = await fetch(`${url}/api/workspaces/${workspace}/ops`, { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${JSON.stringify(body).slice(0, 80)}: ${JSON.stringify(json)}`);
  return json as T;
}

// The walkthrough is stored as written: where it shows how a link is typed, that is text, not a link to resolve.
type Summary = { id: string; title: string; slug: string; revision: number };
const existing = (await op<Summary[]>({ type: "note.list" })).find((n) => n.title === "Try in this PR");
const note = existing
  ? await op<Summary>({ type: "note.write", id: existing.id, baseRevision: existing.revision, text, linkTitles: "keep" })
  : await op<Summary>({ type: "note.create", text, linkTitles: "keep" });
console.log(`${url}/note/${note.slug}-${note.id}`);
