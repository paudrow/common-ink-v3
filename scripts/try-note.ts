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
//
// A reference to an event or a contact is written by its record's name, ::event{Lunch with Sam} or
// ::contact{Sam Okafor}, and is stored as the reference of the sample record of that name, which is
// made for the dev user as the Calendar page makes one. The sample calendar and contacts are connected
// for that first. Only the sample data is read: no calendar or contacts that anyone connected is.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isNoteId, linksIn, retargeted } from "../src/core/links.ts";
import type { CalendarEvent, Contact, Reference, Source } from "../src/core/protocol.ts";
import { namedReferences } from "../src/core/references.ts";

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
const linked = retargeted(text, (target) => idOf.get(target));

/** The text with each record it names written as that sample record's reference. A name no sample record has is left as written. */
async function referring(written: string): Promise<string> {
  const named = namedReferences(written);
  if (!named.length) return written;
  const sample = (source: { id: string }) => source.id.startsWith("sample-");
  const { sources } = await op<{ sources: Source[] }>({ type: "source.list" });
  for (const source of sources.filter((s) => sample(s) && s.state === "not_connected")) await op({ type: "source.connect", id: source.id });
  const DAY = 86_400_000;
  const from = Math.floor(Date.now() / DAY) * DAY;
  const { events } = await op<{ events: CalendarEvent[] }>({ type: "event.list", from, to: from + 7 * DAY, timeZone: "UTC" });
  const { contacts } = await op<{ contacts: Contact[] }>({ type: "contact.list" });
  const records = { event: events.filter((e) => sample({ id: e.sourceId })).map((e) => ({ ...e, name: e.title })), contact: contacts.filter((c) => sample({ id: c.sourceId })) };
  let out = "";
  let at = 0;
  for (const { kind, name, from: start, to } of named) {
    const record = records[kind].find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!record) continue;
    out += written.slice(at, start) + (await op<Reference>({ type: "record.refer", sourceId: record.sourceId, id: record.id })).text;
    at = to;
  }
  return out + written.slice(at);
}
const stored = await referring(linked);

// The links are by id already, and where the walkthrough shows how one is typed, in code, that is text: nothing is left for the server to resolve or refuse.
const existing = notes.find((n) => n.title === "Try in this PR");
const note = existing
  ? await op<Summary>({ type: "note.write", id: existing.id, baseRevision: existing.revision, text: stored, linkTitles: "keep" })
  : await op<Summary>({ type: "note.create", text: stored, linkTitles: "keep" });
console.log(`${url}/note/${note.slug}-${note.id}`);
