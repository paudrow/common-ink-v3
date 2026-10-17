import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { arrive, signIn, whoAmI, workspaceOfNote } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor, type Visitor } from "../../src/core/operations.ts";
import type { Grant, OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { callTool } from "../../src/worker/mcp/tools.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

const address = () => `${crypto.randomUUID()}@example.com`;

/** A new person with a workspace of their own, acting in `host`'s workspace, where they are whatever the grants make them. */
async function newPerson(host: Actor, name: string) {
  const email = address();
  const { personId } = await signIn(env.DB, { email, name });
  return { email, personId, actor: { kind: "member", personId, workspaceId: host.workspaceId } satisfies Actor };
}

const note = (by: Actor, text: string, folderId?: string) => perform(env.DB, by, { type: "note.create", text, folderId });
const folder = (by: Actor, name: string, parentId?: string) => perform(env.DB, by, { type: "folder.create", name, parentId });
const titles = async (as: Actor) => (await perform(env.DB, as, { type: "note.list" })).map((n) => n.title).sort();
const read = (as: Actor, id: string) => perform(env.DB, as, { type: "note.read", id });
const write = (as: Actor, id: string, baseRevision: number, text: string) => perform(env.DB, as, { type: "note.write", id, baseRevision, text });
const share = (by: Actor, on: { noteId: string } | { folderId: string }, email: string, access: "view" | "edit") => perform(env.DB, by, { type: "grant.set", ...on, email, access });
const tokenOf = (grant: Grant | null) => (grant?.to.kind === "link" ? grant.to.token : "");

const NO_NOTE = { code: "not_found", message: "No such note" };
const NO_FOLDER = { code: "not_found", message: "No such folder" };
const NO_WORKSPACE = { code: "not_found", message: "No such workspace" };

describe("a guest: someone who isn't a member, named by a grant", () => {
  it("sees the one note they were given and nothing else of the workspace", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan\n\nfor the launch");
    const other = await note(ada, "# Salaries");
    const gus = await newPerson(ada, "Gus Guest");

    await expect(perform(env.DB, gus.actor, { type: "note.list" })).rejects.toMatchObject(NO_WORKSPACE);
    expect(await workspaceOfNote(env.DB, gus.personId, plan.id)).toBeNull();

    await share(ada, { noteId: plan.id }, gus.email, "view");

    expect((await whoAmI(env.DB, gus.personId)).workspaces.map((w) => `${w.name}: ${w.role}`)).toEqual(["Gus's workspace: admin", "Ada's workspace: guest"]);
    expect(await perform(env.DB, gus.actor, { type: "note.list" })).toMatchObject([{ id: plan.id, title: "Plan", folderId: null, access: "view", private: false }]);
    expect(await perform(env.DB, gus.actor, { type: "folder.list" })).toEqual({ unsortedId: null, folders: [] });
    expect((await read(gus.actor, plan.id)).text).toBe("# Plan\n\nfor the launch");
    expect(await workspaceOfNote(env.DB, gus.personId, plan.id)).toBe(ada.workspaceId);
    expect(await workspaceOfNote(env.DB, gus.personId, other.id)).toBeNull();
    await expect(read(gus.actor, other.id)).rejects.toMatchObject(NO_NOTE);
    await expect(read(gus.actor, "zzzzzzzzzzzz")).rejects.toMatchObject(NO_NOTE);
    await expect(perform(env.DB, gus.actor, { type: "member.list" })).rejects.toMatchObject({ code: "forbidden", message: "A guest can't member.list" });
    await expect(note(gus.actor, "# Mine")).rejects.toMatchObject({ code: "forbidden", message: "A guest can't note.create" });
  });

  it("with view reads the notes and their history, and changes nothing", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    await write(ada, plan.id, 1, "# Plan\n\nStep one");
    const vic = await newPerson(ada, "Vic Viewer");
    await share(ada, { noteId: plan.id }, vic.email, "view");

    expect((await perform(env.DB, vic.actor, { type: "note.history", id: plan.id })).map((c) => [c.revision, c.author.name])).toEqual([
      [1, "Ada Lovelace"],
      [2, "Ada Lovelace"],
    ]);
    expect((await perform(env.DB, vic.actor, { type: "note.read", id: plan.id, revision: 1 })).text).toBe("# Plan");
    expect((await perform(env.DB, vic.actor, { type: "history.list" })).changes.map((c) => c.noteTitle)).toEqual(["Plan", "Plan"]);
    await expect(write(vic.actor, plan.id, 2, "# Mine now")).rejects.toMatchObject({ code: "forbidden" });
    await expect(perform(env.DB, vic.actor, { type: "note.revert", id: plan.id, revision: 1 })).rejects.toMatchObject({ code: "forbidden" });
    expect((await read(ada, plan.id)).text).toBe("# Plan\n\nStep one");
  });

  it("with edit on a folder changes its notes, sees their history, and makes notes and folders in it, and only there", async () => {
    const ada = await newMember("Ada Lovelace");
    const shared = await folder(ada, "Shared");
    const inside = await folder(ada, "Inside", shared.id);
    const elsewhere = await folder(ada, "Elsewhere");
    const plan = await note(ada, "# Plan", inside.id);
    await note(ada, "# Kept back", elsewhere.id);
    const gus = await newPerson(ada, "Gus Guest");
    await share(ada, { folderId: shared.id }, gus.email, "edit");

    expect(await perform(env.DB, gus.actor, { type: "folder.list" })).toEqual({
      unsortedId: null,
      folders: [
        { id: inside.id, name: "Inside", parentId: shared.id, noteCount: 1, uploadCount: 0, access: "edit", path: "Shared/Inside" },
        { id: shared.id, name: "Shared", parentId: null, noteCount: 0, uploadCount: 0, access: "edit", path: "Shared" },
      ],
    });
    const written = await write(gus.actor, plan.id, 1, "# Plan\n\nfrom Gus");
    expect(written).toMatchObject({ revision: 2, access: "edit", folderId: inside.id, updatedBy: { kind: "member", personId: gus.personId, name: "Gus Guest" } });
    expect((await perform(env.DB, gus.actor, { type: "note.history", id: plan.id })).map((c) => c.author.name)).toEqual(["Ada Lovelace", "Gus Guest"]);
    const made = await note(gus.actor, "# From Gus", shared.id);
    const nested = await folder(gus.actor, "Gus's", inside.id);
    expect(await titles(gus.actor)).toEqual(["From Gus", "Plan"]);
    expect(await titles(ada)).toEqual(["From Gus", "Kept back", "Plan"]);
    expect((await perform(env.DB, gus.actor, { type: "note.move", id: made.id, folderId: nested.id })).folderId).toBe(nested.id);

    await expect(note(gus.actor, "# Out", elsewhere.id)).rejects.toMatchObject(NO_FOLDER);
    await expect(perform(env.DB, gus.actor, { type: "note.move", id: made.id, folderId: elsewhere.id })).rejects.toMatchObject(NO_FOLDER);
    await expect(folder(gus.actor, "Top")).rejects.toMatchObject({ code: "forbidden" });
    // Renaming the shared folder itself could collide with a folder beside it that the guest can't see, which would name it.
    await expect(perform(env.DB, gus.actor, { type: "folder.rename", id: shared.id, name: "Elsewhere" })).rejects.toMatchObject({ code: "forbidden", message: "A guest can rename only the folders inside one shared with them" });
    await expect(perform(env.DB, gus.actor, { type: "folder.rename", id: nested.id, name: "Renamed" })).resolves.toMatchObject({ name: "Renamed" });
    await expect(perform(env.DB, gus.actor, { type: "note.list", folderId: elsewhere.id })).resolves.toEqual([]);
    await expect(share(gus.actor, { noteId: made.id }, address(), "view")).rejects.toMatchObject({ code: "forbidden", message: "A guest can't grant.set" });
    await expect(perform(env.DB, gus.actor, { type: "grant.link", noteId: made.id, link: "public" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("is covered by a folder's grant all the way down, and a closer grant wins either way", async () => {
    const ada = await newMember("Ada Lovelace");
    const top = await folder(ada, "Top");
    const mid = await folder(ada, "Mid", top.id);
    const low = await folder(ada, "Low", mid.id);
    const [inTop, inMid, inLow, raised] = await Promise.all([note(ada, "# In top", top.id), note(ada, "# In mid", mid.id), note(ada, "# In low", low.id), note(ada, "# Raised", low.id)]);
    const gus = await newPerson(ada, "Gus Guest");
    const access = async () => Object.fromEntries((await perform(env.DB, gus.actor, { type: "note.list" })).map((n) => [n.title, n.access]));

    await share(ada, { folderId: top.id }, gus.email, "edit");
    expect(await access()).toEqual({ "In top": "edit", "In mid": "edit", "In low": "edit", Raised: "edit" });

    await share(ada, { folderId: mid.id }, gus.email, "view");
    await share(ada, { noteId: raised!.id }, gus.email, "edit");
    expect(await access()).toEqual({ "In top": "edit", "In mid": "view", "In low": "view", Raised: "edit" });
    await expect(write(gus.actor, inLow!.id, 1, "# No")).rejects.toMatchObject({ code: "forbidden" });
    await expect(write(gus.actor, raised!.id, 1, "# Raised\n\nyes")).resolves.toMatchObject({ revision: 2 });
    await expect(note(gus.actor, "# New", mid.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(write(gus.actor, inTop!.id, 1, "# In top\n\nyes")).resolves.toMatchObject({ revision: 2 });
    expect(inMid!.id).toHaveLength(12);
  });

  it("loses a note that is moved out from under their grant, and gains one moved in", async () => {
    const ada = await newMember("Ada Lovelace");
    const shared = await folder(ada, "Shared");
    const kept = await folder(ada, "Kept");
    const a = await note(ada, "# A", shared.id);
    const b = await note(ada, "# B", kept.id);
    const gus = await newPerson(ada, "Gus Guest");
    await share(ada, { folderId: shared.id }, gus.email, "edit");
    expect(await titles(gus.actor)).toEqual(["A"]);

    await perform(env.DB, ada, { type: "note.move", id: a.id, folderId: kept.id });
    await perform(env.DB, ada, { type: "note.move", id: b.id, folderId: shared.id });

    expect(await titles(gus.actor)).toEqual(["B"]);
    await expect(read(gus.actor, a.id)).rejects.toMatchObject(NO_NOTE);
  });

  it("is let in when they first sign in, if the grant was made before they had an account", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    const email = address();

    const grant = await share(ada, { noteId: plan.id }, `  ${email.toUpperCase()} `, "edit");
    expect(grant).toMatchObject({ on: { kind: "note", id: plan.id, name: "Plan" }, access: "edit", to: { kind: "person", email, personId: null, name: null, role: null }, grantedBy: { personId: ada.personId, name: "Ada Lovelace" } });

    const { personId } = await signIn(env.DB, { email, name: "Nia New" });

    expect((await whoAmI(env.DB, personId)).workspaces.map((w) => `${w.name}: ${w.role}`)).toEqual(["Nia's workspace: admin", "Ada's workspace: guest"]);
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: plan.id })).grants).toMatchObject([{ to: { kind: "person", email, personId, name: "Nia New", role: null } }]);
  });

  it("is not let in by a waiting grant whose maker can no longer share the item", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const plan = await note(ada, "# Plan");
    const [removed, demoted] = [address(), address()];
    const ed = await addMember(ada, "editor", "Ed Editor");
    await share(eve, { noteId: plan.id }, removed, "view");
    await share(ed, { noteId: plan.id }, demoted, "view");

    await perform(env.DB, ada, { type: "member.remove", memberId: eve.personId });
    await perform(env.DB, ada, { type: "member.setRole", memberId: ed.personId, as: "viewer" });
    const one = await signIn(env.DB, { email: removed, name: "One" });
    const two = await signIn(env.DB, { email: demoted, name: "Two" });

    for (const { personId } of [one, two]) expect((await whoAmI(env.DB, personId)).workspaces).toHaveLength(1);
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: plan.id })).grants).toEqual([]);
  });

  it("who is then invited as a member has the role they were offered, and the grants that made them a guest are gone", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const team = await folder(ada, "Team");
    const plan = await note(ada, "# Plan", team.id);
    const diary = await note(eve, "# Diary");
    await perform(env.DB, eve, { type: "note.setPrivate", id: diary.id, private: true });
    const gus = await newPerson(ada, "Gus Guest");
    await share(ada, { folderId: team.id }, gus.email, "view");
    await share(eve, { noteId: diary.id }, gus.email, "view");
    expect((await read(gus.actor, plan.id)).access).toBe("view");

    await perform(env.DB, ada, { type: "member.invite", email: gus.email, as: "editor" });
    expect((await read(gus.actor, plan.id)).access).toBe("view");
    await arrive(env.DB, gus.personId);

    expect((await whoAmI(env.DB, gus.personId)).workspaces.map((w) => `${w.name}: ${w.role}`)).toEqual(["Gus's workspace: admin", "Ada's workspace: editor"]);
    expect((await read(gus.actor, plan.id)).access).toBe("edit");
    expect((await perform(env.DB, ada, { type: "grant.list", folderId: team.id })).grants).toEqual([]);
    // The grant on a private note is what lets them in, member or not, so it stays.
    expect(await read(gus.actor, diary.id)).toMatchObject({ private: true, access: "view" });
  });

  it("keeps a grant that had taken effect when its maker leaves, and loses it when it is revoked", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const plan = await note(ada, "# Plan");
    const gus = await newPerson(ada, "Gus Guest");
    const grant = await share(eve, { noteId: plan.id }, gus.email, "view");
    await perform(env.DB, eve, { type: "member.leave" });
    expect(await titles(gus.actor)).toEqual(["Plan"]);

    expect(await perform(env.DB, ada, { type: "grant.revoke", id: grant.id })).toEqual({ id: grant.id });

    await expect(perform(env.DB, gus.actor, { type: "note.list" })).rejects.toMatchObject(NO_WORKSPACE);
    await expect(perform(env.DB, ada, { type: "grant.revoke", id: grant.id })).rejects.toMatchObject({ code: "not_found", message: "No such grant" });
  });

  it("has settings of their own in the workspace they are a guest in", async () => {
    const ada = await newMember("Ada Lovelace");
    const gus = await newPerson(ada, "Gus Guest");
    await share(ada, { noteId: (await note(ada, "# Plan")).id }, gus.email, "view");

    await perform(env.DB, gus.actor, { type: "settings.write", text: '{"core.theme":"dark"}', baseRevision: 0 });

    expect((await perform(env.DB, gus.actor, { type: "settings.read" })).text).toBe('{"core.theme":"dark"}');
    expect((await perform(env.DB, ada, { type: "settings.read" })).text).toBe("{}");
  });
});

describe("a grant that names a member", () => {
  it("narrows what their role allows, there and nowhere else, and never widens it", async () => {
    const ada = await newMember("Ada Lovelace");
    const team = await folder(ada, "Team");
    const inTeam = await note(ada, "# In team", team.id);
    const loose = await note(ada, "# Loose");
    const email = address();
    await perform(env.DB, ada, { type: "member.invite", email, as: "editor" });
    const ned: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Ned Narrowed" })).personId, workspaceId: ada.workspaceId };
    const viewerEmail = address();
    await perform(env.DB, ada, { type: "member.invite", email: viewerEmail, as: "viewer" });
    const vera: Actor = { kind: "member", personId: (await signIn(env.DB, { email: viewerEmail, name: "Vera Viewer" })).personId, workspaceId: ada.workspaceId };

    expect(await share(ada, { folderId: team.id }, email, "view")).toMatchObject({ to: { role: "editor", name: "Ned Narrowed" } });
    await share(ada, { noteId: loose.id }, viewerEmail, "edit");

    expect((await read(ned, inTeam.id)).access).toBe("view");
    await expect(write(ned, inTeam.id, 1, "# No")).rejects.toMatchObject({ code: "forbidden", message: "You can read this note, and not change it" });
    await expect(note(ned, "# New", team.id)).rejects.toMatchObject({ code: "forbidden", message: "You can read this folder, and not change it" });
    await expect(write(ned, loose.id, 1, "# Loose\n\nyes")).resolves.toMatchObject({ revision: 2 });
    expect((await read(vera, loose.id)).access).toBe("view");
    await expect(write(vera, loose.id, 2, "# No")).rejects.toMatchObject({ code: "forbidden", message: "A viewer can't note.write" });
  });

  it("is an admin's to make and to take back: an editor shares with people outside, and can't narrow another member or lift it", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const plan = await note(ada, "# Plan");
    const email = address();
    await perform(env.DB, ada, { type: "member.invite", email, as: "editor" });
    await signIn(env.DB, { email, name: "Ed Editor" });

    const NARROWING = { code: "forbidden", message: "They are a member here, and only an admin can narrow what a member's role allows, or stop narrowing it" };
    await expect(share(eve, { noteId: plan.id }, email, "view")).rejects.toMatchObject(NARROWING);
    const outside = await share(eve, { noteId: plan.id }, address(), "view");
    const narrowed = await share(ada, { noteId: plan.id }, email, "view");
    expect(narrowed).toMatchObject({ to: { role: "editor" } });

    await expect(share(eve, { noteId: plan.id }, email, "edit")).rejects.toMatchObject(NARROWING);
    await expect(perform(env.DB, eve, { type: "grant.revoke", id: narrowed.id })).rejects.toMatchObject(NARROWING);
    await expect(perform(env.DB, eve, { type: "grant.revoke", id: outside.id })).resolves.toEqual({ id: outside.id });
    await expect(perform(env.DB, ada, { type: "grant.revoke", id: narrowed.id })).resolves.toEqual({ id: narrowed.id });
  });

  it("doesn't narrow an admin, and goes when the member is removed so it can't let them back in", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    const email = address();
    await perform(env.DB, ada, { type: "member.invite", email, as: "admin" });
    const abe: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Abe Admin" })).personId, workspaceId: ada.workspaceId };
    await share(ada, { noteId: plan.id }, email, "view");
    expect((await read(abe, plan.id)).access).toBe("edit");

    await perform(env.DB, ada, { type: "member.remove", memberId: abe.personId });

    await expect(read(abe, plan.id)).rejects.toMatchObject(NO_WORKSPACE);
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: plan.id })).grants).toEqual([]);
    expect((await whoAmI(env.DB, abe.personId)).workspaces.map((w) => w.name)).toEqual(["Abe's workspace"]);
  });

  it("refuses a grant on nothing, on two things, to oneself, and for what isn't view or edit", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    const own = (await whoAmI(env.DB, ada.personId)).person.email;
    const bad: OpInput[] = [
      { type: "grant.set", email: address(), access: "view" },
      { type: "grant.set", noteId: plan.id, folderId: plan.folderId!, email: address(), access: "view" },
      { type: "grant.set", noteId: plan.id, email: own, access: "view" },
      { type: "grant.set", noteId: plan.id, email: address(), access: "manage" } as unknown as OpInput,
      { type: "grant.set", noteId: plan.id, email: "nobody", access: "view" },
    ];
    for (const op of bad) await expect(perform(env.DB, ada, op), JSON.stringify(op)).rejects.toMatchObject({ code: "invalid" });
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: plan.id })).grants).toEqual([]);
  });
});

describe("a private note", () => {
  /** Ada's workspace, where Eve, an editor, made a note and made it private. */
  async function withSecret() {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const ed = await addMember(ada, "editor", "Ed Editor");
    const team = await folder(ada, "Team");
    const open = await note(ada, "# Open");
    const secret = await note(eve, `# Diary\n\nabout [[${open.id}]]`, team.id);
    await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: true });
    return { ada, eve, ed, team, open, secret };
  }

  it("is hidden from every other member, admins too, everywhere a note shows", async () => {
    const { ada, eve, ed, team, open, secret } = await withSecret();
    const zed = await connectAgent(env.DB, eve.personId, "Zed");
    await perform(env.DB, { kind: "agent", agentId: zed.agent.id, personId: eve.personId, workspaceId: ada.workspaceId }, { type: "note.write", id: secret.id, baseRevision: 1, text: `# Diary\n\nabout [[${open.id}]] and more` });
    // To Ada the private note's id is the id of no note, so a link to it is refused as one to nothing is, and kept only as text.
    await expect(perform(env.DB, ada, { type: "note.create", text: `# Linking\n\nsee [[${secret.id}]]`, linkTitles: "resolve-strict" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(`No note has the id or the title "${secret.id}"`) });
    const linking = await note(ada, `# Linking\n\nsee [[${secret.id}]]`);
    expect(linking.unresolved).toEqual([{ target: secret.id, matches: [] }]);

    for (const other of [ada, ed]) {
      expect(await titles(other)).toEqual(["Linking", "Open"]);
      await expect(read(other, secret.id)).rejects.toMatchObject(NO_NOTE);
      await expect(write(other, secret.id, 2, "# Mine")).rejects.toMatchObject(NO_NOTE);
      await expect(perform(env.DB, other, { type: "note.history", id: secret.id })).rejects.toMatchObject(NO_NOTE);
      await expect(perform(env.DB, other, { type: "grant.list", noteId: secret.id })).rejects.toMatchObject(NO_NOTE);
      expect(await workspaceOfNote(env.DB, other.personId, secret.id)).toBeNull();
      expect(await perform(env.DB, other, { type: "note.backlinks", id: open.id })).toEqual([]);
      expect((await read(other, linking.id)).links).toEqual([{ id: secret.id, title: null, state: null }]);
      await expect(perform(env.DB, other, { type: "note.create", text: "# New\n\n[[Diary]]", linkTitles: "resolve-strict" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('No note is titled "Diary"') });
      expect((await perform(env.DB, other, { type: "history.list" })).changes.map((c) => c.noteTitle)).toEqual(["Linking", "Open"]);
      expect((await perform(env.DB, other, { type: "history.authors" })).map((a) => a.name)).toEqual(["Ada Lovelace"]);
      expect((await perform(env.DB, other, { type: "history.summary", authors: [{ kind: "member", id: eve.personId }] })).notes).toEqual([]);
      expect((await perform(env.DB, other, { type: "folder.list" })).folders.find((f) => f.id === team.id)!.noteCount).toBe(0);
      expect((await perform(env.DB, other, { type: "note.list", folderId: team.id }))).toEqual([]);
      expect(await perform(env.DB, other, { type: "history.revertAuthor", author: { kind: "agent", id: zed.agent.id } })).toEqual({ reverted: [], emptied: [], failed: [], next: null });
    }
    expect(await perform(env.DB, ada, { type: "links.rebuild" })).toEqual({ done: true });
    expect((await perform(env.DB, ada, { type: "grant.list" })).grants).toEqual([]);

    expect(await titles(eve)).toEqual(["Diary", "Linking", "Open"]);
    expect(await read(eve, secret.id)).toMatchObject({ private: true, access: "edit", revision: 2 });
    expect((await perform(env.DB, eve, { type: "note.backlinks", id: open.id })).map((n) => n.title)).toEqual(["Diary"]);
    expect((await perform(env.DB, eve, { type: "grant.list", noteId: secret.id })).note).toEqual({ private: true, owner: { personId: eve.personId, name: "Eve Editor" }, canSetPrivate: true, released: null });
  });

  it("can be made private only by the member who made it, and stops being so only by its owner", async () => {
    const { ada, eve, ed, open, secret } = await withSecret();
    const byAgent = await note({ kind: "agent", agentId: (await connectAgent(env.DB, ed.personId, "Claude")).agent.id, personId: ed.personId, workspaceId: ada.workspaceId }, "# By Ed's agent");

    await expect(perform(env.DB, eve, { type: "note.setPrivate", id: open.id, private: true })).rejects.toMatchObject({ code: "forbidden", message: "Only the member who made a note can make it private" });
    await expect(perform(env.DB, ada, { type: "note.setPrivate", id: byAgent.id, private: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(perform(env.DB, ed, { type: "note.setPrivate", id: byAgent.id, private: true })).resolves.toEqual({ id: byAgent.id, private: true, removed: 0 });
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: open.id })).note).toMatchObject({ private: false, owner: null, canSetPrivate: true });
    expect((await perform(env.DB, eve, { type: "grant.list", noteId: open.id })).note).toMatchObject({ canSetPrivate: false });

    await expect(perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: false })).resolves.toEqual({ id: secret.id, private: false, removed: 0 });
    expect(await titles(ada)).toEqual(["Diary", "Open"]);
  });

  it("keeps only what its owner put on it: a link and grants others made go as it becomes private, and theirs stay", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const plan = await note(eve, "# Plan\n\nthe whole text");
    const gus = await newPerson(ada, "Gus Guest");
    const kept = await newPerson(ada, "Kay Kept");
    const link = await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: "public" });
    const visitor: Visitor = { kind: "visitor", token: tokenOf(link), personId: null };
    await share(ada, { noteId: plan.id }, gus.email, "view");
    await share(eve, { noteId: plan.id }, kept.email, "view");
    expect((await perform(env.DB, visitor, { type: "shared.read", id: plan.id })).text).toBe("# Plan\n\nthe whole text");

    expect(await perform(env.DB, eve, { type: "note.setPrivate", id: plan.id, private: true })).toEqual({ id: plan.id, private: true, removed: 2 });

    await expect(perform(env.DB, visitor, { type: "shared.open" })).rejects.toMatchObject({ code: "not_found", message: "No such link" });
    await expect(perform(env.DB, gus.actor, { type: "note.list" })).rejects.toMatchObject(NO_WORKSPACE);
    expect(await titles(kept.actor)).toEqual(["Plan"]);
    await expect(read(ada, plan.id)).rejects.toMatchObject(NO_NOTE);
    expect((await perform(env.DB, ada, { type: "grant.list" })).grants).toEqual([]);
    expect((await perform(env.DB, eve, { type: "grant.list", noteId: plan.id })).grants.map((g) => [g.to.kind, g.grantedBy.name])).toEqual([["person", "Eve Editor"]]);
    // A link the owner makes afterwards is the owner's, and has a new address.
    const again = await perform(env.DB, eve, { type: "grant.link", noteId: plan.id, link: "public" });
    expect(tokenOf(again)).not.toBe(tokenOf(link));
  });

  it("is its owner's to share even when they are a viewer, who can share nothing else", async () => {
    const ada = await newMember("Ada Lovelace");
    const vera = await addMember(ada, "editor", "Vera Viewer");
    const other = await note(ada, "# Other");
    const diary = await note(vera, "# Diary");
    await perform(env.DB, vera, { type: "note.setPrivate", id: diary.id, private: true });
    await perform(env.DB, ada, { type: "member.setRole", memberId: vera.personId, as: "viewer" });
    const adaEmail = (await whoAmI(env.DB, ada.personId)).person.email;

    expect(await perform(env.DB, vera, { type: "grant.list", noteId: diary.id })).toMatchObject({ canShare: true, note: { private: true, canSetPrivate: true } });
    const grant = await share(vera, { noteId: diary.id }, adaEmail, "view");
    expect((await read(ada, diary.id)).access).toBe("view");
    expect(tokenOf(await perform(env.DB, vera, { type: "grant.link", noteId: diary.id, link: "signed_in" }))).toHaveLength(43);
    await expect(perform(env.DB, vera, { type: "grant.revoke", id: grant.id })).resolves.toEqual({ id: grant.id });

    const REFUSED = { code: "forbidden", message: "Only a member who can change this note can share it" };
    await expect(share(vera, { noteId: other.id }, address(), "view")).rejects.toMatchObject(REFUSED);
    await expect(perform(env.DB, vera, { type: "grant.link", noteId: other.id, link: "public" })).rejects.toMatchObject(REFUSED);
    await expect(write(vera, diary.id, 1, "# No")).rejects.toMatchObject({ code: "forbidden", message: "A viewer can't note.write" });
  });

  it("is opened to one member by a grant on it, for no more than their role allows, and they can't share it on", async () => {
    const { ada, eve, ed, secret } = await withSecret();
    const edEmail = (await whoAmI(env.DB, ed.personId)).person.email;
    const adaEmail = (await whoAmI(env.DB, ada.personId)).person.email;

    await share(eve, { noteId: secret.id }, edEmail, "edit");
    await share(eve, { noteId: secret.id }, adaEmail, "view");

    expect(await read(ed, secret.id)).toMatchObject({ private: true, access: "edit" });
    expect(await read(ada, secret.id)).toMatchObject({ private: true, access: "view" });
    await expect(write(ada, secret.id, 1, "# No")).rejects.toMatchObject({ code: "forbidden" });
    await expect(share(ed, { noteId: secret.id }, address(), "view")).rejects.toMatchObject({ code: "forbidden", message: "Only a member who can change this note can share it" });
    await expect(perform(env.DB, ed, { type: "note.setPrivate", id: secret.id, private: false })).rejects.toMatchObject({ code: "forbidden", message: "Only its owner can stop a note being private" });
    expect(await perform(env.DB, ed, { type: "grant.list", noteId: secret.id })).toMatchObject({ canShare: false, grants: [], note: { private: true, owner: { name: "Eve Editor" }, canSetPrivate: false } });
  });

  it("takes nothing from the folder it is in: not a guest's grant on the folder, and not the folder's link", async () => {
    const { ada, eve, team, secret } = await withSecret();
    const beside = await note(ada, "# Beside", team.id);
    const gus = await newPerson(ada, "Gus Guest");
    await share(ada, { folderId: team.id }, gus.email, "edit");
    const link = await perform(env.DB, ada, { type: "grant.link", folderId: team.id, link: "public" });
    const visitor: Visitor = { kind: "visitor", token: tokenOf(link), personId: null };

    expect(await titles(gus.actor)).toEqual(["Beside"]);
    expect((await perform(env.DB, visitor, { type: "shared.open" })).notes.map((n) => n.title)).toEqual(["Beside"]);
    await expect(perform(env.DB, visitor, { type: "shared.read", id: secret.id })).rejects.toMatchObject(NO_NOTE);
    expect((await perform(env.DB, eve, { type: "grant.list", noteId: secret.id })).inherited).toEqual([]);
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: beside.id })).inherited.map((g) => g.to.kind).sort()).toEqual(["link", "person"]);
  });

  it("goes to Unsorted when an admin deletes the folder it was alone in, which looked empty to them", async () => {
    const { ada, eve, team, secret } = await withSecret();
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });

    expect(await perform(env.DB, ada, { type: "folder.delete", id: team.id })).toEqual({ id: team.id });

    expect((await read(eve, secret.id)).folderId).toBe(unsortedId);
    await expect(read(ada, secret.id)).rejects.toMatchObject(NO_NOTE);
  });

  it("stays where it is when the folder also holds a note the admin can see", async () => {
    const { ada, eve, team, secret } = await withSecret();
    await note(ada, "# Beside", team.id);

    await expect(perform(env.DB, ada, { type: "folder.delete", id: team.id })).rejects.toMatchObject({ code: "invalid", message: `"Team" isn't empty. Move or delete what's in it first.` });
    expect((await read(eve, secret.id)).folderId).toBe(team.id);
  });

  it("keeps its owner from leaving, so it isn't left with nobody", async () => {
    const { ada, eve, secret } = await withSecret();

    await expect(perform(env.DB, eve, { type: "member.leave" })).rejects.toMatchObject({ code: "invalid", message: "You have a private note here besides your daily notes, which nobody else can reach. Stop it being private first, so it isn't left with nobody." });
    expect(await titles(eve)).toEqual(["Diary", "Open"]);

    await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: false });
    await expect(perform(env.DB, eve, { type: "member.leave" })).resolves.toEqual({ memberId: eve.personId });
    expect(await titles(ada)).toEqual(["Diary", "Open"]);
  });

  it("stops being private when an admin removes its owner, and says whose it was", async () => {
    const { ada, eve, secret } = await withSecret();

    await perform(env.DB, ada, { type: "member.remove", memberId: eve.personId }, 5000);

    expect(await read(ada, secret.id)).toMatchObject({ private: false, access: "edit" });
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: secret.id })).note).toEqual({ private: false, owner: null, canSetPrivate: false, released: { from: "Eve Editor", by: "Ada Lovelace", at: 5000 } });
    await expect(read(eve, secret.id)).rejects.toMatchObject(NO_WORKSPACE);
  });
});

describe("a link", () => {
  const SECRET = "test-secret";
  const fetchAs = async (path: string, personId?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (personId) headers.set("Cookie", `__Host-ink_session=${await sign({ personId }, SECRET, 600)}`);
    return worker.fetch(new Request(`https://commonink.app${path}`, { ...init, headers }) as never, { ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: undefined } as never);
  };

  it("that is public opens the note for anyone who has it, with no account, and says nothing of who wrote it", async () => {
    const ada = await newMember("Ada Lovelace");
    const other = await note(ada, "# Other");
    const plan = await note(ada, `# Plan\n\nsee [[${other.id}]]`);

    const link = await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: "public" });
    expect(link).toMatchObject({ on: { kind: "note", id: plan.id }, access: "view", to: { kind: "link", link: "public", token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) } });
    const token = tokenOf(link);

    const opened = await fetchAs(`/api/shared/${token}`);
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ link: "public", on: { kind: "note", id: plan.id }, folders: [], notes: [{ id: plan.id, title: "Plan", slug: "plan", folderId: null, updatedAt: expect.any(Number), snippet: expect.any(String) }] });
    expect(Object.fromEntries(["Cache-Control", "X-Robots-Tag", "Referrer-Policy", "Set-Cookie"].map((h) => [h, opened.headers.get(h)]))).toEqual({
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": null,
    });
    const text = await (await fetchAs(`/api/shared/${token}/notes/${plan.id}`)).text();
    expect(JSON.parse(text)).toEqual({ id: plan.id, title: "Plan", slug: "plan", folderId: null, updatedAt: expect.any(Number), snippet: expect.any(String), text: `# Plan\n\nsee [[${other.id}]]`, revision: 1, links: [{ id: other.id, title: null, state: null }], uploads: [] });
    expect(text).not.toMatch(/Ada|Lovelace/);
    expect(text).not.toContain(ada.personId);

    expect((await fetchAs(`/api/shared/${token}/notes/${other.id}`)).status).toBe(404);
    expect((await fetchAs(`/api/shared/${token}`, undefined, { method: "POST" })).status).toBe(405);
    expect((await fetchAs(`/api/notes/${plan.id}`)).status).toBe(401);
  });

  it("opens nothing from the moment it is taken away, the same as a link that never was", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    const token = tokenOf(await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: "public" }));
    expect((await fetchAs(`/api/shared/${token}`)).status).toBe(200);

    expect(await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: null })).toBeNull();

    const [gone, never] = await Promise.all([fetchAs(`/api/shared/${token}`), fetchAs(`/api/shared/${"x".repeat(43)}`)]);
    expect([gone.status, await gone.json()]).toEqual([never.status, await never.json()]);
    expect(gone.status).toBe(404);
    const again = tokenOf(await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: "public" }));
    expect(again).not.toBe(token);
  });

  it("that is for signed-in people asks for an account, and then opens for anyone who has one", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    const publicToken = tokenOf(await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: "public" }));

    const link = await perform(env.DB, ada, { type: "grant.link", noteId: plan.id, link: "signed_in" });
    const token = tokenOf(link);
    expect(token).toBe(publicToken);
    const stranger = await signIn(env.DB, { email: address(), name: "Sam Stranger" });

    const signedOut = await fetchAs(`/api/shared/${token}`);
    expect([signedOut.status, await signedOut.json()]).toEqual([401, { error: "signed_out", message: "Sign in to open this link" }]);
    expect((await fetchAs(`/api/shared/${token}/notes/${plan.id}`)).status).toBe(401);
    const signedIn = await fetchAs(`/api/shared/${token}/notes/${plan.id}`, stranger.personId);
    expect([signedIn.status, ((await signedIn.json()) as { text: string }).text]).toEqual([200, "# Plan"]);
    // Opening it makes them nothing in the workspace.
    expect((await whoAmI(env.DB, stranger.personId)).workspaces).toHaveLength(1);
    await expect(read({ kind: "member", personId: stranger.personId, workspaceId: ada.workspaceId }, plan.id)).rejects.toMatchObject(NO_WORKSPACE);
  });

  it("on a folder opens the notes and folders in it, each placed under the shared folder, and titles only what it covers", async () => {
    const ada = await newMember("Ada Lovelace");
    const shared = await folder(ada, "Handbook");
    const inner = await folder(ada, "Policies", shared.id);
    const outside = await note(ada, "# Outside");
    const leave = await note(ada, "# Leave", inner.id);
    const start = await note(ada, `# Start\n\n[[${leave.id}]] and [[${outside.id}]]`, shared.id);
    const visitor: Visitor = { kind: "visitor", token: tokenOf(await perform(env.DB, ada, { type: "grant.link", folderId: shared.id, link: "public" })), personId: null };

    expect(await perform(env.DB, visitor, { type: "shared.open" })).toEqual({
      link: "public",
      on: { kind: "folder", id: shared.id, name: "Handbook" },
      folders: [{ id: inner.id, name: "Policies", parentId: null }],
      notes: [
        { id: leave.id, title: "Leave", slug: "leave", folderId: inner.id, updatedAt: expect.any(Number), snippet: "" },
        { id: start.id, title: "Start", slug: "start", folderId: null, updatedAt: expect.any(Number), snippet: expect.any(String) },
      ],
    });
    expect((await perform(env.DB, visitor, { type: "shared.read", id: start.id })).links).toEqual([
      { id: leave.id, title: "Leave", state: "live" },
      { id: outside.id, title: null, state: null },
    ]);
    await expect(perform(env.DB, visitor, { type: "shared.read", id: outside.id })).rejects.toMatchObject(NO_NOTE);
  });

  it("is made and taken away only by a member who can share the item, never by an agent", async () => {
    const ada = await newMember("Ada Lovelace");
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const plan = await note(ada, "# Plan");
    const agent: Actor = { kind: "agent", agentId: (await connectAgent(env.DB, ada.personId, "Claude")).agent.id, personId: ada.personId, workspaceId: ada.workspaceId };

    await expect(perform(env.DB, vera, { type: "grant.link", noteId: plan.id, link: "public" })).rejects.toMatchObject({ code: "forbidden", message: "Only a member who can change this note can share it" });
    for (const op of [{ type: "grant.link", noteId: plan.id, link: "public" }, { type: "grant.set", noteId: plan.id, email: address(), access: "view" }, { type: "note.setPrivate", id: plan.id, private: true }, { type: "grant.list", noteId: plan.id }] as OpInput[]) {
      await expect(perform(env.DB, agent, op)).rejects.toMatchObject({ code: "forbidden", message: `An agent can't ${op.type}` });
    }
    expect(await perform(env.DB, vera, { type: "grant.list", noteId: plan.id })).toEqual({ canShare: false, grants: [], inherited: [], note: { private: false, owner: null, canSetPrivate: false, released: null } });
  });
});

describe("an agent", () => {
  const tool = async (agent: Parameters<typeof callTool>[1], name: string, args: Record<string, unknown> = {}) => {
    const result = (await callTool(env.DB, agent, name, args))!;
    return { isError: !!result.isError, text: result.content[0]!.text };
  };

  it("of a guest reaches what the guest was given through its tools, and no more", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    const other = await note(ada, "# Salaries");
    const gus = await newPerson(ada, "Gus Guest");
    await share(ada, { noteId: plan.id }, gus.email, "edit");
    const { agent } = await connectAgent(env.DB, gus.personId, "Claude", { workspaceId: ada.workspaceId });
    const claude = { agentId: agent.id, personId: gus.personId, name: "Claude", workspaceId: ada.workspaceId, readOnly: false, folderIds: null };

    expect(JSON.parse((await tool(claude, "list_workspaces")).text).workspaces).toEqual([{ id: ada.workspaceId, name: "Ada's workspace", role: "guest" }]);
    expect(JSON.parse((await tool(claude, "list_notes")).text)).toMatchObject([{ id: plan.id, title: "Plan", access: "edit", folderId: null }]);
    expect(await tool(claude, "read_note", { id: other.id })).toEqual({ isError: true, text: "not_found: No such note" });
    expect(await tool(claude, "read_note", { id: "zzzzzzzzzzzz" })).toEqual({ isError: true, text: "not_found: No such note" });
    expect((await tool(claude, "write_note", { id: plan.id, baseRevision: 1, text: "# Plan\n\nby the guest's agent" })).isError).toBe(false);
    expect((await read(ada, plan.id)).updatedBy).toMatchObject({ kind: "agent", name: "Claude", onBehalfOf: gus.personId });
    expect(await tool(claude, "list_members")).toEqual({ isError: true, text: "forbidden: A guest can't member.list" });

    await perform(env.DB, ada, { type: "grant.revoke", id: (await perform(env.DB, ada, { type: "grant.list", noteId: plan.id })).grants[0]!.id });
    expect(await tool(claude, "list_notes", { workspace: ada.workspaceId })).toEqual({ isError: true, text: "not_found: No such workspace" });
    expect(JSON.parse((await tool(claude, "list_workspaces")).text).workspaces).toEqual([]);
  });

  it("of a member can't see that member's colleague's private note, and can see the member's own", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const diary = await note(eve, "# Diary");
    await perform(env.DB, eve, { type: "note.setPrivate", id: diary.id, private: true });
    const of = async (personId: string, readOnly = false) => ({ agentId: (await connectAgent(env.DB, personId, "Claude", { readOnly })).agent.id, personId, name: "Claude", workspaceId: null, readOnly, folderIds: null });

    expect(JSON.parse((await tool(await of(ada.personId), "list_notes", { workspace: ada.workspaceId })).text)).toEqual([]);
    expect(await tool(await of(ada.personId), "note_history", { workspace: ada.workspaceId, id: diary.id })).toEqual({ isError: true, text: "not_found: No such note" });
    expect(JSON.parse((await tool(await of(eve.personId), "list_notes", { workspace: ada.workspaceId })).text)).toMatchObject([{ title: "Diary", private: true, access: "edit" }]);
    expect(await tool(await of(eve.personId, true), "write_note", { workspace: ada.workspaceId, id: diary.id, baseRevision: 1, text: "# No" })).toEqual({ isError: true, text: "forbidden: A read-only token can't note.write" });
  });

  it("is not let into a workspace by a grant made since its person last opened Common Ink, until they do", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await note(ada, "# Plan");
    const email = address();
    await share(ada, { noteId: plan.id }, email, "view");
    const { personId } = await signIn(env.DB, { email, name: "Nia New" });
    await arrive(env.DB, personId);

    expect(await titles({ kind: "member", personId, workspaceId: ada.workspaceId })).toEqual(["Plan"]);
  });
});
