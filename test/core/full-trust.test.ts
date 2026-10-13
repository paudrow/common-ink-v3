import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { authenticateAgent, connectAgent } from "../../src/core/agents.ts";
import { agentActor, perform, type Actor } from "../../src/core/operations.ts";
import { DRAFT_ASKS_FULL_TRUST, NOT_GRANTED, fullTrustOff, permitPlugin, trustPlugin } from "../../src/core/pluginRecord.ts";
import { OWN_SANDBOXED, OWN_SANDBOXED_IDS } from "../../src/core/ownPlugins.ts";
import { Manifest, codeHash, type Capability } from "../../src/core/plugins.ts";
import type { OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { TOOLS, callTool } from "../../src/worker/mcp/tools.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

/*
 * Full trust, tried as whoever would misuse it: a member who isn't an admin, another member, an
 * admin acting on someone else, a guest, an agent of every kind, a plugin, a draft, and the plugin
 * that has it.
 */

const FULL = { name: "full-trust", reason: "It adds keys to the editor." } as const;
const READ = { name: "notes.read", reason: "Counts the words in your notes." } as const;
const manifest = (capabilities: readonly object[], name = "Deep Keys") => JSON.stringify({ name, capabilities });
const CODE = "host.commands.register({ id: 'deep.hello', title: 'Hello', run() {} })";
const OTHER = `${CODE}; fetch('/api/me')`;

const outcome = async (actor: Actor, op: OpInput): Promise<string> => {
  try {
    await perform(env.DB, actor, op);
    return "done";
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
};
const pluginOf = (member: Actor, pluginId: string, draft = false): Actor => ({ kind: "plugin", pluginId, personId: member.personId, workspaceId: member.workspaceId, draft });
const install = async (admin: Actor, capabilities: readonly object[], code = CODE) => (await perform(env.DB, admin, { type: "plugin.install", manifest: manifest(capabilities), code })).id;
const update = (admin: Actor, id: string, code: string, capabilities: readonly object[] = [FULL]) => perform(env.DB, admin, { type: "plugin.install", manifest: manifest(capabilities), code, replaces: id });
const grant = async (admin: Actor, id: string, capability: Capability = "full-trust", code = CODE) => perform(env.DB, admin, { type: "plugin.permit", id, capability, allowed: true, codeHash: await codeHash(code) });
const turnOn = async (member: Actor, id: string, code = CODE) => perform(env.DB, member, { type: "plugin.trust", id, on: true, codeHash: await codeHash(code) });
const stateOf = async (asker: Actor, id: string) => (await perform(env.DB, asker, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.fullTrust;
const rows = async (workspaceId: string) => (await env.DB.prepare("SELECT plugin_id, person_id FROM plugin_trust WHERE workspace_id = ?").bind(workspaceId).all<{ plugin_id: string; person_id: string }>()).results;
const refused = `forbidden: ${fullTrustOff("Deep Keys")}`;

/** A workspace with an admin, an editor and a viewer, a note of the editor's that is private to her, and a guest on the shared note. */
async function team() {
  const ada = await newMember("Ada Lovelace");
  const eve = await addMember(ada, "editor", "Eve Editor");
  const vera = await addMember(ada, "viewer", "Vera Viewer");
  const secret = await perform(env.DB, eve, { type: "note.create", text: "# Eve's secret\n\nonly-eve-knows" });
  await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: true });
  const shared = await perform(env.DB, ada, { type: "note.create", text: "# Roadmap\n\nfor everyone" });
  await perform(env.DB, ada, { type: "grant.set", noteId: shared.id, email: "gus@example.com", access: "edit" });
  const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email: "gus@example.com", name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
  return { ada, eve, vera, gus, secret: secret.id, shared: shared.id };
}

/** An agent of `member`'s of each kind there is, each made the one way the worker makes an agent's actor. */
async function agentsOf(member: Actor): Promise<Record<string, { actor: Actor; agent: NonNullable<Awaited<ReturnType<typeof authenticateAgent>>> }>> {
  const folder = (await perform(env.DB, { ...member, kind: "member" } as Actor, { type: "folder.list" })).folders[0]!.id;
  const kinds = {
    "an agent": {},
    "a read-only agent": { readOnly: true },
    "an agent pinned to the workspace": { workspaceId: member.workspaceId },
    "an agent limited to a folder": { workspaceId: member.workspaceId, folderIds: [folder] },
    "a read-only agent limited to a folder": { workspaceId: member.workspaceId, folderIds: [folder], readOnly: true },
  };
  const made: Record<string, { actor: Actor; agent: NonNullable<Awaited<ReturnType<typeof authenticateAgent>>> }> = {};
  for (const [kind, options] of Object.entries(kinds)) {
    const agent = (await authenticateAgent(env.DB, (await connectAgent(env.DB, member.personId, "Claude", options as never)).token))!;
    made[kind] = { agent, actor: agentActor(agent, member.workspaceId) };
  }
  return made;
}

describe("full trust runs for a member only with an admin's grant of that code and their own turning it on", () => {
  it("performs nothing with the grant alone, with a member's wish alone, or with neither, and as that member with both", async () => {
    const { ada, eve, vera, shared } = await team();
    const id = await install(ada, [FULL]);
    const read: OpInput = { type: "note.read", id: shared };
    expect(await outcome(pluginOf(eve, id), read), "neither").toBe(refused);
    // Turning on what no admin granted is refused, and keeps nothing to count later.
    expect(await outcome(eve, { type: "plugin.trust", id, on: true, codeHash: await codeHash(CODE) })).toBe(`conflict: ${NOT_GRANTED}`);
    expect(await rows(ada.workspaceId)).toEqual([]);
    // Even a row put there past the operation counts for nothing without the grant.
    await env.DB.prepare("INSERT INTO plugin_trust (workspace_id, plugin_id, person_id, code_hash, at) VALUES (?, ?, ?, ?, 0)").bind(ada.workspaceId, id, eve.personId, await codeHash(CODE)).run();
    expect(await outcome(pluginOf(eve, id), read), "her row without an admin's grant").toBe(refused);
    expect((await stateOf(eve, id))!.on, "and she isn't told it is on").toBe(false);
    await env.DB.prepare("DELETE FROM plugin_trust").run();

    await grant(ada, id);
    for (const who of [ada, eve, vera]) expect(await outcome(pluginOf(who, id), read), "the grant without their own turning it on").toBe(refused);
    await turnOn(eve, id);
    expect(await outcome(pluginOf(eve, id), read)).toBe("done");
    expect(await outcome(pluginOf(vera, id), read), "Eve's is not Vera's").toBe(refused);
    expect(await outcome(pluginOf(ada, id), read), "the admin who granted it hasn't turned it on for herself").toBe(refused);
    expect(await stateOf(eve, id)).toEqual({ grantedHash: await codeHash(CODE), changedSince: false, on: true, turnedOnBy: null });
    expect(await stateOf(vera, id)).toEqual({ grantedHash: await codeHash(CODE), changedSince: false, on: false, turnedOnBy: null });
    expect((await stateOf(ada, id))!.turnedOnBy!.map((who) => who.name), "an admin is told who has it on").toEqual(["Eve Editor"]);
    // Off is hers to say, and is at once.
    await perform(env.DB, eve, { type: "plugin.trust", id, on: false });
    await perform(env.DB, eve, { type: "plugin.trust", id, on: false });
    expect(await outcome(pluginOf(eve, id), read)).toBe(refused);
  });

  it("is granted and taken back only by an admin, signed in: every other actor is refused, by every way in", async () => {
    const { ada, eve, vera, gus, shared } = await team();
    const id = await install(ada, [FULL, READ]);
    const tame = await install(ada, [READ]);
    await grant(ada, tame, "notes.read");
    await perform(env.DB, eve, { type: "draft.save", id: tame, manifest: manifest([READ]), code: "draft", running: true });
    const hash = await codeHash(CODE);
    const permit: OpInput = { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: hash };
    const revoke: OpInput = { type: "plugin.permit", id, capability: "full-trust", allowed: false };
    for (const op of [permit, revoke]) {
      expect(await outcome(eve, op)).toBe("forbidden: A editor can't plugin.permit");
      expect(await outcome(vera, op)).toBe("forbidden: A viewer can't plugin.permit");
      expect(await outcome(gus, op)).toBe("forbidden: A guest can't plugin.permit");
      for (const [kind, { actor }] of Object.entries(await agentsOf(ada))) expect(await outcome(actor, op), `an admin's own: ${kind}`).toBe("forbidden: An agent can't plugin.permit");
      expect(await outcome(pluginOf(ada, tame), op), "a plugin that runs shut off, in an admin's session").toBe("forbidden: Deep Keys isn't permitted to plugin.permit");
      expect(await outcome(pluginOf(eve, tame, true), op), "a member's draft").toBe("forbidden: Deep Keys isn't permitted to plugin.permit");
      expect(await outcome(pluginOf(ada, id), op), "the plugin that asks for it, before it runs").toBe(refused);
    }
    expect((await stateOf(ada, id))!.grantedHash).toBeNull();
    // A member's yes is a request, which allows nothing.
    await perform(env.DB, eve, { type: "plugin.request", id, capability: "full-trust" });
    expect((await stateOf(ada, id))!.grantedHash).toBeNull();
    expect(await outcome(eve, { type: "plugin.trust", id, on: true, codeHash: hash })).toBe(`conflict: ${NOT_GRANTED}`);
    // An admin grants code she names, and no other.
    expect(await outcome(ada, { type: "plugin.permit", id, capability: "full-trust", allowed: true })).toMatch(/^invalid: Say which code/);
    expect(await outcome(ada, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: await codeHash(OTHER) })).toMatch(/^conflict: /);
    await grant(ada, id);
    // Running in an admin's own session with her turning it on, it is still no admin at the plugin's address.
    await turnOn(ada, id);
    expect(await outcome(pluginOf(ada, id), { type: "note.read", id: shared })).toBe("done");
    for (const op of [permit, revoke]) expect(await outcome(pluginOf(ada, id), op), "the plugin that has it, in an admin's session").toBe("forbidden: Deep Keys isn't permitted to plugin.permit");
    expect((await stateOf(ada, id))!.grantedHash).toBe(hash);
  });

  it("is turned on by each member for themself, signed in: no field names another, and nobody else's actor is let in", async () => {
    const { ada, eve, vera, gus, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    const hash = await codeHash(CODE);
    const on: OpInput = { type: "plugin.trust", id, on: true, codeHash: hash };
    // An admin sends every way of naming someone else. None is a field of the operation: it is turned on for the admin alone.
    await perform(env.DB, ada, { ...on, personId: eve.personId, memberId: eve.personId, for: eve.personId, actor: eve, as: eve.personId, onBehalfOf: eve.personId } as never);
    expect((await rows(ada.workspaceId)).map((row) => row.person_id)).toEqual([ada.personId]);
    expect((await stateOf(eve, id))!.on).toBe(false);
    expect(await outcome(pluginOf(eve, id), { type: "note.read", id: shared })).toBe(refused);
    await perform(env.DB, ada, { type: "plugin.trust", id, on: false });

    for (const member of [ada, eve, vera]) {
      for (const [kind, { actor, agent }] of Object.entries(await agentsOf(member))) {
        expect(await outcome(actor, on), kind).toBe("forbidden: An agent can't plugin.trust");
        // No tool does it either, whatever it is called with.
        for (const tool of TOOLS) await callTool(env.DB, agent, tool.name, { id, on: true, codeHash: hash, workspace: member.workspaceId }).catch(() => null);
      }
    }
    expect(TOOLS.map((tool) => tool.name).filter((name) => /trust/i.test(name))).toEqual([]);
    expect(await outcome(gus, on)).toBe("forbidden: A guest can't plugin.trust");
    expect(await rows(ada.workspaceId), "nothing any of them did turned it on for anyone").toEqual([]);

    // A plugin can't turn itself or another on: not shut off, not as a draft, and not the full-trust one once it runs.
    const tame = await install(ada, [READ]);
    await grant(ada, tame, "notes.read");
    await perform(env.DB, vera, { type: "draft.save", id: tame, manifest: manifest([READ]), code: "draft", running: true });
    expect(await outcome(pluginOf(vera, tame), on)).toBe("forbidden: Deep Keys isn't permitted to plugin.trust");
    expect(await outcome(pluginOf(vera, tame, true), on)).toBe("forbidden: Deep Keys isn't permitted to plugin.trust");
    const second = await install(ada, [FULL]);
    await grant(ada, second);
    await turnOn(eve, id);
    expect(await outcome(pluginOf(eve, id), { type: "plugin.trust", id: second, on: true, codeHash: hash }), "one that runs, turning on another").toBe("forbidden: Deep Keys isn't permitted to plugin.trust");
    expect((await rows(ada.workspaceId)).map((row) => [row.plugin_id, row.person_id])).toEqual([[id, eve.personId]]);

    // A member can't turn on code they weren't shown, or a plugin that runs shut off.
    expect(await outcome(vera, { type: "plugin.trust", id, on: true, codeHash: await codeHash(OTHER) })).toMatch(/^conflict: This plugin has been replaced/);
    expect(await outcome(vera, { type: "plugin.trust", id, on: true })).toMatch(/^invalid: /);
    expect(await outcome(vera, { type: "plugin.trust", id: tame, on: true, codeHash: hash })).toMatch(/^invalid: Deep Keys doesn't ask for full trust/);
  });

  it("stops for everyone at once when its code changes, and putting the old code back restores neither the grant nor anyone's turning it on", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    await turnOn(eve, id);
    await turnOn(ada, id);
    const read: OpInput = { type: "note.read", id: shared };
    expect([await outcome(pluginOf(eve, id), read), await outcome(pluginOf(ada, id), read)]).toEqual(["done", "done"]);

    // A member's, an agent's and the plugin's own try at the code are refused, and change nothing.
    const replace: OpInput = { type: "plugin.install", manifest: manifest([FULL]), code: OTHER, replaces: id };
    expect(await outcome(eve, replace)).toBe("forbidden: A editor can't plugin.install");
    expect(await outcome(pluginOf(eve, id), replace)).toBe("forbidden: Deep Keys isn't permitted to plugin.install");
    expect(await outcome(pluginOf(ada, id), replace), "in an admin's session, at the plugin's address").toBe("forbidden: Deep Keys isn't permitted to plugin.install");
    for (const { actor } of Object.values(await agentsOf(ada))) expect(await outcome(actor, replace)).toBe("forbidden: An agent can't plugin.install");
    await perform(env.DB, eve, { type: "draft.save", id, manifest: manifest([]), code: OTHER, running: true });
    expect(await outcome(pluginOf(eve, id), read), "her draft changed nothing of the plugin").toBe("done");
    expect((await perform(env.DB, eve, { type: "plugin.read", id })).code).toBe(CODE);
    await perform(env.DB, eve, { type: "draft.discard", id });

    // A → B: off for everyone, and nobody's row is left.
    await update(ada, id, OTHER);
    expect([await outcome(pluginOf(eve, id), read), await outcome(pluginOf(ada, id), read)]).toEqual([refused, refused]);
    expect(await stateOf(ada, id)).toEqual({ grantedHash: null, changedSince: true, on: false, turnedOnBy: [] });
    expect(await rows(ada.workspaceId)).toEqual([]);
    // A row for the old code, were one left, is no row for the new.
    expect(await outcome(eve, { type: "plugin.trust", id, on: true, codeHash: await codeHash(CODE) })).toMatch(/^conflict: /);
    expect(await outcome(eve, { type: "plugin.trust", id, on: true, codeHash: await codeHash(OTHER) })).toBe(`conflict: ${NOT_GRANTED}`);
    // An approval of the old code is no approval of the new.
    expect(await outcome(ada, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: await codeHash(CODE) })).toMatch(/^conflict: /);

    // B → A: the code an admin once granted is back, and nothing of that comes back with it.
    await update(ada, id, CODE);
    expect(await stateOf(ada, id), "A, B, A").toEqual({ grantedHash: null, changedSince: true, on: false, turnedOnBy: [] });
    expect([await outcome(pluginOf(eve, id), read), await outcome(pluginOf(ada, id), read)]).toEqual([refused, refused]);
    expect(await outcome(eve, { type: "plugin.trust", id, on: true, codeHash: await codeHash(CODE) })).toBe(`conflict: ${NOT_GRANTED}`);

    // Only a fresh grant and each member's own fresh turning on start it again, one member at a time.
    await grant(ada, id);
    expect([await outcome(pluginOf(eve, id), read), await outcome(pluginOf(ada, id), read)], "granting again turned nobody on").toEqual([refused, refused]);
    await turnOn(eve, id);
    expect([await outcome(pluginOf(eve, id), read), await outcome(pluginOf(ada, id), read)]).toEqual(["done", refused]);
  });

  it("ends by every way a plugin becomes something else: a draft published over it, its asking declared another way, its asking dropped, and uninstalling", async () => {
    const { ada, eve, shared } = await team();
    const read: OpInput = { type: "note.read", id: shared };
    const running = async () => {
      const id = await install(ada, [FULL]);
      await grant(ada, id);
      await turnOn(eve, id);
      await turnOn(ada, id);
      expect(await outcome(pluginOf(eve, id), read)).toBe("done");
      return id;
    };

    // An admin publishes her draft: it is other code.
    let id = await running();
    await perform(env.DB, ada, { type: "draft.save", id, manifest: manifest([FULL]), code: "ada's version", running: false });
    const hers = await perform(env.DB, ada, { type: "draft.read", id });
    await perform(env.DB, ada, { type: "plugin.install", manifest: hers.manifest, code: hers.code, replaces: id });
    expect(await outcome(pluginOf(eve, id), read)).toBe(refused);
    expect(await rows(ada.workspaceId)).toEqual([]);

    // The same code, asking with another reason: what was granted is not what it asks now, and the first reason coming back restores nothing.
    id = await running();
    await perform(env.DB, ada, { type: "plugin.install", manifest: manifest([{ ...FULL, reason: "Another reason." }]), code: CODE, replaces: id });
    expect(await outcome(pluginOf(eve, id), read)).toBe(refused);
    await update(ada, id, CODE);
    expect(await stateOf(ada, id)).toEqual({ grantedHash: null, changedSince: true, on: false, turnedOnBy: [] });
    expect(await rows(ada.workspaceId)).toEqual([]);

    // It stops asking, and asks again: it starts from nothing.
    id = await running();
    await update(ada, id, CODE, [READ]);
    expect(await stateOf(ada, id)).toBeNull();
    await update(ada, id, CODE);
    expect(await stateOf(ada, id)).toEqual({ grantedHash: null, changedSince: true, on: false, turnedOnBy: [] });
    expect(await outcome(pluginOf(eve, id), read)).toBe(refused);
    expect(await rows(ada.workspaceId)).toEqual([]);

    // The same manifest and code installed over itself changes nothing, so nothing ends.
    id = await running();
    await update(ada, id, CODE);
    expect([await outcome(pluginOf(eve, id), read), await outcome(pluginOf(ada, id), read)]).toEqual(["done", "done"]);

    // Uninstalled, it performs nothing; installed again it is another plugin, with nothing of the first's.
    await perform(env.DB, ada, { type: "plugin.uninstall", id });
    expect(await outcome(pluginOf(eve, id), read)).toBe("forbidden: That plugin isn't installed in this workspace");
    expect(await rows(ada.workspaceId)).toEqual([]);
    const again = await install(ada, [FULL]);
    expect(again).not.toBe(id);
    expect(await stateOf(ada, again)).toEqual({ grantedHash: null, changedSince: false, on: false, turnedOnBy: [] });
    expect(await outcome(pluginOf(eve, again), read)).toBe(refused);
    expect(await outcome(ada, { type: "plugin.install", manifest: manifest([FULL]), code: CODE, replaces: id }), "an uninstalled plugin's id is nobody's to install under").toBe("not_found: No such plugin");
  });

  it("starts from nobody whenever an admin decides it, either way: taking it back turns everyone off, and granting again turns nobody back on", async () => {
    const { ada, eve, vera, shared } = await team();
    const id = await install(ada, [FULL]);
    const read: OpInput = { type: "note.read", id: shared };
    await grant(ada, id);
    for (const who of [ada, eve, vera]) await turnOn(who, id);
    await perform(env.DB, ada, { type: "plugin.permit", id, capability: "full-trust", allowed: false });
    for (const who of [ada, eve, vera]) expect(await outcome(pluginOf(who, id), read)).toBe(refused);
    expect(await rows(ada.workspaceId)).toEqual([]);
    await grant(ada, id);
    for (const who of [ada, eve, vera]) expect(await outcome(pluginOf(who, id), read), "granted again").toBe(refused);
    expect(await stateOf(ada, id)).toEqual({ grantedHash: await codeHash(CODE), changedSince: false, on: false, turnedOnBy: [] });
    // Saying again what already stands decides nothing, so locking a grant, or a second press of Allow, turns nobody off.
    await turnOn(eve, id);
    await grant(ada, id);
    await perform(env.DB, ada, { type: "plugin.permit", id, capability: "full-trust", allowed: true, locked: true, codeHash: await codeHash(CODE) });
    await perform(env.DB, ada, { type: "plugin.permit", id, capability: "full-trust", allowed: true, locked: false, codeHash: await codeHash(CODE) });
    expect(await outcome(pluginOf(eve, id), read)).toBe("done");
    // A grant where none stood is one, whatever rows were left before it.
    await env.DB.prepare("UPDATE plugin_permissions SET state = 'off' WHERE subject = ?").bind(id).run();
    await grant(ada, id);
    expect(await rows(ada.workspaceId)).toEqual([]);
    expect(await outcome(pluginOf(eve, id), read)).toBe(refused);
    // A decision about another permission of the plugin's is not one about full trust.
    const both = await install(ada, [FULL, READ]);
    await grant(ada, both);
    await turnOn(eve, both);
    await grant(ada, both, "notes.read");
    expect(await outcome(pluginOf(eve, both), read)).toBe("done");
  });

  it("is turned on by one statement that asks, as it runs, for the membership, the code and the grant: whatever it crosses, no row is left that nothing stands behind", async () => {
    const { ada, eve, shared } = await team();
    const read: OpInput = { type: "note.read", id: shared };
    const hash = await codeHash(CODE);
    /** Every row there is has a member, a plugin whose code is the row's, and a grant of that code. */
    const sound = async () =>
      (
        await env.DB.prepare(
          `SELECT t.plugin_id FROM plugin_trust t WHERE NOT (
             EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = t.workspace_id AND m.person_id = t.person_id)
             AND EXISTS (SELECT 1 FROM plugin_installs i WHERE i.id = t.plugin_id AND i.workspace_id = t.workspace_id AND i.removed_at IS NULL AND i.code_hash = t.code_hash)
             AND EXISTS (SELECT 1 FROM plugin_permissions p WHERE p.workspace_id = t.workspace_id AND p.subject = t.plugin_id AND p.capability = 'full-trust' AND p.state = 'allowed' AND instr(p.approved, t.code_hash) > 0))`,
        ).all()
      ).results;
    const on = (who: Actor, id: string) => perform(env.DB, who, { type: "plugin.trust", id, on: true, codeHash: hash }).catch(() => null);
    const crossing = async (what: (id: string) => Promise<unknown>) => {
      const id = await install(ada, [FULL]);
      await grant(ada, id);
      await Promise.all([on(eve, id), on(eve, id), on(eve, id), what(id), on(eve, id), on(eve, id), on(eve, id)]);
      expect(await sound(), "no row without all three").toEqual([]);
      expect(await outcome(pluginOf(eve, id), read)).not.toBe("done");
      return id;
    };
    await crossing((id) => update(ada, id, OTHER));
    await crossing((id) => perform(env.DB, ada, { type: "plugin.permit", id, capability: "full-trust", allowed: false }));
    await crossing((id) => perform(env.DB, ada, { type: "plugin.uninstall", id }));
    const last = await crossing(() => perform(env.DB, ada, { type: "member.remove", memberId: eve.personId }));

    // The statement itself refuses, whatever was read before it: asked for someone who isn't a member, or with the grant gone under it, it keeps nothing.
    const stale = { db: env.DB, workspaceId: ada.workspaceId, personId: eve.personId, now: 1, author: { kind: "member" }, role: "editor" } as never;
    await expect(trustPlugin(stale, { type: "plugin.trust", id: last, on: true, codeHash: hash })).rejects.toMatchObject({ code: "conflict" });
    await env.DB.prepare("UPDATE plugin_permissions SET state = 'off' WHERE subject = ?").bind(last).run();
    await expect(trustPlugin({ db: env.DB, workspaceId: ada.workspaceId, personId: ada.personId, now: 1, author: { kind: "member" }, role: "admin" } as never, { type: "plugin.trust", id: last, on: true, codeHash: hash })).rejects.toMatchObject({ code: "conflict" });
    expect(await rows(ada.workspaceId)).toEqual([]);
  });

  it("is granted by a statement that asks, as it runs, whether the code is still the code named: a grant that crosses an update is of nothing, then and when the old code comes back", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [FULL]);
    const hash = await codeHash(CODE);
    /** A database in which the plugin changes, or goes, between what a decision read and what it writes. */
    const crossedBy = (what: () => Promise<unknown>) => ({ prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => (await what(), env.DB.batch(statements)) }) as unknown as D1Database;
    const asAda = (db: D1Database) => ({ db, workspaceId: ada.workspaceId, personId: ada.personId, now: 1, author: { kind: "member" }, role: "admin" }) as never;
    const allow = { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: hash } as const;
    await expect(permitPlugin(asAda(crossedBy(() => update(ada, id, OTHER))), allow)).rejects.toMatchObject({ code: "conflict" });
    expect(await stateOf(ada, id)).toMatchObject({ grantedHash: null });
    await update(ada, id, CODE);
    expect(await stateOf(ada, id), "the code she named is back, and her crossed grant is still no grant").toMatchObject({ grantedHash: null });
    expect(await outcome(eve, { type: "plugin.trust", id, on: true, codeHash: hash })).toBe(`conflict: ${NOT_GRANTED}`);
    expect(await outcome(pluginOf(eve, id), { type: "note.read", id: shared })).toBe(refused);
    // One that crosses an uninstall leaves no row for a plugin that is gone.
    await expect(permitPlugin(asAda(crossedBy(() => perform(env.DB, ada, { type: "plugin.uninstall", id }))), allow)).rejects.toMatchObject({ code: "conflict" });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_permissions WHERE subject = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
  });

  it("is forgotten for a member who is removed or who leaves, and is not waiting for them if they are added again", async () => {
    const { ada, eve, vera, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    for (const who of [ada, eve, vera]) await turnOn(who, id);
    await perform(env.DB, ada, { type: "member.remove", memberId: eve.personId });
    await perform(env.DB, vera, { type: "member.leave" });
    expect((await rows(ada.workspaceId)).map((row) => row.person_id)).toEqual([ada.personId]);
    expect((await stateOf(ada, id))!.turnedOnBy!.map((who) => who.name)).toEqual(["Ada Lovelace"]);
    for (const gone of [eve, vera]) expect(await outcome(pluginOf(gone, id), { type: "note.read", id: shared })).toMatch(/^not_found: /);
    const email = async (who: Actor) => (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(who.personId).first<{ email: string }>())!.email;
    for (const back of [eve, vera]) {
      await perform(env.DB, ada, { type: "member.invite", email: await email(back), as: "editor" });
      await signIn(env.DB, { email: await email(back), name: "Back Again" });
      expect((await perform(env.DB, back, { type: "note.read", id: shared })).id, "they are a member again").toBe(shared);
      expect((await stateOf(back, id))!.on).toBe(false);
      expect(await outcome(pluginOf(back, id), { type: "note.read", id: shared })).toBe(refused);
    }
    // A removal that is refused forgets nothing: the only admin can't leave, and keeps what she turned on.
    expect(await outcome(ada, { type: "member.leave" })).not.toBe("done");
    expect(await outcome(pluginOf(ada, id), { type: "note.read", id: shared })).toBe("done");
    // A row left for someone who is gone, were there one, counts for nothing and is told to nobody.
    const mallory = await addMember(ada, "editor", "Mallory Gone");
    await turnOn(mallory, id);
    await env.DB.prepare("DELETE FROM members WHERE workspace_id = ? AND person_id = ?").bind(ada.workspaceId, mallory.personId).run();
    expect((await stateOf(ada, id))!.turnedOnBy!.map((who) => who.name)).toEqual(["Ada Lovelace"]);
  });

  it("is one workspace's: a grant and a turning on in one are nothing in another, for the same person and the same code", async () => {
    const { ada, eve } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    await turnOn(eve, id);
    // Eve has a workspace of her own, where she is the admin, with the same code installed.
    const hers: Actor = { kind: "member", personId: eve.personId, workspaceId: (await env.DB.prepare("SELECT workspace_id FROM members WHERE person_id = ? AND workspace_id <> ?").bind(eve.personId, ada.workspaceId).first<{ workspace_id: string }>())!.workspace_id };
    const there = await install(hers, [FULL]);
    expect(await stateOf(hers, there)).toEqual({ grantedHash: null, changedSince: false, on: false, turnedOnBy: [] });
    expect(await outcome(pluginOf(hers, there), { type: "note.list" })).toBe(refused);
    // Ada's plugin isn't there, and hers isn't in Ada's: an admin of one grants nothing in the other.
    expect(await outcome(pluginOf(hers, id), { type: "note.list" })).toBe("forbidden: That plugin isn't installed in this workspace");
    expect(await outcome(hers, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: await codeHash(CODE) })).toBe("not_found: No such plugin");
    expect(await outcome(hers, { type: "plugin.trust", id, on: true, codeHash: await codeHash(CODE) })).toBe("not_found: No such plugin");
    expect(await outcome({ ...eve }, { type: "plugin.permit", id: there, capability: "full-trust", allowed: true, codeHash: await codeHash(CODE) }), "her being an admin elsewhere").toBe("forbidden: A editor can't plugin.permit");
    await grant(hers, there);
    await turnOn(hers, there);
    await perform(env.DB, hers, { type: "plugin.permit", id: there, capability: "full-trust", allowed: false });
    expect(await outcome(pluginOf(eve, id), { type: "note.list" }), "what she decided in her own workspace changed nothing in Ada's").toBe("done");
  });
});

describe("what full trust reaches on the server is what its member reaches, and never what is theirs alone to ask", () => {
  it("acts as the member it runs for: their notes, their role, and nobody else's private note", async () => {
    const { ada, eve, vera, secret, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    for (const who of [ada, eve, vera]) await turnOn(who, id);
    expect((await perform(env.DB, pluginOf(eve, id), { type: "note.read", id: secret })).text).toContain("only-eve-knows");
    for (const other of [vera, ada]) {
      expect(await outcome(pluginOf(other, id), { type: "note.read", id: secret })).toBe("not_found: No such note");
      const said = JSON.stringify([
        await perform(env.DB, pluginOf(other, id), { type: "note.list" }),
        await perform(env.DB, pluginOf(other, id), { type: "search", query: "only-eve-knows" }),
        await perform(env.DB, pluginOf(other, id), { type: "history.list", limit: 100 }),
        await perform(env.DB, pluginOf(other, id), { type: "note.backlinks", id: shared }),
      ]);
      expect(said).not.toContain("secret");
      expect(said).not.toContain(secret);
    }
    // A viewer's can't write, and what it writes for an editor is recorded as the plugin's, for her.
    expect(await outcome(pluginOf(vera, id), { type: "note.write", id: shared, baseRevision: 1, text: "# Mine now" })).toBe("forbidden: A viewer can't note.write");
    const wrote = await perform(env.DB, pluginOf(eve, id), { type: "note.write", id: shared, baseRevision: 1, text: "# Roadmap\n\nby the plugin" });
    expect(wrote.updatedBy).toMatchObject({ kind: "plugin", pluginId: id, name: "Deep Keys", onBehalfOf: eve.personId });
  });

  it("is refused, at the plugin's address, everything that is a member's alone, in an admin's session as in anyone's", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    for (const who of [ada, eve]) await turnOn(who, id);
    const hash = await codeHash(CODE);
    const kept: OpInput[] = [
      { type: "plugin.install", manifest: manifest([FULL], "Another"), code: OTHER },
      { type: "plugin.install", manifest: manifest([FULL]), code: OTHER, replaces: id },
      { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: hash },
      { type: "plugin.permit", id, capability: "full-trust", allowed: false },
      { type: "plugin.uninstall", id },
      { type: "member.invite", email: "mallory@example.com", as: "admin" },
      { type: "member.setRole", memberId: eve.personId, as: "admin" },
      { type: "member.remove", memberId: eve.personId },
      { type: "invite.list" },
      { type: "grant.link", noteId: shared, link: "public" },
      { type: "grant.set", noteId: shared, email: "mallory@example.com", access: "edit" },
      { type: "plugin.trust", id, on: true, codeHash: hash },
      { type: "plugin.trust", id, on: false },
      { type: "plugin.read", id },
      { type: "plugin.request", id, capability: "full-trust" },
      { type: "settings.read" },
      { type: "settings.write", text: "{}", baseRevision: 0 },
      { type: "draft.list" },
      { type: "draft.save", id, manifest: manifest([]), code: OTHER, running: true },
      { type: "note.setPrivate", id: shared, private: true },
    ] as OpInput[];
    for (const who of [ada, eve]) {
      for (const op of kept) expect(await outcome(pluginOf(who, id), op), `${op.type} as the plugin`).toBe(`forbidden: Deep Keys isn't permitted to ${op.type}`);
    }
    // Asked in a non-admin's own name, as code in her page could with her session, an admin's work is refused by her role.
    for (const op of kept.slice(0, 9)) expect(await outcome(eve, op), `${op.type} as an editor`).toBe(`forbidden: A editor can't ${op.type}`);
    expect((await perform(env.DB, ada, { type: "member.list" })).map((m) => [m.name, m.role]).sort()).toEqual([
      ["Ada Lovelace", "admin"],
      ["Eve Editor", "editor"],
      ["Vera Viewer", "viewer"],
    ]);
    expect((await perform(env.DB, ada, { type: "plugin.read", id })).code).toBe(CODE);
  });

  it("tells an agent of any kind, and a plugin, nothing of it: not that it is asked for, whether it was granted, or who has it on", async () => {
    const { ada, eve } = await team();
    const id = await install(ada, [FULL, READ]);
    const tame = await install(ada, [READ]);
    await grant(ada, id);
    await grant(ada, id, "notes.read");
    await grant(ada, tame, "notes.read");
    await turnOn(eve, id);
    await perform(env.DB, eve, { type: "plugin.request", id: tame, capability: "notes.read" });
    for (const member of [ada, eve]) {
      for (const [kind, { actor, agent }] of Object.entries(await agentsOf(member))) {
        if (kind.includes("limited")) {
          expect(await outcome(actor, { type: "plugin.list" }), kind).toBe("forbidden: An agent limited to folders can't plugin.list");
        } else {
          const listed = (await perform(env.DB, actor, { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
          expect(listed.manifest.capabilities.map((c) => c.name), kind).toEqual(["notes.read"]);
          expect(listed.fullTrust).toBeNull();
          expect(listed.permissions.map((p) => p.capability)).toEqual(["notes.read"]);
        }
        const said: string[] = [];
        for (const tool of TOOLS) {
          const result = await callTool(env.DB, agent, tool.name, {}).catch(() => null);
          if (result) said.push(result.content[0]!.text);
        }
        expect(said.join("\n").replaceAll('"fullTrust": null', ""), kind).not.toMatch(/full-trust|fullTrust|turnedOnBy|grantedHash/);
      }
    }
    // The full-trust plugin itself, running for Eve, reads the record as a plugin does.
    const asPlugin = (await perform(env.DB, pluginOf(eve, id), { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
    expect(asPlugin.fullTrust).toBeNull();
    expect(asPlugin.permissions.map((p) => p.capability)).toEqual(["notes.read"]);
    expect(JSON.stringify(asPlugin)).not.toMatch(/full-trust|Eve Editor/);
    // A member who isn't an admin is told of themself and of nobody else.
    await turnOn(ada, id);
    expect(JSON.stringify(await stateOf(eve, id))).not.toContain("Ada");
  });

  it("is refused a guest, who runs no plugin of a workspace's", async () => {
    const { ada, gus, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    expect(await outcome(pluginOf(gus, id), { type: "note.read", id: shared })).toMatch(/^forbidden: A guest runs no plugins/);
    await env.DB.prepare("INSERT INTO plugin_trust (workspace_id, plugin_id, person_id, code_hash, at) VALUES (?, ?, ?, ?, 0)").bind(ada.workspaceId, id, gus.personId, await codeHash(CODE)).run();
    expect(await outcome(pluginOf(gus, id), { type: "note.read", id: shared }), "even with a row").toMatch(/^forbidden: A guest runs no plugins/);
    expect(await outcome(gus, { type: "plugin.list" })).toBe("forbidden: A guest can't plugin.list");
  });
});

describe("a draft and full trust", () => {
  it("never gains full trust by being edited: not of a plugin that has it, and not of one that doesn't, even were it marked as running", async () => {
    const { ada, eve, shared } = await team();
    const tame = await install(ada, [READ]);
    await grant(ada, tame, "notes.read");
    const asks = manifest([READ, FULL]);
    expect(await outcome(eve, { type: "draft.save", id: tame, manifest: asks, code: "draft", running: true })).toBe(`invalid: ${DRAFT_ASKS_FULL_TRUST}`);
    // Kept, since it is only text, and never run: neither shut off with the rest of what it asks, nor in the page.
    await perform(env.DB, eve, { type: "draft.save", id: tame, manifest: asks, code: "draft", running: false });
    await env.DB.prepare("UPDATE plugin_drafts SET running = 1 WHERE plugin_id = ?").bind(tame).run();
    expect(await outcome(pluginOf(eve, tame, true), { type: "note.read", id: shared })).toBe(`forbidden: ${DRAFT_ASKS_FULL_TRUST}`);
    expect(await outcome(eve, { type: "plugin.trust", id: tame, on: true, codeHash: await codeHash("draft") })).toMatch(/^invalid: /);

    const deep = await install(ada, [FULL, READ]);
    await grant(ada, deep);
    await grant(ada, deep, "notes.read");
    await turnOn(eve, deep);
    await perform(env.DB, eve, { type: "draft.save", id: deep, manifest: manifest([FULL, READ]), code: OTHER, running: false });
    await env.DB.prepare("UPDATE plugin_drafts SET running = 1 WHERE plugin_id = ?").bind(deep).run();
    expect(await outcome(pluginOf(eve, deep, true), { type: "note.read", id: shared })).toBe(`forbidden: ${DRAFT_ASKS_FULL_TRUST}`);
    // Her turning it on was for the code an admin granted: one for her draft's code is refused.
    expect(await outcome(eve, { type: "plugin.trust", id: deep, on: true, codeHash: await codeHash(OTHER) })).toMatch(/^conflict: /);
    // A draft of it that doesn't ask runs shut off, with what the original is allowed that isn't full trust, and as no more than a plugin.
    await perform(env.DB, eve, { type: "draft.save", id: deep, manifest: manifest([READ]), code: OTHER, running: true });
    expect(await outcome(pluginOf(eve, deep, true), { type: "note.read", id: shared })).toBe("done");
    expect(await outcome(pluginOf(eve, deep, true), { type: "note.write", id: shared, baseRevision: 1, text: "# Taken" })).toBe("forbidden: Deep Keys isn't permitted to note.write");
    expect(await outcome(pluginOf(eve, deep, true), { type: "history.list", limit: 1 })).toBe("forbidden: Deep Keys isn't permitted to history.list");
  });
});

describe("no plugin of a workspace's passes as one that comes with Common Ink", () => {
  it("can't take a name or an id of the app's own, and none of the app's own asks for full trust", async () => {
    const { ada } = await team();
    for (const id of OWN_SANDBOXED_IDS) {
      const { name, ...rest } = OWN_SANDBOXED[id];
      expect(Manifest.safeParse({ ...rest, name }).success, `${name} is a name of the app's own`).toBe(false);
      expect(rest.capabilities.map((c) => c.name)).not.toContain("full-trust");
      expect(await outcome(ada, { type: "plugin.install", manifest: manifest([FULL]), code: CODE, replaces: id as never })).toMatch(/^invalid: /);
      expect(await outcome(ada, { type: "plugin.trust", id: id as never, on: true, codeHash: await codeHash(CODE) })).toMatch(/^invalid: /);
    }
    for (const name of ["Tabs and splits", "Word count", "Wоrd count", "Backlinks"]) expect(await outcome(ada, { type: "plugin.install", manifest: manifest([FULL], name), code: CODE }), name).toMatch(/^invalid: /);
  });
});

describe("over HTTP", () => {
  const SECRET = "a-secret-for-tests";
  const send = async (headers: Record<string, string>, workspaceId: string, path: string, op: OpInput) => {
    const res = await worker.fetch(new Request(`https://ink.test/api/workspaces/${workspaceId}${path}`, { method: "POST", headers: { Origin: "https://ink.test", "Content-Type": "application/json", ...headers }, body: JSON.stringify(op) }) as never, { ...env, SESSION_SECRET: SECRET });
    return { status: res.status, body: (await res.json()) as { message?: string; id?: string; plugins?: { id: string; fullTrust: unknown }[] } };
  };
  const post = async (member: Actor, path: string, op: OpInput) => send({ Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ personId: member.personId }, SECRET, 3600))}` }, member.workspaceId, path, op);

  it("the plugin's address answers for the session's person and the code that is granted now, and stops the moment the code changes", async () => {
    const { ada, eve, vera, secret, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    const hash = await codeHash(CODE);
    const read: OpInput = { type: "note.read", id: shared };
    expect((await post(eve, `/plugins/${id}/ops`, read)).status, "granted, not turned on").toBe(403);
    // A body that names someone else turns it on for the session's person and nobody besides.
    expect((await post(vera, "/ops", { type: "plugin.trust", id, on: true, codeHash: hash, personId: eve.personId } as never)).status).toBe(200);
    expect((await post(eve, `/plugins/${id}/ops`, read)).status).toBe(403);
    expect((await post(vera, `/plugins/${id}/ops`, read)).status).toBe(200);
    expect((await post(eve, "/ops", { type: "plugin.trust", id, on: true, codeHash: hash })).status).toBe(200);
    expect((await post(eve, `/plugins/${id}/ops`, { type: "note.read", id: secret })).status).toBe(200);
    expect(await post(vera, `/plugins/${id}/ops`, { type: "note.read", id: secret })).toEqual({ status: 404, body: { error: "not_found", message: "No such note" } });
    // Neither address is a way to turn it on, grant it, or change the code: not the plugin's, and not a draft's.
    for (const path of [`/plugins/${id}/ops`, `/plugins/${id}/draft/ops`]) {
      for (const op of [{ type: "plugin.trust", id, on: true, codeHash: hash }, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: hash }, { type: "plugin.install", manifest: manifest([FULL]), code: OTHER, replaces: id }, { type: "member.invite", email: "m@example.com", as: "admin" }] as OpInput[]) {
        expect((await post(ada, path, op)).status, `${path} ${op.type}`).toBe(403);
      }
    }
    // An agent's token opens neither address, and the ops address not at all.
    const { token } = await connectAgent(env.DB, eve.personId, "Claude");
    for (const path of ["/ops", `/plugins/${id}/ops`, `/plugins/${id}/draft/ops`]) expect((await send({ Authorization: `Bearer ${token}` }, eve.workspaceId, path, { type: "plugin.trust", id, on: true, codeHash: hash })).status, path).toBe(401);

    await update(ada, id, OTHER);
    expect(await post(eve, `/plugins/${id}/ops`, read), "the old code's address, at once").toEqual({ status: 403, body: { error: "forbidden", message: fullTrustOff("Deep Keys") } });
    expect((await post(vera, `/plugins/${id}/ops`, read)).status).toBe(403);
  });

  it("an admin's own session is an admin, which is what code in her page has: said here so that it is known, not hidden", async () => {
    const { ada, eve, shared } = await team();
    const id = await install(ada, [FULL]);
    await grant(ada, id);
    await turnOn(ada, id);
    await turnOn(eve, id);
    // The plugin's own address refuses each of these in her session. The same requests sent as her, which code running in her page can do, are hers.
    expect((await post(ada, "/ops", { type: "member.invite", email: "mallory@example.com", as: "admin" })).status).toBe(200);
    expect((await post(ada, "/ops", { type: "member.setRole", memberId: eve.personId, as: "admin" })).status).toBe(200);
    expect((await post(ada, "/ops", { type: "plugin.install", manifest: manifest([FULL]), code: OTHER, replaces: id })).status).toBe(200);
    expect((await post(ada, "/ops", { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash: await codeHash(OTHER) })).status, "approving a new version of itself").toBe(200);
    expect((await post(ada, "/ops", { type: "plugin.trust", id, on: true, codeHash: await codeHash(OTHER) })).status, "and turning it on for her, and only her").toBe(200);
    expect((await stateOf(ada, id))!.turnedOnBy!.map((who) => who.name)).toEqual(["Ada Lovelace"]);
    // In anyone's session: a link to a note of theirs, which outlasts the plugin.
    expect((await post(ada, "/ops", { type: "grant.link", noteId: shared, link: "public" })).status).toBe(200);
    await perform(env.DB, ada, { type: "plugin.uninstall", id });
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: shared })).grants.some((g) => g.to.kind === "link"), "the link is still there").toBe(true);
  });
});
