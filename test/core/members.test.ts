import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { arrive, signIn, whoAmI, workspaceOfInvite, workspaceOfNote } from "../../src/core/accounts.ts";
import { invite as inviteAs, removeMember, revokeInvite, setRole } from "../../src/core/membership.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { OpInput, Role } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

const ROLES = ["admin", "editor", "viewer"] as const;
const address = () => `${crypto.randomUUID()}@example.com`;

const members = async (actor: Actor) => (await perform(env.DB, actor, { type: "member.list" })).map((m) => `${m.name}: ${m.role}`).sort();
const invites = async (admin: Actor) => (await perform(env.DB, admin, { type: "invite.list" })).map((i) => `${i.email}: ${i.role}`);
const roleOf = async (member: Actor) => (await whoAmI(env.DB, member.personId)).workspaces.find((w) => w.id === member.workspaceId)?.role ?? null;
const invite = async (admin: Actor, email: string, as: Role) => (await perform(env.DB, admin, { type: "member.invite", email, as })).invite!;
const at = (workspaceId: string, personId: string): Actor => ({ kind: "member", personId, workspaceId });

const LAST_ADMIN = { code: "invalid", message: "A workspace needs an admin. Make someone else an admin first." };
const NO_WORKSPACE = { code: "not_found", message: "No such workspace" };

describe("inviting", () => {
  for (const role of ROLES) {
    it(`makes whoever signs in with the email ${role === "viewer" ? "a" : "an"} ${role}, beside a workspace of their own`, async () => {
      const ada = await newMember("Ada Lovelace");
      const email = address();

      const made = await perform(env.DB, ada, { type: "member.invite", email, as: role }, 1000);
      expect(made).toEqual({ member: null, invite: { id: expect.stringMatching(/^[a-z0-9]{12}$/), email, role, invitedBy: { personId: ada.personId, name: "Ada Lovelace" }, createdAt: 1000 } });
      expect(await invites(ada)).toEqual([`${email}: ${role}`]);
      expect(await members(ada)).toEqual(["Ada Lovelace: admin"]);

      const { personId } = await signIn(env.DB, { email, name: "Grace Hopper" });

      expect((await whoAmI(env.DB, personId)).workspaces.map((w) => `${w.name}: ${w.role}`)).toEqual([`Ada's workspace: ${role}`, "Grace's workspace: admin"]);
      expect(await members(ada)).toEqual(["Ada Lovelace: admin", `Grace Hopper: ${role}`]);
      expect(await invites(ada)).toEqual([]);
    });
  }

  it("reaches a person who is already signed in the next time they open Common Ink, and not through their agent", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = address();
    const { personId } = await signIn(env.DB, { email, name: "Grace Hopper" });
    await invite(ada, email, "editor");

    expect((await whoAmI(env.DB, personId)).workspaces).toHaveLength(1);
    expect(await invites(ada)).toEqual([`${email}: editor`]);

    await arrive(env.DB, personId);

    expect((await whoAmI(env.DB, personId)).workspaces.map((w) => `${w.name}: ${w.role}`)).toEqual(["Grace's workspace: admin", "Ada's workspace: editor"]);
    expect(await invites(ada)).toEqual([]);
  });

  it("matches the email a person signs in with, whatever its case, and no other spelling of it", async () => {
    const ada = await newMember("Ada Lovelace");
    await invite(ada, "  G.Hopper@Example.COM ", "editor");
    expect(await invites(ada)).toEqual(["g.hopper@example.com: editor"]);

    for (const other of ["ghopper@example.com", "g.hopper+notes@example.com", "g.hopper@example.org"]) {
      const { personId } = await signIn(env.DB, { email: other, name: "Someone Else" });
      expect((await whoAmI(env.DB, personId)).workspaces.map((w) => w.name), other).toEqual(["Someone's workspace"]);
    }
    expect(await invites(ada)).toEqual(["g.hopper@example.com: editor"]);

    await signIn(env.DB, { email: "G.Hopper@example.com", name: "Grace Hopper" });
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Grace Hopper: editor"]);
  });

  it("refuses what isn't an email or a role", async () => {
    const ada = await newMember();
    for (const email of ["", "grace", "grace@", "@example.com", "grace@example", "grace hopper@example.com", `${"g".repeat(250)}@example.com`]) {
      await expect(perform(env.DB, ada, { type: "member.invite", email, as: "editor" }), email).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(perform(env.DB, ada, { type: "member.invite", email: address(), as: "owner" } as unknown as OpInput)).rejects.toMatchObject({ code: "invalid" });
    expect(await invites(ada)).toEqual([]);
  });

  it("a second time changes the role offered, and keeps the one invite and its link", async () => {
    const ada = await newMember();
    const email = address();

    const first = await invite(ada, email, "viewer");
    const second = await invite(ada, email.toUpperCase(), "editor");

    expect(second.id).toBe(first.id);
    expect(await invites(ada)).toEqual([`${email}: editor`]);
    await signIn(env.DB, { email, name: "Grace Hopper" });
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Grace Hopper: editor"]);
  });

  it("someone who is already a member changes their role, and makes no invite", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = address();
    await invite(ada, email, "viewer");
    const { personId } = await signIn(env.DB, { email, name: "Grace Hopper" });

    expect(await perform(env.DB, ada, { type: "member.invite", email, as: "editor" })).toEqual({ member: { personId, name: "Grace Hopper", email, role: "editor" }, invite: null });
    expect(await invites(ada)).toEqual([]);
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Grace Hopper: editor"]);

    const adas = (await perform(env.DB, ada, { type: "member.list" })).find((m) => m.personId === ada.personId)!.email!;
    await expect(perform(env.DB, ada, { type: "member.invite", email: adas, as: "viewer" })).rejects.toMatchObject(LAST_ADMIN);
    expect(await roleOf(ada)).toBe("admin");
  });

  it("can be taken back while nobody has taken it up, and not after", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = address();
    const pending = await invite(ada, email, "editor");

    expect(await perform(env.DB, ada, { type: "invite.revoke", id: pending.id })).toEqual({ id: pending.id });
    expect(await perform(env.DB, ada, { type: "invite.revoke", id: pending.id })).toEqual({ id: pending.id });
    expect(await invites(ada)).toEqual([]);
    const { personId } = await signIn(env.DB, { email, name: "Grace Hopper" });
    expect((await whoAmI(env.DB, personId)).workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
    expect(await workspaceOfInvite(env.DB, personId, pending.id)).toBeNull();

    const again = await invite(ada, email, "viewer");
    expect(again.id).not.toBe(pending.id);
    await arrive(env.DB, personId);
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Grace Hopper: viewer"]);
    await expect(perform(env.DB, ada, { type: "invite.revoke", id: again.id })).rejects.toMatchObject({ code: "invalid", message: "They have already joined. Remove them from the members instead." });
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Grace Hopper: viewer"]);
  });

  it("does not bring back a member who was removed after taking it up", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = address();
    const taken = await invite(ada, email, "editor");
    const { personId } = await signIn(env.DB, { email, name: "Grace Hopper" });
    await perform(env.DB, ada, { type: "member.remove", memberId: personId });

    await signIn(env.DB, { email, name: "Grace Hopper" });

    expect(await members(ada)).toEqual(["Ada Lovelace: admin"]);
    expect(await workspaceOfInvite(env.DB, personId, taken.id)).toBeNull();
  });

  it("has a link that leads only the invited person to the workspace, and tells anyone else nothing", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = address();
    const pending = await invite(ada, email, "editor");
    const mallory = await newMember("Mallory");

    expect(await workspaceOfInvite(env.DB, mallory.personId, pending.id)).toBeNull();
    await arrive(env.DB, mallory.personId);
    expect(await invites(ada), "someone else opening the link doesn't use it up").toEqual([`${email}: editor`]);
    expect((await whoAmI(env.DB, mallory.personId)).workspaces).toHaveLength(1);

    const { personId } = await signIn(env.DB, { email, name: "Grace Hopper" });
    expect(await workspaceOfInvite(env.DB, personId, pending.id)).toBe(ada.workspaceId);
    expect(await workspaceOfInvite(env.DB, mallory.personId, pending.id)).toBeNull();
    expect(await workspaceOfInvite(env.DB, ada.personId, pending.id)).toBeNull();
    expect(await workspaceOfInvite(env.DB, personId, "aaaaaaaaaaaa")).toBeNull();
  });
});

describe("an invite stands only while whoever made it is still an admin", () => {
  /** Ada's workspace, where Bob, an admin too, has invited an email as admin. */
  async function planted() {
    const ada = await newMember("Ada Lovelace");
    const bob = await addMember(ada, "admin", "Bob Kahn");
    const email = address();
    const pending = await invite(bob, email, "admin");
    return { ada, bob, email, inviteId: pending.id };
  }
  const ENDS: Record<string, (ada: Actor, bob: Actor) => Promise<unknown>> = {
    "is removed": (ada, bob) => perform(env.DB, ada, { type: "member.remove", memberId: bob.personId }),
    "is made an editor": (ada, bob) => perform(env.DB, ada, { type: "member.setRole", memberId: bob.personId, as: "editor" }),
    "makes themself a viewer": (_, bob) => perform(env.DB, bob, { type: "member.setRole", memberId: bob.personId, as: "viewer" }),
    "is made a viewer by an invite": async (ada, bob) => perform(env.DB, ada, { type: "member.invite", email: (await whoAmI(env.DB, bob.personId)).person.email, as: "viewer" }),
    leaves: (_, bob) => perform(env.DB, bob, { type: "member.leave" }),
  };

  for (const [how, end] of Object.entries(ENDS)) {
    it(`so it is revoked when its inviter ${how}, and lets nobody in after`, async () => {
      const { ada, bob, email, inviteId } = await planted();
      const adas = await invite(ada, "kept@example.com", "viewer");

      await end(ada, bob);

      expect(await invites(ada), "only the invites of the one who stopped being admin go").toEqual(["kept@example.com: viewer"]);
      const { personId } = await signIn(env.DB, { email, name: "Victor" });
      expect((await whoAmI(env.DB, personId)).workspaces.map((w) => w.name)).toEqual(["Victor's workspace"]);
      expect(await workspaceOfInvite(env.DB, personId, inviteId)).toBeNull();
      expect((await members(ada)).filter((m) => m.startsWith("Victor"))).toEqual([]);
      expect(adas.id).toMatch(/^[a-z0-9]{12}$/);
    });
  }

  it("and is refused where it is taken up, should it still be pending once its inviter is no admin", async () => {
    const { ada, bob, email } = await planted();
    // As after a change to members that didn't come through an operation.
    await env.DB.prepare("UPDATE members SET role = 'editor' WHERE workspace_id = ? AND person_id = ?").bind(bob.workspaceId, bob.personId).run();

    const { personId } = await signIn(env.DB, { email, name: "Victor" });

    expect((await whoAmI(env.DB, personId)).workspaces.map((w) => w.name)).toEqual(["Victor's workspace"]);
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Bob Kahn: editor"]);
  });

  it("when the inviter's removal and the invited person's arrival come at once: they are in only if they arrived first, and never by an invite left standing", async () => {
    for (let round = 0; round < 10; round++) {
      const ada = await newMember("Ada Lovelace");
      const bob = await addMember(ada, "admin", "Bob Kahn");
      const email = address();
      const { personId } = await signIn(env.DB, { email, name: "Victor" });
      await invite(bob, email, "admin");

      await Promise.all([perform(env.DB, ada, { type: "member.remove", memberId: bob.personId }), arrive(env.DB, personId)]);

      expect(await invites(ada)).toEqual([]);
      const first = (await members(ada)).filter((m) => m.startsWith("Victor"));
      await arrive(env.DB, personId);
      expect((await members(ada)).filter((m) => m.startsWith("Victor")), "a later arrival changes nothing").toEqual(first);
    }
  });

  it("keeps an invite its inviter made again as an admin, and one another admin took over", async () => {
    const { ada, bob, email } = await planted();
    await invite(ada, email, "viewer");

    await perform(env.DB, ada, { type: "member.remove", memberId: bob.personId });

    expect(await invites(ada), "Ada's now, by inviting the email again").toEqual([`${email}: viewer`]);
    await signIn(env.DB, { email, name: "Victor" });
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Victor: viewer"]);
  });
});

describe("inviting an email at the moment its person arrives", () => {
  it("ends with them in the role last offered, whichever came first, and no invite left over", async () => {
    for (let round = 0; round < 20; round++) {
      const ada = await newMember("Ada Lovelace");
      const email = address();
      const { personId } = await signIn(env.DB, { email, name: "Grace Hopper" });
      await invite(ada, email, "viewer");

      const [answer] = await Promise.all([perform(env.DB, ada, { type: "member.invite", email, as: "editor" }), arrive(env.DB, personId)]);
      await arrive(env.DB, personId);

      expect(await members(ada), `round ${round}`).toEqual(["Ada Lovelace: admin", "Grace Hopper: editor"]);
      expect(await invites(ada)).toEqual([]);
      expect(answer.member?.role ?? answer.invite?.role).toBe("editor");
    }
  });

  it("is one write: the email is a member whose role it changes, or it isn't and an invite is made, with nothing between", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = address();
    const statements: string[] = [];
    const spied = new Proxy(env.DB, {
      get(db, key) {
        if (key === "prepare") return (sql: string) => (statements.push(sql.trim().split(/\s+/)[0]!), db.prepare(sql));
        if (key === "batch") return (batch: D1PreparedStatement[]) => (statements.push(`batch of ${batch.length}`), db.batch(batch));
        return Reflect.get(db, key);
      },
    });

    await inviteAs({ db: spied, workspaceId: ada.workspaceId, personId: ada.personId, now: Date.now() }, email, "editor");

    expect(statements.slice(0, statements.findIndex((s) => s.startsWith("batch")) + 1).filter((s) => s === "SELECT"), "nothing is read before the write that decides").toEqual([]);
    expect(statements.filter((s) => s.startsWith("batch"))).toHaveLength(1);
  });
});

describe("who is told a member's email", () => {
  it("is admins: an editor, a viewer, and every agent get names and roles alone", async () => {
    const ada = await newMember("Ada Lovelace");
    const editor = await addMember(ada, "editor", "Edith Clarke");
    const viewer = await addMember(ada, "viewer", "Vera Rubin");
    const agentOf = (member: Actor): Actor => ({ kind: "agent", agentId: "aaaaaaaaaaaa", personId: member.personId, workspaceId: member.workspaceId });
    const bare = [
      { personId: ada.personId, name: "Ada Lovelace", role: "admin" },
      { personId: editor.personId, name: "Edith Clarke", role: "editor" },
      { personId: viewer.personId, name: "Vera Rubin", role: "viewer" },
    ];

    for (const who of [editor, viewer, agentOf(ada), agentOf(editor), agentOf(viewer)]) {
      const listed = await perform(env.DB, who, { type: "member.list" });
      expect(listed).toEqual(bare);
      expect(JSON.stringify(listed)).not.toContain("@");
    }
    expect((await perform(env.DB, ada, { type: "member.list" })).map((m) => m.email)).toEqual([expect.stringContaining("@"), expect.stringContaining("@"), expect.stringContaining("@")]);
  });
});

describe("roles", () => {
  /** Ada's workspace with one member of each role, a note, and an invite nobody has taken up. */
  async function team() {
    const ada = await newMember("Ada Lovelace");
    const editor = await addMember(ada, "editor", "Edith Clarke");
    const viewer = await addMember(ada, "viewer", "Vera Rubin");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const pending = await invite(ada, "pending@example.com", "viewer");
    return { ada, editor, viewer, noteId: note.id, inviteId: pending.id };
  }

  it("let an admin manage members, and an editor or a viewer only see who is here and leave", async () => {
    const { ada, editor, viewer, inviteId } = await team();
    const managing = (target: Actor): OpInput[] => [
      { type: "member.invite", email: "new@example.com", as: "admin" },
      { type: "member.setRole", memberId: target.personId, as: "admin" },
      { type: "member.remove", memberId: target.personId },
      { type: "invite.list" },
      { type: "invite.revoke", id: inviteId },
    ];
    const everyone = ["Ada Lovelace: admin", "Edith Clarke: editor", "Vera Rubin: viewer"];

    for (const [who, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
      for (const op of managing(who === editor ? viewer : editor)) {
        await expect(perform(env.DB, who, op), `${role} ${op.type}`).rejects.toMatchObject({ code: "forbidden", message: `${role === "viewer" ? "A viewer" : "A editor"} can't ${op.type}` });
      }
      await expect(perform(env.DB, who, { type: "member.setRole", memberId: who.personId, as: "admin" }), `${role} promoting themself`).rejects.toMatchObject({ code: "forbidden" });
      expect(await members(who)).toEqual(everyone);
    }
    expect(await members(ada)).toEqual(everyone);
    expect(await invites(ada)).toEqual(["pending@example.com: viewer"]);

    expect(await perform(env.DB, ada, { type: "member.setRole", memberId: viewer.personId, as: "editor" })).toMatchObject({ personId: viewer.personId, name: "Vera Rubin", role: "editor" });
    expect(await perform(env.DB, ada, { type: "member.remove", memberId: editor.personId })).toEqual({ memberId: editor.personId });
    expect(await perform(env.DB, viewer, { type: "member.leave" })).toEqual({ memberId: viewer.personId });
    expect(await members(ada)).toEqual(["Ada Lovelace: admin"]);
  });

  it("keep a viewer from changing anything, and let them read", async () => {
    const { viewer, noteId } = await team();

    expect((await perform(env.DB, viewer, { type: "note.read", id: noteId })).text).toBe("# Plan");
    await expect(perform(env.DB, viewer, { type: "note.write", id: noteId, baseRevision: 1, text: "# Changed" })).rejects.toMatchObject({ code: "forbidden", message: "A viewer can't note.write" });
    await expect(perform(env.DB, viewer, { type: "note.create", text: "# Mine" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(perform(env.DB, viewer, { type: "folder.create", name: "Mine" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("change what a member can do from their next request, down and up", async () => {
    const { ada, editor, noteId } = await team();
    const write = (text: string) => perform(env.DB, editor, { type: "note.write", id: noteId, baseRevision: 1, text });

    expect((await write("# Plan\n\nAs an editor")).revision).toBe(2);
    await perform(env.DB, ada, { type: "member.setRole", memberId: editor.personId, as: "viewer" });
    await expect(write("# Plan\n\nAs a viewer")).rejects.toMatchObject({ code: "forbidden", message: "A viewer can't note.write" });
    expect((await perform(env.DB, editor, { type: "note.read", id: noteId })).text).toBe("# Plan\n\nAs an editor");

    await perform(env.DB, ada, { type: "member.setRole", memberId: editor.personId, as: "admin" });
    expect(await perform(env.DB, editor, { type: "member.invite", email: "new@example.com", as: "viewer" })).toMatchObject({ invite: { email: "new@example.com" } });
  });

  it("end with removal: a removed member reaches nothing from their next request, and what they wrote stays under their name", async () => {
    const { ada, editor, noteId } = await team();
    await perform(env.DB, editor, { type: "note.write", id: noteId, baseRevision: 1, text: "# Plan\n\nEdith's step" });
    await perform(env.DB, editor, { type: "note.label", id: noteId, revision: 2, name: "Edith's" });
    await perform(env.DB, editor, { type: "settings.write", text: '{"core.theme":"dark"}', baseRevision: 0 });

    await perform(env.DB, ada, { type: "member.remove", memberId: editor.personId });

    for (const op of [{ type: "note.read", id: noteId }, { type: "note.list" }, { type: "member.list" }, { type: "settings.read" }, { type: "member.leave" }] as const) {
      await expect(perform(env.DB, editor, op), op.type).rejects.toMatchObject(NO_WORKSPACE);
    }
    expect(await roleOf(editor)).toBeNull();
    expect((await perform(env.DB, ada, { type: "note.read", id: noteId })).updatedBy).toEqual({ kind: "member", personId: editor.personId, name: "Edith Clarke" });
    expect((await perform(env.DB, ada, { type: "note.history", id: noteId })).map((c) => `${c.revision} ${c.author.name} ${c.label ?? ""}`.trim())).toEqual(["1 Ada Lovelace", "2 Edith Clarke Edith's"]);
    expect(await perform(env.DB, ada, { type: "history.authors" })).toContainEqual({ kind: "member", personId: editor.personId, name: "Edith Clarke" });

    const email = (await whoAmI(env.DB, editor.personId)).person.email;
    await perform(env.DB, ada, { type: "member.invite", email, as: "viewer" });
    await arrive(env.DB, editor.personId);
    expect((await perform(env.DB, editor, { type: "settings.read" })).text, "their settings are there if they come back").toBe('{"core.theme":"dark"}');
  });

  it("stop at the workspace: another workspace's member or invite, named by id, is not found", async () => {
    const { ada } = await team();
    const grace = await newMember("Grace Hopper");
    const hers = await addMember(grace, "editor", "Mary Jackson");
    const herInvite = await invite(grace, "pending@example.org", "editor");

    await expect(perform(env.DB, ada, { type: "member.setRole", memberId: hers.personId, as: "viewer" })).rejects.toMatchObject({ code: "not_found", message: "No such member" });
    await expect(perform(env.DB, ada, { type: "member.remove", memberId: hers.personId })).rejects.toMatchObject({ code: "not_found", message: "No such member" });
    await expect(perform(env.DB, ada, { type: "member.remove", memberId: grace.personId })).rejects.toMatchObject({ code: "not_found", message: "No such member" });
    await expect(perform(env.DB, ada, { type: "invite.revoke", id: herInvite.id })).rejects.toMatchObject({ code: "not_found", message: "No such invite" });
    await expect(perform(env.DB, at(grace.workspaceId, ada.personId), { type: "member.list" })).rejects.toMatchObject(NO_WORKSPACE);
    await expect(perform(env.DB, at(grace.workspaceId, ada.personId), { type: "member.remove", memberId: hers.personId })).rejects.toMatchObject(NO_WORKSPACE);

    expect(await members(grace)).toEqual(["Grace Hopper: admin", "Mary Jackson: editor"]);
    expect(await invites(grace)).toEqual(["pending@example.org: editor"]);
  });
});

describe("removing yourself", () => {
  it("is refused, so leaving always goes through Leave, which first asks that no private note is left with nobody", async () => {
    // Grace, not Ada: Ada made the workspace and pays for it, and is refused leaving for that first.
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "admin", "Grace Hopper");
    const secret = await perform(env.DB, grace, { type: "note.create", text: "# Diary" });
    await perform(env.DB, grace, { type: "note.setPrivate", id: secret.id, private: true });

    await expect(perform(env.DB, grace, { type: "member.remove", memberId: grace.personId })).rejects.toMatchObject({ code: "invalid", message: "Use Leave to leave a workspace" });
    await expect(perform(env.DB, grace, { type: "member.leave" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("You have a private note here") });
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Grace Hopper: admin"]);
  });
});

describe("a workspace always has an admin", () => {
  /**
   * Admins of a workspace with no owner, as one made before there were owners can be, whose first admin
   * has made themself an editor, so these are all the admins it has. An owner stays an admin.
   */
  async function besideTheOwner(...names: string[]): Promise<Actor[]> {
    const owner = await newMember("Olive Owner");
    const admins = [];
    for (const name of names) admins.push(await addMember(owner, "admin", name));
    await env.DB.prepare("UPDATE workspaces SET owner_id = NULL WHERE id = ?").bind(owner.workspaceId).run();
    await perform(env.DB, owner, { type: "member.setRole", memberId: owner.personId, as: "editor" });
    return admins;
  }

  it("so its only admin can't be demoted, removed, or leave, by themself or through an invite", async () => {
    const [ada] = (await besideTheOwner("Ada Lovelace")) as [Actor];
    const editor = await addMember(ada, "editor", "Edith Clarke");

    await expect(perform(env.DB, ada, { type: "member.setRole", memberId: ada.personId, as: "editor" })).rejects.toMatchObject(LAST_ADMIN);
    await expect(perform(env.DB, ada, { type: "member.remove", memberId: ada.personId })).rejects.toMatchObject({ code: "invalid", message: "Use Leave to leave a workspace" });
    await expect(perform(env.DB, ada, { type: "member.leave" })).rejects.toMatchObject(LAST_ADMIN);
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Edith Clarke: editor", "Olive Owner: editor"]);

    expect(await perform(env.DB, ada, { type: "member.setRole", memberId: ada.personId, as: "admin" }), "staying admin is no demotion").toMatchObject({ role: "admin" });
    await perform(env.DB, ada, { type: "member.setRole", memberId: editor.personId, as: "admin" });
    expect(await perform(env.DB, ada, { type: "member.leave" })).toEqual({ memberId: ada.personId });
    expect(await members(editor)).toEqual(["Edith Clarke: admin", "Olive Owner: editor"]);
    await expect(perform(env.DB, editor, { type: "member.leave" })).rejects.toMatchObject(LAST_ADMIN);
  });

  const outcomes = async (ops: Promise<unknown>[]) => (await Promise.allSettled(ops)).map((r) => (r.status === "fulfilled" ? "done" : ((r.reason as { code?: string }).code ?? String(r.reason))));
  const admins = async (workspaceId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'admin'").bind(workspaceId).first<{ n: number }>())!.n;

  /** Two admins, each acting at the same moment on what the other's change depends on. */
  const RACES: Record<string, (ada: Actor, grace: Actor) => [OpInput, OpInput]> = {
    "demote each other": (ada, grace) => [{ type: "member.setRole", memberId: grace.personId, as: "editor" }, { type: "member.setRole", memberId: ada.personId, as: "viewer" }],
    "remove each other": (ada, grace) => [{ type: "member.remove", memberId: grace.personId }, { type: "member.remove", memberId: ada.personId }],
    "both leave": () => [{ type: "member.leave" }, { type: "member.leave" }],
    "both demote themselves": (ada, grace) => [{ type: "member.setRole", memberId: ada.personId, as: "editor" }, { type: "member.setRole", memberId: grace.personId, as: "editor" }],
    "one demotes the other, who removes them": (ada, grace) => [{ type: "member.setRole", memberId: grace.personId, as: "viewer" }, { type: "member.remove", memberId: ada.personId }],
    "one leaves while the other demotes themself": (_, grace) => [{ type: "member.leave" }, { type: "member.setRole", memberId: grace.personId, as: "viewer" }],
  };

  for (const [name, race] of Object.entries(RACES)) {
    it(`when its two admins ${name} at the same moment: one of them is refused`, async () => {
      for (let round = 0; round < 5; round++) {
        const [ada, grace] = (await besideTheOwner("Ada Lovelace", "Grace Hopper")) as [Actor, Actor];
        const [hers, his] = race(ada, grace);

        const done = await outcomes([perform(env.DB, ada, hers), perform(env.DB, grace, his)]);

        expect(done.filter((d) => d === "done"), `${name}: ${done.join(", ")}`).toHaveLength(1);
        expect(await admins(ada.workspaceId), name).toBe(1);
      }
    });
  }

  it("when an admin is demoted between being let through and the write: the write itself refuses them", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "admin", "Grace Hopper");
    const editor = await addMember(ada, "editor", "Edith Clarke");
    const pending = await invite(ada, "pending@example.com", "viewer");
    await perform(env.DB, ada, { type: "member.setRole", memberId: grace.personId, as: "editor" });
    // What an operation hands on once it has let an admin through, here for one who no longer is.
    const stale = { db: env.DB, workspaceId: grace.workspaceId, personId: grace.personId, now: Date.now() };

    await expect(setRole(stale, editor.personId, "admin")).rejects.toMatchObject({ code: "forbidden", message: "A editor can't member.setRole" });
    await expect(setRole(stale, grace.personId, "admin")).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeMember(stale, editor.personId)).rejects.toMatchObject({ code: "forbidden", message: "A editor can't member.remove" });
    await expect(removeMember(stale, ada.personId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(inviteAs(stale, "mallory@example.com", "admin")).rejects.toMatchObject({ code: "forbidden", message: "A editor can't member.invite" });
    await expect(inviteAs(stale, "pending@example.com", "admin")).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeInvite(stale, pending.id)).rejects.toMatchObject({ code: "forbidden", message: "A editor can't invite.revoke" });

    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Edith Clarke: editor", "Grace Hopper: editor"]);
    expect(await invites(ada)).toEqual(["pending@example.com: viewer"]);
  });
});

describe("an agent", () => {
  // The tools, pinned and read-only tokens are in test/core/agent-access.test.ts. This is the core's own refusal.
  it("can see who is in the workspace, and is refused every change to its members, even for an admin", async () => {
    const ada = await newMember("Ada Lovelace");
    const editor = await addMember(ada, "editor", "Edith Clarke");
    const pending = await invite(ada, "pending@example.com", "viewer");
    const agent: Actor = { kind: "agent", agentId: "aaaaaaaaaaaa", personId: ada.personId, workspaceId: ada.workspaceId };

    expect((await perform(env.DB, agent, { type: "member.list" })).map((m) => m.name)).toEqual(["Ada Lovelace", "Edith Clarke"]);
    const kept: OpInput[] = [
      { type: "member.invite", email: "mallory@example.com", as: "admin" },
      { type: "member.setRole", memberId: editor.personId, as: "admin" },
      { type: "member.remove", memberId: editor.personId },
      { type: "member.leave" },
      { type: "invite.list" },
      { type: "invite.revoke", id: pending.id },
    ];
    for (const op of kept) await expect(perform(env.DB, agent, op), op.type).rejects.toMatchObject({ code: "forbidden", message: `An agent can't ${op.type}` });
    expect(await members(ada)).toEqual(["Ada Lovelace: admin", "Edith Clarke: editor"]);
    expect(await invites(ada)).toEqual(["pending@example.com: viewer"]);
  });
});

describe("a person in several workspaces", () => {
  it("is listed in each in the order they came to them, with their role there", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await newMember("Grace Hopper");
    const mary = await newMember("Mary Jackson");
    const email = (await whoAmI(env.DB, mary.personId)).person.email;

    await perform(env.DB, grace, { type: "member.invite", email, as: "viewer" });
    await arrive(env.DB, mary.personId, Date.now() + 1000);
    await perform(env.DB, ada, { type: "member.invite", email, as: "editor" });
    await arrive(env.DB, mary.personId, Date.now() + 2000);

    expect((await whoAmI(env.DB, mary.personId)).workspaces.map((w) => `${w.name}: ${w.role}`)).toEqual(["Mary's workspace: admin", "Grace's workspace: viewer", "Ada's workspace: editor"]);
  });

  it("has a note's workspace found from the note's id, in whichever of theirs it is, and nowhere else", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "viewer", "Grace Hopper");
    const own = (await whoAmI(env.DB, grace.personId)).workspaces.find((w) => w.id !== ada.workspaceId)!.id;
    const shared = await perform(env.DB, ada, { type: "note.create", text: "# Shared" });
    const hers = await perform(env.DB, at(own, grace.personId), { type: "note.create", text: "# Hers" });
    const mallory = await newMember("Mallory");

    expect(await workspaceOfNote(env.DB, grace.personId, shared.id)).toBe(ada.workspaceId);
    expect(await workspaceOfNote(env.DB, grace.personId, hers.id)).toBe(own);
    expect(await workspaceOfNote(env.DB, ada.personId, hers.id)).toBeNull();
    expect(await workspaceOfNote(env.DB, mallory.personId, shared.id)).toBeNull();
    expect(await workspaceOfNote(env.DB, mallory.personId, "aaaaaaaaaaaa")).toBeNull();

    await perform(env.DB, ada, { type: "member.remove", memberId: grace.personId });
    expect(await workspaceOfNote(env.DB, grace.personId, shared.id)).toBeNull();
  });

  it("keeps settings of their own in each", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "viewer", "Grace Hopper");
    const own = at((await whoAmI(env.DB, grace.personId)).workspaces.find((w) => w.id !== ada.workspaceId)!.id, grace.personId);

    await perform(env.DB, grace, { type: "settings.write", text: '{"core.theme":"dark"}', baseRevision: 0 });

    expect((await perform(env.DB, own, { type: "settings.read" })).text).toBe("{}");
    expect((await perform(env.DB, grace, { type: "settings.read" })).text).toBe('{"core.theme":"dark"}');
    expect((await perform(env.DB, ada, { type: "settings.read" })).text).toBe("{}");
  });
});

describe("over HTTP, as a signed-in person", () => {
  const SECRET = "test-secret";
  /** Requests as `personId` with a session cookie made the way Common Ink makes one. */
  const session = async (personId: string) => {
    const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ personId }, SECRET, 3600))}`;
    return async (path: string, init: RequestInit = {}) => {
      const res = await worker.fetch(new Request(`https://ink.test${path}`, { ...init, headers: { ...(init.headers as object), Cookie: cookie } }) as never, { ...env, SESSION_SECRET: SECRET });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    };
  };
  const op = (body: OpInput): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ink.test" }, body: JSON.stringify(body) });

  it("an invite takes effect when the invited person next opens Common Ink, and its link leads them and nobody else to the workspace", async () => {
    const ada = await newMember("Ada Lovelace");
    const asAda = await session(ada.personId);
    const email = address();
    const grace = await signIn(env.DB, { email, name: "Grace Hopper" });
    const asGrace = await session(grace.personId);
    const asMallory = await session((await newMember("Mallory")).personId);

    const made = await asAda(`/api/workspaces/${ada.workspaceId}/ops`, op({ type: "member.invite", email, as: "viewer" }));
    expect(made.status).toBe(200);
    const inviteId = (made.body as { invite: { id: string } }).invite.id;

    expect(await asMallory(`/api/invites/${inviteId}`)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await asMallory("/api/invites/aaaaaaaaaaaa")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await asGrace(`/api/invites/${inviteId}`)).toEqual({ status: 200, body: { workspaceId: ada.workspaceId } });
    expect(((await asGrace("/api/me")).body as { workspaces: { name: string; role: Role }[] }).workspaces).toMatchObject([{ name: "Grace's workspace", role: "admin" }, { name: "Ada's workspace", role: "viewer" }]);

    expect((await asGrace(`/api/workspaces/${ada.workspaceId}/ops`, op({ type: "note.create", text: "# No" }))).status).toBe(403);
    expect((await asGrace(`/api/workspaces/${ada.workspaceId}/ops`, op({ type: "member.invite", email: address(), as: "admin" }))).status).toBe(403);
    expect((await asGrace(`/api/workspaces/${ada.workspaceId}/ops`, op({ type: "member.list" }))).status).toBe(200);
  });

  it("an invite made since they last looked is taken up by /api/me alone", async () => {
    const ada = await newMember("Ada Lovelace");
    const email = address();
    const grace = await signIn(env.DB, { email, name: "Grace Hopper" });
    const asGrace = await session(grace.personId);
    await invite(ada, email, "editor");

    expect(((await asGrace("/api/me")).body as { workspaces: unknown[] }).workspaces).toHaveLength(2);
  });

  it("a note's address says which of the person's workspaces it is in, and the same of a note that isn't theirs as of one that doesn't exist", async () => {
    const ada = await newMember("Ada Lovelace");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const asAda = await session(ada.personId);
    const asMallory = await session((await newMember("Mallory")).personId);

    expect(await asAda(`/api/notes/${note.id}`)).toEqual({ status: 200, body: { workspaceId: ada.workspaceId } });
    expect(await asMallory(`/api/notes/${note.id}`)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await asMallory("/api/notes/aaaaaaaaaaaa")).toEqual({ status: 404, body: { error: "not_found" } });
    const signedOut = await worker.fetch(new Request(`https://ink.test/api/notes/${note.id}`) as never, { ...env, SESSION_SECRET: SECRET });
    expect(signedOut.status).toBe(401);
  });

  it("a removed member's session reaches nothing in the workspace on its next request", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const asGrace = await session(grace.personId);
    expect((await asGrace(`/api/workspaces/${ada.workspaceId}/ops`, op({ type: "note.read", id: note.id }))).status).toBe(200);

    await perform(env.DB, ada, { type: "member.remove", memberId: grace.personId });

    expect(await asGrace(`/api/workspaces/${ada.workspaceId}/ops`, op({ type: "note.read", id: note.id }))).toEqual({ status: 404, body: { error: "not_found", message: "No such workspace" } });
    expect(await asGrace(`/api/notes/${note.id}`)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(((await asGrace("/api/me")).body as { workspaces: { name: string }[] }).workspaces.map((w) => w.name)).toEqual(["Grace's workspace"]);
  });

  it("a session whose person is no longer there is signed out", async () => {
    const personId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO people (id, email, name, created_at) VALUES (?, ?, 'Gone Person', 0)").bind(personId, address()).run();
    const asGone = await session(personId);
    await env.DB.prepare("DELETE FROM people WHERE id = ?").bind(personId).run();

    expect(await asGone("/api/me")).toEqual({ status: 401, body: { error: "signed_out" } });
  });
});

describe("signing in as someone else without Google", () => {
  const get = (url: string, settings: Partial<Env>) => worker.fetch(new Request(url) as never, { ...env, SESSION_SECRET: "test-secret", ...settings });

  it("is there only where dev sign-in is switched on, and never on the production host", async () => {
    const path = "/auth/dev?email=second@example.com&name=Second";

    expect((await get(`http://localhost:5314${path}`, { DEV_SIGN_IN: "1" })).status).toBe(302);
    expect((await get(`https://pr-14-common-ink-v3-previews.draftox.workers.dev${path}`, { DEV_SIGN_IN: "1" })).status).toBe(302);
    expect((await get(`http://localhost:5314${path}`, {})).status).toBe(404);
    expect((await get(`https://commonink.app${path}`, { DEV_SIGN_IN: "1" })).status).toBe(404);
    expect((await get(`https://commonink.app${path}`, {})).status).toBe(404);
    expect((await get("https://commonink.app/api/me", { DEV_SIGN_IN: "1" })).status).toBe(401);
  });

  it("signs in only on a GET, as someone with an email of at most 254 characters and a name of at most 100", async () => {
    const at = (query: Record<string, string>, method = "GET") =>
      worker.fetch(new Request(`http://localhost:5314/auth/dev?${new URLSearchParams(query)}`, { method }) as never, { ...env, SESSION_SECRET: "test-secret", DEV_SIGN_IN: "1" }).then((res) => res.status);
    const email = `${"a".repeat(242)}@example.com`;

    expect(await at({ email, name: "N".repeat(100) })).toBe(302);
    expect(await at({ email }, "HEAD")).toBe(302);
    expect(await at({ email }, "POST")).toBe(405);
    expect(await at({ email }, "PUT")).toBe(405);
    expect(await at({ email: `a${email}` })).toBe(400);
    expect(await at({ email: "nobody" })).toBe(400);
    expect(await at({ email, name: "N".repeat(101) })).toBe(400);
  });
});
