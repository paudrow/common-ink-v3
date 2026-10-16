import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { IN_TRASH, type Covering, type NoteState, type Trashed } from "../../src/core/lifecycle.ts";
import { newId } from "../../src/core/ids.ts";
import { perform, type Actor, type Visitor } from "../../src/core/operations.ts";
import { UPLOAD_IN_TRASH } from "../../src/core/uploads.ts";
import { Op, OpError, type CalendarEvent, type OpInput, type OpType, type Results } from "../../src/core/protocol.ts";
import type { Sources } from "../../src/core/sources.ts";
import { NOT_FOR_AGENTS } from "../../src/worker/mcp/tools.ts";
import { addMember, newMember } from "./members.ts";
import { PNG, upload } from "./uploading.ts";

/*
 * Every operation, asked by every kind of actor, of every kind of note and folder. What each actor
 * may do with each item is written out below as a table. The operations are not: each one only says
 * what it needs of the item it is pointed at, and the test works out from the table whether it is
 * done, refused, or answered as if the item weren't there. An operation with no row here fails the
 * first test, so one added later can't go unasked.
 *
 * Where a note is in its life is written out the same way, beside who may see it: one note is
 * archived and one is in Trash. Each operation on a note says what it does with a note in Trash,
 * and each listing says which states it covers, so none can leave either unsaid.
 *
 * Beside every note is an upload of the same name: in the same folder, in the same state, private to
 * the same owner, under the same grants. An upload is decided as a note is, so the one table says
 * what each actor may do with both, and an operation on an upload is held to the row its note has.
 */

type Level = "-" | "V" | "E";
const NOTES = ["open", "team", "deep", "lone", "secret", "vpriv", "arch", "bin"] as const;
const FOLDERS = ["Open", "Team", "Deep"] as const;
type NoteName = (typeof NOTES)[number];
type FolderName = (typeof FOLDERS)[number];
const FOLDER_OF: Record<NoteName, FolderName> = { open: "Open", team: "Team", deep: "Deep", lone: "Open", secret: "Team", vpriv: "Open", arch: "Open", bin: "Team" };
/** `arch` is archived and `bin` is in Trash. Every other note is live. */
const STATE_OF: Record<NoteName, NoteState> = { open: "live", team: "live", deep: "live", lone: "live", secret: "live", vpriv: "live", arch: "archived", bin: "trashed" };
const COVERED: Record<Covering, readonly NoteState[]> = { live: ["live"], archived: ["archived"], kept: ["live", "archived"], trashed: ["trashed"], any: ["live", "archived", "trashed"] };

/**
 * Each actor, what they may do with each note (open team deep lone secret vpriv arch bin) and each folder (Open Team Deep), and whether they may
 * share what they can edit. `secret` is private to Eve and `vpriv` to Vera, and an owner shares their own private note whatever their role.
 */
const OWNER: Partial<Record<NoteName, string>> = { secret: "Eve, an editor who owns the private note", vpriv: "Vera, a viewer who owns a private note" };

const ACTORS = {
  "Ada, an admin": { notes: "EEEE--EE", folders: "EEE", shares: true },
  "Eve, an editor who owns the private note": { notes: "EEEEE-EE", folders: "EEE", shares: true },
  "Ed, an editor": { notes: "EEEE--EE", folders: "EEE", shares: true },
  "Vera, a viewer who owns a private note": { notes: "VVVV-VVV", folders: "VVV", shares: false },
  "Ned, an editor narrowed to view on Team": { notes: "EVVE--EV", folders: "EVV", shares: true },
  "Gus, a guest with edit on Team": { notes: "-EE----E", folders: "-EE", shares: false },
  "Vic, a guest with view on Team": { notes: "-VV----V", folders: "-VV", shares: false },
  "Nia, a guest with edit on the note lone": { notes: "---E----", folders: "---", shares: false },
  "Val, a guest with view on the note lone": { notes: "---V----", folders: "---", shares: false },
} as const;
type ActorName = keyof typeof ACTORS;

interface World {
  actors: Record<ActorName, Actor>;
  notes: Record<NoteName, string>;
  /** The upload beside each note. */
  uploads: Record<NoteName, string>;
  folders: Record<FolderName, string>;
  /** A grant on each note, there to be revoked. */
  spare: Record<NoteName, string>;
  /** And one on each upload. */
  spareUpload: Record<NoteName, string>;
  /** An agent of Eve's that has only ever written the private note. */
  secretAgent: { id: string; name: string };
  /** A link an admin put on `secret` before its owner made it private, and how many grants went when she did. */
  before: { token: string; removed: number };
  /** For each note and folder, everything that would give it away: its id, its title, a word of its text. */
  marks: Record<NoteName | FolderName, string[]>;
}

const address = () => `${crypto.randomUUID()}@example.com`;

/** Each note has a todo with words of its own, a tag of its own, and someone of its own it is assigned to, which give the note away as its title does. */
const todoOf = (name: NoteName) => `- [ ] todo-${name} +proj-${name} #tag-${name} @[[who-${name}]]`;
const textOf = (name: NoteName, more = "") => `# Title-${name}\n\nbody-${name} ${more}\n${todoOf(name)}`;

/** `more` is written in every note's text, after its own words. */
async function world(more = ""): Promise<World> {
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

  const note = async (by: Actor, name: NoteName, text = "") => (await perform(env.DB, by, { type: "note.create", folderId: folders[FOLDER_OF[name]], text: textOf(name, more ? `${text} ${more}` : text) })).id;
  const notes = { open: await note(ada, "open"), team: await note(ada, "team"), deep: await note(ada, "deep"), lone: await note(ada, "lone"), secret: "", vpriv: await note(vera, "vpriv"), arch: await note(ada, "arch"), bin: await note(ada, "bin") };
  const file = async (by: Actor, name: NoteName, more: { private?: boolean } = {}) => (await upload(by, `File-${name}.png`, PNG, { folderId: folders[FOLDER_OF[name]], ...more })).id;
  const uploads = { open: await file(ada, "open"), team: await file(ada, "team"), deep: await file(ada, "deep"), lone: await file(ada, "lone"), secret: await file(eve, "secret"), vpriv: await file(vera, "vpriv", { private: true }), arch: await file(ada, "arch"), bin: await file(ada, "bin") };
  await perform(env.DB, ada, { type: "upload.archive", id: uploads.arch, archived: true });
  await perform(env.DB, ada, { type: "upload.trash", id: uploads.bin });
  // As with the note: what an admin put on the upload before it was private goes when its owner makes it so.
  await perform(env.DB, ada, { type: "grant.set", uploadId: uploads.secret, email: `gone-${address()}`, access: "view" });
  expect(await perform(env.DB, eve, { type: "upload.setPrivate", id: uploads.secret, private: true })).toEqual({ id: uploads.secret, private: true, removed: 1 });
  await perform(env.DB, ada, { type: "note.archive", id: notes.arch, archived: true });
  await perform(env.DB, ada, { type: "note.trash", id: notes.bin });
  await perform(env.DB, vera, { type: "note.setPrivate", id: notes.vpriv, private: true });
  await perform(env.DB, ada, { type: "member.setRole", memberId: vera.personId, as: "viewer" });
  notes.secret = await note(eve, "secret", `[[${notes.open}]]`);
  const zed = await connectAgent(env.DB, eve.personId, "Zed-agent");
  const asZed: Actor = { kind: "agent", agentId: zed.agent.id, personId: eve.personId, workspaceId: ada.workspaceId };
  await perform(env.DB, asZed, { type: "note.write", id: notes.secret, baseRevision: 1, text: textOf("secret", `[[${notes.open}]] more${more && ` ${more}`}`) });
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
  await perform(env.DB, ada, { type: "grant.set", uploadId: uploads.lone, email: nia!.email, access: "edit" });
  await perform(env.DB, ada, { type: "grant.set", uploadId: uploads.lone, email: val!.email, access: "view" });

  const spare = {} as World["spare"];
  for (const name of NOTES) spare[name] = (await perform(env.DB, name === "secret" ? eve : name === "vpriv" ? vera : ada, { type: "grant.set", noteId: notes[name], email: `spare-${name}-${address()}`, access: "view" })).id;

  const spareUpload = {} as World["spareUpload"];
  for (const name of NOTES) spareUpload[name] = (await perform(env.DB, name === "secret" ? eve : name === "vpriv" ? vera : ada, { type: "grant.set", uploadId: uploads[name], email: `spare-up-${name}-${address()}`, access: "view" })).id;

  const marks = {} as World["marks"];
  for (const name of NOTES) marks[name] = [notes[name], `Title-${name}`, `body-${name}`, `spare-${name}-`, `todo-${name}`, `proj-${name}`, `tag-${name}`, `who-${name}`, uploads[name], `File-${name}`, `spare-up-${name}-`];
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
    uploads,
    folders,
    spare,
    spareUpload,
    secretAgent: { id: zed.agent.id, name: "Zed-agent" },
    before,
    marks,
  };
}

type Args<K extends OpType> = Omit<Extract<OpInput, { type: K }>, "type">;

/** Puts a note back in the state the table gives it, after an operation that moved it. */
const settle = (w: World, note: NoteName, table: "notes" | "uploads" = "notes") =>
  env.DB.prepare(`UPDATE ${table} SET state = ?2, state_at = ?3, state_by = ?4, state_by_kind = ?5, restores_as = ?6, restores_to = ?7, folder_id = ?8 WHERE id = ?1`)
    .bind(
      (table === "notes" ? w.notes : w.uploads)[note],
      STATE_OF[note],
      STATE_OF[note] === "live" ? null : Date.now(),
      STATE_OF[note] === "live" ? null : w.actors["Ada, an admin"].personId,
      STATE_OF[note] === "live" ? null : "member",
      STATE_OF[note] === "trashed" ? "live" : null,
      STATE_OF[note] === "trashed" ? w.folders[FOLDER_OF[note]] : null,
      w.folders[FOLDER_OF[note]],
    )
    .run();
/** The operations that move a note through its life, each followed by `settle`. */
const MOVES: readonly OpType[] = ["note.trash", "note.restore", "upload.trash", "upload.restore"];

/**
 * What an operation is asked about, and what it needs of that. Each is given arguments that change
 * nothing an actor's access depends on, so the same world serves every operation: a write of the
 * text the note already has, a move to the folder it is in, a revert of a change that isn't there.
 */
type Plan<K extends OpType> =
  /**
   * Needs `needs` of one note. `share` when it also takes a member who may share it, `members` when a guest is refused whatever they were given,
   * `maker` when it takes an admin or the member who made the note. `trashed` is what it does with a note in Trash, for someone it would otherwise let through.
   */
  | { on: "note"; needs: "V" | "E"; trashed: Exclude<Trashed, "hidden">; share?: true; members?: true; maker?: true; args: (noteId: string, w: World, note: NoteName) => Args<K>; also?: "folder" }
  /** The same of the upload beside each note. */
  | { on: "upload"; needs: "V" | "E"; trashed: Exclude<Trashed, "hidden">; share?: true; members?: true; maker?: true; args: (uploadId: string, w: World, note: NoteName) => Args<K>; also?: "folder" }
  | { on: "folder"; needs: "V" | "E"; share?: true; args: (folderId: string, w: World) => Args<K> }
  /**
   * Lists across the workspace: asked by everyone, and checked for anything of what they can't see. `covers` is the states of the notes
   * it lists as asked here, and with `archived` it takes `includeArchived`, which is asked too and covers archived notes as well.
   * With `only` it also takes `includeArchived: "only"`, which is asked too and covers the archived notes alone.
   */
  | { on: "everything"; covers: Covering; archived?: true; only?: true; args: (w: World) => Args<K> }
  /** Decided by who is asking alone. `who` says which roles are let in; a guest never is. */
  | { on: "workspace"; who: readonly ("admin" | "editor" | "viewer" | "guest")[]; args: (w: World) => Args<K> }
  /** For whoever holds a link, and refused to everyone else. */
  | { on: "link"; args: (w: World) => Args<K> };

const MISSING = "zzzzzzzzzzzz";
/** One change of every note there is, and of one that was never there. */
const everyNote = (w: World, revision: number) => ({ changes: [...Object.values(w.notes), MISSING].map((noteId) => ({ noteId, revisions: [revision] })) });

const EVERYONE = ["admin", "editor", "viewer", "guest"] as const;
const MEMBERS = ["admin", "editor", "viewer"] as const;
const ADMINS = ["admin"] as const;

const PLANS: { [K in OpType]: Plan<K> } = {
  "note.list": { on: "everything", covers: "live", archived: true, only: true, args: () => ({}) },
  "note.create": { on: "folder", needs: "E", args: (folderId) => ({ folderId, text: "# Made" }) },
  "note.read": { on: "note", needs: "V", trashed: "opens", args: (id) => ({ id }) },
  "note.write": { on: "note", needs: "E", trashed: "refused", args: (id, w, note) => ({ id, baseRevision: note === "secret" ? 2 : 1, text: note === "secret" ? textOf("secret", `[[${w.notes.open}]] more`) : textOf(note) }) },
  "note.backlinks": { on: "note", needs: "V", trashed: "opens", args: (id) => ({ id }) },
  "note.history": { on: "note", needs: "V", trashed: "opens", args: (id) => ({ id }) },
  "note.diff": { on: "note", needs: "V", trashed: "opens", args: (id) => ({ id, revision: 1 }) },
  "note.blame": { on: "note", needs: "V", trashed: "opens", args: (id) => ({ id }) },
  "note.move": { on: "note", needs: "E", trashed: "refused", also: "folder", args: (id, w, note) => ({ id, folderId: w.folders[FOLDER_OF[note]] }) },
  // Archiving sets the state the note already has, and trashing and restoring are each followed by `settle`.
  "note.archive": { on: "note", needs: "E", trashed: "refused", args: (id, _, note) => ({ id, archived: STATE_OF[note] === "archived" }) },
  "note.trash": { on: "note", needs: "E", trashed: "opens", args: (id) => ({ id }) },
  "note.restore": { on: "note", needs: "E", trashed: "opens", args: (id) => ({ id }) },
  "trash.list": { on: "everything", covers: "trashed", args: () => ({}) },
  "tag.list": { on: "everything", covers: "live", archived: true, args: () => ({}) },
  search: { on: "everything", covers: "live", archived: true, only: true, args: () => ({ query: "body", limit: 50 }) },
  "note.label": { on: "note", needs: "E", trashed: "refused", args: (id) => ({ id, revision: 1, name: "Start" }) },
  "note.revert": { on: "note", needs: "E", trashed: "refused", args: (id, _, note) => ({ id, revision: note === "secret" ? 2 : 1 }) },
  "note.revertChanges": { on: "note", needs: "E", trashed: "refused", args: (id) => ({ id, revisions: [99] }) },
  "note.previewRevert": { on: "note", needs: "V", trashed: "opens", args: (id) => ({ id, revisions: [1] }) },
  "note.undo": { on: "note", needs: "E", trashed: "refused", args: (id) => ({ id }) },
  "note.redo": { on: "note", needs: "E", trashed: "refused", args: (id) => ({ id }) },
  "history.summary": { on: "everything", covers: "kept", args: () => ({ limit: 100 }) },
  "history.list": { on: "everything", covers: "kept", args: () => ({}) },
  "history.authors": { on: "everything", covers: "kept", args: () => ({}) },
  "history.revertAuthor": { on: "workspace", who: ["admin", "editor", "guest"], args: () => ({ author: { kind: "agent", id: "aaaaaaaaaaaa" } }) },
  "history.diff": { on: "note", needs: "V", trashed: "opens", args: (noteId) => ({ changes: [{ noteId, revisions: [1] }] }) },
  // These two answer note by note, and a note the actor can't see is one of the answers: each is asked of every note at once, and one that was never there.
  "history.previewRevert": { on: "everything", covers: "any", args: (w) => everyNote(w, 1) },
  "history.revert": { on: "workspace", who: ["admin", "editor", "guest"], args: (w) => everyNote(w, 99) },
  "links.rebuild": { on: "workspace", who: ADMINS, args: () => ({}) },
  "todo.list": { on: "everything", covers: "live", archived: true, args: () => ({ includeCompleted: true }) },
  "todo.filters": { on: "everything", covers: "live", archived: true, args: () => ({}) },
  "todo.set": { on: "note", needs: "E", trashed: "refused", args: (id, _, note) => ({ id, revision: note === "secret" ? 2 : 1, line: 3, text: todoOf(note), importance: 0 }) },
  "todo.history": { on: "note", needs: "V", trashed: "opens", args: (id, _, note) => ({ id, revision: note === "secret" ? 2 : 1, line: 3, text: todoOf(note) }) },
  "todos.rebuild": { on: "workspace", who: ADMINS, args: () => ({}) },
  "daily.open": { on: "workspace", who: ["admin", "editor"], args: () => ({ on: "2026-10-11" }) },
  "folder.list": { on: "everything", covers: "live", args: () => ({}) },
  "folder.create": { on: "folder", needs: "E", args: (parentId) => ({ parentId, name: `New-${crypto.randomUUID().slice(0, 8)}` }) },
  "folder.rename": { on: "folder", needs: "E", args: (id, w) => ({ id, name: `${FOLDERS.find((f) => w.folders[f] === id)}-folder` }) },
  "folder.move": { on: "folder", needs: "E", args: (id, w) => ({ id, parentId: id === w.folders.Deep ? w.folders.Team : null }) },
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
  "grant.list": { on: "note", needs: "V", trashed: "opens", args: (noteId) => ({ noteId }) },
  "grant.set": { on: "note", needs: "V", trashed: "opens", share: true, args: (noteId) => ({ noteId, email: address(), access: "view" }) },
  "grant.link": { on: "folder", needs: "V", share: true, args: (folderId) => ({ folderId, link: "signed_in" }) },
  "grant.revoke": { on: "note", needs: "V", trashed: "opens", share: true, args: (_, w, note) => ({ id: w.spare[note] }) },
  "note.setPrivate": { on: "note", needs: "V", trashed: "opens", members: true, args: (id, _, note) => ({ id, private: note === "secret" }) },
  "shared.open": { on: "link", args: () => ({}) },
  "shared.read": { on: "link", args: (w) => ({ id: w.notes.open }) },
  "shared.upload": { on: "link", args: (w) => ({ id: w.uploads.open }) },
  "upload.create": { on: "folder", needs: "E", args: (folderId) => ({ folderId, name: "made.png", size: PNG.byteLength }) },
  "upload.list": { on: "everything", covers: "live", archived: true, args: () => ({}) },
  "upload.read": { on: "upload", needs: "V", trashed: "opens", args: (id) => ({ id }) },
  "upload.open": { on: "upload", needs: "V", trashed: "opens", args: (id) => ({ id }) },
  "upload.move": { on: "upload", needs: "E", trashed: "refused", also: "folder", args: (id, w, note) => ({ id, folderId: w.folders[FOLDER_OF[note]] }) },
  // The upload beside each note put in that note: none here is its owner's alone in a note that isn't private, so nothing moves.
  "upload.place": { on: "upload", needs: "E", trashed: "refused", args: (id, w, note) => ({ id, noteId: w.notes[note] }) },
  "upload.archive": { on: "upload", needs: "E", trashed: "refused", args: (id, _, note) => ({ id, archived: STATE_OF[note] === "archived" }) },
  "upload.trash": { on: "upload", needs: "E", trashed: "opens", args: (id) => ({ id }) },
  "upload.restore": { on: "upload", needs: "E", trashed: "opens", args: (id) => ({ id }) },
  "upload.trashed": { on: "everything", covers: "trashed", args: () => ({}) },
  "upload.setPrivate": { on: "upload", needs: "V", trashed: "opens", members: true, args: (id, _, note) => ({ id, private: OWNER[note] !== undefined }) },
  // A data source is the asker's own, so each of these is let through for anyone in the workspace, and with nothing connected here finds nothing.
  // Whose records each answers is asked in test/core/sources.test.ts, where there are records to keep apart.
  // An agent limited to folders is refused each (OWN below): what it would read is in no folder.
  "source.list": { on: "workspace", who: EVERYONE, args: () => ({}) },
  "source.connect": { on: "workspace", who: EVERYONE, args: () => ({ id: "google-calendar" }) },
  "source.disconnect": { on: "workspace", who: EVERYONE, args: () => ({ id: "google-calendar" }) },
  "event.list": { on: "workspace", who: EVERYONE, args: () => ({ from: 0, to: 1, timeZone: "UTC" }) },
  "event.update": { on: "workspace", who: EVERYONE, args: () => ({ sourceId: "google-calendar", id: "none", etag: "none", title: "No" }) },
  "event.create": { on: "workspace", who: EVERYONE, args: () => ({ sourceId: "google-calendar", calendarId: "none", title: "No", when: { allDay: true, from: "2026-10-14", to: "2026-10-14" } }) },
  "contact.list": { on: "workspace", who: EVERYONE, args: () => ({}) },
  // Only the member changes a contact, and only their own: with nothing connected here there is none of anyone's to change. Agents are refused each (NOT_FOR_AGENTS).
  "contact.update": { on: "workspace", who: EVERYONE, args: () => ({ sourceId: "google-contacts", id: "people/c1", etag: "none", name: "No" }) },
  "contact.photo": { on: "workspace", who: EVERYONE, args: () => ({ sourceId: "google-contacts", id: "people/c1", photo: null }) },
  "contact.create": { on: "workspace", who: EVERYONE, args: () => ({ sourceId: "google-contacts", name: "No" }) },
  // Asked in capitals, so the answer's echo of who it is about is no mark of the note: only a line of it would be.
  "person.read": { on: "workspace", who: EVERYONE, args: () => ({ who: "WHO-TEAM" }) },
  "record.refer": { on: "workspace", who: EVERYONE, args: () => ({ sourceId: "google-calendar", id: "none" }) },
  "record.read": { on: "workspace", who: EVERYONE, args: () => ({ ref: "aaaaaaaaaaaa" }) },
  "record.notes": { on: "workspace", who: EVERYONE, args: () => ({ sourceId: "google-calendar", id: "none" }) },
  // Asked last: it is the one operation that leaves a note not there for the ones after, the note in Trash for whoever may remove it.
  "note.purge": { on: "note", needs: "E", trashed: "opens", members: true, maker: true, args: (id) => ({ id }) },
  "upload.purge": { on: "upload", needs: "E", trashed: "opens", members: true, maker: true, args: (id) => ({ id }) },
};

/** The operations on how a note is shared, asked again of the upload beside it. */
const SHARING_AN_UPLOAD: { type: OpType; plan: Extract<Plan<OpType>, { on: "upload" }> }[] = [
  { type: "grant.list", plan: { on: "upload", needs: "V", trashed: "opens", args: (uploadId) => ({ uploadId }) } },
  { type: "grant.set", plan: { on: "upload", needs: "V", trashed: "opens", share: true, args: (uploadId) => ({ uploadId, email: address(), access: "view" }) } },
  { type: "grant.revoke", plan: { on: "upload", needs: "V", trashed: "opens", share: true, args: (_, w, note) => ({ id: w.spareUpload[note] }) } },
];

/** How an operation ended: done, or refused and how. */
type Outcome = "done" | "forbidden" | "in trash" | `not_found: ${string}` | `other: ${string}`;

async function ask(actor: Actor | Visitor, op: OpInput): Promise<{ outcome: Outcome; answer?: unknown }> {
  try {
    const answer: unknown = await perform(env.DB, actor, op, Date.now(), undefined, { bucket: env.FILES, body: op.type === "upload.create" ? new Response(PNG).body : null });
    // An upload's bytes are let go of here. What was told of the upload is kept, to be read for what it gives away.
    if (answer && typeof answer === "object" && "body" in answer) await (answer as { body?: ReadableStream }).body?.cancel();
    return { outcome: "done", answer: answer && typeof answer === "object" && "body" in answer ? { ...answer, body: undefined } : answer };
  } catch (err) {
    if (!(err instanceof OpError)) throw err;
    if (err.code === "conflict" && (err.message === IN_TRASH || err.message === UPLOAD_IN_TRASH)) return { outcome: "in trash" };
    // Refused for something other than who is asking, so they were let through to it.
    if (err.code === "invalid" || err.code === "conflict") return { outcome: "done" };
    if (err.code === "forbidden") return { outcome: "forbidden" };
    return { outcome: `not_found: ${err.message}` };
  }
}

const roleOf = (name: ActorName) => (name.includes("admin") ? "admin" : name.includes("editor") ? "editor" : name.includes("viewer") ? "viewer" : "guest");
const personLevelOf = (name: ActorName, note: NoteName) => ACTORS[name].notes[NOTES.indexOf(note)] as Level;
const personFolderLevelOf = (name: ActorName, folder: FolderName) => ACTORS[name].folders[FOLDERS.indexOf(folder)] as Level;
const enough = (level: Level, needs: "V" | "E") => level === "E" || (level === "V" && needs === "V");
/** Whether an actor may share a note: its owner when it is private, and otherwise a member who shares and can edit it. */
const sharesNote = (name: ActorName, note: NoteName) => OWNER[note] === name || (ACTORS[name].shares && personLevelOf(name, note) === "E");
/** Who made each note that Ada didn't. An admin, or the member who made a note, may remove it for good. */
const MAKER: Partial<Record<NoteName, ActorName>> = { secret: "Eve, an editor who owns the private note", vpriv: "Vera, a viewer who owns a private note" };
const madeBy = (name: ActorName, note: NoteName) => (MAKER[note] ?? "Ada, an admin") === name;
const sharesFolder = (name: ActorName, folder: FolderName) => ACTORS[name].shares && personFolderLevelOf(name, folder) === "E";
/** What a read-only token is refused whoever its person is, beyond what needs edit of a note or folder. */
const CHANGES: readonly OpType[] = ["history.revertAuthor", "history.revert", "links.rebuild", "todos.rebuild", "folder.delete", "daily.open", "event.update", "event.create", "contact.update", "contact.photo", "contact.create", "record.refer"];
/** What answers from the asker's own data sources, which are in no folder. */
const OWN: readonly OpType[] = ["source.list", "event.list", "event.update", "event.create", "contact.list", "contact.update", "contact.photo", "contact.create", "record.refer", "record.read", "record.notes"];
const AGENTS = [
  "their agent",
  "their read-only agent",
  "their agent pinned to this workspace",
  "their agent limited to the folder Team",
  "their read-only agent limited to the folder Team",
  "their agent limited to the folder Open",
] as const;
/** The folder an agent is limited to, and what that takes in: Deep is inside Team. Nothing else is there for it, whoever its person is. */
const LIMITED: Partial<Record<(typeof AGENTS)[number], readonly FolderName[]>> = {
  "their agent limited to the folder Team": ["Team", "Deep"],
  "their read-only agent limited to the folder Team": ["Team", "Deep"],
  "their agent limited to the folder Open": ["Open"],
};

/** `not_found` for a note that was never there, which is what one the actor can't see must be answered with. */
const NO_NOTE: Outcome = "not_found: No such note";
const NO_UPLOAD: Outcome = "not_found: No such upload";
const NO_FOLDER: Outcome = "not_found: No such folder";
const NO_CHANGE: Outcome = "not_found: The note has no change 99";
const NO_GRANT: Outcome = "not_found: No such grant";

// Each actor's test asks every operation of every note, so it grows with each operation added and has outgrown the default five seconds on CI.
describe("every operation, by every actor", { timeout: 30_000 }, () => {
  it("has a row in this test, so a new operation can't be added without saying what it needs", () => {
    expect(Object.keys(PLANS).sort()).toEqual(Op.options.map((o) => o.shape.type.value).sort());
  });

  for (const name of Object.keys(ACTORS) as ActorName[]) {
    for (const as of ["themself", ...AGENTS] as const) {
      it(`${name}, as ${as}`, async () => {
        const w = await world();
        const person = w.actors[name];
        const within = as === "themself" ? undefined : LIMITED[as];
        const scope =
          as === "their read-only agent"
            ? { readOnly: true }
            : as === "their agent pinned to this workspace"
              ? { pinnedWorkspaceId: person.workspaceId }
              : within && { pinnedWorkspaceId: person.workspaceId, folderIds: [w.folders[within[0]!]], readOnly: as.includes("read-only") };
        // The table says what the person may do. An agent limited to a folder has that of what is inside it, and nothing of the rest.
        const levelOf = (who: ActorName, note: NoteName): Level => (within && !within.includes(FOLDER_OF[note]) ? "-" : personLevelOf(who, note));
        const folderLevelOf = (who: ActorName, folder: FolderName): Level => (within && !within.includes(folder) ? "-" : personFolderLevelOf(who, folder));
        const actor: Actor = as === "themself" ? person : { kind: "agent", agentId: (await connectAgent(env.DB, person.personId, "Claude")).agent.id, personId: person.personId, workspaceId: person.workspaceId, scope };
        const readOnly = as.includes("read-only");
        const role = roleOf(name);
        // What is told as a number gives a note away as surely as its title: a folder's count, and an author's changes by day.
        const { folders: listed } = await perform(env.DB, actor, { type: "folder.list" });
        const counted = (folder: FolderName) => NOTES.filter((note) => FOLDER_OF[note] === folder && levelOf(name, note) !== "-" && STATE_OF[note] === "live").length;
        expect(listed.map((f) => f.uploadCount)).toEqual(listed.map((f) => f.noteCount));
        expect(Object.fromEntries(listed.map((f) => [f.name, f.noteCount]))).toEqual(Object.fromEntries(FOLDERS.filter((f) => folderLevelOf(name, f) !== "-").map((f) => [`${f}-folder`, counted(f)]).concat(role === "guest" || within ? [] : [["Unsorted", 0]])));

        const answers: unknown[] = [];
        /** What each listing answered, to hold it to the states it covers. */
        const listings: { key: string; covers: Covering; said: string }[] = [];
        const got: Record<string, Outcome> = {};
        const expected: Record<string, Outcome> = {};
        const run = async (key: string, type: OpType, args: object, expectation: Outcome, letThrough = false) => {
          const kept = as !== "themself" && NOT_FOR_AGENTS[type] !== undefined;
          const { outcome, answer } = await ask(actor, { type, ...args } as OpInput);
          // An operation on the workspace is asked about a member, an invite or a folder that isn't there: finding none, it had let the actor through.
          got[key] = letThrough && outcome.startsWith("not_found") ? "done" : outcome;
          const changes = readOnly && (CHANGES.includes(type) || ("needs" in PLANS[type] ? PLANS[type].needs === "E" : false));
          expected[key] = kept || changes ? "forbidden" : expectation;
          // A note that isn't there for the actor is answered with the id they asked by and nothing more, which is checked below against one that was never there.
          const told = () => (type === "history.previewRevert" ? (answer as { refused?: string; noteTitle: string }[]).filter((p) => !(p.refused === "No such note" && p.noteTitle === "")) : type === "history.revert" ? (answer as { skipped: { message: string; noteTitle: string }[] }).skipped.filter((s) => !(s.message === "No such note" && s.noteTitle === "")) : answer);
          if (answer !== undefined) answers.push(told());
        };

        /** One operation asked of every note, or of the upload beside every note, and then of one that was never there. */
        const ofEach = async (type: OpType, plan: Extract<Plan<OpType>, { on: "note" | "upload" }>) => {
          const ids = plan.on === "note" ? w.notes : w.uploads;
          const NONE = plan.on === "note" ? NO_NOTE : NO_UPLOAD;
          const key = (note: NoteName) => `${type} ${plan.on === "note" ? "" : "upload "}${note}`;
          for (const note of NOTES) {
            const level = levelOf(name, note);
            let expectation: Outcome = level === "-" ? NONE : !enough(level, plan.needs) || (plan.share && !sharesNote(name, note)) ? "forbidden" : "done";
            // Whoever can't even change anything in the workspace is refused before the note is looked for, and told nothing of it.
            if (plan.needs === "E" && (role === "viewer" || (role === "guest" && !ACTORS[name].notes.includes("E")))) expectation = "forbidden";
            if ((plan.share || plan.members) && role === "guest") expectation = "forbidden";
            if (plan.maker && expectation === "done" && role !== "admin" && !madeBy(name, note)) expectation = "forbidden";
            if (expectation === "done" && STATE_OF[note] === "trashed" && plan.trashed === "refused") expectation = "in trash";
            if (expectation === "done" && plan.also === "folder" && folderLevelOf(name, FOLDER_OF[note]) === "-") expectation = NO_FOLDER;
            if (expectation === "done" && type === "note.revertChanges") expectation = NO_CHANGE;
            if (type === "grant.revoke" && expectation === NONE) expectation = NO_GRANT;
            await run(key(note), type, plan.args(ids[note], w, note), expectation);
            if (MOVES.includes(type)) await settle(w, note, plan.on === "note" ? "notes" : "uploads");
          }
          // The same operation on one that was never there: what a hidden one has to look like.
          if (type !== "grant.revoke") {
            const missing = await ask(actor, { type, ...plan.args(MISSING, w, "open"), ...(plan.on === "upload" || type === "history.diff" ? {} : type === "grant.list" || type === "grant.set" ? { noteId: MISSING } : { id: MISSING }) } as OpInput);
            const hidden = NOTES.filter((note) => levelOf(name, note) === "-" && got[key(note)] !== "forbidden").map((note) => got[key(note)]);
            expect(hidden.every((outcome) => outcome === missing.outcome), `${type}: a hidden ${plan.on} and a missing one`).toBe(true);
          }
        };

        for (const type of Object.keys(PLANS) as OpType[]) {
          const plan = PLANS[type] as Plan<OpType>;
          if (plan.on === "note" || plan.on === "upload") {
            // How an upload is shared is asked before the one operation that removes it.
            if (type === "upload.purge") for (const sharing of SHARING_AN_UPLOAD) await ofEach(sharing.type, sharing.plan);
            await ofEach(type, plan);
          } else if (plan.on === "folder") {
            for (const folder of FOLDERS) {
              const level = folderLevelOf(name, folder);
              let expectation: Outcome = level === "-" ? NO_FOLDER : !enough(level, plan.needs) || (plan.share && !sharesFolder(name, folder)) ? "forbidden" : "done";
              if (plan.needs === "E" && (role === "viewer" || (role === "guest" && !ACTORS[name].notes.includes("E")))) expectation = "forbidden";
              if (plan.share && role === "guest") expectation = "forbidden";
              // A guest renames only inside what was shared: Team is the shared folder itself, Deep is inside it.
              if (type === "folder.rename" && role === "guest" && expectation === "done" && folder === "Team") expectation = "forbidden";
              // As an agent does only inside what it is limited to: the folder it is limited to has folders beside it that it can't see.
              if (type === "folder.rename" && within && expectation === "done" && folder === within[0]) expectation = "forbidden";
              // A folder is moved to where it is, and the same holds: Open and Team are at the top, among folders a guest or a limited agent can't see.
              if (type === "folder.move" && (role === "guest" || within) && expectation === "done" && folder !== "Deep") expectation = "forbidden";
              await run(`${type} ${folder}`, type, plan.args(w.folders[folder], w), expectation);
            }
          } else if (plan.on === "everything") {
            await run(type, type, plan.args(w), "done");
            listings.push({ key: type, covers: plan.covers, said: JSON.stringify(answers.at(-1)) });
            if (plan.archived) {
              await run(`${type} with archived`, type, { ...plan.args(w), includeArchived: true }, "done");
              listings.push({ key: `${type} with archived`, covers: "kept", said: JSON.stringify(answers.at(-1)) });
            }
            if (plan.only) {
              const onlyArchived = await run(`${type} with archived only`, type, { ...plan.args(w), includeArchived: "only" }, "done");
              if (onlyArchived !== undefined) listings.push({ key: `${type} with archived only`, covers: "archived", said: JSON.stringify(onlyArchived) });
            }
          } else if (plan.on === "workspace") {
            let allowed = (plan.who as readonly string[]).includes(role);
            if ((type === "history.revertAuthor" || type === "history.revert") && role === "guest") allowed = ACTORS[name].notes.includes("E");
            // The one admin can't leave, and nobody here asks to: leaving is checked in members.test.ts.
            if (type === "member.leave") continue;
            // Who is in the workspace is told to whoever sees all of it.
            // A daily note is in a folder at the top of the workspace, or makes one there: a member's, and their agent's when it sees all of it.
            if ((type === "member.list" || type === "daily.open" || OWN.includes(type)) && within) allowed = false;
            await run(type, type, plan.args(w), allowed ? "done" : "forbidden", true);
          } else {
            await run(type, type, plan.args(w), "forbidden");
          }
        }
        // The listings again, each narrowed the ways it can be: by note, by author, by time. A filter that names a hidden note finds nothing of it.
        const every = Object.values(w.notes);
        const narrowed: Args<"history.list">[] = [{ noteIds: every }, { noteIds: [w.notes.secret, w.notes.vpriv] }, { authors: [{ kind: "agent", id: w.secretAgent.id }] }, { from: 0, to: Date.now() + 86_400_000, limit: 100 }, { noteIds: every, diffs: false, limit: 1 }];
        for (const [i, args] of narrowed.entries()) await run(`history.list narrowed ${i}`, "history.list", args, "done");
        for (const [i, { diffs: _, ...args }] of narrowed.entries()) await run(`history.summary narrowed ${i}`, "history.summary", args, "done");
        // A note's line totals and its count of changes are only ever of a note the actor can see.
        const summed = await perform(env.DB, actor, { type: "history.summary", noteIds: every, limit: 100 });
        // The admin removed the note in Trash for good above, which only a member can.
        const there = new Set((await env.DB.prepare("SELECT id FROM notes WHERE workspace_id = ?").bind(actor.workspaceId).all<{ id: string }>()).results.map((r) => r.id));
        expect(summed.notes.map((n) => n.noteId).sort()).toEqual(NOTES.filter((note) => levelOf(name, note) !== "-").map((note) => w.notes[note]).filter((id) => there.has(id)).sort());
        expect((await perform(env.DB, actor, { type: "history.summary", authors: [{ kind: "agent", id: w.secretAgent.id }] })).notes.map((n) => [n.noteId, n.changes])).toEqual(levelOf(name, "secret") === "-" ? [] : [[w.notes.secret, 1]]);
        await run("history.revertAuthor narrowed", "history.revertAuthor", { author: { kind: "agent", id: "aaaaaaaaaaaa" }, noteIds: every }, role === "viewer" || (role === "guest" && !ACTORS[name].notes.includes("E")) ? "forbidden" : "done");
        await run("note.list in a hidden folder", "note.list", { folderId: w.folders.Open }, "done");
        // A search narrowed to a folder: one the actor can't see is no such folder, and one they can answers with only what they see in it, in the states asked for.
        for (const folder of FOLDERS) {
          const inFolder = (note: NoteName) => FOLDER_OF[note] === folder && levelOf(name, note) !== "-";
          for (const [words, includeArchived, covers] of [["", false, "live"], [" with archived", true, "kept"], [" with archived only", "only", "archived"]] as const) {
            const key = `search in ${folder}${words}`;
            const found = (await run(key, "search", { query: "body", limit: 50, folderId: w.folders[folder], includeArchived }, folderLevelOf(name, folder) === "-" ? NO_FOLDER : "done")) as Results["search"] | undefined;
            if (found === undefined) continue;
            listings.push({ key, covers, said: JSON.stringify(found) });
            expect(found.results.map((r) => r.note.id).sort(), key).toEqual(NOTES.filter((note) => inFolder(note) && COVERED[covers].includes(STATE_OF[note])).map((note) => w.notes[note]).sort());
            expect(found.next, key).toBeNull();
          }
        }
        // The todos of each folder, with the folder inside it: a folder that isn't there for the actor is no folder, as one that never was is, and no note is listed that they can't see.
        for (const folder of FOLDERS) {
          const seen = folderLevelOf(name, folder) !== "-";
          await run(`todo.list in ${folder}`, "todo.list", { folderId: w.folders[folder], includeCompleted: true }, seen ? "done" : NO_FOLDER);
          if (!seen) continue;
          const inside = NOTES.filter((note) => (FOLDER_OF[note] === folder || (folder === "Team" && FOLDER_OF[note] === "Deep")) && levelOf(name, note) !== "-");
          for (const [includeArchived, covers] of [[false, "live"], [true, "kept"]] as const) {
            expect((await perform(env.DB, actor, { type: "todo.list", folderId: w.folders[folder], includeArchived })).todos.map((t) => t.noteId).sort(), `todo.list in ${folder}, ${covers}`).toEqual(inside.filter((note) => COVERED[covers].includes(STATE_OF[note])).map((note) => w.notes[note]).sort());
          }
        }
        await run("todo.list in a folder that never was", "todo.list", { folderId: MISSING }, NO_FOLDER);
        // Several notes at once, each answered for itself: a hidden note is answered word for word as one that was never there, and one the actor may only read is not reverted.
        const asMissing = (answer: object, noteId: string) => ({ ...answer, noteId });
        const left = new Set((await env.DB.prepare("SELECT id FROM notes").all<{ id: string }>()).results.map((n) => n.id));
        const nowOf = (note: NoteName): Level => (left.has(w.notes[note]) ? levelOf(name, note) : "-");
        const previews = await perform(env.DB, actor, { type: "history.previewRevert", ...everyNote(w, 1) });
        for (const [i, note] of NOTES.entries()) {
          if (nowOf(note) === "-") expect(previews[i], `history.previewRevert ${note}`).toEqual(asMissing(previews.at(-1)!, w.notes[note]));
          else expect(previews[i], `history.previewRevert ${note}`).toMatchObject({ noteId: w.notes[note], noteTitle: `Title-${note}`, revisions: [1] });
        }
        expect(previews.at(-1)).toMatchObject({ noteTitle: "", refused: "No such note" });
        if (got["history.revert"] === "done") {
          const { reverted, skipped } = await perform(env.DB, actor, { type: "history.revert", ...everyNote(w, 99) });
          expect(reverted).toEqual([]);
          const told = (note: NoteName) => (nowOf(note) === "-" ? "No such note" : nowOf(note) === "V" ? "You can read this note, and not change it" : STATE_OF[note] === "trashed" ? IN_TRASH : "The note has no change 99");
          expect(Object.fromEntries(skipped.map((s) => [s.noteId, s.message]))).toEqual(Object.fromEntries([...NOTES.map((note) => [w.notes[note], told(note)]), [MISSING, "No such note"]]));
          for (const note of NOTES) if (nowOf(note) === "-") expect(skipped.find((s) => s.noteId === w.notes[note])).toEqual(asMissing(skipped.at(-1)!, w.notes[note]));
        }
        // Every grant in the workspace is an admin's to see, and nobody else's.
        await run("grant.list of the workspace", "grant.list", {}, role === "admin" ? "done" : "forbidden");
        expect(got).toEqual(expected);

        // Nothing any operation answered says anything of what the actor can't see: not an id, a title, a word of it, or who wrote it.
        const said = JSON.stringify(answers);
        const hidden = [...NOTES.filter((note) => levelOf(name, note) === "-"), ...FOLDERS.filter((folder) => folderLevelOf(name, folder) === "-")];
        // A link is written in the note that makes it, as its target's id. Whoever reads `secret` reads the id of `open`, and is told no more of it: not its title, nor that there is such a note.
        const written = levelOf(name, "secret") === "-" ? [] : [`open: ${w.notes.open}`];
        expect(hidden.flatMap((item) => w.marks[item].filter((mark) => said.includes(mark)).map((mark) => `${item}: ${mark}`)).filter((found) => !written.includes(found))).toEqual([]);
        // And what they can see is there, so the check above isn't passing on an empty answer.
        const seen = NOTES.filter((note) => levelOf(name, note) !== "-");
        expect(seen.filter((note) => !said.includes(`Title-${note}`) || !said.includes(`File-${note}`))).toEqual([]);

        // No listing says anything of a note in a state it doesn't cover, though the actor can see the note: not its title, a tag, a todo, or its id.
        const beyond = listings.flatMap(({ key, covers, said }) => seen.filter((note) => !COVERED[covers].includes(STATE_OF[note])).flatMap((note) => w.marks[note].filter((mark) => said.includes(mark)).map((mark) => `${key}: ${note}: ${mark}`)));
        expect(beyond).toEqual([]);
        // And each one that names notes names every note it covers, so an include that did nothing would fail here.
        const NAMES: readonly string[] = ["note.list", "todo.list", "todo.filters", "tag.list", "search", "trash.list", "history.summary", "history.list", "upload.list", "upload.trashed"];
        const lacking = listings
          .filter(({ key }) => NAMES.includes(key.replace(/ with archived( only)?$/, "")))
          .flatMap(({ key, covers, said }) => seen.filter((note) => COVERED[covers].includes(STATE_OF[note]) && !w.marks[note].some((mark) => said.includes(mark))).map((note) => `${key}: ${note}`));
        expect(lacking).toEqual([]);
        // A listing of notes says nothing of an upload, and a listing of uploads names each upload it covers by its own id.
        const uploadsListed = listings.filter(({ key }) => key.startsWith("upload."));
        expect(uploadsListed.flatMap(({ key, covers, said }) => seen.filter((note) => COVERED[covers].includes(STATE_OF[note]) && !said.includes(w.uploads[note])).map((note) => `${key}: ${note}`))).toEqual([]);
      });
    }
  }

  for (const name of Object.keys(ACTORS) as ActorName[]) {
    it(`${name} reverts, of every note at once, exactly the ones the table lets them change, by changes, by revision and by author`, async () => {
      const ways = { revisions: (w: World, note: NoteName) => ({ revisions: [note === "secret" ? 2 : 1] }), to: () => ({ to: 0 }), author: (w: World) => ({ author: { kind: "member" as const, id: w.actors["Ada, an admin"].personId } }) };
      for (const [way, of] of Object.entries(ways)) {
        const w = await world();
        const before = Object.fromEntries(await Promise.all(NOTES.map(async (note) => [note, (await env.DB.prepare("SELECT revision FROM notes WHERE id = ?").bind(w.notes[note]).first<{ revision: number }>())!.revision] as const)));
        const { outcome, answer } = await ask(w.actors[name], { type: "history.revert", changes: NOTES.map((note) => ({ noteId: w.notes[note], ...of(w, note) })) });
        const after = Object.fromEntries(await Promise.all(NOTES.map(async (note) => [note, (await env.DB.prepare("SELECT revision FROM notes WHERE id = ?").bind(w.notes[note]).first<{ revision: number }>())!.revision] as const)));
        const moved = NOTES.filter((note) => after[note] !== before[note]);
        const may = NOTES.filter((note) => personLevelOf(name, note) === "E" && STATE_OF[note] !== "trashed");
        // By author it is Ada's changes that go: she wrote every note but the two private ones.
        const has = way === "author" ? may.filter((note) => note !== "secret" && note !== "vpriv") : may;
        expect(moved, `${way}: the notes changed`).toEqual(outcome === "forbidden" ? [] : has);
        if (outcome === "forbidden") expect(may.length === 0 || roleOf(name) === "viewer", `${way}: refused outright only with nothing to change`).toBe(true);
        else expect((answer as { reverted: { noteId: string }[] }).reverted.map((r) => r.noteId).sort(), `${way}: the notes said to be reverted`).toEqual(has.map((note) => w.notes[note]).sort());
      }
    });
  }

  it("lets a grant that waited for its email take effect only if its maker may still share the item, by the same table", async () => {
    const w = await world();
    const waiting: Record<string, string> = {};
    const expected: Record<string, boolean> = {};
    for (const name of Object.keys(ACTORS) as ActorName[]) {
      const maker = w.actors[name];
      const items = [...NOTES.map((note) => ({ key: note as string, column: "note_id", id: w.notes[note], level: personLevelOf(name, note) })), ...NOTES.map((note) => ({ key: `upload ${note}`, column: "upload_id", id: w.uploads[note], level: personLevelOf(name, note) })), ...FOLDERS.map((folder) => ({ key: folder as string, column: "folder_id", id: w.folders[folder], level: personFolderLevelOf(name, folder) }))];
      for (const item of items) {
        const email = address();
        // Written straight into the record, as a grant made while its maker still could and left waiting since.
        await env.DB.prepare(`INSERT INTO grants (id, workspace_id, ${item.column}, kind, email, access, granted_by, created_at) VALUES (?, ?, ?, 'person', ?, 'view', ?, 0)`)
          .bind(crypto.randomUUID().replace(/-/g, "").slice(0, 12), maker.workspaceId, item.id, email, maker.personId)
          .run();
        waiting[`${name} / ${item.key}`] = email;
        expected[`${name} / ${item.key}`] = item.column === "folder_id" ? sharesFolder(name, item.key as FolderName) : sharesNote(name, item.key.replace("upload ", "") as NoteName);
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
    expect(read).toEqual({ open: NO_NOTE, team: "done", deep: "done", lone: NO_NOTE, secret: NO_NOTE, vpriv: NO_NOTE, arch: NO_NOTE, bin: NO_NOTE });
    // And the bytes of the uploads in that folder, by the same rule.
    const bytes: Record<string, Outcome> = {};
    for (const note of NOTES) bytes[note] = (await ask(visitor, { type: "shared.upload", id: w.uploads[note] })).outcome;
    expect(bytes).toEqual({ open: NO_UPLOAD, team: "done", deep: "done", lone: NO_UPLOAD, secret: NO_UPLOAD, vpriv: NO_UPLOAD, arch: NO_UPLOAD, bin: NO_UPLOAD });
    expect((await ask(visitor, { type: "shared.upload", id: MISSING })).outcome).toBe(NO_UPLOAD);
    expect((await ask(visitor, { type: "shared.read", id: MISSING })).outcome).toBe(NO_NOTE);
    const said = JSON.stringify(answers);
    expect((["open", "lone", "secret", "vpriv", "arch", "bin", "Open"] as const).flatMap((item) => w.marks[item].filter((mark) => said.includes(mark)))).toEqual([]);
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
      const args = plan.on === "note" ? plan.args(w.notes.open, w, "open") : plan.on === "upload" ? plan.args(w.uploads.open, w, "open") : plan.on === "folder" ? plan.args(w.folders.Open, w) : plan.args(w);
      outcomes[type] = (await ask(visitor, { type, ...args } as OpInput)).outcome;
    }
    // A link on a note opens that note. The upload beside it, in the same folder, is no upload to whoever holds it.
    expect(outcomes).toEqual(Object.fromEntries((Object.keys(PLANS) as OpType[]).map((type) => [type, type === "shared.upload" ? NO_UPLOAD : type.startsWith("shared.") ? "done" : "forbidden"])));
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
        const args = plan.on === "note" ? plan.args(w.notes.open, w, "open") : plan.on === "upload" ? plan.args(w.uploads.open, w, "open") : plan.on === "folder" ? plan.args(w.folders.Open, w) : plan.args(w);
        outcomes.add((await ask(actor, { type, ...args } as OpInput)).outcome);
      }
      expect([...outcomes], who).toEqual(["not_found: No such workspace"]);
    }
  });
});

/*
 * Every filter of the query language, asked by every kind of actor. What each filter is true of is
 * written out below, of the same notes; what an actor is answered is then exactly those of them the
 * table above lets that actor see, in the states the query covers. A filter with no row fails the
 * first test.
 */
type Truth = readonly NoteName[] | ((who: { name: ActorName; agent: boolean; sees: (note: NoteName) => boolean }) => readonly NoteName[]);
const LIVE = NOTES.filter((note) => STATE_OF[note] === "live");
const BY_ADA = NOTES.filter((note) => !MAKER[note]);
/** A filter that names something: `needs` is what must be there for the actor, and without it the query is refused as one naming nothing is. */
interface Row {
  query: string;
  finds: Truth;
  needs?: { folder: FolderName } | { note: NoteName } | { anyOf: readonly NoteName[] };
  /** The same query naming something that was never there. */
  missing?: string;
}
const NOTE_FILTERS: Record<string, Row[]> = {
  folder: [
    { query: "folder:Team-folder", finds: ["team", "deep", "secret", "bin"], needs: { folder: "Team" }, missing: "folder:Nope-folder" },
    { query: "folder:TEAM-FOLDER is:trashed", finds: ["bin"], needs: { folder: "Team" }, missing: "folder:Nope-folder is:trashed" },
    { query: "-folder:Open-folder", finds: ["team", "deep", "secret", "bin"], needs: { folder: "Open" }, missing: "-folder:Nope-folder" },
  ],
  tag: [{ query: "tag:tag-team", finds: ["team"] }, { query: "#TAG-deep OR #tag-arch OR #tag-bin", finds: ["deep"] }, { query: "-tag:tag-open", finds: NOTES.filter((note) => note !== "open") }],
  updated: [{ query: "updated:>=2020-01-01", finds: NOTES }, { query: "updated:<2020-01-01", finds: [] }, { query: "updated:today", finds: NOTES }, { query: "-updated:today", finds: [] }],
  created: [{ query: "created:2020-01-01..*", finds: NOTES }, { query: "created:yesterday", finds: [] }, { query: "created:>=7d", finds: NOTES }],
  editor: [
    { query: 'editor:"Zed-agent"', finds: ["secret"], needs: { note: "secret" }, missing: 'editor:"Nobody-agent"' },
    { query: 'edited-by:"eve editor"', finds: ["secret"], needs: { note: "secret" }, missing: 'edited-by:"nobody editor"' },
    { query: "editor:@me", finds: ({ name, agent }) => (agent ? [] : name === "Ada, an admin" ? BY_ADA : NOTES.filter((note) => MAKER[note] === name)) },
  ],
  author: [
    { query: 'author:"Vera Viewer"', finds: ["vpriv"], needs: { note: "vpriv" }, missing: 'author:"Nobody Viewer"' },
    { query: 'author:"Ada Lovelace"', finds: BY_ADA, needs: { anyOf: BY_ADA }, missing: 'author:"Nobody Lovelace"' },
    { query: "-author:@me", finds: ({ name, agent }) => (agent ? NOTES : name === "Ada, an admin" ? NOTES.filter((note) => MAKER[note]) : NOTES.filter((note) => MAKER[note] !== name)) },
  ],
  is: [
    { query: "is:open", finds: LIVE },
    { query: "is:archived", finds: ["arch"] },
    { query: "is:trashed", finds: ["bin"] },
    { query: "is:archived OR is:trashed OR is:open", finds: NOTES },
    { query: "is:private", finds: ["secret", "vpriv"] },
    // Every note has a grant of its own. Which of them an actor is told are shared is which they may list the grants of.
    { query: "is:shared", finds: ({ name, agent }) => (agent ? [] : NOTES.filter((note) => sharesNote(name, note))) },
    { query: "-is:shared", finds: ({ name, agent }) => NOTES.filter((note) => agent || !sharesNote(name, note)) },
  ],
  has: [
    { query: "has:todo", finds: NOTES },
    { query: "has:task has:open-task", finds: NOTES },
    { query: "no:open-todo", finds: [] },
    { query: "has:tag", finds: NOTES },
    { query: "has:link", finds: ["secret"] },
    // `open` shows the upload beside `team`, written there before these are asked.
    { query: "has:attachment", finds: ["open"] },
    { query: "no:attachment", finds: NOTES.filter((note) => note !== "open") },
    // `open` is linked to from `secret` alone, so it has a backlink only for someone who can see `secret`.
    { query: "has:backlink", finds: ({ sees }) => (sees("secret") ? ["open"] : []) },
    { query: "no:backlink", finds: ({ sees }) => NOTES.filter((note) => note !== "open" || !sees("secret")) },
  ],
  mentions: [
    { query: "mentions:who-team", finds: ["team"] },
    { query: "mention:WHO-DEEP OR mentions:who-secret", finds: ["deep", "secret"] },
    { query: "-mentions:who-open", finds: NOTES.filter((note) => note !== "open") },
    { query: "mentions:@me", finds: [] },
  ],
  in: [{ query: "Title in:title", finds: NOTES }, { query: "body in:title", finds: [] }, { query: "body in:body -Title-team", finds: NOTES.filter((note) => note !== "team") }],
  sort: [{ query: "body sort:title-desc", finds: NOTES }],
};
/** The same of the upload beside each note, which `open` shows the one beside `team` of. */
const UPLOAD_FILTERS: Record<string, Row[]> = {
  folder: [
    { query: "folder:Team-folder", finds: ["team", "deep", "secret", "bin"], needs: { folder: "Team" }, missing: "folder:Nope-folder" },
    { query: "-folder:Open-folder is:trashed", finds: ["bin"], needs: { folder: "Open" }, missing: "-folder:Nope-folder is:trashed" },
  ],
  name: [{ query: "name:File-team", finds: ["team"] }, { query: "file-DEEP OR name:file-lone", finds: ["deep", "lone"] }, { query: "-name:.png", finds: [] }],
  type: [{ query: "type:image", finds: NOTES }, { query: "type:pdf OR type:text OR kind:other OR type:video OR type:audio", finds: [] }],
  uploader: [
    { query: 'uploader:"Eve Editor"', finds: ["secret"], needs: { note: "secret" }, missing: 'uploader:"Nobody Editor"' },
    { query: 'uploaded-by:"ada lovelace"', finds: BY_ADA, needs: { anyOf: BY_ADA }, missing: 'uploaded-by:"Nobody Lovelace"' },
    { query: "uploader:@me", finds: ({ name, agent }) => (agent ? [] : name === "Ada, an admin" ? BY_ADA : NOTES.filter((note) => MAKER[note] === name)) },
  ],
  // `open` shows the upload beside `team`: it is used for whoever sees `open`, and for nobody else.
  used: [{ query: "used:yes", finds: ({ sees }) => (sees("open") ? ["team"] : []) }, { query: "used:no", finds: ({ sees }) => NOTES.filter((note) => note !== "team" || !sees("open")) }],
  size: [{ query: "size:>1kb", finds: [] }, { query: `size:${PNG.byteLength}`, finds: NOTES }, { query: "size:1..1mb is:archived", finds: ["arch"] }],
  uploaded: [{ query: "uploaded:today", finds: NOTES }, { query: "uploaded:<2020-01-01", finds: [] }, { query: "uploaded:>=7d", finds: NOTES }],
  is: [
    { query: "is:open", finds: LIVE },
    { query: "is:archived", finds: ["arch"] },
    { query: "is:trashed", finds: ["bin"] },
    { query: "is:private", finds: ["secret", "vpriv"] },
    // Every upload has a grant of its own. Which of them an actor is told are shared is which they may list the grants of.
    { query: "is:shared", finds: ({ name, agent }) => (agent ? [] : NOTES.filter((note) => sharesNote(name, note))) },
  ],
  sort: [{ query: "sort:size-desc", finds: NOTES }, { query: "file sort:name-asc", finds: NOTES }],
};
const TODO_FILTERS: Record<string, Row[]> = {
  folder: [{ query: "folder:Team-folder", finds: ["team", "deep", "secret", "bin"], needs: { folder: "Team" }, missing: "folder:Nope-folder" }],
  tag: [{ query: "tag:tag-team OR #tag-lone", finds: ["team", "lone"] }],
  updated: [{ query: "updated:>=yesterday", finds: NOTES }],
  created: [{ query: "created:<2020-01-01", finds: [] }],
  editor: [{ query: 'editor:"Zed-agent"', finds: ["secret"], needs: { note: "secret" }, missing: 'editor:"Nobody-agent"' }],
  author: [{ query: 'author:"Ada Lovelace"', finds: BY_ADA, needs: { anyOf: BY_ADA }, missing: 'author:"Nobody Lovelace"' }],
  is: [
    { query: "is:open", finds: NOTES },
    { query: "is:done", finds: [] },
    { query: "is:open OR is:done", finds: NOTES },
    { query: "is:archived", finds: ["arch"] },
    { query: "is:trashed", finds: ["bin"] },
    { query: "is:private", finds: ["secret", "vpriv"] },
    { query: "is:shared", finds: ({ name, agent }) => (agent ? [] : NOTES.filter((note) => sharesNote(name, note))) },
  ],
  has: [{ query: "has:due", finds: [] }, { query: "no:due", finds: NOTES }, { query: "has:repeat", finds: [] }, { query: "no:repeat has:tag", finds: NOTES }, { query: "has:link", finds: ["secret"] }, { query: "has:backlink", finds: ({ sees }) => (sees("secret") ? ["open"] : []) }],
  assignee: [
    { query: "assignee:who-team", finds: ["team"] },
    { query: "assigned:WHO-LONE OR assignee:who-secret", finds: ["lone", "secret"] },
    { query: "-assignee:who-open", finds: NOTES.filter((note) => note !== "open") },
    { query: "assignee:@me", finds: [] },
  ],
  due: [{ query: "due:<today", finds: [] }, { query: "-due:<today", finds: NOTES }, { query: "due:2020-01-01..2030-01-01", finds: [] }],
  priority: [{ query: "priority:none", finds: NOTES }, { query: "priority:>=low", finds: [] }, { query: "importance:0..3", finds: NOTES }],
  in: [{ query: "todo-team", finds: ["team"] }, { query: "Title-team", finds: [] }, { query: "Title-team in:title", finds: ["team"] }, { query: "body-team in:body", finds: [] }],
  sort: [{ query: "sort:priority-desc", finds: NOTES }],
};

describe("every filter, by every actor", { timeout: 30_000 }, () => {
  it("has a row for every filter of each scope, so one added later can't go unasked", async () => {
    const { keysFor } = await import("../../src/core/query.ts");
    expect(Object.keys(NOTE_FILTERS).sort()).toEqual([...keysFor("notes")].sort());
    expect(Object.keys(TODO_FILTERS).sort()).toEqual([...keysFor("todos")].sort());
    expect(Object.keys(UPLOAD_FILTERS).sort()).toEqual([...keysFor("uploads")].sort());
  });

  for (const name of Object.keys(ACTORS) as ActorName[]) {
    for (const as of ["themself", "their agent", "their agent limited to the folder Team", "their agent limited to the folder Open"] as const) {
      it(`${name}, as ${as}`, async () => {
        const w = await world();
        await perform(env.DB, w.actors["Ada, an admin"], { type: "note.write", id: w.notes.open, baseRevision: 1, text: textOf("open", `\n::image{${w.uploads.team} 1x1}\n`) });
        const person = w.actors[name];
        const within = as === "themself" ? undefined : LIMITED[as];
        const actor: Actor = as === "themself" ? person : { kind: "agent", agentId: (await connectAgent(env.DB, person.personId, "Claude")).agent.id, personId: person.personId, workspaceId: person.workspaceId, scope: within && { folderIds: [w.folders[within[0]!]] } };
        const sees = (note: NoteName) => !(within && !within.includes(FOLDER_OF[note])) && personLevelOf(name, note) !== "-";
        const seesFolder = (folder: FolderName) => !(within && !within.includes(folder)) && personFolderLevelOf(name, folder) !== "-";
        const today = new Date().toISOString().slice(0, 10);
        const covered = (query: string): Covering => (query.includes("is:trashed") ? "any" : query.includes("is:archived") ? "kept" : "live");
        const said = async (input: OpInput) => perform(env.DB, actor, input).then((answer) => JSON.stringify(answer), (err: unknown) => (err instanceof OpError ? `${err.code}: ${err.message}` : Promise.reject(err)));

        for (const [type, rows] of [["search", NOTE_FILTERS], ["todo.list", TODO_FILTERS], ["upload.list", UPLOAD_FILTERS]] as const) {
          for (const row of Object.values(rows).flat()) {
            const key = `${type} ${row.query}`;
            const input: OpInput = type === "search" ? { type, query: row.query, today, limit: 50 } : { type, query: row.query, today };
            const there = !row.needs || ("folder" in row.needs ? seesFolder(row.needs.folder) : "note" in row.needs ? sees(row.needs.note) : row.needs.anyOf.some(sees));
            if (row.missing) {
              // Naming what the actor can't see is answered in the words naming what was never there is, with the name alone different.
              const blank = (text: string) => text.replace(/"[^"]*"/g, '"…"').replace(/of the query: .*\)$/, "");
              const missing = await said({ ...input, query: row.missing } as OpInput);
              expect(missing, `${key}: what was never there`).toMatch(/^invalid: (No folder named|Nobody named) "/);
              if (!there) {
                expect(blank(await said(input)), `${key}: hidden`).toBe(blank(missing));
                continue;
              }
            }
            const answer = (await perform(env.DB, actor, input)) as Results["search" | "todo.list" | "upload.list"];
            const truth = typeof row.finds === "function" ? row.finds({ name, agent: as !== "themself", sees }) : row.finds;
            const expected = truth.filter((note) => sees(note) && COVERED[covered(row.query)].includes(STATE_OF[note])).map((note) => (type === "upload.list" ? w.uploads : w.notes)[note]).sort();
            if (Array.isArray(answer)) {
              expect(answer.map((u) => u.id).sort(), key).toEqual(expected);
              // How many notes show each is counted among the notes the actor sees, and no others.
              expect(answer.filter((u) => u.uses > 0).map((u) => [u.id, u.uses]), `${key}: uses`).toEqual(sees("open") && answer.some((u) => u.id === w.uploads.team) ? [[w.uploads.team, 1]] : []);
            } else {
              const found = "results" in answer ? answer.results.map((r) => r.note.id) : answer.todos.map((t) => t.noteId);
              expect([...found].sort(), key).toEqual(expected);
              // What it is told beside the notes says no more: nothing left to page to, and nothing still to be read in.
              expect(answer.next, `${key}: next`).toBeNull();
              if ("results" in answer) expect(answer.indexing, `${key}: indexing`).toBe(false);
            }
            const hidden = [...NOTES.filter((note) => !sees(note)), ...FOLDERS.filter((folder) => !seesFolder(folder))];
            const written = sees("secret") ? [`open: ${w.notes.open}`] : [];
            expect(hidden.flatMap((item) => w.marks[item].filter((mark) => JSON.stringify(answer).includes(mark)).map((mark) => `${item}: ${mark}`)).filter((mark) => !written.includes(mark)), `${key}: says nothing of what is hidden`).toEqual([]);
          }
        }
      });
    }
  }
});

describe("the notes about an event on a calendar everyone has, by every actor", { timeout: 30_000 }, () => {
  /** One event every person's calendar holds, as a calendar they all share does: one id for all. */
  const SYNC: CalendarEvent = { sourceId: "cal", id: "team s1", calendarId: "team", calendar: "Team", color: null, title: "Team sync", when: { allDay: false, from: 0, to: 3_600_000 }, timeZone: null, location: null, description: null, recurring: false, editable: false, etag: "e", url: null };
  const shared = (has: (personId: string) => boolean): Sources => ({
    of: async (personId) => [
      {
        kind: "calendar",
        info: { id: "cal", name: "Team calendar", provider: "Test", state: "connected", account: null },
        list: async () => ({ calendars: [], events: has(personId) ? [SYNC] : [] }),
        get: async (id) => (has(personId) && id === SYNC.id ? SYNC : null),
        calendar: async () => null,
      },
    ],
    connect: async () => ({ redirect: null }),
    disconnect: async () => {},
  });

  for (const name of Object.keys(ACTORS) as ActorName[]) {
    for (const as of ["themself", "their agent", "their read-only agent", "their agent limited to the folder Team"] as const) {
      it(`${name}, as ${as}`, async () => {
        // Every note holds Ada's reference to the event; the reference is made before the notes, by its id.
        const ref = newId();
        const w = await world(`::event{${ref} Team sync}`);
        const ada = w.actors["Ada, an admin"];
        await env.DB.prepare("INSERT INTO source_refs (id, person_id, data_source, record_id, created_at) VALUES (?, ?, 'cal', ?, 0)").bind(ref, ada.personId, SYNC.id).run();
        const person = w.actors[name];
        const within = LIMITED[as as (typeof AGENTS)[number]];
        const actor: Actor = as === "themself" ? person : { kind: "agent", agentId: (await connectAgent(env.DB, person.personId, "Claude")).agent.id, personId: person.personId, workspaceId: person.workspaceId, scope: within ? { folderIds: [w.folders[within[0]!]] } : as === "their read-only agent" ? { readOnly: true } : undefined };
        const ask = (has: (personId: string) => boolean) => perform(env.DB, actor, { type: "record.notes", sourceId: "cal", id: SYNC.id }, Date.now(), shared(has));
        if (within) {
          // What it would list is about its member's calendar, which is in no folder.
          await expect(ask(() => true)).rejects.toThrow(/record.notes/);
          return;
        }
        const sees = (note: NoteName) => personLevelOf(name, note) !== "-" && STATE_OF[note] !== "trashed";
        const answer = await ask(() => true);
        expect(answer.notes.map((n) => n.id).sort(), "with the event in their calendar").toEqual(NOTES.filter(sees).map((note) => w.notes[note]).sort());
        const hidden = NOTES.filter((note) => personLevelOf(name, note) === "-");
        expect(hidden.flatMap((note) => w.marks[note].filter((mark) => JSON.stringify(answer).includes(mark))), "says nothing of what is hidden").toEqual([]);
        // Without the event in their own calendar, Ada's reference is no way to it: only Ada, whose reference it is, is told.
        const without = await ask((personId) => personId !== person.personId);
        expect(without.notes.map((n) => n.id).sort(), "without the event").toEqual(person.personId === ada.personId ? answer.notes.map((n) => n.id).sort() : []);
      });
    }
  }
});
