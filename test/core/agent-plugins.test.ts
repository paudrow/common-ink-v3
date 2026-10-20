import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { PluginRecord } from "../../src/core/plugins.ts";
import type { OpInput, PluginProposal } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";

const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await worker.fetch(
    new Request("https://ink.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://ink.test", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }) as never,
    env,
  );
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: result.content[0]!.text, isError: !!result.isError };
};

const agentOf = async (member: Actor, name: string, scope?: { readOnly?: boolean; folderIds?: string[] }): Promise<Actor> => ({
  kind: "agent",
  agentId: (await connectAgent(env.DB, member.personId, name)).agent.id,
  personId: member.personId,
  workspaceId: member.workspaceId,
  ...(scope ? { scope } : {}),
});

const outcome = (run: Promise<unknown>) =>
  run.then(
    () => "done",
    (err: { code?: string; message?: string }) => `${err.code}: ${err.message}`,
  );

const MANIFEST = JSON.stringify({ name: "Word Tally", capabilities: [{ name: "notes.read", reason: "Counts the words in your notes." }] });
const TRUSTED = JSON.stringify({ name: "Deep Keys", capabilities: [{ name: "full-trust", reason: "Rebinds keys inside the editor." }] });

/** Ada approving what her agent's tool call asked, as she would on the Plugins page. The call itself changed nothing. */
async function approve(ada: Actor, answer: { text: string; isError: boolean }): Promise<PluginProposal> {
  expect(answer.isError, answer.text).toBe(false);
  const { proposed } = JSON.parse(answer.text) as { proposed: PluginProposal };
  expect([proposed.state, proposed.message]).toEqual(["pending", expect.stringContaining("Waiting for an admin to approve it")]);
  await perform(env.DB, ada, { type: "plugin.decide", id: proposed.id, approve: true });
  return proposed;
}

/** Ada, the admin, with an agent connected through MCP; Ed, an editor, and Vera, a viewer. */
async function workspace() {
  const ada = await newMember("Ada Lovelace");
  const ed = await addMember(ada, "editor");
  const vera = await addMember(ada, "viewer");
  const { token } = await connectAgent(env.DB, ada.personId, "Claude");
  return { ada, ed, vera, token, ws: ada.workspaceId };
}

describe("an agent makes and manages plugins in its member's role", () => {
  it("an admin's agent scaffolds, checks, installs, permits, updates and uninstalls, and each change says it was the agent for the admin", async () => {
    const { ada, token, ws } = await workspace();
    const made = JSON.parse((await tool(token, "scaffold_plugin", { workspace: ws, name: "Greeter" })).text) as { manifest: string; code: string };
    expect(JSON.parse(made.manifest)).toMatchObject({ name: "Greeter", capabilities: [], commands: [{ id: "hello", title: "Say hello" }] });
    expect(made.code).toContain('ink.onCommand("hello"');

    const checked = JSON.parse((await tool(token, "validate_plugin", { workspace: ws, ...made })).text);
    expect(checked).toMatchObject({ ok: true, fullTrust: false, manifest: { name: "Greeter" } });
    expect(checked.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse((await tool(token, "validate_plugin", { workspace: ws, manifest: '{"name":"History"}', code: "" })).text)).toMatchObject({ ok: false, reason: expect.stringContaining("Common Ink's own") });
    expect(await tool(token, "scaffold_plugin", { workspace: ws, name: "History" })).toMatchObject({ isError: true, text: expect.stringContaining("Common Ink's own") });
    // A line separator would end the comment the name is written in, and start code of the caller's.
    expect(await tool(token, "scaffold_plugin", { workspace: ws, name: "Hi\u2028globalThis.taken = 1; //" })).toMatchObject({ isError: true, text: expect.stringContaining("line or paragraph separator") });

    // What it scaffolds installs as it is, once Ada approves: asking installs nothing.
    const asked = await tool(token, "install_plugin", { workspace: ws, ...made });
    expect(JSON.parse(asked.text).plugins.map((p: { manifest: { name: string } }) => p.manifest.name)).not.toContain("Greeter");
    await approve(ada, asked);
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.map((p) => p.manifest.name)).toContain("Greeter");
    const asking = await tool(token, "install_plugin", { workspace: ws, manifest: MANIFEST, code: "ink.notify(1)" });
    const installed = JSON.parse(asking.text) as PluginRecord & { id: string };
    const id = installed.id;
    expect(installed.canManage).toBe(true);
    expect((await approve(ada, asking)).pluginId).toBe(id);
    const read = JSON.parse((await tool(token, "read_plugin", { workspace: ws, id })).text) as { code: string; codeHash: string };
    expect(read.code).toBe("ink.notify(1)");
    await approve(ada, await tool(token, "permit_plugin", { workspace: ws, id, capability: "notes.read", allowed: true, codeHash: read.codeHash }));

    // What the admin reads in the app: who did it, and the agent that did it for them.
    let seen = (await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
    expect([seen.installedBy, seen.installedVia, seen.updatedBy, seen.updatedVia]).toEqual(["Ada Lovelace", "Claude", null, null]);
    expect(seen.permissions.map((p) => [p.capability, p.state, p.decidedBy, p.decidedVia])).toEqual([["notes.read", "allowed", "Ada Lovelace", "Claude"]]);

    await perform(env.DB, ada, { type: "plugin.permit", id, capability: "notes.read", allowed: true, codeHash: read.codeHash, locked: true });
    seen = (await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
    expect(seen.permissions.map((p) => [p.decidedBy, p.decidedVia])).toEqual([["Ada Lovelace", null]]);

    await approve(ada, await tool(token, "install_plugin", { workspace: ws, manifest: MANIFEST, code: "ink.notify(2)", pluginId: id }));
    seen = (await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
    expect([seen.installedVia, seen.updatedBy, seen.updatedVia, seen.permissions[0]!.voided]).toEqual(["Claude", "Ada Lovelace", "Claude", true]);

    await approve(ada, await tool(token, "uninstall_plugin", { workspace: ws, id }));
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.map((p) => p.manifest.name)).toEqual(["Greeter", "HTML embeds"]);
  });

  it("an admin's agent grants full trust like any decision, and turns it on for nobody: that stays each member's own click", async () => {
    const { ada, ed, ws, token } = await workspace();
    const agent = await agentOf(ada, "Claude");
    const asked = await perform(env.DB, agent, { type: "plugin.install", manifest: TRUSTED, code: "trusted()" });
    await perform(env.DB, ada, { type: "plugin.decide", id: asked.proposed!.id, approve: true });
    const { plugins } = await perform(env.DB, agent, { type: "plugin.list" });
    const id = asked.id;
    const codeHash = plugins.find((p) => p.id === id)!.codeHash!;
    // It is told what its admin is: that the plugin asks for full trust, and whether it is granted.
    expect(plugins.find((p) => p.id === id)!.manifest.capabilities.map((c) => c.name)).toEqual(["full-trust"]);
    const granting = await perform(env.DB, agent, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash });
    await perform(env.DB, ada, { type: "plugin.decide", id: granting.proposed!.id, approve: true });

    for (const as of [agent, await agentOf(ed, "Eds")]) expect(await outcome(perform(env.DB, as, { type: "plugin.trust", id, on: true, codeHash }))).toBe("forbidden: An agent can't plugin.trust");
    expect((await tool(token, "list_plugins", { workspace: ws })).text).not.toContain('"on":true');
    const record = await perform(env.DB, ada, { type: "plugin.list" });
    expect(record.plugins.find((p) => p.id === id)!.fullTrust).toMatchObject({ grantedHash: codeHash, on: false, turnedOnBy: [] });
  });

  it("a member's agent asks and keeps its member's own drafts, and does nothing only an admin does", async () => {
    const { ada, ed, vera } = await workspace();
    const { id, plugins } = await perform(env.DB, ada, { type: "plugin.install", manifest: MANIFEST, code: "ink.notify(1)" });
    const baseHash = plugins.find((p) => p.id === id)!.codeHash!;
    const eds = await agentOf(ed, "Eds");

    for (const op of [
      { type: "plugin.install", manifest: MANIFEST, code: "" },
      { type: "plugin.install", manifest: MANIFEST, code: "mine()", replaces: id },
      { type: "plugin.uninstall", id },
      { type: "plugin.permit", id, capability: "notes.read", allowed: true, codeHash: baseHash },
    ] satisfies OpInput[])
      expect(await outcome(perform(env.DB, eds, op)), op.type).toBe(`forbidden: A editor can't ${op.type}`);
    expect((await perform(env.DB, ada, { type: "plugin.read", id })).code).toBe("ink.notify(1)");

    await perform(env.DB, eds, { type: "plugin.request", id, capability: "notes.read" });
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.permissions[0]!.requests.map((r) => r.by.id)).toEqual([ed.personId]);

    await perform(env.DB, eds, { type: "draft.save", id, manifest: MANIFEST, code: "edsDraft()", baseHash, running: true });
    await perform(env.DB, vera, { type: "draft.save", id, manifest: MANIFEST, code: "verasDraft()", baseHash, running: true });
    // It is Ed's, as if Ed had saved it, and Vera's is hers: neither agent nor member reads the other's.
    expect((await perform(env.DB, ed, { type: "draft.read", id })).code).toBe("edsDraft()");
    expect((await perform(env.DB, eds, { type: "draft.list" })).drafts.map((d) => [d.pluginId, d.codeHash === baseHash])).toEqual([[id, false]]);
    expect((await perform(env.DB, eds, { type: "draft.read", id })).code).toBe("edsDraft()");
    expect((await perform(env.DB, await agentOf(vera, "Veras"), { type: "draft.read", id })).code).toBe("verasDraft()");

    // What Ed's agent kept runs for Ed and for nobody else: Ada has no draft, so a plugin acting for her as one is refused.
    const asDraft = (member: Actor): Actor => ({ kind: "plugin", pluginId: id, personId: member.personId, workspaceId: member.workspaceId, draft: true });
    expect(await outcome(perform(env.DB, asDraft(ada), { type: "note.list" }))).toBe("forbidden: You have no draft of that plugin that is running");
    expect(await outcome(perform(env.DB, asDraft(ed), { type: "plugin.list" }))).toBe("forbidden: Word Tally isn't permitted to plugin.list");

    await perform(env.DB, eds, { type: "draft.discard", id });
    expect((await perform(env.DB, ed, { type: "draft.list" })).drafts).toEqual([]);
    expect((await perform(env.DB, vera, { type: "draft.list" })).drafts.map((d) => d.pluginId)).toEqual([id]);
  });

  it("a read-only agent reads plugins and drafts and changes nothing; an agent limited to folders gets none of it, its admin's included", async () => {
    const { ada } = await workspace();
    const { id } = await perform(env.DB, ada, { type: "plugin.install", manifest: MANIFEST, code: "ink.notify(1)" });
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    const readOnly = await agentOf(ada, "Reader", { readOnly: true });
    const limited = await agentOf(ada, "Narrow", { folderIds: [folder.id] });

    const reads: OpInput[] = [{ type: "plugin.read", id }, { type: "draft.list" }, { type: "plugin.validate", manifest: MANIFEST, code: "" }, { type: "plugin.scaffold", name: "Greeter" }];
    const writes: OpInput[] = [
      { type: "plugin.install", manifest: MANIFEST, code: "" },
      { type: "plugin.uninstall", id },
      { type: "plugin.permit", id, capability: "notes.read", allowed: false },
      { type: "draft.save", id, manifest: MANIFEST, code: "", running: false },
      { type: "draft.discard", id },
    ];
    for (const op of reads) expect(await outcome(perform(env.DB, readOnly, op)), op.type).toBe("done");
    for (const op of writes) expect(await outcome(perform(env.DB, readOnly, op)), op.type).toBe(`forbidden: A read-only token can't ${op.type}`);
    for (const op of [...reads, ...writes, { type: "plugin.list" } as OpInput]) expect(await outcome(perform(env.DB, limited, op)), op.type).toBe(`forbidden: An agent limited to folders can't ${op.type}`);
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.map((p) => p.id)).toEqual([id, "html"]);
  });

  it("a plugin does none of it, even one with full trust turned on: it acts for its member, never in their role over plugins", async () => {
    const { ada } = await workspace();
    const { id, plugins } = await perform(env.DB, ada, { type: "plugin.install", manifest: TRUSTED, code: "trusted()" });
    const codeHash = plugins.find((p) => p.id === id)!.codeHash!;
    await perform(env.DB, ada, { type: "plugin.permit", id, capability: "full-trust", allowed: true, codeHash });
    await perform(env.DB, ada, { type: "plugin.trust", id, on: true, codeHash });
    const plugin: Actor = { kind: "plugin", pluginId: id, personId: ada.personId, workspaceId: ada.workspaceId };
    expect(await outcome(perform(env.DB, plugin, { type: "note.list" }))).toBe("done");
    for (const op of [{ type: "plugin.install", manifest: MANIFEST, code: "" }, { type: "plugin.uninstall", id }, { type: "plugin.read", id }, { type: "draft.save", id, manifest: TRUSTED, code: "", running: false }, { type: "plugin.scaffold", name: "Greeter" }] satisfies OpInput[])
      expect(await outcome(perform(env.DB, plugin, op)), op.type).toBe(`forbidden: Deep Keys isn't permitted to ${op.type}`);
  });
});
