import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { MAX_ACTIVE_AGENTS, authenticateAgent, connectAgent, disconnectAgent, editAgent, listAgents } from "../../src/core/agents.ts";
import { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS } from "../../src/core/protocol.ts";
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
    expect(agent.expiresAt! - agent.createdAt).toBe(90 * DAY);
    expect(short.agent.expiresAt! - short.agent.createdAt).toBe(7 * DAY);
    expect((await listAgents(env.DB, ada.personId)).map((a) => a.expiresAt).sort()).toEqual([agent.expiresAt, short.agent.expiresAt].sort());
  });

  it("can't be shorter than a day or longer than a year, or fractional", async () => {
    const ada = await newPerson();
    for (const expiresInDays of [0, -1, 1.5, MAX_EXPIRY_DAYS + 1]) {
      await expect(connectAgent(env.DB, ada.personId, "Claude", { expiresInDays })).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: MAX_EXPIRY_DAYS })).resolves.toBeTruthy();
  });

  it("can be never: the token works a lifetime on, is listed with no end, and still counts as connected", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: "never" });

    expect(agent.expiresAt).toBeNull();
    expect((await listAgents(env.DB, ada.personId))[0]!.expiresAt).toBeNull();
    expect(await authenticateAgent(env.DB, token, agent.createdAt + 100 * 365 * DAY)).toMatchObject({ agentId: agent.id });
    expect((await call(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);

    for (let i = 1; i < MAX_ACTIVE_AGENTS; i++) await connectAgent(env.DB, ada.personId, `Agent ${i}`, { expiresInDays: "never" });
    await expect(connectAgent(env.DB, ada.personId, "One too many")).rejects.toMatchObject({ code: "invalid" });
    await disconnectAgent(env.DB, ada.personId, agent.id);
    expect(await authenticateAgent(env.DB, token)).toBeNull();
  });

  it("stops working once it has expired, at /mcp too", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: 1 });

    expect(await authenticateAgent(env.DB, token, agent.expiresAt! - 1)).not.toBeNull();
    expect(await authenticateAgent(env.DB, token, agent.expiresAt!)).toBeNull();
    expect((await call(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);

    await env.DB.prepare("UPDATE agents SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, agent.id).run();
    expect((await call(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });
});

describe("several tokens under one name", () => {
  it("are allowed, each its own author, with the name the only thing a member gives it", async () => {
    const ada = await newPerson();
    const laptop = await connectAgent(env.DB, ada.personId, "Claude");
    // A second name for it is refused with every other option nobody defined, and not dropped without a word.
    await expect(connectAgent(env.DB, ada.personId, "Claude", { label: "server" } as never)).rejects.toMatchObject({ code: "invalid" });
    const server = await connectAgent(env.DB, ada.personId, "Claude");

    expect(Object.keys(server.agent)).not.toContain("label");
    expect(laptop.agent.id).not.toBe(server.agent.id);

    const note = (await tool(laptop.token, "create_note", { text: "# One" })).json();
    await tool(server.token, "write_note", { id: note.id, baseRevision: 1, text: "# One\n\ntwo" });
    const history = (await tool(laptop.token, "note_history", { id: note.id })).json();
    expect(history.map((h: { author: { name: string; agentId: string } }) => [h.author.name, h.author.agentId])).toEqual([
      ["Claude", laptop.agent.id],
      ["Claude", server.agent.id],
    ]);
  });
});

describe("editing an agent", () => {
  it("changes what its token may do from the next call on, and keeps the token", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");
    expect((await tool(token, "create_note", { text: "# Before" })).isError).toBe(false);

    const edited = await editAgent(env.DB, ada.personId, agent.id, { readOnly: true });

    expect(edited).toEqual({ ...agent, readOnly: true, lastUsedAt: expect.any(Number) });
    expect((await tool(token, "create_note", { text: "# After" })).text).toContain("A read-only token can't note.create");
    expect((await tool(token, "list_notes")).json().notes).toHaveLength(1);
    await editAgent(env.DB, ada.personId, agent.id, { readOnly: false });
    expect((await tool(token, "create_note", { text: "# Again" })).isError).toBe(false);
  });

  it("sets when the token ends, counted from the edit, or never, and leaves what it isn't given", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: 30, readOnly: true });
    const later = agent.createdAt + 10 * DAY;

    expect((await editAgent(env.DB, ada.personId, agent.id, { expiresInDays: 7 }, later)).expiresAt).toBe(later + 7 * DAY);
    expect(await authenticateAgent(env.DB, token, later + 7 * DAY)).toBeNull();
    const forever = await editAgent(env.DB, ada.personId, agent.id, { expiresInDays: "never" }, later);
    expect(forever).toMatchObject({ expiresAt: null, readOnly: true, workspaceId: null });
    expect(await authenticateAgent(env.DB, token, later + 1000 * DAY)).not.toBeNull();
    expect((await editAgent(env.DB, ada.personId, agent.id, {}, later)).expiresAt).toBeNull();
    for (const expiresInDays of [0, 1.5, MAX_EXPIRY_DAYS + 1, "soon"]) {
      await expect(editAgent(env.DB, ada.personId, agent.id, { expiresInDays } as never)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("writes only the fields it is given, so two edits at once both hold", async () => {
    const ada = await newPerson();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");

    await Promise.all([editAgent(env.DB, ada.personId, agent.id, { readOnly: true }), editAgent(env.DB, ada.personId, agent.id, { workspaceId: ada.workspaceId }), editAgent(env.DB, ada.personId, agent.id, { expiresInDays: "never" })]);

    expect((await listAgents(env.DB, ada.personId))[0]).toMatchObject({ readOnly: true, workspaceId: ada.workspaceId, expiresAt: null });
  });

  it("pins it to one of the member's workspaces or lets it reach them all again", async () => {
    const ada = await newPerson();
    const grace = await newPerson("Grace Hopper");
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");

    expect((await editAgent(env.DB, ada.personId, agent.id, { workspaceId: ada.workspaceId })).workspaceId).toBe(ada.workspaceId);
    expect((await authenticateAgent(env.DB, token))!.workspaceId).toBe(ada.workspaceId);
    await expect(editAgent(env.DB, ada.personId, agent.id, { workspaceId: grace.workspaceId })).rejects.toMatchObject({ code: "not_found" });
    expect((await editAgent(env.DB, ada.personId, agent.id, { workspaceId: null })).workspaceId).toBeNull();
  });

  it("brings an expired token back, unless that is one agent too many", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude", { expiresInDays: 1 });
    const later = agent.createdAt + 2 * DAY;
    expect(await authenticateAgent(env.DB, token, later)).toBeNull();
    for (let i = 0; i < MAX_ACTIVE_AGENTS; i++) await connectAgent(env.DB, ada.personId, `Agent ${i}`, {}, later);

    await expect(editAgent(env.DB, ada.personId, agent.id, { expiresInDays: 30 }, later)).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("disconnect one first") });
    expect((await editAgent(env.DB, ada.personId, agent.id, { readOnly: true }, later)).readOnly).toBe(true);
    await disconnectAgent(env.DB, ada.personId, (await listAgents(env.DB, ada.personId)).find((a) => a.name === "Agent 0")!.id, later);
    await editAgent(env.DB, ada.personId, agent.id, { expiresInDays: 30 }, later);
    expect(await authenticateAgent(env.DB, token, later)).not.toBeNull();
  });

  it("is refused for a disconnected agent, which stays disconnected", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");
    await disconnectAgent(env.DB, ada.personId, agent.id);

    await expect(editAgent(env.DB, ada.personId, agent.id, { expiresInDays: "never" })).rejects.toMatchObject({ code: "invalid" });
    expect(await authenticateAgent(env.DB, token)).toBeNull();
  });

  it("is the owner's alone: not another member's, an admin of a shared workspace's, or the agent's own", async () => {
    const ada = await newPerson();
    const grace = await newPerson("Grace Hopper");
    await join(grace.workspaceId, ada.personId, "editor");
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude", { readOnly: true, workspaceId: grace.workspaceId });

    await expect(editAgent(env.DB, grace.personId, agent.id, { readOnly: false })).rejects.toMatchObject({ code: "not_found" });
    const asAgent = await send(
      new Request(`https://ink.test/api/agents/${agent.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, Origin: "https://ink.test", "Content-Type": "application/json" }, body: JSON.stringify({ readOnly: false }) }),
    );
    expect(asAgent.status).toBe(401);
    expect((await tool(token, "list_notes")).isError).toBe(false);
    expect((await listAgents(env.DB, ada.personId))[0]).toMatchObject({ readOnly: true, workspaceId: grace.workspaceId });
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
    expect((await tool(token, "list_notes")).json().notes.map((n: { id: string }) => n.id)).toEqual([theirs.id]);
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

    expect((await tool(token, "list_notes")).json().notes).toHaveLength(1);
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

  it("takes expiresInDays, workspaceId and readOnly, and lists them back", async () => {
    const { ada, fetchAs } = await asMember();
    const made = await fetchAs("/api/agents", { method: "POST", body: JSON.stringify({ name: "Claude", expiresInDays: 30, workspaceId: ada.workspaceId, readOnly: true }) });
    expect(made.status).toBe(201);
    const { agent, token } = (await made.json()) as { agent: Record<string, unknown>; token: string };
    expect(agent).toMatchObject({ name: "Claude", workspaceId: ada.workspaceId, readOnly: true });
    expect((agent.expiresAt as number) - (agent.createdAt as number)).toBe(30 * DAY);

    const listed = (await (await fetchAs("/api/agents")).json()) as { agents: Array<Record<string, unknown>> };
    expect(listed.agents[0]).toMatchObject({ id: agent.id, expiresAt: agent.expiresAt, workspaceId: ada.workspaceId, readOnly: true });
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it("defaults to 90 days, reach everything, and can write; nulls count as not given", async () => {
    const { fetchAs } = await asMember();
    const { agent } = (await (await fetchAs("/api/agents", { method: "POST", body: JSON.stringify({ name: "Claude", expiresInDays: null, workspaceId: null, readOnly: null }) })).json()) as { agent: Record<string, number | null | boolean> };
    expect((agent.expiresAt as number) - (agent.createdAt as number)).toBe(90 * DAY);
    expect(agent).toMatchObject({ workspaceId: null, readOnly: false });
  });

  it("answers 400 for options of the wrong kind or size and 404 for a workspace that isn't the member's", async () => {
    const { fetchAs } = await asMember();
    const post = (body: unknown) => fetchAs("/api/agents", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ name: "Claude", expiresInDays: 400 })).status).toBe(400);
    expect((await post({ name: "Claude", expiresInDays: "30" })).status).toBe(400);
    expect((await post({ name: "Claude", readOnly: "yes" })).status).toBe(400);
    expect((await post({ name: "Claude", workspaceId: "zzzzzzzzzzzz" })).status).toBe(404);
  });

  it("connects an agent that never expires", async () => {
    const { fetchAs } = await asMember();
    const { agent } = (await (await fetchAs("/api/agents", { method: "POST", body: JSON.stringify({ name: "Claude", expiresInDays: "never" }) })).json()) as { agent: Record<string, unknown> };
    expect(agent.expiresAt).toBeNull();
  });

  it("edits an agent with PATCH, where a null workspace means every workspace, and only from Common Ink's own pages", async () => {
    const { ada, fetchAs } = await asMember();
    const { agent } = (await (await fetchAs("/api/agents", { method: "POST", body: JSON.stringify({ name: "Claude", workspaceId: ada.workspaceId }) })).json()) as { agent: { id: string } };
    const patch = (body: unknown, headers: Record<string, string> = {}) => fetchAs(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify(body), headers });

    const edited = await patch({ readOnly: true, expiresInDays: "never", workspaceId: null });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { agent: unknown }).agent).toMatchObject({ id: agent.id, readOnly: true, expiresAt: null, workspaceId: null });
    expect((await patch({ readOnly: "yes" })).status).toBe(400);
    expect((await patch({ name: "Renamed" })).status).toBe(400);
    expect((await patch({ workspaceId: "zzzzzzzzzzzz" })).status).toBe(404);
    expect((await fetchAs("/api/agents/zzzzzzzzzzzz", { method: "PATCH", body: "{}" })).status).toBe(404);
    const elsewhere = await send(
      new Request(`https://ink.test/api/agents/${agent.id}`, { method: "PATCH", headers: { Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, "test-secret", 3600))}`, Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}" }),
      { ...env, SESSION_SECRET: "test-secret" },
    );
    expect(elsewhere.status).toBe(403);
  });
});
