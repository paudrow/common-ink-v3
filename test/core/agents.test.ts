import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { authenticateAgent, connectAgent, disconnectAgent, hashToken, listAgents, MAX_ACTIVE_AGENTS } from "../../src/core/agents.ts";
import { perform } from "../../src/core/operations.ts";
import { run } from "../../scripts/ink-cli.ts";

async function newPerson(name = "Ada Lovelace") {
  const { personId } = await signIn(env.DB, { email: `${crypto.randomUUID()}@example.com`, name });
  const [workspace] = (await whoAmI(env.DB, personId)).workspaces;
  return { personId, workspaceId: workspace!.id };
}

const send = (req: Request, e: Env = env) => worker.fetch(req as never, e);

const URL_ = "https://ink.test/mcp";
const call = (token: string | null, body: unknown, init: RequestInit = {}) =>
  send(
    new Request(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      ...init,
    }),
    env,
  );

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await call(token, rpc("tools/call", { name, arguments: args }));
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: result.content[0]!.text, isError: !!result.isError, json: () => JSON.parse(result.content[0]!.text) };
};

describe("agent tokens", () => {
  it("are shown once, and only their hash is stored", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");
    const stored = await env.DB.prepare("SELECT token_prefix, token_hash FROM agents WHERE id = ?").bind(agent.id).first<{ token_prefix: string; token_hash: string }>();

    expect(token).toMatch(/^cink_[A-Za-z0-9_-]{43}$/);
    expect(stored!.token_hash).toBe(await hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(await listAgents(env.DB, ada.personId))).not.toContain(token);
    expect(token.startsWith(stored!.token_prefix)).toBe(true);
  });

  it("belong to the member who made them, and only they can disconnect them", async () => {
    const ada = await newPerson();
    const grace = await newPerson("Grace Hopper");
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");

    await expect(disconnectAgent(env.DB, grace.personId, agent.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await authenticateAgent(env.DB, token)).toMatchObject({ agentId: agent.id, personId: ada.personId });
    expect(await listAgents(env.DB, grace.personId)).toEqual([]);
  });

  it("stop working when the agent is disconnected", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");
    await disconnectAgent(env.DB, ada.personId, agent.id);
    await disconnectAgent(env.DB, ada.personId, agent.id);

    expect(await authenticateAgent(env.DB, token)).toBeNull();
    expect((await call(token, rpc("tools/list"))).status).toBe(401);
    expect((await listAgents(env.DB, ada.personId))[0]!.revokedAt).not.toBeNull();
  });

  it("need a name, and a member can have only so many connected", async () => {
    const ada = await newPerson();
    await expect(connectAgent(env.DB, ada.personId, "   ")).rejects.toMatchObject({ code: "invalid" });
    await expect(connectAgent(env.DB, ada.personId, "x".repeat(61))).rejects.toMatchObject({ code: "invalid" });
    for (let i = 0; i < MAX_ACTIVE_AGENTS; i++) await connectAgent(env.DB, ada.personId, `Agent ${i}`);
    await expect(connectAgent(env.DB, ada.personId, "One too many")).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("/mcp sign-in", () => {
  it("answers 401 with a challenge when there is no token", async () => {
    const res = await call(null, rpc("tools/list"));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
  });

  it("answers 401 for a token it doesn't know, a malformed header, and a person's session cookie", async () => {
    expect((await call("cink_" + "A".repeat(43), rpc("tools/list"))).status).toBe(401);
    expect((await call("not-a-token", rpc("tools/list"))).status).toBe(401);
    const basic = await send(new Request(URL_, { method: "POST", headers: { Authorization: "Basic abc", "Content-Type": "application/json" }, body: "{}" }), env);
    expect(basic.status).toBe(401);
    const cookie = await send(new Request(URL_, { method: "POST", headers: { Cookie: "__Host-ink_session=whatever", "Content-Type": "application/json" }, body: "{}" }), env);
    expect(cookie.status).toBe(401);
  });

  it("accepts a valid token", async () => {
    const { token } = await connectAgent(env.DB, (await newPerson()).personId, "Claude");
    expect((await call(token, rpc("tools/list"))).status).toBe(200);
  });

  it("refuses GET and a body that isn't JSON, once signed in", async () => {
    const { token } = await connectAgent(env.DB, (await newPerson()).personId, "Claude");
    expect((await send(new Request(URL_, { headers: { Authorization: `Bearer ${token}` } }), env)).status).toBe(405);
    expect((await call(token, null, { body: "{nope" })).status).toBe(400);
    expect((await call(token, null, { headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}` }, body: "x" })).status).toBe(415);
  });
});

describe("MCP protocol", () => {
  it("initializes, lists its tools, and says nothing back to a notification", async () => {
    const { token } = await connectAgent(env.DB, (await newPerson()).personId, "Claude");

    const init = (await (await call(token, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))).json()) as any;
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "common-ink" }, capabilities: { tools: {} } });
    const old = (await (await call(token, rpc("initialize", { protocolVersion: "1999-01-01" }))).json()) as any;
    expect(old.result.protocolVersion).toBe("2025-06-18");

    const note = await call(token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.status).toBe(202);

    const list = (await (await call(token, rpc("tools/list"))).json()) as any;
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_workspaces",
      "list_notes",
      "read_note",
      "create_note",
      "write_note",
      "backlinks",
      "rebuild_links",
      "list_todos",
      "todo_filters",
      "set_todo",
      "todo_history",
      "daily_note",
      "rebuild_todos",
      "move_note",
      "search",
      "list_tags",
      "archive_note",
      "trash_note",
      "restore_note",
      "list_trash",
      "list_uploads",
      "read_upload",
      "move_upload",
      "archive_upload",
      "trash_upload",
      "restore_upload",
      "list_trashed_uploads",
      "list_folders",
      "create_folder",
      "rename_folder",
      "delete_folder",
      "note_history",
      "change_diff",
      "history_summary",
      "history",
      "history_authors",
      "history_diff",
      "preview_reverts",
      "revert_many",
      "label_revision",
      "revert_note",
      "revert_changes",
      "revert_author",
      "preview_revert",
      "undo",
      "redo",
      "list_sources",
      "list_events",
      "update_event",
      "create_event",
      "list_contacts",
      "read_person",
      "refer_record",
      "read_record",
      "notes_about_record",
      "list_members",
    ]);
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe("object");
  });

  it("reports unknown methods and tools, and bad requests, as JSON-RPC errors", async () => {
    const { token } = await connectAgent(env.DB, (await newPerson()).personId, "Claude");
    expect(((await (await call(token, rpc("nope"))).json()) as any).error.code).toBe(-32601);
    expect(((await (await call(token, rpc("tools/call", { name: "delete_everything" }))).json()) as any).error.code).toBe(-32602);
    expect(((await (await call(token, { id: 1 })).json()) as any).error.code).toBe(-32600);
    expect(((await (await call(token, rpc("ping"))).json()) as any).result).toEqual({});
  });

  it("answers a batch with one answer per request", async () => {
    const { token } = await connectAgent(env.DB, (await newPerson()).personId, "Claude");
    const answers = (await (await call(token, [rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("tools/list", undefined, 2)])).json()) as any[];
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
  });
});

describe("MCP tools", () => {
  it("list_workspaces names the member's workspaces and role", async () => {
    const ada = await newPerson();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const { json } = await tool(token, "list_workspaces");
    expect(json().workspaces).toEqual([expect.objectContaining({ id: ada.workspaceId, role: "admin" })]);
    expect(json().person.name).toBe("Ada Lovelace");
  });

  it("create_note, read_note, write_note, list_notes and note_history work a note end to end", async () => {
    const { token } = await connectAgent(env.DB, (await newPerson()).personId, "Claude");

    const created = (await tool(token, "create_note", { text: "# Plan\n\nStep one" })).json();
    expect(created).toMatchObject({ title: "Plan", revision: 1 });
    const read = (await tool(token, "read_note", { id: created.id })).json();
    expect(read.text).toBe("# Plan\n\nStep one");

    const written = (await tool(token, "write_note", { id: created.id, baseRevision: 1, text: "# Plan\n\nStep one\nStep two", writeId: "w1" })).json();
    expect(written.revision).toBe(2);
    const again = (await tool(token, "write_note", { id: created.id, baseRevision: 1, text: "# Plan\n\nStep one\nStep two", writeId: "w1" })).json();
    expect(again.revision).toBe(2);
    expect((await tool(token, "read_note", { id: created.id, revision: 1 })).json().text).toBe("# Plan\n\nStep one");

    expect((await tool(token, "list_notes")).json()).toEqual([expect.objectContaining({ id: created.id, revision: 2 })]);
    const history = (await tool(token, "note_history", { id: created.id })).json();
    expect(history.map((h: { revision: number }) => h.revision)).toEqual([1, 2]);
  });

  it("records an agent's changes under the agent's name, apart from the member's own", async () => {
    const ada = await newPerson();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");
    const note = await perform(env.DB, { kind: "member", ...ada }, { type: "note.create", text: "# Mine" });
    await tool(token, "write_note", { id: note.id, baseRevision: 1, text: "# Mine\n\nfrom the agent" });

    const history = await perform(env.DB, { kind: "member", ...ada }, { type: "note.history", id: note.id });

    expect(history.map((h) => h.author)).toEqual([
      { kind: "member", personId: ada.personId, name: "Ada Lovelace" },
      { kind: "agent", agentId: agent.id, name: "Claude", onBehalfOf: ada.personId },
    ]);
    const row = await env.DB.prepare("SELECT author_kind, author_id FROM changes WHERE note_id = ? AND revision = 2").bind(note.id).first();
    expect(row).toEqual({ author_kind: "agent", author_id: agent.id });
  });

  it("lists a note an agent wrote or created last as changed by the agent", async () => {
    const ada = await newPerson();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const claude = { kind: "agent", agentId: agent.id, ...ada } as const;
    const note = await perform(env.DB, { kind: "member", ...ada }, { type: "note.create", text: "# Plan" }, 1000);
    await perform(env.DB, claude, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\nby Claude" }, 2000);
    await perform(env.DB, claude, { type: "note.create", text: "# Claude's" }, 3000);

    const listed = await perform(env.DB, { kind: "member", ...ada }, { type: "note.list" });

    const byClaude = { kind: "agent", agentId: agent.id, name: "Claude", onBehalfOf: ada.personId };
    expect(listed.map((n) => [n.title, n.updatedBy])).toEqual([
      ["Claude's", byClaude],
      ["Plan", byClaude],
    ]);
  });

  it("refuses an argument the tool doesn't take, by name, rather than leaving it out", async () => {
    const ada = await newPerson();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const folder = await perform(env.DB, { kind: "member", ...ada }, { type: "folder.create", name: "Plans" });

    expect(await tool(token, "create_note", { text: "# Hi", folder_id: folder.id })).toMatchObject({ isError: true, text: 'invalid: create_note takes no "folder_id". It takes workspace, text, folderId, linkTitles, mentionNames.' });
    expect(await tool(token, "list_workspaces", { all: true })).toMatchObject({ isError: true, text: 'invalid: list_workspaces takes no "all". It takes no arguments.' });
    expect((await tool(token, "list_notes")).json()).toEqual([]);
  });

  it("reports a failure as a tool error the agent can read", async () => {
    const { token } = await connectAgent(env.DB, (await newPerson()).personId, "Claude");
    expect(await tool(token, "read_note", { id: "aaaaaaaaaaaa" })).toMatchObject({ isError: true, text: "not_found: No such note" });
    expect(await tool(token, "read_note", { id: "bad" })).toMatchObject({ isError: true });
    expect(await tool(token, "write_note", { id: "aaaaaaaaaaaa" })).toMatchObject({ isError: true });
  });
});

describe("what an agent can reach", () => {
  it("is what its member can: another member's workspace and notes are out of reach", async () => {
    const ada = await newPerson();
    const grace = await newPerson("Grace Hopper");
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const secret = await perform(env.DB, { kind: "member", ...grace }, { type: "note.create", text: "# Grace's" });

    expect(await tool(token, "read_note", { id: secret.id })).toMatchObject({ isError: true, text: "not_found: No such note" });
    expect(await tool(token, "list_notes", { workspace: grace.workspaceId })).toMatchObject({ isError: true, text: "not_found: No such workspace" });
    expect((await tool(token, "list_notes")).json()).toEqual([]);
  });

  it("is capped by the member's role: a viewer's agent reads but can't write", async () => {
    const owner = await newPerson();
    const viewer = await newPerson("Vee Viewer");
    await env.DB.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, 'viewer')").bind(owner.workspaceId, viewer.personId).run();
    const note = await perform(env.DB, { kind: "member", ...owner }, { type: "note.create", text: "# Shared" });
    const { token } = await connectAgent(env.DB, viewer.personId, "Vee's agent");

    expect((await tool(token, "read_note", { id: note.id, workspace: owner.workspaceId })).json().text).toBe("# Shared");
    expect(await tool(token, "write_note", { workspace: owner.workspaceId, id: note.id, baseRevision: 1, text: "# Hacked" })).toMatchObject({ isError: true, text: "forbidden: A viewer can't note.write" });
    expect(await tool(token, "create_note", { workspace: owner.workspaceId, text: "# New" })).toMatchObject({ isError: true });
  });

  it("needs a workspace named when the member is in several, and honours it", async () => {
    const ada = await newPerson();
    const owner = await newPerson("Owner");
    await env.DB.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, 'editor')").bind(owner.workspaceId, ada.personId).run();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");

    expect((await tool(token, "list_notes")).text).toMatch(/^invalid: Pass workspace/);
    const made = (await tool(token, "create_note", { workspace: owner.workspaceId, text: "# In Owner's" })).json();
    expect((await perform(env.DB, { kind: "member", ...owner }, { type: "note.read", id: made.id })).title).toBe("In Owner's");
  });

  it("is gone when the member loses access", async () => {
    const owner = await newPerson();
    const ada = await newPerson();
    await env.DB.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, 'editor')").bind(owner.workspaceId, ada.personId).run();
    const note = await perform(env.DB, { kind: "member", ...owner }, { type: "note.create", text: "# Team note" });
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    expect((await tool(token, "read_note", { workspace: owner.workspaceId, id: note.id })).isError).toBe(false);

    await env.DB.prepare("DELETE FROM members WHERE workspace_id = ? AND person_id = ?").bind(owner.workspaceId, ada.personId).run();

    expect(await tool(token, "read_note", { workspace: owner.workspaceId, id: note.id })).toMatchObject({ isError: true, text: "not_found: No such workspace" });
  });
});

describe("/api/agents", () => {
  const sameOrigin = { Origin: "https://ink.test", "Content-Type": "application/json" };

  it("needs a signed-in member", async () => {
    const res = await send(new Request("https://ink.test/api/agents"), env);
    expect(res.status).toBe(401);
  });

  it("connects an agent with a visible-once token, lists it without the token, and disconnects it", async () => {
    // A session cookie is made the way Common Ink makes one.
    const { sign } = await import("../../src/worker/session.ts");
    const ada = await newPerson();
    const secretEnv = { ...env, SESSION_SECRET: "test-secret" };
    const as = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, "test-secret", 3600))}`;
    const fetchAs = (path: string, init: RequestInit = {}) =>
      send(new Request(`https://ink.test${path}`, { ...init, headers: { ...(init.headers as object), Cookie: as } }), secretEnv);

    expect((await fetchAs("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Claude" }) })).status).toBe(403);

    const made = await fetchAs("/api/agents", { method: "POST", headers: sameOrigin, body: JSON.stringify({ name: "Claude" }) });
    expect(made.status).toBe(201);
    const { agent, token } = (await made.json()) as { agent: { id: string }; token: string };
    expect(token).toMatch(/^cink_/);

    const listed = await (await fetchAs("/api/agents")).text();
    expect(listed).toContain(agent.id);
    expect(listed).not.toContain(token);
    expect((await call(token, rpc("tools/list"))).status).toBe(200);

    expect((await fetchAs(`/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await fetchAs(`/api/agents/${agent.id}`, { method: "DELETE", headers: { Origin: "https://ink.test" } })).status).toBe(204);
    expect((await call(token, rpc("tools/list"))).status).toBe(401);
    expect((await fetchAs("/api/agents", { method: "POST", headers: sameOrigin, body: JSON.stringify({}) })).status).toBe(400);
  });

  it("refuses an option it doesn't know, so a misspelt limit never mints a token broader than was asked for", async () => {
    const { sign } = await import("../../src/worker/session.ts");
    const ada = await newPerson();
    const secretEnv = { ...env, SESSION_SECRET: "test-secret" };
    const as = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, "test-secret", 3600))}`;
    const post = (body: string) => send(new Request("https://ink.test/api/agents", { method: "POST", headers: { ...sameOrigin, Cookie: as }, body }), secretEnv);
    const agents = async () => ((await (await send(new Request("https://ink.test/api/agents", { headers: { Cookie: as } }), secretEnv)).json()) as { agents: { readOnly: boolean; workspaceId: string | null }[] }).agents;

    for (const body of [
      `{"name":"x","readonly":true}`,
      `{"name":"x","readonly":null}`,
      `{"name":"x","read_only":true}`,
      `{"name":"x","workspace":"${ada.workspaceId}"}`,
      `{"name":"x","workspaceID":"${ada.workspaceId}"}`,
      `{"name":"x","expiresIn":1}`,
      `{"name":"x","readOnly":true,"scope":{"readOnly":false}}`,
      `{"name":"x","readOnly":true,"__proto__":{"readOnly":false}}`,
      `{"name":"x","readOnly":"true"}`,
      `{"name":"x","readOnly":1}`,
      `{"name":"x","workspaceId":""}`,
      `{"name":"x","workspaceId":["${ada.workspaceId}"]}`,
      `[{"name":"x"}]`,
      `"x"`,
      `null`,
    ]) {
      const res = await post(body);
      expect([body, res.status]).toEqual([body, 400]);
      expect(((await res.json()) as { error: string }).error).toBe("invalid");
    }
    expect((await post(`{"name":"x","readonly":true}`).then((r) => r.json() as Promise<{ message: string }>)).message).toContain("readonly");
    expect(await agents()).toEqual([]);

    // What it does know still narrows the token, and a null workspace or expiry is one not given.
    expect((await post(`{"name":"x","readOnly":true,"workspaceId":"${ada.workspaceId}","expiresInDays":1}`)).status).toBe(201);
    expect((await post(`{"name":"y","workspaceId":null,"expiresInDays":null}`)).status).toBe(201);
    expect((await agents()).map((a) => [a.readOnly, a.workspaceId]).sort()).toEqual([[false, null], [true, ada.workspaceId]].sort());
    await expect(connectAgent(env.DB, ada.personId, "z", { readonly: true } as never)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("a fault that is nobody's request", () => {
  /** The database, except that a query of `table` throws what a database that is down would. */
  const without = (table: string): Env => ({
    ...env,
    SESSION_SECRET: "test-secret",
    DB: new Proxy(env.DB, {
      get(db, key) {
        if (key !== "prepare") return Reflect.get(db, key).bind?.(db) ?? Reflect.get(db, key);
        return (sql: string) => {
          if (new RegExp(`\\b${table}\\b`).test(sql)) throw new Error(`D1_ERROR: no such table: ${table} (secret detail)`);
          return db.prepare(sql);
        };
      },
    }),
  });

  it("is answered as JSON that says the server broke, to the web app and to an agent, with none of the fault's own words", async () => {
    const { sign } = await import("../../src/worker/session.ts");
    const ada = await newPerson();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const as = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, "test-secret", 3600))}`;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const op = await send(
      new Request(`https://ink.test/api/workspaces/${ada.workspaceId}/ops`, { method: "POST", headers: { Origin: "https://ink.test", "Content-Type": "application/json", Cookie: as }, body: JSON.stringify({ type: "note.list" }) }),
      without("notes"),
    );
    expect(op.status).toBe(500);
    expect(await op.json()).toEqual({ error: "unknown", message: "Common Ink broke while doing that. Nothing says it was done: try again" });

    const mcp = (e: Env) => send(new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(rpc("tools/call", { name: "list_notes", arguments: {} }, 7)) }), e);
    const called = await mcp(without("notes"));
    expect(called.status).toBe(200);
    expect(await called.json()).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "Common Ink broke while doing that. Nothing says it was done: try again" } });

    // Before any message is read, there is no id to answer.
    const refused = await mcp(without("agents"));
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Common Ink broke while doing that. Nothing says it was done: try again" } });
    expect(quiet).toHaveBeenCalledTimes(3);
    quiet.mockRestore();
  });

  it("is said by the ink command in a line, whatever came back: nothing, a page that isn't JSON, or an error with no message", async () => {
    const said: string[] = [];
    const io = (fetch_: () => Promise<Response>) => ({ env: { INK_TOKEN: "cink_x", INK_URL: "https://ink.test" }, stdin: async () => "", out: (line: string) => said.push(line), fetch: fetch_ as unknown as typeof fetch });

    expect(await run(["notes"], io(async () => Promise.reject(new TypeError("fetch failed"))))).toBe(1);
    expect(await run(["notes"], io(async () => new Response("<!DOCTYPE html><title>Worker threw exception</title>", { status: 500, statusText: "Internal Server Error" })))).toBe(1);
    expect(await run(["notes"], io(async () => Response.json({ error: "too_large" }, { status: 413 })))).toBe(1);
    expect(await run(["notes"], io(async () => Response.json({ error: "unsupported_media_type", message: "Send application/json" }, { status: 415 })))).toBe(1);
    expect(await run(["notes"], io(async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Common Ink broke" } })))).toBe(1);

    expect(said).toEqual([
      "ink: Couldn't reach https://ink.test: fetch failed",
      "ink: https://ink.test answered 500 Internal Server Error, and not with JSON",
      "ink: https://ink.test answered 413: too_large",
      "ink: https://ink.test answered 415: Send application/json",
      "ink: Common Ink broke",
    ]);
  });
});

describe("the ink command", () => {
  it("sends each command to /mcp as a tool call with the token, and prints the answer", async () => {
    const seen: Array<{ url: string; auth: string | null; body: any }> = [];
    const io = (env_: Record<string, string>, stdin = "") => ({
      env: env_,
      stdin: async () => stdin,
      out: (line: string) => lines.push(line),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, auth: new Headers(init.headers).get("Authorization"), body: JSON.parse(init.body as string) });
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "OK" }] } });
      }) as unknown as typeof fetch,
    });
    const lines: string[] = [];
    const vars = { INK_TOKEN: "cink_x", INK_URL: "https://ink.test/" };

    expect(await run(["notes"], io(vars))).toBe(0);
    expect(await run(["read", "aaaaaaaaaaaa", "--revision", "2", "--workspace", "w"], io(vars))).toBe(0);
    expect(await run(["write", "aaaaaaaaaaaa", "--base", "3"], io(vars, "# Piped"))).toBe(0);
    expect(await run(["create", "--text", "# Hi"], io(vars))).toBe(0);
    expect(await run(["history", "aaaaaaaaaaaa"], io(vars))).toBe(0);
    expect(await run(["workspaces"], io(vars))).toBe(0);

    expect(seen.every((s) => s.url === "https://ink.test/mcp" && s.auth === "Bearer cink_x")).toBe(true);
    expect(seen.map((s) => [s.body.params.name, s.body.params.arguments])).toEqual([
      ["list_notes", {}],
      ["read_note", { id: "aaaaaaaaaaaa", revision: 2, workspace: "w" }],
      ["write_note", { id: "aaaaaaaaaaaa", baseRevision: 3, text: "# Piped" }],
      ["create_note", { text: "# Hi" }],
      ["note_history", { id: "aaaaaaaaaaaa" }],
      ["list_workspaces", {}],
    ]);
    expect(lines).toEqual(Array(6).fill("OK"));
  });

  it("explains a missing token, a bad command, a rejected token, and a failed tool", async () => {
    const lines: string[] = [];
    const base = { stdin: async () => "", out: (l: string) => lines.push(l) };
    const reply = (res: Response) => ({ ...base, env: { INK_TOKEN: "cink_x" }, fetch: (async () => res) as unknown as typeof fetch });

    expect(await run(["notes"], { ...base, env: {}, fetch })).toBe(2);
    expect(await run(["frobnicate"], reply(Response.json({})))).toBe(2);
    expect(await run(["read"], reply(Response.json({})))).toBe(2);
    expect(await run(["write", "aaaaaaaaaaaa"], reply(Response.json({})))).toBe(2);
    expect(await run(["notes"], reply(new Response("{}", { status: 401 })))).toBe(2);
    expect(await run(["notes"], reply(Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "not_found: No such note" }] } })))).toBe(1);
    expect(await run([], reply(Response.json({})))).toBe(1);
    expect(lines.join("\n")).toMatch(/INK_TOKEN[\s\S]*No such command[\s\S]*needs a note id[\s\S]*--base[\s\S]*disconnected[\s\S]*not_found: No such note[\s\S]*Usage/);
  });
});
