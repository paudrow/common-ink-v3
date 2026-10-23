import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn, whoAmI } from "../../src/core/accounts.ts";
import { connectAgent, listAgents } from "../../src/core/agents.ts";
import { authenticateClipper, clipperRedirect, connectClipper, listClipperGrants } from "../../src/core/clipper.ts";
import { addMember } from "./members.ts";
import { PRIOR_WRITE, perform } from "../../src/core/operations.ts";
import { sign } from "../../src/worker/session.ts";

const SECRET = "test-secret";
// The unpacked clipper's id, which vitest.config.ts allows.
const EXTENSION = env.CLIPPER_EXTENSION_IDS!;
const REDIRECT = `https://${EXTENSION}.chromiumapp.org/`;
const OTHER = "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/";
const DAY = 24 * 60 * 60_000;
const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://ink.test${path}`, init) as never, { ...env, SESSION_SECRET: SECRET });

async function member(name = "Ada Lovelace") {
  const { personId } = await signIn(env.DB, { email: `${crypto.randomUUID()}@example.com`, name });
  const me = await whoAmI(env.DB, personId);
  const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ personId }, SECRET, 3600))}`;
  return { personId, workspaceId: me.workspaces[0]!.id, cookie, name: me.person.name };
}

const rpc = async (token: string, method: string, params: Record<string, unknown> = {}) => {
  const res = await send("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { result: unknown }) : null };
};

const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const { status, body } = await rpc(token, "tools/call", { name, arguments: args });
  expect(status).toBe(200);
  const result = body!.result as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0]!.text, isError: !!result.isError, json: () => JSON.parse(result.content[0]!.text) as { id?: string } };
};

const upload = (token: string, workspaceId: string, folderId: string) => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n");
  return send(`/api/workspaces/${workspaceId}/uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(pdf.byteLength),
      "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "minutes.pdf", folderId })),
    },
    body: pdf,
  });
};

const unsorted = async (workspaceId: string) => (await env.DB.prepare("SELECT unsorted_folder_id AS id FROM workspaces WHERE id = ?").bind(workspaceId).first<{ id: string }>())!.id;

async function allow(cookie: string, redirect = REDIRECT) {
  const allowed = await send("/clipper/connect", {
    method: "POST",
    headers: { Cookie: cookie, Origin: "https://ink.test", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ redirect }),
  });
  return { allowed, token: new URLSearchParams(new URL(allowed.headers.get("Location") ?? "https://invalid/").hash.slice(1)).get("token") ?? "" };
}

const settings = (cookie: string, path = "/api/clipper", init: RequestInit = {}) => send(path, { ...init, headers: { Cookie: cookie, Origin: "https://ink.test", ...init.headers } });

describe("clipper sign-in", () => {
  it("accepts only the return address of an allowed extension", () => {
    expect(clipperRedirect(REDIRECT, [EXTENSION])).toEqual({ redirect: REDIRECT, extensionId: EXTENSION });
    expect(clipperRedirect(OTHER, [EXTENSION])).toBeNull();
    expect(clipperRedirect(REDIRECT, [])).toBeNull();
    expect(clipperRedirect("https://evil.example/#token=cink_nope", [EXTENSION])).toBeNull();
    expect(clipperRedirect(`${REDIRECT}steal`, [EXTENSION])).toBeNull();
    expect(clipperRedirect(`https://${EXTENSION}.chromiumapp.org:8443/`, [EXTENSION])).toBeNull();
  });

  it("asks a signed-out member to sign in, then returns a token that acts as them", async () => {
    const ada = await member();
    const signedOut = await send(`/clipper/connect?redirect=${encodeURIComponent(REDIRECT)}`);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("Location")).toContain("/auth/google");

    const page = await send(`/clipper/connect?redirect=${encodeURIComponent(REDIRECT)}`, { headers: { Cookie: ada.cookie } });
    const html = await page.text();
    expect(html).toContain(`Save notes as ${ada.name}`);
    expect(html).toContain(`Extension ID <code>${EXTENSION}</code>`);
    expect(page.headers.get("Content-Security-Policy")).toContain(`form-action 'self' https://${EXTENSION}.chromiumapp.org;`);

    const { allowed, token } = await allow(ada.cookie);
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("Location")!.startsWith(REDIRECT)).toBe(true);
    expect(token).toMatch(/^cink_[A-Za-z0-9_-]{43}$/);
    expect(html).not.toContain(token);

    const grant = await authenticateClipper(env.DB, token);
    expect(grant?.personId).toBe(ada.personId);
    expect(await listAgents(env.DB, ada.personId)).toEqual([]);

    const made = await tool(token, "create_note", { text: "# From the clipper\n\nA page." });
    expect(made.isError).toBe(false);
    const note = await env.DB.prepare("SELECT created_by, created_by_kind FROM notes WHERE id = ?").bind(made.json().id).first<{ created_by: string; created_by_kind: string }>();
    expect(note).toEqual({ created_by: ada.personId, created_by_kind: "member" });

    const uploaded = await upload(token, ada.workspaceId, await unsorted(ada.workspaceId));
    expect(uploaded.status).toBe(201);
    expect(((await uploaded.json()) as { kind?: string }).kind).toBe("file");

    const again = (await connectClipper(env.DB, { personId: ada.personId, ended: 0 }, EXTENSION))!;
    expect(await authenticateClipper(env.DB, token)).toBeNull();
    const replaced = await authenticateClipper(env.DB, again.token);
    expect(replaced?.personId).toBe(ada.personId);
  });

  it("refuses an extension that isn't allowed, and a return address aimed somewhere else", async () => {
    const ada = await member();
    const unknown = await send(`/clipper/connect?redirect=${encodeURIComponent(OTHER)}`, { headers: { Cookie: ada.cookie } });
    expect(unknown.status).toBe(400);
    expect((await allow(ada.cookie, OTHER)).allowed.status).toBe(400);
    expect((await allow(ada.cookie, "https://evil.example/")).allowed.status).toBe(400);
    const cross = await send("/clipper/connect", {
      method: "POST",
      headers: { Cookie: ada.cookie, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ redirect: REDIRECT }),
    });
    expect(cross.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM clipper_grants WHERE person_id = ?").bind(ada.personId).first("n")).toBe(0);
  });
});

describe("what a clipper token reaches", () => {
  it("lists workspaces and folders and creates notes, and nothing else an agent could", async () => {
    const ada = await member();
    const { token } = await allow(ada.cookie);
    const listed = await rpc(token, "tools/list");
    expect((listed.body!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort()).toEqual(["create_note", "list_folders", "list_workspaces"]);

    expect((await tool(token, "list_workspaces")).isError).toBe(false);
    expect((await tool(token, "list_folders", { workspaceId: ada.workspaceId })).isError).toBe(false);
    const made = await tool(token, "create_note", { text: "# Secret plans" });
    expect(made.isError).toBe(false);

    for (const [name, args] of [
      ["read_note", { noteId: made.json().id }],
      ["list_notes", {}],
      ["search", { query: "secret" }],
      ["write_note", { noteId: made.json().id, text: "# Gone", baseRevision: 1 }],
      ["trash_note", { noteId: made.json().id }],
      ["list_uploads", {}],
      ["upload_file", { name: "a.txt", base64: "aGk=" }],
      ["start_upload", { name: "a.txt", size: 2 }],
    ] as const) {
      const refused = await tool(token, name, args);
      expect([name, refused.isError, refused.text.split(":")[0]]).toEqual([name, true, "forbidden"]);
    }
    const still = await env.DB.prepare("SELECT state FROM notes WHERE id = ?").bind(made.json().id).first("state");
    expect(still).toBe("live");
  });

  it("learns nothing of the member's notes or fellow members from the links and mentions it writes, which are kept as written", async () => {
    const ada = await member();
    const asAda = { kind: "member", personId: ada.personId, workspaceId: ada.workspaceId } as const;
    const secret = await perform(env.DB, asAda, { type: "note.create", text: "# Secret Plan\n\nx" });
    const grace = await addMember(asAda, "editor", "Grace Hopper");
    const { token } = await allow(ada.cookie);
    const clip = (text: string) => tool(token, "create_note", { workspaceId: ada.workspaceId, text, linkTitles: "resolve-strict", mentionNames: "resolve" });

    // A title the member has and one nobody has are answered alike: both made, with the text as it was sent.
    for (const sent of ["[[Secret Plan]] [[Not There]] [[person:Grace Hopper]]", "[[Also Not There]] [[Not There]] [[person:Nobody Here]]"]) {
      const made = await clip(sent);
      expect([made.isError, made.text.includes(secret.id), made.text.includes(grace.personId)]).toEqual([false, false, false]);
      expect(await env.DB.prepare("SELECT text FROM notes WHERE id = ?").bind(made.json().id).first("text")).toBe(sent);
    }
  });

  it("uploads a file and never reads one back", async () => {
    const ada = await member();
    const { token } = await allow(ada.cookie);
    const uploaded = await upload(token, ada.workspaceId, await unsorted(ada.workspaceId));
    expect(uploaded.status).toBe(201);
    const { id } = (await uploaded.json()) as { id: string };
    const read = await send(`/api/workspaces/${ada.workspaceId}/uploads/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(read.status).toBe(403);
    const asMember = await send(`/api/workspaces/${ada.workspaceId}/uploads/${id}`, { headers: { Cookie: ada.cookie } });
    expect(asMember.status).toBe(200);
  });

  it("isn't allowed when the person is signed out everywhere after the session that asked was checked, and nothing is written", async () => {
    const ada = await member();
    const { token: before } = await allow(ada.cookie);
    // The session was read with no sign-out since, and then the person was signed out everywhere before the grant was written.
    const session = { personId: ada.personId, ended: 0 };
    await perform(env.DB, { kind: "member", personId: ada.personId, workspaceId: ada.workspaceId }, { type: "member.signOut", memberId: ada.personId, agents: false });
    const grants = () => env.DB.prepare("SELECT id, revoked_at FROM clipper_grants WHERE person_id = ? ORDER BY created_at").bind(ada.personId).all<{ id: string; revoked_at: number | null }>();
    const was = (await grants()).results;
    expect(await connectClipper(env.DB, session, EXTENSION)).toBeNull();
    expect((await grants()).results).toEqual(was);
    expect(await authenticateClipper(env.DB, before)).toBeNull();
    // The session that began after the sign-out may allow it.
    expect(await connectClipper(env.DB, { ...session, ended: 1 }, EXTENSION)).not.toBeNull();
  });

  it("lapses after 90 days", async () => {
    const ada = await member();
    const now = Date.now();
    const { token } = (await connectClipper(env.DB, { personId: ada.personId, ended: 0 }, EXTENSION, now))!;
    expect((await authenticateClipper(env.DB, token, now + 89 * DAY))?.personId).toBe(ada.personId);
    expect(await authenticateClipper(env.DB, token, now + 90 * DAY)).toBeNull();
  });
});

describe("revoking a clipper", () => {
  it("ends with its own token, which an agent's token can't do", async () => {
    const ada = await member();
    const { token } = await allow(ada.cookie);
    const agent = await connectAgent(env.DB, ada.personId, "Helper");

    const byAgent = await send("/clipper/revoke", { method: "POST", headers: { Authorization: `Bearer ${agent.token}` } });
    expect(byAgent.status).toBe(401);
    expect((await tool(token, "list_workspaces")).isError).toBe(false);

    const revoked = await send("/clipper/revoke", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    expect(revoked.status).toBe(204);
    expect((await rpc(token, "tools/call", { name: "list_workspaces", arguments: {} })).status).toBe(401);
    expect((await tool(agent.token, "list_workspaces")).isError).toBe(false);
    expect((await send("/clipper/revoke", { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("is listed and revoked in Settings by its member, and by no one else", async () => {
    const ada = await member();
    const grace = await member("Grace Hopper");
    const { token } = await allow(ada.cookie);

    const listed = (await (await settings(ada.cookie)).json()) as { grants: Array<{ id: string; extensionId: string; expiresAt: number; createdAt: number }> };
    expect(listed.grants.map((g) => [g.extensionId, Math.round((g.expiresAt - g.createdAt) / DAY)])).toEqual([[EXTENSION, 90]]);
    const id = listed.grants[0]!.id;
    expect(await (await settings(grace.cookie)).json()).toEqual({ grants: [] });

    expect((await settings(grace.cookie, `/api/clipper/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await settings(ada.cookie, `/api/clipper/${id}`, { method: "DELETE", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await send(`/api/clipper/${id}`, { method: "DELETE" })).status).toBe(401);
    expect((await tool(token, "list_workspaces")).isError).toBe(false);

    expect((await settings(ada.cookie, `/api/clipper/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await authenticateClipper(env.DB, token)).toBeNull();
    expect(await (await settings(ada.cookie)).json()).toEqual({ grants: [] });
  });

  for (const agents of [false, true]) {
    it(`ends when the member signs out everywhere, ${agents ? "with" : "without"} their agents, and Settings no longer lists it`, async () => {
      const ada = await member();
      const { token } = await allow(ada.cookie);
      await perform(env.DB, { kind: "member", personId: ada.personId, workspaceId: ada.workspaceId }, { type: "member.signOut", memberId: ada.personId, agents });
      expect(await authenticateClipper(env.DB, token)).toBeNull();
      expect((await rpc(token, "tools/list")).status).toBe(401);
      expect(await listClipperGrants(env.DB, ada.personId)).toEqual([]);
    });
  }

  it("ends when an admin signs the member out everywhere, and works again once the member allows it again", async () => {
    const admin = await member("Grace Hopper");
    const ada = await addMember({ kind: "member", personId: admin.personId, workspaceId: admin.workspaceId }, "editor", "Ada Lovelace");
    const cookie = `__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId }, SECRET, 3600))}`;
    const { token } = await allow(cookie);
    expect((await authenticateClipper(env.DB, token))?.personId).toBe(ada.personId);
    await perform(env.DB, { kind: "member", personId: admin.personId, workspaceId: admin.workspaceId }, { type: "member.signOut", memberId: ada.personId, agents: false });
    expect(await authenticateClipper(env.DB, token)).toBeNull();
    const { token: again } = await allow(`__Host-ink_session=${encodeURIComponent(await sign({ personId: ada.personId, ended: 1 }, SECRET, 3600))}`);
    expect((await authenticateClipper(env.DB, again))?.personId).toBe(ada.personId);
  });
});

describe("a clip sent twice", () => {
  it("finds the first note by its author and write id through an index, not a scan of changes", async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${PRIOR_WRITE}`).bind("w", "ws", "member", "p").all<{ detail: string }>();
    expect(results.map((row) => row.detail).find((detail) => detail.includes(" c "))).toBe("SEARCH c USING INDEX changes_by_author_write (author_id=? AND write_id=?)");
  });

  it("makes one note", async () => {
    const ada = await member();
    const { token } = await allow(ada.cookie);
    const writeId = crypto.randomUUID();
    const first = await tool(token, "create_note", { text: "# Once", writeId });
    const again = await tool(token, "create_note", { text: "# Once", writeId });
    expect(again.json()).toEqual({ id: first.json().id });
  });

  it("finds only a note the clipper made, so a write id the member used elsewhere reads nothing", async () => {
    const ada = await member();
    const { token } = await allow(ada.cookie);
    const writeId = crypto.randomUUID();
    const own = await perform(env.DB, { kind: "member", personId: ada.personId, workspaceId: ada.workspaceId }, { type: "note.create", text: "# Private plans\n\nNot for the clipper", writeId });
    const clipped = await tool(token, "create_note", { text: "# Clipped", writeId });
    expect(clipped.json().id).not.toBe(own.id);
    expect(clipped.text).not.toContain("Private plans");
    expect((await tool(token, "create_note", { text: "# Clipped", writeId: "x".repeat(57) })).text).toBe("invalid: The clipper's writeId is at most 56 characters");
  });
});
