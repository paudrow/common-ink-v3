import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent, disconnectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { PROPOSAL_MS } from "../../src/core/pluginProposals.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";

const MANIFEST = JSON.stringify({ name: "Word Tally", capabilities: [{ name: "notes.read", reason: "Counts the words in your notes." }] });

const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await worker.fetch(
    new Request("https://ink.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }) as never,
    env,
  );
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: result.content[0]!.text, isError: !!result.isError };
};

const outcome = (run: Promise<unknown>) =>
  run.then(
    () => "done",
    (err: { code?: string; message?: string }) => `${err.code}: ${err.message}`,
  );

/** Ada and Grace, both admins, and Ada's agent. */
async function admins() {
  const ada = await newMember("Ada Lovelace");
  const grace = await addMember(ada, "admin", "Grace Hopper");
  const connected = await connectAgent(env.DB, ada.personId, "Claude");
  const agent: Actor = { kind: "agent", agentId: connected.agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
  return { ada, grace, agent, agentId: connected.agent.id, token: connected.token };
}

const names = async (as: Actor) => (await perform(env.DB, as, { type: "plugin.list" })).plugins.map((p) => p.manifest.name);
const T0 = Date.UTC(2026, 9, 20);

describe("an admin's agent asking to change plugins", () => {
  it("changes nothing by asking: the request waits, an admin sees it, and approving does what it asked", async () => {
    const { ada, grace, agent, token } = await admins();
    const asked = await tool(token, "install_plugin", { workspace: ada.workspaceId, manifest: MANIFEST, code: "count()" });
    const { proposed, id } = JSON.parse(asked.text) as { id: string; proposed: { id: string; kind: string; name: string; message: string; agent: { name: string }; for: { name: string } } };
    expect([proposed.kind, proposed.name, proposed.agent.name, proposed.for.name]).toEqual(["install", "Word Tally", "Claude", "Ada Lovelace"]);
    expect(proposed.message).toBe("Waiting for an admin to approve it in Common Ink, on the Plugins page. Nothing has changed yet. Tell Ada Lovelace it is waiting there.");
    expect(await names(ada)).toEqual(["HTML embeds"]);

    // Any admin answers it; a member who isn't one is told of none.
    const ed = await addMember(ada, "editor", "Ed");
    expect((await perform(env.DB, ed, { type: "plugin.proposals" })).proposals).toEqual([]);
    expect((await perform(env.DB, grace, { type: "plugin.proposals" })).proposals.map((p) => p.id)).toEqual([proposed.id]);
    await perform(env.DB, grace, { type: "plugin.decide", id: proposed.id, approve: true });

    const installed = (await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!;
    expect([installed.manifest.name, installed.installedBy, installed.installedVia]).toEqual(["Word Tally", "Grace Hopper", "Claude"]);
    expect((await perform(env.DB, grace, { type: "plugin.proposals" })).proposals).toEqual([]);
    // The agent reads how it was answered, in words it can pass on.
    const own = (await perform(env.DB, agent, { type: "plugin.proposals" })).proposals;
    expect(own.map((p) => [p.state, p.message])).toEqual([["approved", "Grace Hopper approved it, and it is done."]]);
    // Answered once.
    expect(await outcome(perform(env.DB, ada, { type: "plugin.decide", id: proposed.id, approve: true }))).toBe("conflict: Grace Hopper approved it, and it is done.");
  });

  it("does nothing when declined, and nothing once a week has passed unanswered", async () => {
    const { ada, agent } = await admins();
    const declined = (await perform(env.DB, agent, { type: "plugin.install", manifest: MANIFEST, code: "a()" }, T0)).proposed!;
    await perform(env.DB, ada, { type: "plugin.decide", id: declined.id, approve: false }, T0);
    const lapsed = (await perform(env.DB, agent, { type: "plugin.install", manifest: MANIFEST, code: "b()" }, T0)).proposed!;
    expect((await perform(env.DB, ada, { type: "plugin.proposals" }, T0 + PROPOSAL_MS - 1)).proposals.map((p) => p.id)).toEqual([lapsed.id]);
    expect((await perform(env.DB, ada, { type: "plugin.proposals" }, T0 + PROPOSAL_MS)).proposals).toEqual([]);
    expect(await outcome(perform(env.DB, ada, { type: "plugin.decide", id: lapsed.id, approve: true }, T0 + PROPOSAL_MS))).toBe("conflict: Nobody answered it in time, and nothing changed. Ask again if it is still wanted.");

    expect(await names(ada)).toEqual(["HTML embeds"]);
    const told = (await perform(env.DB, agent, { type: "plugin.proposals" }, T0 + PROPOSAL_MS)).proposals.map((p) => [p.id, p.state]);
    expect(told.sort()).toEqual([
      [declined.id, "declined"],
      [lapsed.id, "expired"],
    ].sort());
  });

  it("asks for a permit and an uninstall too, and approves neither once the plugin has changed or the agent is gone", async () => {
    const { ada, agent, agentId } = await admins();
    const { id, plugins } = await perform(env.DB, ada, { type: "plugin.install", manifest: MANIFEST, code: "one()" });
    const codeHash = plugins.find((p) => p.id === id)!.codeHash!;

    const permit = (await perform(env.DB, agent, { type: "plugin.permit", id, capability: "notes.read", allowed: true, codeHash })).proposed!;
    const uninstall = (await perform(env.DB, agent, { type: "plugin.uninstall", id })).proposed!;
    expect([permit.kind, uninstall.kind]).toEqual(["permit", "uninstall"]);
    expect((await perform(env.DB, ada, { type: "plugin.list" })).plugins.find((p) => p.id === id)!.permissions[0]!.state).toBe("off");

    // Ada updates it herself: what the agent asked about is not what is there now.
    await perform(env.DB, ada, { type: "plugin.install", manifest: MANIFEST, code: "two()", replaces: id });
    expect(await outcome(perform(env.DB, ada, { type: "plugin.decide", id: permit.id, approve: true }))).toBe("conflict: This plugin has been replaced since you read it. Look at it again before deciding. Decline it, and the agent can ask again.");
    await disconnectAgent(env.DB, ada.personId, agentId);
    expect(await outcome(perform(env.DB, ada, { type: "plugin.decide", id: uninstall.id, approve: true }))).toBe("conflict: Claude was disconnected since it asked. Decline it.");
    await perform(env.DB, ada, { type: "plugin.decide", id: uninstall.id, approve: false });
    expect(await names(ada)).toEqual(["Word Tally", "HTML embeds"]);
  });

  it("is checked as the admin's own would be, and no agent answers one", async () => {
    const { ada, agent, token } = await admins();
    expect(await outcome(perform(env.DB, agent, { type: "plugin.install", manifest: "{}", code: "" }))).toMatch(/^invalid: /);
    expect(await outcome(perform(env.DB, agent, { type: "plugin.uninstall", id: "aaaaaaaaaaaa" }))).toBe("not_found: No such plugin");
    const ed = await addMember(ada, "editor", "Ed");
    const eds: Actor = { kind: "agent", agentId: (await connectAgent(env.DB, ed.personId, "Eds")).agent.id, personId: ed.personId, workspaceId: ada.workspaceId };
    expect(await outcome(perform(env.DB, eds, { type: "plugin.install", manifest: MANIFEST, code: "" }))).toBe("forbidden: A editor can't plugin.install");

    const proposed = (await perform(env.DB, agent, { type: "plugin.install", manifest: MANIFEST, code: "" })).proposed!;
    expect(await outcome(perform(env.DB, agent, { type: "plugin.decide", id: proposed.id, approve: true }))).toBe("forbidden: An agent can't plugin.decide");
    expect(JSON.parse((await tool(token, "list_plugin_proposals", { workspace: ada.workspaceId })).text).proposals.map((p: { state: string }) => p.state)).toEqual(["pending"]);
    expect(await names(ada)).toEqual(["HTML embeds"]);
  });
});
