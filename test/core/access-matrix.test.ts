import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor, type Visitor } from "../../src/core/operations.ts";
import { Op, OpError, type OpInput, type OpType } from "../../src/core/protocol.ts";
import { NOT_FOR_AGENTS } from "../../src/worker/mcp/tools.ts";
import { addMember, newMember } from "./members.ts";

/*
 * Every operation, asked by every kind of actor, of every kind of note and folder. What each actor
 * may do with each item is written out below as a table. The operations are not: each one only says
 * what it needs of the item it is pointed at, and the test works out from the table whether it is
 * done, refused, or answered as if the item weren't there. An operation with no row here fails the
 * first test, so one added later can't go unasked.
 */

type Level = "-" | "V" | "E";
const NOTES = ["open", "team", "deep", "lone", "secret", "vpriv"] as const;
const FOLDERS = ["Open", "Team", "Deep"] as const;
type NoteName = (typeof NOTES)[number];
type FolderName = (typeof FOLDERS)[number];
const FOLDER_OF: Record<NoteName, FolderName> = { open: "Open", team: "Team", deep: "Deep", lone: "Open", secret: "Team", vpriv: "Open" };

/**
 * Each actor, what they may do with each note (open team deep lone secret vpriv) and each folder (Open Team Deep), and whether they may
 * share what they can edit. `secret` is private to Eve and `vpriv` to Vera, and an owner shares their own private note whatever their role.
 */
const OWNER: Partial<Record<NoteName, string>> = { secret: "Eve, an editor who owns the private note", vpriv: "Vera, a viewer who owns a private note" };

const ACTORS = {
  "Ada, an admin": { notes: "EEEE--", folders: "EEE", shares: true },
  "Eve, an editor who owns the private note": { notes: "EEEEE-", folders: "EEE", shares: true },
  "Ed, an editor": { notes: "EEEE--", folders: "EEE", shares: true },
  "Vera, a viewer who owns a private note": { notes: "VVVV-V", folders: "VVV", shares: false },
  "Ned, an editor narrowed to view on Team": { notes: "EVVE--", folders: "EVV", shares: true },
  "Gus, a guest with edit on Team": { notes: "-EE---", folders: "-EE", shares: false },
  "Vic, a guest with view on Team": { notes: "-VV---", folders: "-VV", shares: false },
  "Nia, a guest with edit on the note lone": { notes: "---E--", folders: "---", shares: false },
  "Val, a guest with view on the note lone": { notes: "---V--", folders: "---", shares: false },
} as const;
type ActorName = keyof typeof ACTORS;

interface World {
  actors: Record<ActorName, Actor>;
  notes: Record<NoteName, string>;
  folders: Record<FolderName, string>;
  /** A grant on each note, there to be revoked. */
  spare: Record<NoteName, string>;
  /** An agent of Eve's that has only ever written the private note. */
  secretAgent: { id: string; name: string };
  /** A link an admin put on `secret` before its owner made it private, and how many grants went when she did. */
  before: { token: string; removed: number };
  /** For each note and folder, everything that would give it away: its id, its title, a word of its text. */
  marks: Record<NoteName | FolderName, string[]>;
}

const address = () => `${crypto.randomUUID()}@example.com`;

/** Each note has a todo with a project of its own, and a tag of its own, which give the note away as its title does. */
const todoOf = (name: NoteName) => `- [ ] todo-${name} +proj-${name} #tag-${name}`;
const textOf = (name: NoteName, more = "") => `# Title-${name}\n\nbody-${name} ${more}\n${todoOf(name)}`;

async function world(): Promise<World> {
  const ada = await newMember("Ada Lovelace");
  const here = (personId: string): Actor => ({ kind: "member", personId, workspaceId: ada.workspaceId });
  const person = async (name: string) => {
    const email = address();
    return { email, actor: here((await signIn(env.DB, { email, name })).personId) };
  };
  const eve = await addMember(ada, "editor", "Eve Editor");
  const ed = await addMember(ada, "editor", "Ed Editor");
  const vera = await addMember(ada, "editor", "Vera Viewer");
  const nedEmail = address();
  await perform(env.DB, ada, { type: "member.invite", email: nedEmail, as: "editor" });
  const ned = here((await signIn(env.DB, { email: nedEmail, name: "Ned Narrowed" })).personId);
  const [gus, vic, nia, val] = await Promise.all(["Gus Guest", "Vic Guest", "Nia Guest", "Val Guest"].map(person));

  const folder = async (name: FolderName, parentId?: string) => (await perform(env.DB, ada, { type: "folder.create", name: `${name}-folder`, parentId })).id;
  const open = await folder("Open");
  const team = await folder("Team");
  const folders = { Open: open, Team: team, Deep: await folder("Deep", team) };

  const note = async (by: Actor, name: NoteName, text = "") => (await perform(env.DB, by, { type: "note.create", folderId: folders[FOLDER_OF[name]], text: textOf(name, text) })).id;
  const notes = { open: await note(ada, "open"), team: await note(ada, "team"), deep: await note(ada, "deep"), lone: await note(ada, "lone"), secret: "", vpriv: await note(vera, "vpriv") };
  await perform(env.DB, vera, { type: "note.setPrivate", id: notes.vpriv, private: true });
  await perform(env.DB, ada, { type: "member.setRole", memberId: vera.personId, as: "viewer" });
  notes.secret = await note(eve, "secret", `[[${notes.open}]]`);
  const zed = await connectAgent(env.DB, eve.personId, "Zed-agent");
  const asZed: Actor = { kind: "agent", agentId: zed.agent.id, personId: eve.personId, workspaceId: ada.workspaceId };
  await perform(env.DB, asZed, { type: "note.write", id: notes.secret, baseRevision: 1, text: textOf("secret", `[[${notes.open}]] more`) });
  // What an admin put on the note before it was private: a link, and a guest. Neither outlasts it becoming private.
  const linked = await perform(env.DB, ada, { type: "grant.link", noteId: notes.secret, link: "public" });
  await perform(env.DB, ada, { type: "grant.set", noteId: notes.secret, email: vic!.email, access: "view" });
  const { removed } = await perform(env.DB, eve, { type: "note.setPrivate", id: notes.secret, private: true });
  const before = { token: linked!.to.kind === "link" ? linked!.to.token : "", removed };

  await perform(env.DB, ada, { type: "grant.set", folderId: team, email: nedEmail, access: "view" });
  await perform(env.DB, ada, { type: "grant.set", folderId: team, email: gus!.email, access: "edit" });
  await perform(env.DB, ada, { type: "grant.set", folderId: team, email: vic!.email, access: "view" });
  await perform(env.DB, ada, { type: "grant.set", noteId: notes.lone, email: nia!.email, access: "edit" });
  await perform(env.DB, ada, { type: "grant.set", noteId: notes.lone, email: val!.email, access: "view" });

  const spare = {} as World["spare"];
  for (const name of NOTES) spare[name] = (await perform(env.DB, name === "secret" ? eve : name === "vpriv" ? vera : ada, { type: "grant.set", noteId: notes[name], email: `spare-${name}-${address()}`, access: "view" })).id;

  const marks = {} as World["marks"];
  for (const name of NOTES) marks[name] = [notes[name], `Title-${name}`, `body-${name}`, `spare-${name}-`, `todo-${name}`, `proj-${name}`, `tag-${name}`];
  for (const name of FOLDERS) marks[name] = [folders[name], `${name}-folder`];
  marks.secret.push(zed.agent.id, "Zed-agent");

  return {
    actors: {
      "Ada, an admin": ada,
      "Eve, an editor who owns the private note": eve,
      "Ed, an editor": ed,
      "Vera, a viewer who owns a private note": vera,
      "Ned, an editor narrowed to view on Team": ned,
      "Gus, a guest with edit on Team": gus!.actor,
      "Vic, a guest with view on Team": vic!.actor,
      "Nia, a guest with edit on the note lone": nia!.actor,
      "Val, a guest with view on the note lone": val!.actor,
    },
    notes,
    folders,
    spare,
    secretAgent: { id: zed.agent.id, name: "Zed-agent" },
    before,
    marks,
  };
}

type Args<K extends OpType> = Omit<Extract<OpInput, { type: K }>, "type">;

/**
 * What an operation is asked about, and what it needs of that. Each is given arguments that change
 * nothing an actor's access depends on, so the same world serves every operation: a write of the
 * text the note already has, a move to the folder it is in, a revert of a change that isn't there.
 */
type Plan<K extends OpType> =
  /** Needs `needs` of one note. `share` when it also takes a member who may share it, `members` when a guest is refused whatever they were given. */
  | { on: "note"; needs: "V" | "E"; share?: true; members?: true; args: (noteId: string, w: World, note: NoteName) => Args<K>; also?: "folder" }
  | { on: "folder"; needs: "V" | "E"; share?: true; args: (folderId: string, w: World) => Args<K> }
  /** Lists across the workspace: asked by everyone, and checked for anything of what they can't see. */
  | { on: "everything"; args: (w: World) => Args<K> }
  /** Decided by who is asking alone. `who` says which roles are let in; a guest never is. */
  | { on: "workspace"; who: readonly ("admin" | "editor" | "viewer" | "guest")[]; args: (w: World) => Args<K> }
  /** For whoever holds a link, and refused to everyone else. */
  | { on: "link"; args: (w: World) => Args<K> };

const EVERYONE = ["admin", "editor", "viewer", "guest"] as const;
const MEMBERS = ["admin", "editor", "viewer"] as const;
const ADMINS = ["admin"] as const;

const PLANS: { [K in OpType]: Plan<K> } = {
  "note.list": { on: "everything", args: () => ({}) },
  "note.create": { on: "folder", needs: "E", args: (folderId) => ({ folderId, text: "# Made" }) },
  "note.read": { on: "note", needs: "V", args: (id) => ({ id }) },
  "note.write": { on: "note", needs: "E", args: (id, w, note) => ({ id, baseRevision: note === "secret" ? 2 : 1, text: note === "secret" ? textOf("secret", `[[${w.notes.open}]] more`) : textOf(note) }) },
  "note.backlinks": { on: "note", needs: "V", args: (id) => ({ id }) },
  "note.history": { on: "note", needs: "V", args: (id) => ({ id }) },
  "note.move": { on: "note", needs: "E", also: "folder", args: (id, w, note) => ({ id, folderId: w.folders[FOLDER_OF[note]] }) },
  "note.label": { on: "note", needs: "E", args: (id) => ({ id, revision: 1, name: "Start" }) },
  "note.revert": { on: "note", needs: "E", args: (id, _, note) => ({ id, revision: note === "secret" ? 2 : 1 }) },
  "note.revertChanges": { on: "note", needs: "E", args: (id) => ({ id, revisions: [99] }) },
  "note.reapplyChanges": { on: "note", needs: "E", args: (id) => ({ id, revisions: [1] }) },
  "note.undo": { on: "note", needs: "E", args: (id) => ({ id }) },
  "note.redo": { on: "note", needs: "E", args: (id) => ({ id }) },
  "history.list": { on: "everything", args: () => ({}) },
  "history.authors": { on: "everything", args: () => ({}) },
  "history.revertAuthor": { on: "workspace", who: ["admin", "editor", "guest"], args: () => ({ author: { kind: "agent", id: "aaaaaaaaaaaa" } }) },
  "history.activity": { on: "everything", args: (w) => ({ timeZone: "UTC", author: { kind: "agent", id: w.secretAgent.id } }) },
  "links.rebuild": { on: "workspace", who: ADMINS, args: () => ({}) },
  "todo.list": { on: "everything", args: () => ({ includeCompleted: true }) },
  "todo.filters": { on: "everything", args: () => ({}) },
  "todo.set": { on: "note", needs: "E", args: (id, _, note) => ({ id, revision: note === "secret" ? 2 : 1, line: 3, text: todoOf(note), importance: 0 }) },
  "todos.rebuild": { on: "workspace", who: ADMINS, args: () => ({}) },
  "folder.list": { on: "everything", args: () => ({}) },
  "folder.create": { on: "folder", needs: "E", args: (parentId) => ({ parentId, name: `New-${crypto.randomUUID().slice(0, 8)}` }) },
  "folder.rename": { on: "folder", needs: "E", args: (id, w) => ({ id, name: `${FOLDERS.find((f) => w.folders[f] === id)}-folder` }) },
  "folder.delete": { on: "workspace", who: ADMINS, args: () => ({ id: "aaaaaaaaaaaa" }) },
  "settings.read": { on: "workspace", who: EVERYONE, args: () => ({}) },
  "settings.write": { on: "workspace", who: EVERYONE, args: () => ({ text: "{}", baseRevision: 99 }) },
  "member.list": { on: "workspace", who: MEMBERS, args: () => ({}) },
  "member.invite": { on: "workspace", who: ADMINS, args: () => ({ email: address(), as: "viewer" }) },
  "member.setRole": { on: "workspace", who: ADMINS, args: () => ({ memberId: "aaaaaaaaaaaa", as: "viewer" }) },
  "member.remove": { on: "workspace", who: ADMINS, args: () => ({ memberId: "aaaaaaaaaaaa" }) },
  "member.leave": { on: "workspace", who: [], args: () => ({}) },
  "invite.list": { on: "workspace", who: ADMINS, args: () => ({}) },
  "invite.revoke": { on: "workspace", who: ADMINS, args: () => ({ id: "aaaaaaaaaaaa" }) },
  "grant.list": { on: "note", needs: "V", args: (noteId) => ({ noteId }) },
  "grant.set": { on: "note", needs: "V", share: true, args: (noteId) => ({ noteId, email: address(), access: "view" }) },
  "grant.link": { on: "folder", needs: "V", share: true, args: (folderId) => ({ folderId, link: "signed_in" }) },
  "grant.revoke": { on: "note", needs: "V", share: true, args: (_, w, note) => ({ id: w.spare[note] }) },
  "note.setPrivate": { on: "note", needs: "V", members: true, args: (id, _, note) => ({ id, private: note === "secret" }) },
  "shared.open": { on: "link", args: () => ({}) },
  "shared.read": { on: "link", args: (w) => ({ id: w.notes.open }) },
};

/** How an operation ended: done, or refused and how. */
type Outcome = "done" | "forbidden" | `not_found: ${string}` | `other: ${string}`;

async function ask(actor: Actor | Visitor, op: OpInput): Promise<{ outcome: Outcome; answer?: unknown }> {
  try {
    return { outcome: "done", answer: await perform(env.DB, actor, op) };
  } catch (err) {
    if (!(err instanceof OpError)) throw err;
    // Refused for something other than who is asking, so they were let through to it.
    if (err.code === "invalid" || err.code === "conflict") return { outcome: "done" };
    if (err.code === "forbidden") return { outcome: "forbidden" };
    return { outcome: `not_found: ${err.message}` };
  }
}

const roleOf = (name: ActorName) => (name.includes("admin") ? "admin" : name.includes("editor") ? "editor" : name.includes("viewer") ? "viewer" : "guest");
const levelOf = (name: ActorName, note: NoteName) => ACTORS[name].notes[NOTES.indexOf(note)] as Level;
const folderLevelOf = (name: ActorName, folder: FolderName) => ACTORS[name].folders[FOLDERS.indexOf(folder)] as Level;
const enough = (level: Level, needs: "V" | "E") => level === "E" || (level === "V" && needs === "V");
/** Whether an actor may share a note: its owner when it is private, and otherwise a member who shares and can edit it. */
const sharesNote = (name: ActorName, note: NoteName) => OWNER[note] === name || (ACTORS[name].shares && levelOf(name, note) === "E");
const sharesFolder = (name: ActorName, folder: FolderName) => ACTORS[name].shares && folderLevelOf(name, folder) === "E";
/** What a read-only token is refused whoever its person is, beyond what needs edit of a note or folder. */
const CHANGES: readonly OpType[] = ["history.revertAuthor", "links.rebuild", "todos.rebuild", "folder.delete"];
const AGENTS = ["their agent", "their read-only agent", "their agent pinned to this workspace"] as const;

/** `not_found` for a note that was never there, which is what one the actor can't see must be answered with. */
const NO_NOTE: Outcome = "not_found: No such note";
const NO_FOLDER: Outcome = "not_found: No such folder";
const NO_CHANGE: Outcome = "not_found: The note has no change 99";
const NO_GRANT: Outcome = "not_found: No such grant";
const MISSING = "zzzzzzzzzzzz";

describe("every operation, by every actor", () => {
  it("has a row in this test, so a new operation can't be added without saying what it needs", () => {
    expect(Object.keys(PLANS).sort()).toEqual(Op.options.map((o) => o.shape.type.value).sort());
  });

  for (const name of Object.keys(ACTORS) as ActorName[]) {
    for (const as of ["themself", ...AGENTS] as const) {
      it(`${name}, as ${as}`, async () => {
        const w = await world();
        const person = w.actors[name];
        const scope = as === "their read-only agent" ? { readOnly: true } : as === "their agent pinned to this workspace" ? { pinnedWorkspaceId: person.workspaceId } : undefined;
        const actor: Actor = as === "themself" ? person : { kind: "agent", agentId: (await connectAgent(env.DB, person.personId, "Claude")).agent.id, personId: person.personId, workspaceId: person.workspaceId, scope };
        const readOnly = as === "their read-only agent";
        const role = roleOf(name);
        // What is told as a number gives a note away as surely as its title: a folder's count, and an author's changes by day.
        const { folders: listed } = await perform(env.DB, actor, { type: "folder.list" });
        const counted = (folder: FolderName) => NOTES.filter((note) => FOLDER_OF[note] === folder && levelOf(name, note) !== "-").length;
        expect(Object.fromEntries(listed.map((f) => [f.name, f.noteCount]))).toEqual(Object.fromEntries(FOLDERS.filter((f) => folderLevelOf(name, f) !== "-").map((f) => [`${f}-folder`, counted(f)]).concat(role === "guest" ? [] : [["Unsorted", 0]])));
        const { days } = await perform(env.DB, actor, { type: "history.activity", timeZone: "UTC", author: { kind: "agent", id: w.secretAgent.id } });
        expect(days.map((day) => day.count)).toEqual(levelOf(name, "secret") === "-" ? [] : [1]);

        const answers: unknown[] = [];
        const got: Record<string, Outcome> = {};
        const expected: Record<string, Outcome> = {};
        const run = async (key: string, type: OpType, args: object, expectation: Outcome, letThrough = false) => {
          const kept = as !== "themself" && NOT_FOR_AGENTS[type] !== undefined;
          const { outcome, answer } = await ask(actor, { type, ...args } as OpInput);
          // An operation on the workspace is asked about a member, an invite or a folder that isn't there: finding none, it had let the actor through.
          got[key] = letThrough && outcome.startsWith("not_found") ? "done" : outcome;
          const changes = readOnly && (CHANGES.includes(type) || ((PLANS[type] as Plan<OpType>).on === "note" || (PLANS[type] as Plan<OpType>).on === "folder" ? (PLANS[type] as { needs: string }).needs === "E" : false));
          expected[key] = kept || changes ? "forbidden" : expectation;
          if (answer !== undefined) answers.push(answer);
        };

        for (const type of Object.keys(PLANS) as OpType[]) {
          const plan = PLANS[type] as Plan<OpType>;
          if (plan.on === "note") {
            for (const note of NOTES) {
              const level = levelOf(name, note);
              let expectation: Outcome = level === "-" ? NO_NOTE : !enough(level, plan.needs) || (plan.share && !sharesNote(name, note)) ? "forbidden" : "done";
              // Whoever can't even change anything in the workspace is refused before the note is looked for, and told nothing of it.
              if (plan.needs === "E" && (role === "viewer" || (role === "guest" && !ACTORS[name].notes.includes("E")))) expectation = "forbidden";
              if ((plan.share || plan.members) && role === "guest") expectation = "forbidden";
              if (expectation === "done" && plan.also === "folder" && folderLevelOf(name, FOLDER_OF[note]) === "-") expectation = NO_FOLDER;
              if (expectation === "done" && type === "note.revertChanges") expectation = NO_CHANGE;
              if (type === "grant.revoke" && expectation === NO_NOTE) expectation = NO_GRANT;
              await run(`${type} ${note}`, type, plan.args(w.notes[note], w, note), expectation);
            }
            // The same operation on a note that was never there: what a hidden note has to look like.
            if (type !== "grant.revoke") {
              const missing = await ask(actor, { type, ...plan.args(MISSING, w, "open"), ...(type === "grant.list" || type === "grant.set" ? { noteId: MISSING } : { id: MISSING }) } as OpInput);
              const hidden = NOTES.filter((note) => levelOf(name, note) === "-" && got[`${type} ${note}`] !== "forbidden").map((note) => got[`${type} ${note}`]);
              expect(hidden.every((outcome) => outcome === missing.outcome), `${type}: a hidden note and a missing one`).toBe(true);
            }
          } else if (plan.on === "folder") {
            for (const folder of FOLDERS) {
              const level = folderLevelOf(name, folder);
              let expectation: Outcome = level === "-" ? NO_FOLDER : !enough(level, plan.needs) || (plan.share && !sharesFolder(name, folder)) ? "forbidden" : "done";
              if (plan.needs === "E" && (role === "viewer" || (role === "guest" && !ACTORS[name].notes.includes("E")))) expectation = "forbidden";
              if (plan.share && role === "guest") expectation = "forbidden";
              // A guest renames only inside what was shared: Team is the shared folder itself, Deep is inside it.
              if (type === "folder.rename" && role === "guest" && expectation === "done" && folder === "Team") expectation = "forbidden";
              await run(`${type} ${folder}`, type, plan.args(w.folders[folder], w), expectation);
            }
          } else if (plan.on === "everything") {
            await run(type, type, plan.args(w), "done");
          } else if (plan.on === "workspace") {
            let allowed = (plan.who as readonly string[]).includes(role);
            if (type === "history.revertAuthor" && role === "guest") allowed = ACTORS[name].notes.includes("E");
            // The one admin can't leave, and nobody here asks to: leaving is checked in members.test.ts.
            if (type === "member.leave") continue;
            await run(type, type, plan.args(w), allowed ? "done" : "forbidden", true);
          } else {
            await run(type, type, plan.args(w), "forbidden");
          }
        }
        // The listings again, each narrowed the ways it can be: by note, by author, by time. A filter that names a hidden note finds nothing of it.
        const every = Object.values(w.notes);
        const narrowed: Args<"history.list">[] = [{ noteIds: every }, { noteIds: [w.notes.secret, w.notes.vpriv] }, { authors: [{ kind: "agent", id: w.secretAgent.id }] }, { from: 0, to: Date.now() + 86_400_000, limit: 100 }, { noteIds: every, diffs: false, limit: 1 }];
        for (const [i, args] of narrowed.entries()) await run(`history.list narrowed ${i}`, "history.list", args, "done");
        await run("history.revertAuthor narrowed", "history.revertAuthor", { author: { kind: "agent", id: "aaaaaaaaaaaa" }, noteIds: every }, role === "viewer" || (role === "guest" && !ACTORS[name].notes.includes("E")) ? "forbidden" : "done");
        await run("note.list in a hidden folder", "note.list", { folderId: w.folders.Open }, "done");
        // Every grant in the workspace is an admin's to see, and nobody else's.
        await run("grant.list of the workspace", "grant.list", {}, role === "admin" ? "done" : "forbidden");
        expect(got).toEqual(expected);

        // Nothing any operation answered says anything of what the actor can't see: not an id, a title, a word of it, or who wrote it.
        const said = JSON.stringify(answers);
        const hidden = [...NOTES.filter((note) => levelOf(name, note) === "-"), ...FOLDERS.filter((folder) => folderLevelOf(name, folder) === "-")];
        expect(hidden.flatMap((item) => w.marks[item].filter((mark) => said.includes(mark)).map((mark) => `${item}: ${mark}`))).toEqual([]);
        // And what they can see is there, so the check above isn't passing on an empty answer.
        const seen = NOTES.filter((note) => levelOf(name, note) !== "-");
        expect(seen.filter((note) => !said.includes(`Title-${note}`))).toEqual([]);
      });
    }
  }

  it("lets a grant that waited for its email take effect only if its maker may still share the item, by the same table", async () => {
    const w = await world();
    const waiting: Record<string, string> = {};
    const expected: Record<string, boolean> = {};
    for (const name of Object.keys(ACTORS) as ActorName[]) {
      const maker = w.actors[name];
      const items = [...NOTES.map((note) => ({ key: note as string, column: "note_id", id: w.notes[note], level: levelOf(name, note) })), ...FOLDERS.map((folder) => ({ key: folder as string, column: "folder_id", id: w.folders[folder], level: folderLevelOf(name, folder) }))];
      for (const item of items) {
        const email = address();
        // Written straight into the record, as a grant made while its maker still could and left waiting since.
        await env.DB.prepare(`INSERT INTO grants (id, workspace_id, ${item.column}, kind, email, access, granted_by, created_at) VALUES (?, ?, ?, 'person', ?, 'view', ?, 0)`)
          .bind(crypto.randomUUID().replace(/-/g, "").slice(0, 12), maker.workspaceId, item.id, email, maker.personId)
          .run();
        waiting[`${name} / ${item.key}`] = email;
        expected[`${name} / ${item.key}`] = item.column === "note_id" ? sharesNote(name, item.key as NoteName) : sharesFolder(name, item.key as FolderName);
      }
    }
    const took: Record<string, boolean> = {};
    for (const [key, email] of Object.entries(waiting)) {
      const { personId } = await signIn(env.DB, { email, name: "Waited For" });
      took[key] = (await env.DB.prepare("SELECT 1 FROM grants WHERE person_id = ?").bind(personId).first()) !== null;
    }
    expect(took).toEqual(expected);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE email IN (SELECT value FROM json_each(?)) AND person_id IS NULL").bind(JSON.stringify(Object.values(waiting))).first()).toEqual({ n: 0 });
  });

  it("leaves on a note that becomes private only what its owner put there: an admin's link and an admin's grant go", async () => {
    const w = await world();
    expect(w.before.removed).toBe(2);
    await expect(perform(env.DB, { kind: "visitor", token: w.before.token, personId: null }, { type: "shared.open" })).rejects.toMatchObject({ code: "not_found", message: "No such link" });
    const eve = w.actors["Eve, an editor who owns the private note"];
    expect((await perform(env.DB, eve, { type: "grant.list", noteId: w.notes.secret })).grants.map((g) => g.grantedBy.name)).toEqual(["Eve Editor"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM grants WHERE note_id = ? AND granted_by <> ?").bind(w.notes.secret, eve.personId).first()).toEqual({ n: 0 });
  });

  it("opens through a folder's link the notes in that folder, and neither a note outside it nor a private note inside it", async () => {
    const w = await world();
    const link = await perform(env.DB, w.actors["Ada, an admin"], { type: "grant.link", folderId: w.folders.Team, link: "public" });
    const visitor: Visitor = { kind: "visitor", token: link!.to.kind === "link" ? link!.to.token : "", personId: null };
    const read: Record<string, Outcome> = {};
    const answers: unknown[] = [(await ask(visitor, { type: "shared.open" })).answer];
    for (const note of NOTES) {
      const { outcome, answer } = await ask(visitor, { type: "shared.read", id: w.notes[note] });
      read[note] = outcome;
      if (answer !== undefined) answers.push(answer);
    }
    expect(read).toEqual({ open: NO_NOTE, team: "done", deep: "done", lone: NO_NOTE, secret: NO_NOTE, vpriv: NO_NOTE });
    expect((await ask(visitor, { type: "shared.read", id: MISSING })).outcome).toBe(NO_NOTE);
    const said = JSON.stringify(answers);
    expect((["open", "lone", "secret", "vpriv", "Open"] as const).flatMap((item) => w.marks[item].filter((mark) => said.includes(mark)))).toEqual([]);
    expect(said).not.toMatch(/Ada|Eve Editor|Zed-agent/);
  });

  it("refuses whoever holds a link everything but opening it, and refuses everyone else that", async () => {
    const w = await world();
    const ada = w.actors["Ada, an admin"];
    const link = await perform(env.DB, ada, { type: "grant.link", noteId: w.notes.open, link: "public" });
    const visitor: Visitor = { kind: "visitor", token: link!.to.kind === "link" ? link!.to.token : "", personId: null };
    const outcomes: Record<string, Outcome> = {};
    for (const type of Object.keys(PLANS) as OpType[]) {
      const plan = PLANS[type] as Plan<OpType>;
      const args = plan.on === "note" ? plan.args(w.notes.open, w, "open") : plan.on === "folder" ? plan.args(w.folders.Open, w) : plan.args(w);
      outcomes[type] = (await ask(visitor, { type, ...args } as OpInput)).outcome;
    }
    expect(outcomes).toEqual(Object.fromEntries((Object.keys(PLANS) as OpType[]).map((type) => [type, type.startsWith("shared.") ? "done" : "forbidden"])));
  });

  it("answers someone who is in the workspace in no way as if there were no workspace, whatever they ask", async () => {
    const w = await world();
    const sam: Actor = { kind: "member", personId: (await signIn(env.DB, { email: address(), name: "Sam Stranger" })).personId, workspaceId: w.actors["Ada, an admin"].workspaceId };
    // Ed was a member a moment ago and still has his session, and his agent its token. Ada's agent holds a token for another workspace only.
    const ed = w.actors["Ed, an editor"];
    const edsAgent: Actor = { kind: "agent", agentId: (await connectAgent(env.DB, ed.personId, "Claude")).agent.id, personId: ed.personId, workspaceId: ed.workspaceId };
    await perform(env.DB, w.actors["Ada, an admin"], { type: "member.remove", memberId: ed.personId });
    const ada = w.actors["Ada, an admin"];
    const elsewhere: Actor = { kind: "agent", agentId: (await connectAgent(env.DB, ada.personId, "Claude")).agent.id, personId: ada.personId, workspaceId: ada.workspaceId, scope: { pinnedWorkspaceId: "aaaaaaaaaaaa" } };
    for (const [who, actor] of Object.entries({ "a stranger": sam, "a removed member": ed, "a removed member's agent": edsAgent, "an agent pinned to another workspace": elsewhere })) {
      const outcomes = new Set<Outcome>();
      for (const type of Object.keys(PLANS) as OpType[]) {
        const plan = PLANS[type] as Plan<OpType>;
        if (plan.on === "link") continue;
        const args = plan.on === "note" ? plan.args(w.notes.open, w, "open") : plan.on === "folder" ? plan.args(w.folders.Open, w) : plan.args(w);
        outcomes.add((await ask(actor, { type, ...args } as OpInput)).outcome);
      }
      expect([...outcomes], who).toEqual(["not_found: No such workspace"]);
    }
  });
});
