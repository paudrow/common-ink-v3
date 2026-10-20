import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { FRAME_SECONDS, MAX_PLUGINS, redeemFrame } from "../../src/core/pluginRecord.ts";
import { CAPABILITY_NAMES, approvalOf, codeHash, nameSkeleton, opsAllowedBy, type Capability, type DeclaredCapability, type PluginRecord } from "../../src/core/plugins.ts";
import type { OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";
import { upload } from "./uploading.ts";

const READ = { name: "notes.read", reason: "Counts the words in your notes." } as const;
const WRITE = { name: "notes.write", reason: "Writes the count into a note." } as const;
const NETWORK: DeclaredCapability = { name: "network", reason: "Looks words up.", origins: ["https://api.example.com"] };
const TODOS = { name: "todos.read", reason: "Counts your todos." } as const;
const MEMBERS = { name: "members.read", reason: "Says who wrote the most." } as const;
const manifest = (capabilities: readonly object[] = [READ, WRITE, NETWORK], more: object = {}) => JSON.stringify({ name: "Word Tally", capabilities, ...more });
const CODE = "ink.notify('counted')";

const install = async (admin: Actor, capabilities?: readonly object[]) => (await perform(env.DB, admin, { type: "plugin.install", manifest: manifest(capabilities), code: CODE })).id;
const hashOf = async (admin: Actor, id: string) => (id === "html" ? undefined : ((await perform(env.DB, admin, { type: "plugin.list" })).plugins.find((p) => p.id === id)?.codeHash ?? undefined));
const permit = async (admin: Actor, id: string, capability: Capability, more: { allowed?: boolean; locked?: boolean; origins?: string[] } = {}) =>
  perform(env.DB, admin, { type: "plugin.permit", id, capability, allowed: true, ...(more.allowed !== false && { codeHash: await hashOf(admin, id) }), ...more });
/** The plugin `pluginId`, running in `member`'s browser. */
const pluginOf = (member: Actor, pluginId: string): Actor => ({ kind: "plugin", pluginId, personId: member.personId, workspaceId: member.workspaceId });
const permissionOf = (record: PluginRecord, id: string, capability: Capability) => record.plugins.find((p) => p.id === id)!.permissions.find((c) => c.capability === capability)!;
const told = async (asker: Actor, id: string, capability: Capability) => {
  const { state, locked, voided, decidedBy, requests } = permissionOf(await perform(env.DB, asker, { type: "plugin.list" }), id, capability);
  return { state, locked, voided, decidedBy, requests: requests.map((r) => r.by.name) };
};
const OFF = { state: "off", locked: false, voided: false, decidedBy: null, requests: [] };
const ALLOWED = { state: "allowed", locked: false, voided: false, decidedBy: "Ada Lovelace", requests: [] };

const address = () => `${crypto.randomUUID()}@example.com`;
async function guestOf(admin: Actor, noteId: string): Promise<Actor> {
  const email = address();
  await perform(env.DB, admin, { type: "grant.set", noteId, email, access: "edit" });
  return { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: admin.workspaceId };
}

const ID = "aaaaaaaaaaaa";
/** Every plugin.* operation, with arguments the core accepts of `id`. */
const pluginOps = (id: string): OpInput[] => [
  { type: "plugin.list" },
  { type: "plugin.read", id },
  { type: "plugin.install", manifest: manifest(), code: CODE },
  { type: "plugin.install", manifest: manifest(), code: CODE, replaces: id },
  { type: "plugin.uninstall", id },
  { type: "plugin.permit", id, capability: "notes.read", allowed: true },
  { type: "plugin.request", id, capability: "notes.read" },
  { type: "plugin.frame", id },
];
const outcome = async (actor: Actor, op: OpInput): Promise<string> => {
  try {
    await perform(env.DB, actor, op);
    return "done";
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
};

describe("the record of a workspace's plugins", () => {
  it("a plugin performs nothing until an admin installs it", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    await perform(env.DB, ada, { type: "note.create", text: "# Plan" });

    // Nobody but an admin installs.
    for (const member of [grace, vera]) await expect(perform(env.DB, member, { type: "plugin.install", manifest: manifest(), code: CODE })).rejects.toMatchObject({ code: "forbidden" });
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.map((p) => p.id)).toEqual(["html"]);
    // An id nobody was given performs nothing, for an admin either.
    for (const member of [ada, grace]) await expect(perform(env.DB, pluginOf(member, ID), { type: "note.list" })).rejects.toMatchObject({ code: "forbidden", message: "That plugin isn't installed in this workspace" });

    // Installing permits nothing.
    const id = await install(ada);
    for (const op of [{ type: "note.list" }, { type: "note.create", text: "# Made" }, { type: "search", query: "plan" }, { type: "folder.list" }] satisfies OpInput[]) {
      await expect(perform(env.DB, pluginOf(ada, id), op)).rejects.toMatchObject({ code: "forbidden", message: `Word Tally isn't permitted to ${op.type}` });
    }
    await permit(ada, id, "notes.read");
    expect((await perform(env.DB, pluginOf(ada, id), { type: "note.list" })).map((n) => n.title)).toEqual(["Plan"]);
    // And only what that permission names.
    await expect(perform(env.DB, pluginOf(ada, id), { type: "note.create", text: "# Made" })).rejects.toMatchObject({ code: "forbidden", message: "Word Tally isn't permitted to note.create" });
  });

  it("refuses a name that is Common Ink's own or reads as one, whatever letters it is written in", async () => {
    const ada = await newMember();
    const named = (name: string) => outcome(ada, { type: "plugin.install", manifest: JSON.stringify({ name }), code: CODE });
    // The first is written with a Cyrillic С and о, the fourth with Greek capitals, the fifth in full-width letters.
    for (const name of ["Сommоn Ink", "common-ink tools", "HISTORY", "ΗΙSΤΟRΥ", "Ｐｌｕｇｉｎｓ", "Hist0ry", "Plug1ns", "Sеttings", "Tabs  and  splits", "Dashbóard"]) expect(await named(name), name).toMatch(/^invalid: .*a plugin can't have a name that is Common Ink's own, or that reads as one/s);
    expect(nameSkeleton("Сommоn Ink")).toBe("commonink");
    for (const name of ["Historian", "My history", "Ink well", "Счётчик"]) expect(await named(name), name).toBe("done");
  });

  it("refuses what isn't a manifest, and holds only so many plugins", async () => {
    const ada = await newMember();
    const refused = (text: string) => expect(perform(env.DB, ada, { type: "plugin.install", manifest: text, code: CODE })).rejects.toMatchObject({ code: "invalid" });
    await refused("not json");
    await refused(JSON.stringify({ name: "X", capabilities: [{ name: "notes.read" }] }));
    await refused(JSON.stringify({ name: "X", capabilities: [{ name: "everything", reason: "Why not" }] }));
    await refused(manifest([{ name: "network", reason: "No sites" }]));
    await refused(manifest([{ ...NETWORK, origins: ["https://api.example.com/path"] }]));
    await refused(manifest([{ ...NETWORK, origins: ["https://*.example.com"] }]));
    await refused(manifest([{ ...NETWORK, origins: ["https://a.example.com; script-src *"] }]));
    await refused(manifest([READ], { identity: "html" }));
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.map((p) => p.id)).toEqual(["html"]);

    for (let i = 0; i < MAX_PLUGINS; i++) await install(ada, []);
    await expect(perform(env.DB, ada, { type: "plugin.install", manifest: manifest(), code: CODE })).rejects.toMatchObject({ code: "invalid", message: `A workspace holds at most ${MAX_PLUGINS} plugins. Uninstall one first.` });
  });

  it("plugin.list shows each capability with its reason, to every member", async () => {
    const ada = await newMember();
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const id = await install(ada);
    const hash = await codeHash(CODE);
    const off = { state: "off", locked: false, decidedBy: null, decidedVia: null, voided: false, requests: [] };

    const record = await perform(env.DB, vera, { type: "plugin.list" });
    expect(record).toEqual({
      canManage: false,
      plugins: [
        {
          id,
          thirdParty: true,
          manifest: { name: "Word Tally", version: "1", capabilities: [READ, WRITE, NETWORK], commands: [], views: [], embeds: [], settings: {} },
          codeHash: hash,
          fullTrust: null,
          installedBy: "Ada Lovelace",
          installedVia: null,
          installedAt: expect.any(Number),
          updatedBy: null,
          updatedVia: null,
          updatedAt: expect.any(Number),
          permissions: [
            { capability: "notes.read", reason: READ.reason, origins: [], ...off },
            { capability: "notes.write", reason: WRITE.reason, origins: [], ...off },
            { capability: "network", reason: NETWORK.reason, origins: ["https://api.example.com"], ...off },
          ],
        },
        {
          id: "html",
          thirdParty: false,
          manifest: { name: "HTML embeds", version: "1", capabilities: [], commands: [], views: [], embeds: [], settings: {} },
          codeHash: null,
          fullTrust: null,
          installedBy: null,
          installedVia: null,
          installedAt: null,
          updatedBy: null,
          updatedVia: null,
          updatedAt: null,
          permissions: [{ capability: "network", reason: expect.stringContaining("HTML written in a note"), origins: [], ...off }],
        },
      ],
    });
    expect(await perform(env.DB, ada, { type: "plugin.list" })).toEqual({ ...record, canManage: true });
    // The code is read apart from the record, by a member, and is what was installed.
    expect(await perform(env.DB, vera, { type: "plugin.read", id })).toEqual({ id, code: CODE, codeHash: hash });
    await expect(perform(env.DB, vera, { type: "plugin.read", id: ID })).rejects.toMatchObject({ code: "not_found", message: "No such plugin" });
  });

  it("an admin's permit applies to every member's plugin actor and can be locked", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const id = await install(ada);

    // Only an admin decides.
    for (const member of [grace, vera]) await expect(permit(member, id, "notes.read")).rejects.toMatchObject({ code: "forbidden" });
    expect(await told(ada, id, "notes.read")).toEqual(OFF);

    await permit(ada, id, "notes.read");
    await permit(ada, id, "notes.write");
    expect(await told(vera, id, "notes.read")).toEqual(ALLOWED);
    for (const member of [ada, grace, vera]) expect(await outcome(pluginOf(member, id), { type: "note.list" })).toBe("done");
    // What the workspace permits a plugin is no more than its member may do: a viewer's writes nothing.
    expect(await outcome(pluginOf(grace, id), { type: "note.create", text: "# Made" })).toBe("done");
    expect(await outcome(pluginOf(vera, id), { type: "note.create", text: "# Made" })).toBe("forbidden: A viewer can't note.create");

    // Locked, it takes no requests and stays as it is until an admin unlocks it.
    await permit(ada, id, "notes.read", { locked: true });
    expect(await told(grace, id, "notes.read")).toEqual({ ...ALLOWED, locked: true });
    await expect(perform(env.DB, grace, { type: "plugin.request", id, capability: "notes.read" })).rejects.toMatchObject({ code: "conflict" });
    await expect(permit(ada, id, "notes.read", { allowed: false })).rejects.toMatchObject({ code: "conflict", message: "This permission is locked. Unlock it first." });
    await expect(permit(ada, id, "notes.read", { allowed: false, locked: true })).rejects.toMatchObject({ code: "conflict" });
    // Deciding it the way it already is changes nothing, so nothing is refused.
    await permit(ada, id, "notes.read");
    expect(await told(grace, id, "notes.read")).toEqual({ ...ALLOWED, locked: true });
    await permit(ada, id, "notes.read", { allowed: false, locked: false });
    expect(await told(grace, id, "notes.read")).toEqual({ ...OFF, decidedBy: "Ada Lovelace" });
    expect(await outcome(pluginOf(grace, id), { type: "note.list" })).toBe("forbidden: Word Tally isn't permitted to note.list");

    // Locked off, the same: no request, and no allowing it without unlocking.
    await permit(ada, id, "notes.read", { allowed: false, locked: true });
    await expect(perform(env.DB, vera, { type: "plugin.request", id, capability: "notes.read" })).rejects.toMatchObject({ code: "conflict", message: "An admin locked this permission, so it takes no requests" });
    await expect(permit(ada, id, "notes.read")).rejects.toMatchObject({ code: "conflict" });
    expect(await told(grace, id, "notes.read")).toEqual({ ...OFF, decidedBy: "Ada Lovelace", locked: true });
    await permit(ada, id, "notes.read", { locked: false });
    expect(await told(grace, id, "notes.read")).toEqual(ALLOWED);
  });

  it("a non-admin's request allows nothing until an admin permits, and a denial clears it", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const id = await install(ada);
    const request = (by: Actor, capability: Capability, more: object = {}) => perform(env.DB, by, { type: "plugin.request", id, capability, ...more });

    const asked = await request(grace, "notes.read", {});
    expect(permissionOf(asked, id, "notes.read")).toMatchObject({ state: "off", requests: [{ by: { id: grace.personId, name: "Grace Hopper" }, at: expect.any(Number), origins: [] }] });
    expect(await outcome(pluginOf(grace, id), { type: "note.list" })).toBe("forbidden: Word Tally isn't permitted to note.list");
    // Asked again it is the one request, and a viewer's waits behind it.
    await request(grace, "notes.read");
    await perform(env.DB, vera, { type: "plugin.request", id, capability: "notes.read" }, Date.now() + 1000);
    expect(await told(ada, id, "notes.read")).toEqual({ ...OFF, requests: ["Grace Hopper", "Vera Viewer"] });

    await expect(request(ada, "notes.read")).rejects.toMatchObject({ code: "invalid", message: "An admin decides it: plugin.permit" });
    await expect(request(grace, "todos.read")).rejects.toMatchObject({ code: "invalid", message: "Word Tally doesn't ask for todos.read" });
    await expect(request(grace, "network", { origins: ["https://evil.example.com"] })).rejects.toMatchObject({ code: "invalid" });
    await expect(perform(env.DB, grace, { type: "plugin.request", id: ID, capability: "notes.read" })).rejects.toMatchObject({ code: "not_found" });

    // The admin's yes answers every request for it.
    await permit(ada, id, "notes.read");
    expect(await told(grace, id, "notes.read")).toEqual(ALLOWED);
    expect(await outcome(pluginOf(vera, id), { type: "note.list" })).toBe("done");
    // Asking for what is already allowed is nothing to wait on.
    await request(grace, "notes.read");
    expect(await told(ada, id, "notes.read")).toEqual(ALLOWED);

    // And the admin's no clears them too, and allows nothing.
    await request(grace, "notes.write");
    expect((await told(ada, id, "notes.write")).requests).toEqual(["Grace Hopper"]);
    await permit(ada, id, "notes.write", { allowed: false });
    expect(await told(grace, id, "notes.write")).toEqual({ ...OFF, decidedBy: "Ada Lovelace" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_requests WHERE workspace_id = ?").bind(ada.workspaceId).first()).toEqual({ n: 0 });

    // Someone taken out of the workspace is waiting on nothing.
    await request(grace, "notes.write");
    await perform(env.DB, ada, { type: "member.remove", memberId: grace.personId });
    expect((await told(ada, id, "notes.write")).requests).toEqual([]);
  });

  it("new code voids all approvals, a changed reason or origins voids that one", async () => {
    const ada = await newMember();
    const id = await install(ada);
    const replace = (capabilities: readonly object[], code: string) => perform(env.DB, ada, { type: "plugin.install", manifest: manifest(capabilities), code, replaces: id });
    const states = async () => {
      const { permissions } = (await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
      return Object.fromEntries(permissions.map((p) => [p.capability, p.voided ? "voided" : p.state]));
    };
    const permitAll = async () => {
      for (const capability of ["notes.read", "notes.write", "network"] as const) await permit(ada, id, capability);
    };
    await permitAll();
    expect(await states()).toEqual({ "notes.read": "allowed", "notes.write": "allowed", network: "allowed" });

    // The same manifest with other code: the id is kept, and nothing that was allowed still is.
    const replaced = await replace([READ, WRITE, NETWORK], `${CODE};fetch('https://api.example.com')`);
    expect(replaced.id).toBe(id);
    expect(replaced.plugins.filter((p) => p.thirdParty).map((p) => p.id)).toEqual([id]);
    expect(await states()).toEqual({ "notes.read": "voided", "notes.write": "voided", network: "voided" });
    expect(await told(ada, id, "notes.read")).toEqual({ ...OFF, voided: true });
    expect(await outcome(pluginOf(ada, id), { type: "note.list" })).toBe("forbidden: Word Tally isn't permitted to note.list");
    expect(await perform(env.DB, ada, { type: "plugin.frame", id })).toEqual({ token: null, origins: [] });

    // Allowed again as it now is. Then the same code, with one reason and the sites declared another way.
    await permitAll();
    const code = `${CODE};fetch('https://api.example.com')`;
    await replace([READ, { ...WRITE, reason: "Rewrites every note." }, { ...NETWORK, origins: ["https://api.example.com", "https://other.example.com"] }], code);
    expect(await states()).toEqual({ "notes.read": "allowed", "notes.write": "voided", network: "voided" });
    expect(await outcome(pluginOf(ada, id), { type: "note.list" })).toBe("done");
    expect(await outcome(pluginOf(ada, id), { type: "note.create", text: "# Made" })).toBe("forbidden: Word Tally isn't permitted to note.create");
    expect(await perform(env.DB, ada, { type: "plugin.frame", id })).toEqual({ token: null, origins: [] });

    // A capability it stops declaring is no longer its, whatever was allowed.
    await replace([WRITE], code);
    expect(await states()).toEqual({ "notes.write": "allowed" });
    expect(await outcome(pluginOf(ada, id), { type: "note.list" })).toBe("forbidden: Word Tally isn't permitted to note.list");

    // An approval is of one declaration and one code, and of nothing else.
    expect(approvalOf(READ, "a")).not.toBe(approvalOf(READ, "b"));
    expect(approvalOf(READ, "a")).not.toBe(approvalOf({ ...READ, reason: "Another" }, "a"));
    expect(approvalOf(NETWORK, "a")).not.toBe(approvalOf({ ...NETWORK, origins: ["https://other.example.com"] }, "a"));
    await expect(perform(env.DB, ada, { type: "plugin.install", manifest: manifest(), code: CODE, replaces: ID })).rejects.toMatchObject({ code: "not_found", message: "No such plugin" });
  });

  it("refuses to allow code other than the code the admin read", async () => {
    const ada = await newMember();
    const id = await install(ada);
    expect(await outcome(ada, { type: "plugin.permit", id, capability: "notes.read", allowed: true })).toBe("invalid: Say which code you are allowing: codeHash, as plugin.list answers it for the plugin");
    expect(await told(ada, id, "notes.read")).toEqual(OFF);
    const read = (await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.codeHash!;
    await perform(env.DB, ada, { type: "plugin.install", manifest: manifest(), code: `${CODE};more()`, replaces: id });
    expect(await outcome(ada, { type: "plugin.permit", id, capability: "notes.read", allowed: true, codeHash: read })).toBe("conflict: This plugin has been replaced since you read it. Look at it again before deciding.");
    expect(await told(ada, id, "notes.read")).toEqual(OFF);
    const now = (await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.codeHash!;
    await perform(env.DB, ada, { type: "plugin.permit", id, capability: "notes.read", allowed: true, codeHash: now });
    expect(await told(ada, id, "notes.read")).toEqual(ALLOWED);
  });

  it("uninstall refuses at once and deletes permissions and requests, and History still names the plugin", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const id = await install(ada);
    await permit(ada, id, "notes.read");
    await permit(ada, id, "notes.write");
    await perform(env.DB, grace, { type: "plugin.request", id, capability: "network" });
    const note = await perform(env.DB, pluginOf(grace, id), { type: "note.create", text: "# Counted\n\n12 words" });

    for (const member of [grace]) await expect(perform(env.DB, member, { type: "plugin.uninstall", id })).rejects.toMatchObject({ code: "forbidden" });
    const record = await perform(env.DB, ada, { type: "plugin.uninstall", id });
    expect(record.plugins.map((p) => p.id)).toEqual(["html"]);
    for (const member of [ada, grace]) {
      for (const op of [{ type: "note.list" }, { type: "note.read", id: note.id }, { type: "note.write", id: note.id, baseRevision: 1, text: "# Gone" }] satisfies OpInput[]) {
        expect(await outcome(pluginOf(member, id), op)).toBe("forbidden: That plugin isn't installed in this workspace");
      }
    }
    for (const table of ["plugin_permissions", "plugin_requests"]) expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE subject = ?`).bind(id).first(), table).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT code, removed_at IS NOT NULL AS removed FROM plugin_installs WHERE id = ?").bind(id).first()).toEqual({ code: "", removed: 1 });

    // What it wrote is still its, by name.
    const plugin = { kind: "plugin", pluginId: id, name: "Word Tally", onBehalfOf: grace.personId };
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).map((c) => c.author)).toEqual([plugin]);
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).updatedBy).toEqual(plugin);

    // Nothing of it can be read, decided or asked for, and installing over it is installing nothing.
    await expect(perform(env.DB, ada, { type: "plugin.read", id })).rejects.toMatchObject({ code: "not_found" });
    await expect(permit(ada, id, "notes.read")).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, grace, { type: "plugin.request", id, capability: "notes.read" })).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, ada, { type: "plugin.frame", id })).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, ada, { type: "plugin.install", manifest: manifest(), code: CODE, replaces: id })).rejects.toMatchObject({ code: "not_found" });
    // Uninstalled twice, it is as uninstalled as once. One that never was is not found.
    expect((await perform(env.DB, ada, { type: "plugin.uninstall", id })).plugins.map((p) => p.id)).toEqual(["html"]);
    await expect(perform(env.DB, ada, { type: "plugin.uninstall", id: ID })).rejects.toMatchObject({ code: "not_found", message: "No such plugin" });

    // Installed again it is another plugin, with nothing allowed.
    const again = await install(ada);
    expect(again).not.toBe(id);
    expect(await told(ada, again, "notes.read")).toEqual(OFF);
  });

  it("an admin's agent does what its admin does with plugins, but for a frame, which runs in a browser", async () => {
    const ada = await newMember();
    const id = await install(ada);
    const agent: Actor = { kind: "agent", agentId: (await connectAgent(env.DB, ada.personId, "Claude")).agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    const got: Record<string, string> = {};
    for (const op of pluginOps(id)) got[`${op.type}${"replaces" in op ? " replaces" : ""}`] = await outcome(agent, op);
    // In order. Installing, updating, uninstalling and permitting each wait for an admin to approve them, so the plugin is still there to permit; an admin decides rather than asks.
    expect(got).toEqual({
      "plugin.list": "done",
      "plugin.read": "done",
      "plugin.install": "done",
      "plugin.install replaces": "done",
      "plugin.uninstall": "done",
      "plugin.permit": "invalid: Say which code you are allowing: codeHash, as plugin.list answers it for the plugin",
      "plugin.request": "invalid: An admin decides it: plugin.permit",
      "plugin.frame": "forbidden: An agent can't plugin.frame",
    });
    const record = await perform(env.DB, agent, { type: "plugin.list" });
    expect(record.canManage).toBe(true);
    // What it asked is waiting: the one plugin is still Ada's own, and the agent's install is not there yet.
    expect(record.plugins.map((p) => [p.manifest.name, p.installedBy, p.installedVia])).toEqual([
      ["Word Tally", "Ada Lovelace", null],
      ["HTML embeds", null, null],
    ]);
  });

  it("a guest is refused", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Shared" });
    const id = await install(ada);
    await permit(ada, id, "notes.read");
    const gus = await guestOf(ada, note.id);
    expect((await perform(env.DB, gus, { type: "note.read", id: note.id })).title).toBe("Shared");

    const got = new Set<string>();
    for (const op of [...pluginOps(id), { type: "plugin.frame", id: "html" }, { type: "plugin.request", id: "html", capability: "network", origins: ["https://api.example.com"] }] satisfies OpInput[]) got.add((await outcome(gus, op)).replace(op.type, "it"));
    expect([...got]).toEqual(["forbidden: A guest can't it"]);
    // Nor does a plugin run for one: a guest is told nothing of the workspace's plugins, so none is theirs to run.
    expect(await outcome(pluginOf(gus, id), { type: "note.read", id: note.id })).toBe("forbidden: A guest runs no plugins: they are for the workspace's members");
    // The same whatever the id, so a guest learns nothing of which plugins there are.
    expect(await outcome(pluginOf(gus, ID), { type: "note.read", id: note.id })).toBe("forbidden: A guest runs no plugins: they are for the workspace's members");
  });

  it("stops at the workspace: an install's id is nothing in another workspace, to its admin or to a plugin there", async () => {
    const ada = await newMember();
    const id = await install(ada);
    await permit(ada, id, "notes.read");
    await permit(ada, id, "network");
    const before = await perform(env.DB, ada, { type: "plugin.list" });

    const bob = await newMember("Bob Other");
    await perform(env.DB, bob, { type: "note.create", text: "# Bob's" });
    const got: Record<string, string> = {};
    for (const op of pluginOps(id)) if (op.type !== "plugin.list" && !(op.type === "plugin.install" && !("replaces" in op))) got[op.type] = await outcome(bob, op);
    // An admin asking for a permission is told an admin decides, here as anywhere, before anything is looked for.
    expect(got).toEqual({ "plugin.read": "not_found: No such plugin", "plugin.install": "not_found: No such plugin", "plugin.uninstall": "not_found: No such plugin", "plugin.permit": "not_found: No such plugin", "plugin.request": "invalid: An admin decides it: plugin.permit", "plugin.frame": "not_found: No such plugin" });
    expect((await perform(env.DB, bob, { type: "plugin.list" })).plugins.map((p) => p.id)).toEqual(["html"]);
    // The plugin permitted in Ada's workspace is not installed in Bob's, so it performs nothing there for him.
    expect(await outcome(pluginOf(bob, id), { type: "note.list" })).toBe("forbidden: That plugin isn't installed in this workspace");
    // And Bob is nobody in Ada's, as a plugin of hers either.
    expect(await outcome({ ...bob, workspaceId: ada.workspaceId }, { type: "plugin.list" })).toBe("not_found: No such workspace");
    expect(await outcome({ ...pluginOf(bob, id), workspaceId: ada.workspaceId }, { type: "note.list" })).toBe("not_found: No such workspace");

    expect(await perform(env.DB, ada, { type: "plugin.list" })).toEqual(before);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM plugin_permissions WHERE workspace_id = ?").bind(bob.workspaceId).first()).toEqual({ n: 0 });
  });

  it("HTML embeds' network is off until an admin lists the sites, which a member may ask for", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const sites = ["https://api.example.com", "https://cdn.example.com"];
    const html = async (asker: Actor) => permissionOf(await perform(env.DB, asker, { type: "plugin.list" }), "html", "network");

    expect(await html(grace)).toMatchObject({ state: "off", origins: [], requests: [] });
    expect(await perform(env.DB, grace, { type: "plugin.frame", id: "html" })).toEqual({ token: null, origins: [] });

    // A member asks with the sites they want. It allows nothing.
    await expect(perform(env.DB, grace, { type: "plugin.request", id: "html", capability: "network" })).rejects.toMatchObject({ code: "invalid", message: "List the sites HTML embeds may reach, as origins" });
    await expect(perform(env.DB, grace, { type: "plugin.request", id: "html", capability: "notes.read", origins: sites })).rejects.toMatchObject({ code: "invalid", message: "HTML embeds have one permission: network" });
    await expect(perform(env.DB, grace, { type: "plugin.request", id: "html", capability: "network", origins: ["https://api.example.com/v1"] })).rejects.toMatchObject({ code: "invalid" });
    await perform(env.DB, grace, { type: "plugin.request", id: "html", capability: "network", origins: sites });
    expect(await html(ada)).toMatchObject({ state: "off", origins: [], requests: [{ by: { id: grace.personId, name: "Grace Hopper" }, origins: sites }] });
    expect(await perform(env.DB, grace, { type: "plugin.frame", id: "html" })).toEqual({ token: null, origins: [] });

    // The admin lists them: the sites are the admin's, never a manifest's or a note's.
    await expect(permit(ada, "html", "network")).rejects.toMatchObject({ code: "invalid", message: "List the sites HTML embeds may reach, as origins" });
    await expect(permit(ada, "html", "notes.read", { origins: sites })).rejects.toMatchObject({ code: "invalid" });
    for (const bad of ["https://*.example.com", "http://example.com", "https://a.example.com 'unsafe-eval'", "data:"]) await expect(permit(ada, "html", "network", { origins: [bad] }), bad).rejects.toMatchObject({ code: "invalid" });
    await expect(permit(grace, "html", "network", { origins: sites })).rejects.toMatchObject({ code: "forbidden" });
    await permit(ada, "html", "network", { origins: [sites[0]!] });
    expect(await html(grace)).toMatchObject({ state: "allowed", origins: [sites[0]], decidedBy: "Ada Lovelace", voided: false, requests: [] });
    expect(await perform(env.DB, grace, { type: "plugin.frame", id: "html" })).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), origins: [sites[0]] });

    // A third-party plugin's sites are its manifest's, and nobody adds to them.
    const id = await install(ada);
    await expect(permit(ada, id, "network", { origins: sites })).rejects.toMatchObject({ code: "invalid", message: "A plugin's sites are the ones its manifest lists. Only HTML embeds are given origins." });

    // Locked, changing the sites is changing it.
    await permit(ada, "html", "network", { origins: [sites[0]!], locked: true });
    await expect(permit(ada, "html", "network", { origins: sites })).rejects.toMatchObject({ code: "conflict" });
    await permit(ada, "html", "network", { allowed: false, locked: false });
    expect(await html(grace)).toMatchObject({ state: "off", origins: [sites[0]], locked: false });
    expect(await perform(env.DB, grace, { type: "plugin.frame", id: "html" })).toEqual({ token: null, origins: [] });
  });
});

describe("a plugin acting for a member", () => {
  const EVERYTHING = [READ, WRITE, TODOS, MEMBERS, NETWORK];
  async function permitted(capabilities: readonly { name: Capability }[] = EVERYTHING) {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const id = await install(ada, EVERYTHING);
    for (const { name } of capabilities) await permit(ada, id, name);
    return { ada, grace, id };
  }

  it("cannot perform plugin.*, settings.*, changes to members, grant.*, upload.*, source.* or anything else outside its rows, whatever it is permitted", async () => {
    const { ada, grace, id } = await permitted();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan\n\n- [ ] Call" });
    const file = await upload(ada, "cat.png");
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    const agent = await connectAgent(env.DB, ada.personId, "Claude");

    // The whole of a plugin's reach, with every permission there is allowed.
    expect([...opsAllowedBy(CAPABILITY_NAMES)].sort()).toEqual(["daily.find", "folder.list", "member.list", "note.backlinks", "note.create", "note.list", "note.read", "note.write", "search", "todo.list"]);

    const refused: OpInput[] = [
      ...pluginOps(id),
      { type: "plugin.permit", id, capability: "notes.write", allowed: true },
      { type: "plugin.permit", id: "html", capability: "network", allowed: true, origins: ["https://evil.example.com"] },
      { type: "plugin.frame", id: "html" },
      { type: "settings.read" },
      { type: "settings.write", text: "{}", baseRevision: 0 },
      { type: "member.invite", email: address(), as: "admin" },
      { type: "member.setRole", memberId: grace.personId, as: "admin" },
      { type: "member.remove", memberId: grace.personId },
      { type: "member.leave" },
      { type: "invite.list" },
      { type: "invite.revoke", id: ID },
      { type: "grant.list", noteId: note.id },
      { type: "grant.set", noteId: note.id, email: address(), access: "edit" },
      { type: "grant.link", noteId: note.id, link: "public" },
      { type: "grant.revoke", id: ID },
      { type: "note.setPrivate", id: note.id, private: true },
      { type: "upload.create", name: "x.png", size: 1 },
      { type: "upload.list" },
      { type: "upload.read", id: file.id },
      { type: "upload.open", id: file.id },
      { type: "upload.move", id: file.id, folderId: folder.id },
      { type: "upload.archive", id: file.id, archived: true },
      { type: "upload.trash", id: file.id },
      { type: "upload.restore", id: file.id },
      { type: "upload.purge", id: file.id },
      { type: "upload.trashed" },
      { type: "upload.setPrivate", id: file.id, private: true },
      { type: "source.list" },
      { type: "source.connect", id: "google-calendar" },
      { type: "source.disconnect", id: "google-calendar" },
      { type: "event.list", from: 0, to: 1, timeZone: "UTC" },
      { type: "contact.list" },
      { type: "record.read", ref: ID },
      { type: "history.list" },
      { type: "history.authors" },
      { type: "history.revertAuthor", author: { kind: "agent", id: agent.agent.id } },
      { type: "history.summary" },
      { type: "note.history", id: note.id },
      { type: "note.revert", id: note.id, revision: 0 },
      { type: "note.undo", id: note.id },
      { type: "note.label", id: note.id, revision: 1, name: "Mine" },
      { type: "note.move", id: note.id, folderId: folder.id },
      { type: "note.archive", id: note.id, archived: true },
      { type: "note.trash", id: note.id },
      { type: "note.purge", id: note.id },
      { type: "trash.list" },
      { type: "tag.list" },
      { type: "todo.set", id: note.id, revision: 1, line: 2, text: "- [ ] Call", done: true },
      { type: "todo.filters" },
      { type: "daily.open" },
      { type: "folder.create", name: "Mine" },
      { type: "folder.rename", id: folder.id, name: "Mine" },
      { type: "folder.delete", id: folder.id },
      { type: "links.rebuild" },
    ];
    // As the admin's plugin, so nothing but its being a plugin is what refuses it.
    const got = new Set<string>();
    for (const op of refused) got.add((await outcome(pluginOf(ada, id), op)).replace(op.type, "it"));
    expect([...got]).toEqual(["forbidden: Word Tally isn't permitted to it"]);

    // And nothing was done: the note, the upload, the folder, the members and the record are as they were.
    expect(await perform(env.DB, ada, { type: "note.read", id: note.id })).toMatchObject({ revision: 1, state: "live", private: false, folderId: note.folderId });
    expect((await perform(env.DB, ada, { type: "upload.read", id: file.id })).state).toBe("live");
    expect((await perform(env.DB, ada, { type: "member.list" })).map((m) => `${m.name}: ${m.role}`)).toEqual(["Ada Lovelace: admin", "Grace Hopper: editor"]);
    expect(await told(ada, id, "notes.write")).toEqual(ALLOWED);
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.map((p) => p.id)).toEqual([id, "html"]);
    expect(await perform(env.DB, ada, { type: "grant.list" })).toMatchObject({ grants: [] });
  });

  it("is told who last wrote a note only with members.read: without it, another member is \"A member\", and the member it runs for is as they are", async () => {
    const { ada, grace, id } = await permitted([READ]);
    const plan = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const own = await perform(env.DB, grace, { type: "note.create", text: "# Own" });
    const seen = async () => {
      const notes = await perform(env.DB, pluginOf(grace, id), { type: "note.list" });
      return [plan.id, own.id].map((noteId) => notes.find((n) => n.id === noteId)!.updatedBy);
    };
    expect(await seen()).toEqual([
      { kind: "member", personId: "", name: "A member" },
      { kind: "member", personId: grace.personId, name: "Grace Hopper" },
    ]);
    await permit(ada, id, "members.read");
    expect((await seen())[0]).toEqual({ kind: "member", personId: ada.personId, name: "Ada Lovelace" });
  });

  it("writes as itself: its changes are the plugin's in History, with the member it acted for", async () => {
    const { ada, grace, id } = await permitted([READ, WRITE]);
    const acting = pluginOf(grace, id);
    const plugin = { kind: "plugin", pluginId: id, name: "Word Tally", onBehalfOf: grace.personId };
    const mine = await perform(env.DB, ada, { type: "note.create", text: "# Plan\n\nStep" });
    const made = await perform(env.DB, acting, { type: "note.create", text: "# Counted" });
    const empty = await perform(env.DB, acting, { type: "note.create" });
    const written = await perform(env.DB, acting, { type: "note.write", id: mine.id, baseRevision: 1, text: "# Plan\n\nStep\n\n2 words" });
    expect([made.updatedBy, empty.updatedBy, written.updatedBy]).toEqual([plugin, plugin, plugin]);

    // What is kept: the plugin's id as the author, and the member beside it.
    const { results } = await env.DB.prepare("SELECT note_id, revision, author_kind, author_id, author_owner FROM changes WHERE author_kind = 'plugin' AND note_id IN (?, ?)").bind(mine.id, made.id).all();
    expect(results).toHaveLength(2);
    expect(results).toEqual(
      expect.arrayContaining([
        { note_id: made.id, revision: 1, author_kind: "plugin", author_id: id, author_owner: grace.personId },
        { note_id: mine.id, revision: 2, author_kind: "plugin", author_id: id, author_owner: grace.personId },
      ]),
    );

    // Every listing that names an author names the plugin, for the note never written too.
    const listed = await perform(env.DB, ada, { type: "note.list" });
    expect(Object.fromEntries(listed.map((n) => [n.id, n.updatedBy]))).toEqual({ [mine.id]: plugin, [made.id]: plugin, [empty.id]: plugin });
    expect((await perform(env.DB, ada, { type: "note.history", id: mine.id })).map((c) => c.author)).toEqual([{ kind: "member", personId: ada.personId, name: "Ada Lovelace" }, plugin]);

    // history.list, whole and narrowed to the plugin, as it is to an agent.
    const all = await perform(env.DB, ada, { type: "history.list" });
    expect(all.changes.map((c) => [c.noteTitle, c.author.kind]).sort()).toEqual([["Counted", "plugin"], ["Plan", "member"], ["Plan", "plugin"]]);
    const theirs = await perform(env.DB, ada, { type: "history.list", authors: [{ kind: "plugin", id }] });
    expect(theirs.changes.map((c) => [c.noteId, c.revision, c.author]).sort()).toEqual([[made.id, 1, plugin], [mine.id, 2, plugin]].sort());
    expect((await perform(env.DB, ada, { type: "history.list", authors: [{ kind: "agent", id }] })).changes).toEqual([]);
    expect((await perform(env.DB, ada, { type: "history.list", authors: [{ kind: "member", id: grace.personId }] })).changes).toEqual([]);

    // history.authors lists it once, whoever it acted for, beside the members.
    await perform(env.DB, pluginOf(ada, id), { type: "note.write", id: mine.id, baseRevision: 2, text: "# Plan\n\nStep\n\n2 words\n\nAgain" });
    expect(await perform(env.DB, ada, { type: "history.authors" })).toEqual([{ kind: "member", personId: ada.personId, name: "Ada Lovelace" }, { kind: "plugin", pluginId: id, name: "Word Tally", onBehalfOf: "" }]);
    expect((await perform(env.DB, ada, { type: "history.summary", authors: [{ kind: "plugin", id }] })).notes.reduce((sum, n) => sum + n.changes, 0)).toBe(3);

    // Reverting the author takes every change of the plugin's back out, whichever member it was for, and leaves the member's.
    const reverted = await perform(env.DB, ada, { type: "history.revertAuthor", author: { kind: "plugin", id }, trashEmptied: true });
    expect(reverted.reverted.map((r) => [r.note.id, r.revisions]).sort()).toEqual([[made.id, [1]], [mine.id, [2, 3]]].sort());
    expect(reverted.emptied).toEqual([{ noteId: made.id, title: "Counted", trashed: true }]);
    expect((await perform(env.DB, ada, { type: "note.read", id: mine.id })).text).toBe("# Plan\n\nStep");
    expect((await perform(env.DB, ada, { type: "note.list" })).map((n) => n.id).sort()).toEqual([mine.id, empty.id].sort());
    // An agent of a member's is not the plugin, though both act for a member.
    expect((await perform(env.DB, ada, { type: "history.revertAuthor", author: { kind: "plugin", id } })).reverted).toEqual([]);
    // The notes History lists name it among who changed each, and so does a revert that a change of its stands in the way of.
    const two = await perform(env.DB, ada, { type: "note.create", text: "# Two\n\nStep" });
    await perform(env.DB, acting, { type: "note.write", id: two.id, baseRevision: 1, text: "# Two\n\nStep by step" });
    const summed = await perform(env.DB, ada, { type: "history.summary" });
    const [preview] = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: two.id, revisions: [1] }] });
    expect(preview!.conflicts.flatMap((c) => c.later.map((l) => l.author))).toContainEqual(plugin);
    expect(summed.notes.find((n) => n.noteId === two.id)!.authors).toEqual(expect.arrayContaining([{ kind: "plugin", pluginId: id, name: "Word Tally", onBehalfOf: "" }]));
  });

  it("is answered no more than its permission names: no uploads or members with a note, and never an email", async () => {
    const { ada, grace, id } = await permitted();
    const file = await upload(ada, "cat.png");
    const text = `# Plan\n\n@[[${grace.personId}|Gracie]] and @[[Sam]]\n\n::image{${file.id}}\n- [ ] Call @[[${grace.personId}|Gracie]]`;
    const note = await perform(env.DB, ada, { type: "note.create", text });

    const asMember = await perform(env.DB, ada, { type: "note.read", id: note.id });
    expect(asMember.uploads).toEqual([{ id: file.id, upload: expect.objectContaining({ name: "cat.png" }) }]);
    expect(asMember.mentions).toEqual([{ id: grace.personId, name: "Grace Hopper", member: true }, { id: null, name: "Sam", member: false }]);

    const asPlugin = await perform(env.DB, pluginOf(ada, id), { type: "note.read", id: note.id });
    expect(asPlugin.text).toBe(text);
    expect(asPlugin.uploads).toEqual([]);
    // Nor how many there are: a folder's count of uploads is of what reading notes doesn't reach.
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.map((f) => f.uploadCount)).toContain(1);
    expect((await perform(env.DB, pluginOf(ada, id), { type: "folder.list" })).folders.map((f) => f.uploadCount)).not.toContain(1);
    // Each mention as the text writes it: who is a member, and what they are called now, is not the note's to say.
    expect(asPlugin.mentions).toEqual([{ id: grace.personId, name: "Gracie", member: false }, { id: null, name: "Sam", member: false }]);
    expect(JSON.stringify(asPlugin)).not.toMatch(/cat\.png|Grace Hopper/);
    const todos = await perform(env.DB, pluginOf(ada, id), { type: "todo.list" });
    expect(todos.todos.map((t) => t.assignees)).toEqual([[{ id: grace.personId, name: "Gracie", member: false }]]);

    // A name it writes is kept as a name: a write is not a way to ask who is a member.
    const wrote = await perform(env.DB, pluginOf(ada, id), { type: "note.create", text: "# Hi\n\n@[[Grace Hopper]]" });
    expect(wrote.text).toBe("# Hi\n\n@[[Grace Hopper]]");
    expect((await perform(env.DB, ada, { type: "note.create", text: "# Hi\n\n@[[Grace Hopper]]" })).text).toBe(`# Hi\n\n@[[${grace.personId}|Grace Hopper]]`);

    // member.list for a plugin, an admin's too: names and roles, and no email.
    const members = await perform(env.DB, pluginOf(ada, id), { type: "member.list" });
    expect(members).toEqual([{ personId: ada.personId, name: "Ada Lovelace", role: "admin" }, { personId: grace.personId, name: "Grace Hopper", role: "editor" }]);
    expect((await perform(env.DB, ada, { type: "member.list" })).every((m) => m.email?.includes("@"))).toBe(true);
  });

  it("reads and writes what its member can, and no note its member can't see", async () => {
    const { ada, grace, id } = await permitted([READ, WRITE]);
    const open = await perform(env.DB, ada, { type: "note.create", text: "# Open\n\nwords" });
    const secret = await perform(env.DB, ada, { type: "note.create", text: "# Secret\n\nwords" });
    await perform(env.DB, ada, { type: "note.setPrivate", id: secret.id, private: true });

    expect((await perform(env.DB, pluginOf(ada, id), { type: "note.list" })).map((n) => n.title).sort()).toEqual(["Open", "Secret"]);
    expect((await perform(env.DB, pluginOf(grace, id), { type: "note.list" })).map((n) => n.title)).toEqual(["Open"]);
    expect((await perform(env.DB, pluginOf(grace, id), { type: "search", query: "words" })).results.map((r) => r.note.title)).toEqual(["Open"]);
    expect(await outcome(pluginOf(grace, id), { type: "note.read", id: secret.id })).toBe("not_found: No such note");
    expect(await outcome(pluginOf(grace, id), { type: "note.write", id: secret.id, baseRevision: 1, text: "# Mine" })).toBe("not_found: No such note");
    expect(await outcome(pluginOf(grace, id), { type: "note.write", id: open.id, baseRevision: 1, text: "# Open\n\nmore words" })).toBe("done");

    // A plugin that has only written a note someone can't see is no author to them, installed or not.
    const other = await install(ada, [READ, WRITE]);
    await permit(ada, other, "notes.write");
    await perform(env.DB, pluginOf(ada, other), { type: "note.write", id: secret.id, baseRevision: 1, text: "# Secret\n\nwords counted" });
    const unseen = async () => [
      (await perform(env.DB, grace, { type: "history.authors" })).map((a) => (a.kind === "plugin" ? a.pluginId : a.name)),
      (await perform(env.DB, grace, { type: "history.list", authors: [{ kind: "plugin", id: other }] })).changes,
      (await perform(env.DB, grace, { type: "history.summary", authors: [{ kind: "plugin", id: other }] })).notes,
      (await perform(env.DB, grace, { type: "history.revertAuthor", author: { kind: "plugin", id: other } })).reverted,
    ];
    expect(await unseen()).toEqual([["Ada Lovelace", id], [], [], []]);
    await perform(env.DB, ada, { type: "plugin.uninstall", id: other });
    expect(await unseen()).toEqual([["Ada Lovelace", id], [], [], []]);
    expect((await perform(env.DB, ada, { type: "history.authors" })).map((a) => (a.kind === "plugin" ? a.pluginId : a.name)).sort()).toEqual(["Ada Lovelace", id, other].sort());
    expect((await perform(env.DB, ada, { type: "note.read", id: secret.id })).text).toBe("# Secret\n\nwords counted");
  });
});

describe("a frame's token", () => {
  async function networked() {
    const ada = await newMember();
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const id = await install(ada);
    return { ada, vera, id };
  }
  const grants = async (workspaceId: string) => (await env.DB.prepare("SELECT token_hash, origins, expires_at, used_at FROM frame_grants WHERE workspace_id = ?").bind(workspaceId).all<{ token_hash: string; origins: string; expires_at: number; used_at: number | null }>()).results;

  it("is minted only when the plugin's network is allowed", async () => {
    const { ada, vera, id } = await networked();
    expect(await perform(env.DB, vera, { type: "plugin.frame", id })).toEqual({ token: null, origins: [] });
    // Another permission is not this one.
    await permit(ada, id, "notes.read");
    expect(await perform(env.DB, vera, { type: "plugin.frame", id })).toEqual({ token: null, origins: [] });
    expect(await grants(ada.workspaceId)).toEqual([]);

    await permit(ada, id, "network");
    const frame = await perform(env.DB, vera, { type: "plugin.frame", id });
    expect(frame).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), origins: ["https://api.example.com"] });
    // A plugin that declares no network has none to allow.
    const quiet = await install(ada, [READ]);
    expect(await perform(env.DB, ada, { type: "plugin.frame", id: quiet })).toEqual({ token: null, origins: [] });
    await expect(perform(env.DB, ada, { type: "plugin.frame", id: ID })).rejects.toMatchObject({ code: "not_found" });

    // Only the token's hash is kept.
    const kept = await grants(ada.workspaceId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ origins: '["https://api.example.com"]', used_at: null });
    expect(JSON.stringify(kept)).not.toContain(frame.token);
  });

  it("is good once, and for a minute", async () => {
    const { ada, id } = await networked();
    await permit(ada, id, "network");
    const at = 1_800_000_000_000;
    const mint = async () => (await perform(env.DB, ada, { type: "plugin.frame", id }, at)).token!;

    const [one, late, onTime] = [await mint(), await mint(), await mint()];
    expect(new Set([one, late, onTime]).size).toBe(3);
    expect(await redeemFrame(env.DB, one, at + 1000)).toEqual(["https://api.example.com"]);
    expect(await redeemFrame(env.DB, one, at + 2000)).toBeNull();
    expect(await redeemFrame(env.DB, late, at + FRAME_SECONDS * 1000)).toBeNull();
    expect(await redeemFrame(env.DB, onTime, at + FRAME_SECONDS * 1000 - 1)).toEqual(["https://api.example.com"]);
    // Asked for at once by two, it answers one.
    const raced = await mint();
    expect((await Promise.all([redeemFrame(env.DB, raced, at + 1), redeemFrame(env.DB, raced, at + 1)])).filter((sites) => sites !== null)).toHaveLength(1);

    for (const unknown of ["", "x", "A".repeat(43), `${one}x`, one.slice(1), "../../etc/passwd"]) expect(await redeemFrame(env.DB, unknown, at + 1), unknown).toBeNull();
    // Tokens past their minute are cleared as the next is made.
    await perform(env.DB, ada, { type: "plugin.frame", id }, at + 10 * 60_000);
    expect(await grants(ada.workspaceId)).toHaveLength(1);
  });

  it("carries only sites that read as sites, whatever was kept", async () => {
    const { ada } = await networked();
    const token = "B".repeat(43);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (b) => b.toString(16).padStart(2, "0")).join("");
    const kept = ["https://ok.example.com", "https://evil.example.com; script-src *", "https://*.example.com", "javascript:alert(1)", "https://ok.example.com/path", 7, null];
    await env.DB.prepare("INSERT INTO frame_grants (token_hash, workspace_id, origins, expires_at) VALUES (?, ?, ?, ?)").bind(hash, ada.workspaceId, JSON.stringify(kept), Date.now() + 60_000).run();
    expect(await redeemFrame(env.DB, token, Date.now())).toEqual(["https://ok.example.com"]);
  });
});

describe("a plugin's operations over HTTP", () => {
  const SECRET = "test-secret";
  const send = (path: string, init: RequestInit = {}, more: Partial<Env> = {}) => worker.fetch(new Request(`https://ink.test${path}`, init) as never, { ...env, SESSION_SECRET: SECRET, ...more });
  const cookieOf = async (member: Actor) => `__Host-ink_session=${encodeURIComponent(await sign({ personId: member.personId }, SECRET, 3600))}`;
  const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

  it("come through the address that names the install, as that plugin and the signed-in member", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const id = await install(ada);
    await permit(ada, id, "notes.read");
    await permit(ada, id, "notes.write");
    const route = `/api/workspaces/${ada.workspaceId}/plugins/${id}/ops`;
    const post = async (body: unknown, headers: Record<string, string> = {}, path = route) =>
      answer(await send(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ink.test", Cookie: await cookieOf(grace), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

    const made = await post({ type: "note.create", text: "# Counted" });
    expect(made).toMatchObject({ status: 200, body: { title: "Counted", updatedBy: { kind: "plugin", pluginId: id, name: "Word Tally", onBehalfOf: grace.personId } } });
    // What the plugin says of who it is counts for nothing: the address names it.
    const other = await install(ada);
    expect(await post({ type: "note.list", pluginId: other, actor: { kind: "member" } })).toMatchObject({ status: 200 });
    expect(await post({ type: "note.list" }, {}, `/api/workspaces/${ada.workspaceId}/plugins/${other}/ops`)).toEqual({ status: 403, body: { error: "forbidden", message: "Word Tally isn't permitted to note.list" } });

    expect(await post({ type: "settings.read" })).toEqual({ status: 403, body: { error: "forbidden", message: "Word Tally isn't permitted to settings.read" } });
    expect(await post({ type: "plugin.permit", id, capability: "network", allowed: true })).toEqual({ status: 403, body: { error: "forbidden", message: "Word Tally isn't permitted to plugin.permit" } });
    expect(await post({ type: "note.list" }, {}, `/api/workspaces/${ada.workspaceId}/plugins/aaaaaaaaaaaa/ops`)).toEqual({ status: 403, body: { error: "forbidden", message: "That plugin isn't installed in this workspace" } });
    expect(await post({ type: "nothing" })).toMatchObject({ status: 400, body: { error: "invalid" } });

    // The same checks as the app's own operations: from Common Ink itself, as JSON, signed in, and no bytes.
    expect(await post({ type: "note.list" }, { Origin: "https://evil.example.com" })).toEqual({ status: 403, body: { error: "forbidden", message: "Operations come as JSON from Common Ink itself" } });
    expect(await post({ type: "note.list" }, { "Content-Type": "text/plain" })).toMatchObject({ status: 403 });
    expect(await post("{", {})).toEqual({ status: 400, body: { error: "invalid", message: "The body isn't JSON" } });
    for (const type of ["upload.create", "upload.open", "shared.upload"]) expect((await post({ type, id, name: "x.png", size: 1 })).body.message, type).toBe("A file's bytes come and go at /api/workspaces/<id>/uploads, and a part of one at the address upload.start gives");
    expect((await send(route, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ink.test" }, body: '{"type":"note.list"}' })).status).toBe(401);
    expect((await send(route, { headers: { Cookie: await cookieOf(grace) } })).status).toBe(404);
    // An agent's token is no session here either.
    const { token } = await connectAgent(env.DB, grace.personId, "Claude");
    expect((await send(route, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ink.test", Authorization: `Bearer ${token}` }, body: '{"type":"note.list"}' })).status).toBe(401);
  });

  it("/api/me says dev only where dev sign-in is on", async () => {
    const ada = await newMember();
    const me = async (host: string, more: Partial<Env>) => {
      const res = await worker.fetch(new Request(`https://${host}/api/me`, { headers: { Cookie: await cookieOf(ada) } }) as never, { ...env, SESSION_SECRET: SECRET, ...more });
      return ((await res.json()) as { dev?: boolean }).dev;
    };
    expect(await me("localhost", { DEV_SIGN_IN: "1" })).toBe(true);
    expect(await me("pr-16-common-ink-v3-previews.draftox.workers.dev", { DEV_SIGN_IN: "1" })).toBe(true);
    expect(await me("commonink.app", { DEV_SIGN_IN: "1" })).toBe(false);
    expect(await me("localhost", {})).toBe(false);
    expect(await me("commonink.app", {})).toBe(false);
    expect((await whoAmI(env.DB, ada.personId)).dev).toBe(false);
  });
});
