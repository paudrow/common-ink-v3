import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { authenticateAgent, connectAgent, DEFAULT_EXPIRY_DAYS, listAgents, MAX_EXPIRY_DAYS } from "../../src/core/agents.ts";
import { perform } from "../../src/core/operations.ts";
import { sign } from "../../src/worker/session.ts";

const DAY = 86_400_000;

async function newPerson(name = "Ada Lovelace") {
  const { personId } = await signIn(env.DB, { email: `${crypto.randomUUID()}@example.com`, name });
  const [workspace] = (await whoAmI(env.DB, personId)).workspaces;
  return { personId, workspaceId: workspace!.id };
}
const join = (workspaceId: string, personId: string, role = "editor") =>
  env.DB.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, ?)").bind(workspaceId, personId, role).run();

const send = (req: Request, e: Env = env) => worker.fetch(req as never, e);
const call = (token: string, body: unknown) =>
  send(new Request("https://ink.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await call(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: result.content[0]!.text, isError: !!result.isError, json: () => JSON.parse(result.content[0]!.text) };
};

describe("token expiry", () => {
  it("is 90 days unless asked otherwise, and is shown with the agent", async () => {
    const ada = await newPerson();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const short = await connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: 7 });

    expect(DEFAULT_EXPIRY_DAYS).toBe(90);
    expect(agent.expiresAt - agent.createdAt).toBe(90 * DAY);
    expect(short.agent.expiresAt - short.agent.createdAt).toBe(7 * DAY);
    expect((await listAgents(env.DB, ada.personId)).map((a) => a.expiresAt).sort()).toEqual([agent.expiresAt, short.agent.expiresAt].sort());
  });

  it("can't be shorter than a day or longer than a year, or fractional", async () => {
    const ada = await newPerson();
    for (const expiresInDays of [0, -1, 1.5, MAX_EXPIRY_DAYS + 1]) {
      await expect(connectAgent(env.DB, ada.personId, "Claude", { expiresInDays })).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: MAX_EXPIRY_DAYS })).resolves.toBeTruthy();
  });

  it("stops working once it has expired, at /mcp too", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: 1 });

    expect(await authenticateAgent(env.DB, token, agent.expiresAt - 1)).not.toBeNull();
    expect(await authenticateAgent(env.DB, token, agent.expiresAt)).toBeNull();
    expect((await call(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);

    await env.DB.prepare("UPDATE agents SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, agent.id).run();
    expect((await call(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });
});

describe("several tokens under one name", () => {
  it("are allowed, told apart by label, and each is its own author", async () => {
    const ada = await newPerson();
    const laptop = await connectAgent(env.DB, ada.personId, "Claude", { label: "laptop" });
    const server = await connectAgent(env.DB, ada.personId, "Claude", { label: "  server " });
    const plain = await connectAgent(env.DB, ada.personId, "Claude");

    expect([laptop.agent.label, server.agent.label, plain.agent.label]).toEqual(["laptop", "server", null]);
    expect(new Set([laptop.agent.id, server.agent.id, plain.agent.id]).size).toBe(3);

    const note = (await tool(laptop.token, "create_note", { text: "# One" })).json();
    await tool(server.token, "write_note", { id: note.id, baseRevision: 1, text: "# One\n\ntwo" });
    const history = (await tool(laptop.token, "note_history", { id: note.id })).json();
    expect(history.map((h: { author: { name: string; agentId: string } }) => [h.author.name, h.author.agentId])).toEqual([
      ["Claude", laptop.agent.id],
      ["Claude", server.agent.id],
    ]);
  });

  it("can't be labelled with more than a name's length", async () => {
    const ada = await newPerson();
    await expect(connectAgent(env.DB, ada.personId, "Claude", { label: "x".repeat(61) })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("a token pinned to one workspace", () => {
  async function twoWorkspaces() {
    const ada = await newPerson();
    const team = await newPerson("Team Owner");
    await join(team.workspaceId, ada.personId);
    const mine = await perform(env.DB, { kind: "member", ...ada }, { type: "note.create", text: "# Mine" });
    const theirs = await perform(env.DB, { kind: "member", personId: team.personId, workspaceId: team.workspaceId }, { type: "note.create", text: "# Team's" });
    return { ada, team, mine, theirs };
  }

  it("sees only that workspace, and needs no workspace argument even though its member is in two", async () => {
    const { ada, team, mine, theirs } = await twoWorkspaces();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude", { workspaceId: team.workspaceId });
    expect(agent.workspaceId).toBe(team.workspaceId);

    const workspaces = (await tool(token, "list_workspaces")).json().workspaces;
    expect(workspaces.map((w: { id: string }) => w.id)).toEqual([team.workspaceId]);
    expect((await tool(token, "list_notes")).json().map((n: { id: string }) => n.id)).toEqual([theirs.id]);
    expect((await tool(token, "read_note", { id: theirs.id })).json().text).toBe("# Team's");
    expect(await tool(token, "read_note", { id: mine.id })).toMatchObject({ isError: true, text: "not_found: No such note" });
    expect(await tool(token, "list_notes", { workspace: ada.workspaceId })).toMatchObject({ isError: true, text: "not_found: No such workspace" });
    expect(await tool(token, "create_note", { workspace: ada.workspaceId, text: "# Nope" })).toMatchObject({ isError: true });
  });

  it("is refused by the core operations for any other workspace, not only by the tools", async () => {
    const { ada, team, mine } = await twoWorkspaces();
    const agent = { kind: "agent", agentId: "aaaaaaaaaaaa", personId: ada.personId, scope: { pinnedWorkspaceId: team.workspaceId } } as const;
    await expect(perform(env.DB, { ...agent, workspaceId: ada.workspaceId }, { type: "note.read", id: mine.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, { ...agent, workspaceId: team.workspaceId }, { type: "note.list" })).resolves.toEqual([expect.anything()]);
  });

  it("can only be pinned to a workspace its member belongs to", async () => {
    const ada = await newPerson();
    const grace = await newPerson("Grace Hopper");
    await expect(connectAgent(env.DB, ada.personId, "Claude", { workspaceId: grace.workspaceId })).rejects.toMatchObject({ code: "not_found" });
    await expect(connectAgent(env.DB, ada.personId, "Claude", { workspaceId: "nope" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("loses the workspace when its member does", async () => {
    const { ada, team, theirs } = await twoWorkspaces();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude", { workspaceId: team.workspaceId });
    await env.DB.prepare("DELETE FROM members WHERE workspace_id = ? AND person_id = ?").bind(team.workspaceId, ada.personId).run();
    expect((await tool(token, "read_note", { id: theirs.id })).isError).toBe(true);
    expect((await tool(token, "list_workspaces")).json().workspaces).toEqual([]);
  });
});

describe("a read-only token", () => {
  it("reads and can't change anything, even for an editor or admin", async () => {
    const ada = await newPerson();
    const note = await perform(env.DB, { kind: "member", ...ada }, { type: "note.create", text: "# Mine" });
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Reader", { readOnly: true });
    expect(agent.readOnly).toBe(true);

    expect((await tool(token, "list_notes")).json()).toHaveLength(1);
    expect((await tool(token, "read_note", { id: note.id })).json().text).toBe("# Mine");
    expect((await tool(token, "note_history", { id: note.id })).json()).toHaveLength(1);
    expect((await tool(token, "list_workspaces")).json().readOnly).toBe(true);

    expect(await tool(token, "write_note", { id: note.id, baseRevision: 1, text: "# Changed" })).toMatchObject({ isError: true, text: "forbidden: A read-only token can't note.write" });
    expect(await tool(token, "create_note", { text: "# New" })).toMatchObject({ isError: true, text: "forbidden: A read-only token can't note.create" });
    expect((await perform(env.DB, { kind: "member", ...ada }, { type: "note.read", id: note.id })).text).toBe("# Mine");
    expect(await perform(env.DB, { kind: "member", ...ada }, { type: "note.list" })).toHaveLength(1);
  });

  it("is enforced by the core operations too", async () => {
    const ada = await newPerson();
    const actor = { kind: "agent", agentId: "aaaaaaaaaaaa", ...ada, scope: { readOnly: true } } as const;
    await expect(perform(env.DB, actor, { type: "note.create", text: "# x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(perform(env.DB, actor, { type: "note.list" })).resolves.toEqual([]);
    const empty = await perform(env.DB, { kind: "member", ...ada }, { type: "folder.create", name: "Empty" });
    await expect(perform(env.DB, actor, { type: "folder.delete", id: empty.id })).rejects.toMatchObject({ code: "forbidden", message: "A read-only token can't folder.delete" });
  });

  it("leaves a token that isn't read-only able to write", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Writer");
    expect(agent.readOnly).toBe(false);
    expect((await tool(token, "create_note", { text: "# Fine" })).isError).toBe(false);
  });
});

describe("/api/agents with options", () => {
  async function asMember() {
    const ada = await newPerson();
    const as = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, "test-secret", 3600))}`;
    const fetchAs = (path: string, init: RequestInit = {}) =>
      send(new Request(`https://ink.test${path}`, { ...init, headers: { ...(init.headers as object), Cookie: as, Origin: "https://ink.test", "Content-Type": "application/json" } }), { ...env, SESSION_SECRET: "test-secret" });
    return { ada, fetchAs };
  }

  it("takes expiresInDays, workspaceId, readOnly and label, and lists them back", async () => {
    const { ada, fetchAs } = await asMember();
    const made = await fetchAs("/api/agents", { method: "POST", body: JSON.stringify({ name: "Claude", label: "laptop", expiresInDays: 30, workspaceId: ada.workspaceId, readOnly: true }) });
    expect(made.status).toBe(201);
    const { agent, token } = (await made.json()) as { agent: Record<string, unknown>; token: string };
    expect(agent).toMatchObject({ name: "Claude", label: "laptop", workspaceId: ada.workspaceId, readOnly: true });
    expect((agent.expiresAt as number) - (agent.createdAt as number)).toBe(30 * DAY);

    const listed = (await (await fetchAs("/api/agents")).json()) as { agents: Array<Record<string, unknown>> };
    expect(listed.agents[0]).toMatchObject({ id: agent.id, expiresAt: agent.expiresAt, workspaceId: ada.workspaceId, readOnly: true, label: "laptop" });
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it("defaults to 90 days, reach everything, and can write; nulls count as not given", async () => {
    const { fetchAs } = await asMember();
    const { agent } = (await (await fetchAs("/api/agents", { method: "POST", body: JSON.stringify({ name: "Claude", expiresInDays: null, workspaceId: null, readOnly: null, label: null }) })).json()) as { agent: Record<string, number | null | boolean> };
    expect((agent.expiresAt as number) - (agent.createdAt as number)).toBe(90 * DAY);
    expect(agent).toMatchObject({ workspaceId: null, readOnly: false, label: null });
  });

  it("answers 400 for options of the wrong kind or size and 404 for a workspace that isn't the member's", async () => {
    const { fetchAs } = await asMember();
    const post = (body: unknown) => fetchAs("/api/agents", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ name: "Claude", expiresInDays: 400 })).status).toBe(400);
    expect((await post({ name: "Claude", expiresInDays: "30" })).status).toBe(400);
    expect((await post({ name: "Claude", readOnly: "yes" })).status).toBe(400);
    expect((await post({ name: "Claude", workspaceId: "zzzzzzzzzzzz" })).status).toBe(404);
  });
});
