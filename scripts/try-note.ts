// Writes a PR's "Try in this PR" note into a running Common Ink, from the section of the PR body
// between <!-- try --> and <!-- /try -->. Run again after the PR adds more; it rewrites the note.
//
//   node scripts/try-note.ts --url http://localhost:5203 --pr 25
//   node scripts/try-note.ts --url http://localhost:5199 --file try.md
//
// A link in the section is written by its note's title, [[Title]] or [[Title|other words]], and is
// stored by that note's id as a link picked in the editor is. A note with the title is made when
// there is none, so the links are drawn in any workspace the note is written to. Titles are matched
// as the server matches them, whatever their case. A target of twelve lowercase letters and digits
// is an id, as it is everywhere, and is left as written: that is how a link to a note that is gone is shown.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isNoteId, linksIn, retargeted } from "../src/core/links.ts";

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

type Summary = { id: string; title: string; slug: string; revision: number };
const notes = await op<Summary[]>({ type: "note.list" });

const idOf = new Map<string, string>();
for (const title of new Set(linksIn(text).map((link) => link.target).filter((target) => !isNoteId(target)))) {
  const titled = notes.filter((n) => n.title.toLowerCase() === title.toLowerCase());
  if (titled.length > 1) throw new Error(`${titled.length} notes are titled ${JSON.stringify(title)}, so [[${title}]] could mean any of them`);
  // A link to this note itself has nothing to point at until the note is there, and making a second note of its title would leave two.
  if (!titled.length && title.toLowerCase() === "try in this pr") continue;
  idOf.set(title, (titled[0] ?? (await op<Summary>({ type: "note.create", text: `# ${title}\n\nA sample note, here so that Try in this PR has a note to link to.` }))).id);
}
const stored = retargeted(text, (target) => idOf.get(target));

// The links are by id already, and where the walkthrough shows how one is typed, in code, that is text: nothing is left for the server to resolve or refuse.
const existing = notes.find((n) => n.title === "Try in this PR");
const note = existing
  ? await op<Summary>({ type: "note.write", id: existing.id, baseRevision: existing.revision, text: stored, linkTitles: "keep" })
  : await op<Summary>({ type: "note.create", text: stored, linkTitles: "keep" });
console.log(`${url}/note/${note.slug}-${note.id}`);
