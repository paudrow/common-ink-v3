import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { whoAmI } from "../../src/core/accounts.ts";
import { authenticateAgent, connectAgent, disconnectAgent, editAgent, hashToken, listAgents, MAX_ACTIVE_AGENTS } from "../../src/core/agents.ts";
import { MAX_PENDING_PER_CLIENT, MAX_PENDING_PER_PERSON, MAX_PENDING_REQUESTS, MAX_REGISTRATIONS_PER_HOUR, MAX_UNUSED_CLIENTS, consent, deny, exchangeCode, openRequest, redirectBack, registerClient, sweep } from "../../src/core/oauth.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { b64url, sign } from "../../src/worker/session.ts";
import * as people from "./members.ts";
import { PNG, upload } from "./uploading.ts";

/*
 * Signing in with OAuth, driven the way a hosted chat app drives it: through worker.fetch, with only the
 * addresses a client is told about. Consent is the browser's step, so it is taken through the core
 * function that /api/oauth/consent calls. What a connection may then do is what an agent may do.
 */

type Member = Extract<Actor, { kind: "member" }>;
const newMember = async (name?: string) => (await people.newMember(name)) as Member;
const addMember = async (...args: Parameters<typeof people.addMember>) => (await people.addMember(...args)) as Member;
const SECRET = "test-secret";
const ORIGIN = "https://ink.test";
const REDIRECT = "https://chat.example/oauth/callback";
const DAY = 86_400_000;
const HOUR = 3_600_000;

const send = (path: string, init: RequestInit = {}, more: Partial<Env> = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init) as never, { ...env, SESSION_SECRET: SECRET, ...more });
const form = (fields: Record<string, string>) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }) satisfies RequestInit;
const asJson = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) satisfies RequestInit;
const session = async (who: { personId: string }) => ({ Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ personId: who.personId }, SECRET, 3600))}` });

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) };
}

async function register(more: Record<string, unknown> = {}, redirect = REDIRECT) {
  const res = await send("/oauth/register", asJson({ client_name: "Chat", redirect_uris: [redirect], ...more }));
  return { res, body: (await res.json()) as { client_id: string; [key: string]: unknown } };
}

/** Starts an authorization as the app does, in the browser of `who` (or of nobody), and says where the browser is sent. */
async function authorize(clientId: string, challenge: string, who?: { personId: string }, more: Record<string, string> = {}) {
  const query = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", ...more });
  const res = await send(`/oauth/authorize?${query}`, { redirect: "manual", headers: who ? await session(who) : {} });
  await res.body?.cancel();
  return { res, to: res.headers.get("Location") };
}
const requestOf = (to: string | null) => new URL(to!, ORIGIN).searchParams.get("request")!;

const exchange = (fields: Record<string, string>) => send("/oauth/token", form({ grant_type: "authorization_code", redirect_uri: REDIRECT, ...fields }));
const refresh = (fields: Record<string, string>) => send("/oauth/token", form({ grant_type: "refresh_token", ...fields }));
interface TokenAnswer {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** A whole sign-in as a member: register, authorize, consent, trade the code. */
async function connect(who: Member, options: Omit<Parameters<typeof consent>[2], "requestId"> = {}, name = "Chat") {
  const client = (await register({ client_name: name })).body.client_id;
  const { verifier, challenge } = await pkce();
  const { to } = await authorize(client, challenge, who);
  const granted = await consent(env.DB, who.personId, { requestId: requestOf(to), ...options });
  const res = await exchange({ code: granted.code, client_id: client, code_verifier: verifier });
  const tokens = (await res.json()) as TokenAnswer;
  return { client, verifier, challenge, granted, res, tokens, agentId: granted.agentId };
}

const mcp = (token: string, body: unknown) => send("/mcp", { ...asJson(body), headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: result.content[0]!.text, isError: !!result.isError, json: () => JSON.parse(result.content[0]!.text) };
};
const status = async (token: string) => (await mcp(token, { jsonrpc: "2.0", id: 1, method: "ping" })).status;
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

const pending = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_requests").first<{ n: number }>())!.n;

const agentRow = (id: string) => env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<{ revoked_at: number | null; expires_at: number | null; client_id: string | null; token_prefix: string }>();

describe("what a client finds out before it signs in", () => {
  it("is told by /mcp where to sign in, and by that address where the sign-in is", async () => {
    const lacking = await send("/mcp", asJson({}));
    expect(lacking.status).toBe(401);
    expect(lacking.headers.get("WWW-Authenticate")).toBe(`Bearer realm="Common Ink", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    // A token that was sent and is no good is said to be, which is how an app knows to refresh it.
    const wrong = await send("/mcp", { ...asJson({}), headers: { Authorization: "Bearer cink_wrong", "Content-Type": "application/json" } });
    expect(wrong.headers.get("WWW-Authenticate")).toBe(`Bearer realm="Common Ink", error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    const ada = await newMember();
    // Uploads aren't the resource those addresses describe.
    expect((await send(`/api/workspaces/${ada.workspaceId}/uploads/aaaaaaaaaaaa`, { headers: { Authorization: "Bearer cink_wrong" } })).headers.get("WWW-Authenticate")).toBe('Bearer realm="Common Ink"');
    const { tokens } = await connect(ada);
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).headers.get("WWW-Authenticate")).toContain('error="invalid_token"');

    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await send(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"], resource_name: "Common Ink" });
    }
    const server = (await (await send("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect((await send("/.well-known/oauth-authorization-server", { method: "POST" })).status).toBe(405);
  });

  it("is told the host it asked, so a Preview signs in on its own address", async () => {
    const res = await worker.fetch(new Request("https://preview.example.workers.dev/.well-known/oauth-protected-resource") as never, { ...env, SESSION_SECRET: SECRET });
    expect(await res.json()).toMatchObject({ resource: "https://preview.example.workers.dev/mcp", authorization_servers: ["https://preview.example.workers.dev"] });
  });
});

describe("registering an app", () => {
  it("makes a public client, and says so", async () => {
    const { res, body } = await register({ grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ client_name: "Chat", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    expect(body.client_id).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body).not.toHaveProperty("client_secret");
    expect((await register({ client_name: undefined })).body).toMatchObject({ client_name: "Unnamed app" });
  });

  it("registers an app that asks to authenticate with a secret as the public client it will be, and says so", async () => {
    for (const method of ["client_secret_basic", "client_secret_post", "private_key_jwt", "none"]) {
      const { res, body } = await register({ token_endpoint_auth_method: method });
      expect([method, res.status, body.token_endpoint_auth_method]).toEqual([method, 201, "none"]);
      expect(body).not.toHaveProperty("client_secret");
    }
  });

  it("keeps an address as a browser writes it, and takes any way of writing it as the same", async () => {
    const { body } = await register({}, "HTTPS://Chat.Example:443/cb");
    expect(body.redirect_uris).toEqual(["https://chat.example/cb"]);
    const same = await register({ redirect_uris: ["https://chat.example/cb", "https://CHAT.example/cb", "https://münchen.example/cb"] });
    expect(same.body.redirect_uris).toEqual(["https://chat.example/cb", "https://xn--mnchen-3ya.example/cb"]);
    const { challenge } = await pkce();
    for (const written of ["https://chat.example:443/cb", "https://Chat.Example/cb"]) {
      expect((await authorize(body.client_id, challenge, undefined, { redirect_uri: written })).res.status, written).toBe(302);
    }
    expect((await authorize(same.body.client_id, challenge, undefined, { redirect_uri: "https://münchen.example/cb" })).res.status).toBe(302);
    expect((await authorize(body.client_id, challenge, undefined, { redirect_uri: "https://chat.example/cb/" })).res.status).toBe(400);
  });

  it("counts registrations by the address they come from, keeps only a hash of it, and lets another address register", async () => {
    const from = (ip: string) => ({ headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip } });
    const body = JSON.stringify({ client_name: "Chat", redirect_uris: [REDIRECT] });
    for (let i = 0; i < MAX_REGISTRATIONS_PER_HOUR; i++) expect((await send("/oauth/register", { method: "POST", body, ...from("203.0.113.7") })).status).toBe(201);
    const refused = await send("/oauth/register", { method: "POST", body, ...from("203.0.113.7") });
    expect([refused.status, await errorOf(refused)]).toEqual([429, "temporarily_unavailable"]);
    expect((await send("/oauth/register", { method: "POST", body, ...from("203.0.113.8") })).status).toBe(201);
    expect((await send("/oauth/register", { method: "POST", body, headers: { "Content-Type": "application/json" } })).status).toBe(201);
    const kept = (await env.DB.prepare("SELECT DISTINCT registered_from FROM oauth_clients WHERE registered_from IS NOT NULL").all<{ registered_from: string }>()).results.map((r) => r.registered_from);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    for (const hash of kept) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM oauth_clients").all()).results)).not.toContain("203.0.113");
    // After the hour it may register again.
    await env.DB.prepare("UPDATE oauth_clients SET created_at = created_at - ?").bind(2 * 3_600_000).run();
    expect((await send("/oauth/register", { method: "POST", body, ...from("203.0.113.7") })).status).toBe(201);
  });

  it("counts an IPv6 address by its /48, so one site can't register more by changing its address", async () => {
    const from = (ip: string) => send("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "Chat", redirect_uris: [REDIRECT] }), headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip } });
    for (let i = 1; i <= MAX_REGISTRATIONS_PER_HOUR; i++) expect((await from(`2001:db8:1:${i.toString(16)}::1`)).status).toBe(201);
    for (const same of ["2001:db8:1:ffff:ffff:ffff:ffff:ffff", "2001:0DB8:0001:0002:0:0:0:abcd", "2001:db8:1::"]) {
      const refused = await from(same);
      expect([same, refused.status, await errorOf(refused)]).toEqual([same, 429, "temporarily_unavailable"]);
    }
    for (const other of ["2001:db8:2::1", "::ffff:203.0.113.77", "203.0.113.78"]) expect((await from(other)).status, other).toBe(201);
  });

  it("forgets within the hour an app that never sent anyone to sign in, and gives one that did the day", async () => {
    const idle = (await register({ client_name: "Idle" })).body.client_id;
    const started = (await register({ client_name: "Started" })).body.client_id;
    await authorize(started, (await pkce()).challenge, await newMember());
    const age = (id: string, by: number) => env.DB.prepare("UPDATE oauth_clients SET created_at = ? WHERE id = ?").bind(Date.now() - by, id).run();
    const left = async () => (await env.DB.prepare("SELECT id FROM oauth_clients WHERE id IN (?, ?)").bind(idle, started).all<{ id: string }>()).results.map((r) => r.id);
    await age(idle, 2 * HOUR);
    await age(started, 2 * HOUR);
    await sweep(env.DB, Date.now(), true);
    expect(await left()).toEqual([started]);
    await age(started, 25 * HOUR);
    await env.DB.prepare("UPDATE oauth_requests SET created_at = ? WHERE client_id = ?").bind(Date.now() - 11 * 60_000, started).run();
    await sweep(env.DB, Date.now(), true);
    expect(await left()).toEqual([]);

    // Apps past their hour are not counted toward those waiting, so a table full of them refuses no one.
    await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO oauth_clients (id, name, redirect_uris, created_at) SELECT 'filler' || i, 'Filler', '[]', ? FROM n").bind(MAX_UNUSED_CLIENTS, Date.now() - 2 * HOUR).run();
    const allowed = await register();
    await env.DB.prepare("DELETE FROM oauth_clients WHERE id LIKE 'filler%'").run();
    expect(allowed.res.status).toBe(201);
  });

  it("takes https addresses, and http only to this machine", async () => {
    for (const ok of ["https://chat.example/cb", "https://claude.ai/api/mcp/auth_callback", "http://localhost:8123/callback", "http://127.0.0.1:9/cb", "http://[::1]:5000/cb"]) {
      expect((await register({}, ok)).res.status, ok).toBe(201);
    }
    for (const bad of ["http://chat.example/cb", "http://localhost.evil.example/cb", "http://127.0.0.1.evil.example/", "javascript:alert(1)", "claude://callback", "/relative", "https://chat.example/cb#frag", "https://user:pw@chat.example/cb", "https://", "ftp://chat.example/", "", 5]) {
      const { res, body } = await register({}, bad as string);
      expect([res.status, body.error], String(bad)).toEqual([400, "invalid_redirect_uri"]);
    }
  });

  it("takes few addresses, and refuses what asks for more than a public client is", async () => {
    expect((await register({ redirect_uris: [] })).body.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: undefined })).body.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://chat.example/${i}`) })).body.error).toBe("invalid_redirect_uri");
    expect((await register({ redirect_uris: Array.from({ length: 5 }, (_, i) => `https://chat.example/${i}`) })).res.status).toBe(201);
    for (const more of [{ token_endpoint_auth_method: 5 }, { grant_types: ["client_credentials"] }, { grant_types: ["refresh_token"] }, { response_types: ["token"] }, { client_name: "x".repeat(101) }, { client_name: "Claude‮evil" }, { client_name: "Two\nlines" }, ...["\u061c", "\u200b", "\u200c", "\u200d", "\u2028", "\u2029", "\ufeff"].map((c) => ({ client_name: `Cla${c}ude` })), { client_name: 7 }]) {
      const { res, body } = await register(more);
      expect([res.status, body.error], JSON.stringify(more)).toEqual([400, "invalid_client_metadata"]);
    }
    for (const body of ["not json", "[]", "null", "x".repeat(20_000)]) {
      const res = await send("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      expect([res.status, await errorOf(res)]).toEqual([400, "invalid_client_metadata"]);
    }
    expect((await send("/oauth/register")).status).toBe(405);
  });

  it("forgets an app that got no grant within a day, keeps one that did, and once too many wait, makes room from the oldest that never started or refuses", async () => {
    const ada = await newMember();
    const old = (await register({ client_name: "Old" })).body.client_id;
    const used = await connect(ada);
    const aWeekAgo = Date.now() - 7 * DAY;
    await env.DB.prepare("UPDATE oauth_clients SET created_at = ?").bind(aWeekAgo).run();
    // (A sweep runs at most once a minute, so this one is asked at a later time.)
    const fresh = (await registerClient(env.DB, { client_name: "Fresh", redirect_uris: [REDIRECT] }, Date.now() + 5 * 60_000)).id;
    const left = (await env.DB.prepare("SELECT id FROM oauth_clients").all<{ id: string }>()).results.map((r) => r.id);
    expect(left).toContain(used.client);
    expect(left).toContain(fresh);
    expect(left).not.toContain(old);

    // Full of apps that never sent anyone to sign in, the oldest of them makes room.
    await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO oauth_clients (id, name, redirect_uris, created_at) SELECT 'filler' || i, 'Filler', '[]', ? - i FROM n").bind(MAX_UNUSED_CLIENTS, Date.now()).run();
    const oldest = `filler${MAX_UNUSED_CLIENTS}`;
    expect((await register()).res.status).toBe(201);
    expect(await env.DB.prepare("SELECT id FROM oauth_clients WHERE id = ?").bind(oldest).first()).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE id LIKE 'filler%'").first<{ n: number }>())!.n).toBe(MAX_UNUSED_CLIENTS - 1);
    // Full of apps that did, none is pushed out, and more are refused.
    await env.DB.prepare("UPDATE oauth_clients SET requested_at = created_at WHERE requested_at IS NULL").run();
    const refused = await register();
    expect([refused.res.status, refused.body.error]).toEqual([503, "temporarily_unavailable"]);
    await env.DB.prepare("DELETE FROM oauth_clients WHERE id LIKE 'filler%'").run();
    expect((await register()).res.status).toBe(201);
  });

  it("does nothing but read when it refuses for being full, and counts only the apps that are live", async () => {
    // Every app here has sent someone to sign in, so none makes room.
    await env.DB.prepare("UPDATE oauth_clients SET requested_at = created_at WHERE requested_at IS NULL").run();
    await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1) INSERT INTO oauth_clients (id, name, redirect_uris, created_at, requested_at) SELECT 'filler' || i, 'Filler', '[]', ?2, ?2 FROM n").bind(MAX_UNUSED_CLIENTS, Date.now()).run();
    const client = (await register()).body;
    void client;
    // A request that lapsed, which a sweep would remove: the refusal leaves it.
    const ada = await newMember();
    await env.DB.prepare("INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, person_id, created_at) SELECT 'lapsed', id, 'https://chat.example/cb', 'c', ?, ? FROM oauth_clients LIMIT 1").bind(ada.personId, Date.now() - 3_600_000).run();
    const refused = await registerClient(env.DB, { redirect_uris: [REDIRECT] }, Date.now() + 5 * 60_000).catch((e: { error: string }) => e.error);
    expect(refused).toBe("temporarily_unavailable");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_requests WHERE id = 'lapsed'").first<{ n: number }>())!.n).toBe(1);
    // Apps that lapsed are not counted, so a full table of them doesn't refuse anyone.
    await env.DB.prepare("UPDATE oauth_clients SET created_at = ? WHERE id LIKE 'filler%'").bind(Date.now() - 3 * DAY).run();
    await expect(registerClient(env.DB, { redirect_uris: [REDIRECT] }, Date.now() + 5 * 60_000)).resolves.toBeTruthy();
    await env.DB.prepare("DELETE FROM oauth_clients WHERE id LIKE 'filler%'").run();
    await env.DB.prepare("DELETE FROM oauth_requests WHERE id = 'lapsed'").run();
  });
});

describe("authorizing", () => {
  it("sends a browser with no session to sign in and back to the same address, and keeps nothing for it", async () => {
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();
    const before = await pending();
    const { res, to } = await authorize(client, challenge);
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const next = new URL(to!, ORIGIN);
    const query = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
    expect([next.pathname, next.searchParams.get("next")]).toEqual(["/auth/google", `/oauth/authorize?${query}`]);
    expect(await pending()).toBe(before);

    // Sign-in takes that address as it is: dev sign-in follows next the way Google's does.
    const onThisMachine = await worker.fetch(new Request(`http://localhost/auth/dev?next=${encodeURIComponent(next.searchParams.get("next")!)}`, { redirect: "manual" }) as never, { ...env, SESSION_SECRET: SECRET, DEV_SIGN_IN: "1" });
    expect(onThisMachine.status).toBe(302);
    expect(onThisMachine.headers.get("Location")).toBe(next.searchParams.get("next"));
  });

  it("asks a browser with no session to sign in first when the request is too long to come back to, and keeps nothing", async () => {
    const client = (await register()).body.client_id;
    const before = await pending();
    const { res, to } = await authorize(client, (await pkce()).challenge, undefined, { state: "s".repeat(1500) });
    expect([res.status, to]).toEqual([401, null]);
    expect(await pending()).toBe(before);
  });

  it("keeps nothing for a crowd of browsers with no session, so they can't fill the room members need", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();
    const before = await pending();
    for (let i = 0; i < MAX_PENDING_PER_CLIENT + 5; i++) expect((await authorize(client, challenge)).res.status).toBe(302);
    expect(await pending()).toBe(before);
    expect((await authorize(client, challenge, ada)).to).toMatch(/^\/connect\?request=/);
  });

  it("sends a browser with a session to the consent page, and makes nothing but the request", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();
    const before = await listAgents(env.DB, ada.personId);
    const { res, to } = await authorize(client, challenge, ada, { resource: `${ORIGIN}/mcp`, scope: "anything" });
    expect(res.status).toBe(302);
    expect(to).toMatch(/^\/connect\?request=[A-Za-z0-9_-]{40,}$/);
    expect(await listAgents(env.DB, ada.personId)).toEqual(before);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes").first<{ n: number }>())!.n).toBe(0);
    expect(await openRequest(env.DB, ada.personId, requestOf(to))).toEqual({ clientName: "Chat", redirectHost: "chat.example" });
    // Only a hash of the request's id is kept, since the id is in the address of the consent page.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_requests WHERE id = ?").bind(requestOf(to)).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_requests WHERE id = ?").bind(await hashToken(requestOf(to))).first<{ n: number }>())!.n).toBe(1);
  });

  it("shows the member only the host an app will send them to, as an address bar writes it", async () => {
    const ada = await newMember();
    const client = (await register({ client_name: "Bank" }, "https://bаnk.example/cb")).body.client_id;
    const { to } = await authorize(client, (await pkce()).challenge, ada, { redirect_uri: "https://bаnk.example/cb" });
    const view = await openRequest(env.DB, ada.personId, requestOf(to));
    expect(view).toEqual({ clientName: "Bank", redirectHost: "xn--bnk-6cd.example" });
    expect(JSON.stringify(view)).not.toContain("/cb");
  });

  it("makes no request for a HEAD, which asks only whether the address is there", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const before = await pending();
    const query = new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: (await pkce()).challenge, code_challenge_method: "S256" });
    const head = await send(`/oauth/authorize?${query}`, { method: "HEAD", headers: await session(ada), redirect: "manual" });
    expect(head.status).toBe(405);
    expect(await pending()).toBe(before);
  });

  it("shows an error, and sends nowhere, when the app or its address can't be trusted", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();
    const waiting = await pending();
    const evil = [
      ["an address it didn't register", { redirect_uri: "https://evil.example/cb" }],
      ["a prefix of the address it registered", { redirect_uri: `${REDIRECT}/more` }],
      ["the address with a query added", { redirect_uri: `${REDIRECT}?x=1` }],
      ["no address", { redirect_uri: "" }],
      ["a client that was never registered", { client_id: "nobody" }],
      ["no client", { client_id: "" }],
    ] as const;
    for (const [what, more] of evil) {
      const { res, to } = await authorize(client, challenge, ada, more);
      expect([what, res.status, to]).toEqual([what, 400, null]);
    }
    const page = await send(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect((await page.text()).replaceAll("&#39;", "'")).toContain("didn't register");
    // A parameter given twice has no one meaning.
    const twice = await send(`/oauth/authorize?client_id=${client}&client_id=other&redirect_uri=${encodeURIComponent(REDIRECT)}`);
    expect(twice.status).toBe(400);
    expect(await pending()).toBe(waiting);
  });

  it("never redirects an error to the app: it says what is wrong on a page, with a link the member may follow", async () => {
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();
    const waiting = await pending();
    const cases: [string, Record<string, string>, string, string][] = [
      ["a response type that isn't code", { response_type: "token" }, "unsupported_response_type", "something other than a code"],
      ["no challenge", { code_challenge: "" }, "invalid_request", "PKCE"],
      ["a challenge that isn't a SHA-256 hash", { code_challenge: "short" }, "invalid_request", "PKCE"],
      ["the plain method", { code_challenge_method: "plain" }, "invalid_request", "S256"],
      ["no method", { code_challenge_method: "" }, "invalid_request", "S256"],
      ["a resource that isn't /mcp", { resource: "https://other.example/mcp" }, "invalid_target", "isn't Common Ink"],
      ["a state that is huge", { state: "s".repeat(2001) }, "invalid_request", "too long"],
    ];
    for (const [what, more, error, said] of cases) {
      const { res, to } = await authorize(client, challenge, undefined, more);
      expect([what, res.status, to], what).toEqual([what, 400, null]);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      const html = await (await send(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", ...more })}`)).text();
      expect(html.replaceAll("&#39;", "'"), what).toContain(said);
      const href = /<a href="([^"]+)">Return to chat\.example<\/a>/.exec(html)?.[1];
      const back = new URL(href!.replaceAll("&#38;", "&").replaceAll("&#61;", "=").replaceAll("&#39;", "'").replaceAll("&#34;", '"').replaceAll("&#60;", "<").replaceAll("&#62;", ">"));
      expect([what, back.origin + back.pathname, back.searchParams.get("error"), back.searchParams.get("iss")], what).toEqual([what, REDIRECT, error, ORIGIN]);
      if (!more.state) expect(back.searchParams.get("state")).toBe("xyz");
    }
    expect(await pending()).toBe(waiting);
  });

  it("holds only so many requests at once, and lets one lapse after ten minutes", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();
    const { to } = await authorize(client, challenge, ada);
    await env.DB.prepare("UPDATE oauth_requests SET created_at = ?").bind(Date.now() - 11 * 60_000).run();
    await expect(consent(env.DB, ada.personId, { requestId: requestOf(to) })).rejects.toMatchObject({ code: "not_found" });
    await expect(openRequest(env.DB, ada.personId, requestOf(to))).rejects.toMatchObject({ code: "not_found" });

    await env.DB.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, person_id, created_at) SELECT 'waiting' || i, ?, ?, ?, ?, ? FROM n").bind(MAX_PENDING_REQUESTS, client, REDIRECT, challenge, ada.personId, Date.now()).run();
    const someoneElse = await newMember();
    const full = await authorize(client, challenge, someoneElse);
    expect(full.res.status).toBe(503);
    expect(full.res.headers.get("Content-Type")).toContain("text/html");
    await env.DB.prepare("DELETE FROM oauth_requests WHERE id LIKE 'waiting%'").run();
  });

  it("holds only so many for one app, as a page, and leaves the room for other apps", async () => {
    const people = [await newMember(), await newMember(), await newMember()];
    const ada = people[2]!;
    const [busy, quiet] = [(await register()).body.client_id, (await register()).body.client_id];
    const { challenge } = await pkce();
    for (let i = 0; i < MAX_PENDING_PER_CLIENT; i++) expect((await authorize(busy, challenge, people[i % 2])).res.status).toBe(302);
    const refused = await authorize(busy, challenge, ada);
    expect(refused.res.status).toBe(429);
    expect(refused.res.headers.get("Content-Type")).toContain("text/html");
    expect((await authorize(quiet, challenge, ada)).res.status).toBe(302);
    // A request that lapsed makes room.
    await env.DB.prepare("UPDATE oauth_requests SET created_at = ? WHERE client_id = ?").bind(Date.now() - 11 * 60_000, busy).run();
    expect((await authorize(busy, challenge, ada)).res.status).toBe(302);
  });
});

describe("waiting requests from one person", () => {
  it("holds only so many for one person, across apps, fewer than one app's room, and leaves the room for other people", async () => {
    expect(MAX_PENDING_PER_PERSON).toBeLessThan(MAX_PENDING_PER_CLIENT);
    const [ada, grace] = [await newMember(), await newMember("Grace Hopper")];
    const apps = [(await register()).body.client_id, (await register()).body.client_id];
    const { challenge } = await pkce();
    for (let i = 0; i < MAX_PENDING_PER_PERSON; i++) expect((await authorize(apps[i % 2]!, challenge, ada)).res.status).toBe(302);
    const refused = await authorize(apps[0]!, challenge, ada);
    expect(refused.res.status).toBe(429);
    expect(refused.res.headers.get("Content-Type")).toContain("text/html");
    expect((await authorize(apps[0]!, challenge, grace)).res.status).toBe(302);
  });
});

describe("consent", () => {
  it("makes an agent with the limits the member chose, and a code for the app", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Projects" });
    const { granted, client } = await connect(ada, { workspaceId: ada.workspaceId, readOnly: true, folderIds: [folder.id], expiresInDays: 7, name: "Claude on the web" });
    const agent = (await listAgents(env.DB, ada.personId)).find((a) => a.id === granted.agentId)!;
    expect(agent).toMatchObject({ name: "Claude on the web", workspaceId: ada.workspaceId, readOnly: true, folderIds: [folder.id], revokedAt: null });
    expect(agent.expiresAt! - agent.createdAt).toBe(7 * DAY);
    expect(await agentRow(granted.agentId)).toMatchObject({ client_id: client, token_prefix: "oauth" });
    expect(granted.code).toMatch(/^cink_ac_/);
    expect(redirectBack(granted.redirectUri, { code: granted.code, state: granted.state, iss: ORIGIN })).toBe(`${REDIRECT}?code=${granted.code}&state=xyz&iss=${encodeURIComponent(ORIGIN)}`);
  });

  it("is answered from the consent page: who is asking, then a code or a refusal", async () => {
    const ada = await newMember();
    const client = (await register({ client_name: "Chat" })).body.client_id;
    const { verifier, challenge } = await pkce();
    const requestId = requestOf((await authorize(client, challenge, ada)).to);
    const headers = { ...(await session(ada)), Origin: ORIGIN };
    const shown = await send(`/api/oauth/request?request=${requestId}`, { headers });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({ clientName: "Chat", redirectHost: "chat.example" });
    const signedOut = await send(`/api/oauth/request?request=${requestId}`);
    expect(signedOut.status).toBe(401);
    const foreign = await send("/api/oauth/consent", { ...asJson({ requestId }), headers: { "Content-Type": "application/json", Origin: "https://evil.example", ...(await session(ada)) } });
    expect(foreign.status).toBe(403);

    const refusedId = requestOf((await authorize(client, challenge, ada)).to);
    const refused = await send("/api/oauth/deny", { ...asJson({ requestId: refusedId }), headers: { ...headers, "Content-Type": "application/json" } });
    expect(await refused.json()).toMatchObject({ redirect: expect.stringContaining("error=access_denied") });

    const allowed = await send("/api/oauth/consent", { ...asJson({ requestId, readOnly: true, expiresInDays: 30 }), headers: { ...headers, "Content-Type": "application/json" } });
    const redirect = ((await allowed.json()) as { redirect: string }).redirect;
    expect(new URL(redirect).searchParams.get("state")).toBe("xyz");
    const code = new URL(redirect).searchParams.get("code")!;
    const traded = await exchange({ code, client_id: client, code_verifier: verifier });
    expect(traded.status).toBe(200);
    expect((await listAgents(env.DB, ada.personId)).find((a) => a.revokedAt === null)).toMatchObject({ readOnly: true });
  });

  it("replaces that app's earlier connection, so reconnecting does not add another agent", async () => {
    const ada = await newMember();
    const client = (await register({ client_name: "Chat" })).body.client_id;
    const again = async () => consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, (await pkce()).challenge, ada)).to) });
    const first = await again();
    const other = await connect(ada, {}, "Other");
    for (let i = 2; i < MAX_ACTIVE_AGENTS; i++) await connectAgent(env.DB, ada.personId, `Agent ${i}`);
    const second = await again();
    const agents = await listAgents(env.DB, ada.personId);
    expect(agents.find((a) => a.id === first.agentId)?.revokedAt).not.toBeNull();
    expect(agents.find((a) => a.id === second.agentId)?.revokedAt).toBeNull();
    expect(agents.find((a) => a.id === other.agentId)?.revokedAt).toBeNull();
    expect(agents.filter((a) => a.revokedAt === null)).toHaveLength(MAX_ACTIVE_AGENTS);
  });

  it("is named for the app unless the member says otherwise, within what a name can be", async () => {
    const ada = await newMember();
    expect((await listAgents(env.DB, ada.personId)).length).toBe(0);
    const first = await connect(ada, {}, "Chat");
    const long = await connect(ada, {}, "N".repeat(100));
    const names = Object.fromEntries((await listAgents(env.DB, ada.personId)).map((a) => [a.id, a.name]));
    expect(names[first.agentId]).toBe("Chat");
    expect(names[long.agentId]).toBe("N".repeat(60));
  });

  it("answers a request once: the code is made once, and a second answer finds no request", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { to } = await authorize(client, (await pkce()).challenge, ada);
    const requestId = requestOf(to);
    const answers = await Promise.allSettled([consent(env.DB, ada.personId, { requestId }), consent(env.DB, ada.personId, { requestId })]);
    expect(answers.map((a) => a.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(consent(env.DB, ada.personId, { requestId })).rejects.toMatchObject({ code: "not_found" });
    await expect(deny(env.DB, ada.personId, requestId)).rejects.toMatchObject({ code: "not_found" });
    expect((await listAgents(env.DB, ada.personId)).length).toBe(1);
  });

  it("can be refused, and the app is sent back to the address it gave", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { to } = await authorize(client, (await pkce()).challenge, ada);
    expect(await deny(env.DB, ada.personId, requestOf(to))).toEqual({ redirectUri: REDIRECT, state: "xyz" });
    expect((await listAgents(env.DB, ada.personId)).length).toBe(0);
  });

  it("belongs to the person who started it: no one else opens it, answers it or refuses it", async () => {
    const ada = await newMember();
    const grace = await newMember("Grace Hopper");
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();

    const opened = requestOf((await authorize(client, challenge, ada)).to);
    await openRequest(env.DB, ada.personId, opened);
    await expect(openRequest(env.DB, grace.personId, opened)).rejects.toMatchObject({ code: "not_found" });
    await expect(consent(env.DB, grace.personId, { requestId: opened })).rejects.toMatchObject({ code: "not_found" });
    await expect(deny(env.DB, grace.personId, opened)).rejects.toMatchObject({ code: "not_found" });
    expect(await listAgents(env.DB, grace.personId)).toEqual([]);
    await expect(consent(env.DB, ada.personId, { requestId: opened })).resolves.toMatchObject({ redirectUri: REDIRECT });

    // Not opened yet, it is still theirs alone.
    const unopened = requestOf((await authorize(client, challenge, ada)).to);
    await expect(deny(env.DB, grace.personId, unopened)).rejects.toMatchObject({ code: "not_found" });
    await expect(consent(env.DB, ada.personId, { requestId: unopened })).resolves.toMatchObject({ redirectUri: REDIRECT });
    // A request that was never there is answered as one that isn't theirs.
    const missing = await consent(env.DB, ada.personId, { requestId: "nothing" }).catch((e: Error) => e.message);
    const taken = await consent(env.DB, grace.personId, { requestId: opened }).catch((e: Error) => e.message);
    expect(missing).toBe(taken);
  });

  it("holds the member to what the Agents page could give: their workspaces, the folders they see, no more agents than are allowed, and no options nobody defined", async () => {
    const ada = await newMember();
    const grace = await newMember("Grace Hopper");
    const secret = await perform(env.DB, grace, { type: "folder.create", name: "Grace's folder" });
    const client = (await register()).body.client_id;
    const { challenge } = await pkce();
    const request = async () => requestOf((await authorize(client, challenge, ada)).to);

    // A workspace Ada isn't in, a folder in a workspace of hers that isn't hers, a folder limit with no workspace, a key nobody defined.
    for (const refused of [{ workspaceId: grace.workspaceId }, { workspaceId: ada.workspaceId, folderIds: [secret.id] }, { folderIds: [secret.id] }, { workspaceId: grace.workspaceId, folderIds: [secret.id] }]) {
      const id = await request();
      await expect(consent(env.DB, ada.personId, { requestId: id, ...refused }), JSON.stringify(refused)).rejects.toMatchObject({ code: expect.stringMatching(/not_found|invalid/) });
      // The request stands, to be answered again with something she may.
      await expect(consent(env.DB, ada.personId, { requestId: id, workspaceId: ada.workspaceId })).resolves.toBeTruthy();
    }
    await expect(consent(env.DB, ada.personId, { requestId: await request(), readOnly: "yes", admin: true } as never)).rejects.toMatchObject({ code: "invalid" });
    expect(await listAgents(env.DB, grace.personId)).toEqual([]);

    const have = (await listAgents(env.DB, ada.personId)).filter((a) => a.revokedAt === null).length;
    for (let i = have; i < MAX_ACTIVE_AGENTS; i++) await connectAgent(env.DB, ada.personId, `Agent ${i}`);
    const other = (await register({ client_name: "Other" })).body.client_id;
    const id = requestOf((await authorize(other, (await pkce()).challenge, ada)).to);
    await expect(consent(env.DB, ada.personId, { requestId: id })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(String(MAX_ACTIVE_AGENTS)) });
    expect((await openRequest(env.DB, ada.personId, id)).clientName).toBe("Other");
  });
});

describe("trading a code for tokens", () => {
  it("gives an access token for an hour and a refresh token for 30 days, as a client is told, and neither is cached", async () => {
    const ada = await newMember();
    const { res, tokens, agentId } = await connect(ada);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(tokens.access_token).toMatch(/^cink_at_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^cink_rt_[A-Za-z0-9_-]{43}$/);
    const ends = Object.fromEntries((await env.DB.prepare("SELECT kind, expires_at FROM oauth_tokens WHERE agent_id = ?").bind(agentId).all<{ kind: string; expires_at: number }>()).results.map((r) => [r.kind, r.expires_at - Date.now()]));
    expect(ends.access).toBeGreaterThan(HOUR - 60_000);
    expect(ends.access).toBeLessThanOrEqual(HOUR);
    expect(ends.refresh).toBeGreaterThan(30 * DAY - 60_000);
    expect(ends.refresh).toBeLessThanOrEqual(30 * DAY);
    // Only hashes are kept.
    const kept = JSON.stringify((await env.DB.prepare("SELECT * FROM oauth_tokens").all()).results) + JSON.stringify((await env.DB.prepare("SELECT * FROM oauth_codes").all()).results);
    expect(kept).not.toContain(tokens.access_token.slice(8));
    expect(kept).not.toContain(tokens.refresh_token.slice(8));
  });

  it("opens /mcp: it lists tools and reads notes, as the member who consented", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Reading list\n\nSomething to read." });
    const { tokens } = await connect(ada);
    const listed = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toContain("read_note");
    expect((await tool(tokens.access_token, "read_note", { id: note.id })).json()).toMatchObject({ id: note.id });
    expect((await tool(tokens.access_token, "list_workspaces")).json().workspaces.map((w: { id: string }) => w.id)).toEqual([ada.workspaceId]);
    // Its edits are recorded under the agent's name.
    const made = (await tool(tokens.access_token, "create_note", { text: "# Mine" })).json();
    const history = (await tool(tokens.access_token, "note_history", { id: made.id })).json();
    expect(history[0].author).toMatchObject({ name: "Chat" });
  });

  it("works once: the second trade of a code is refused, and so is one that has lapsed", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { verifier, challenge } = await pkce();
    const granted = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    const first = await exchange({ code: granted.code, client_id: client, code_verifier: verifier });
    expect(first.status).toBe(200);
    const again = await exchange({ code: granted.code, client_id: client, code_verifier: verifier });
    expect([again.status, await errorOf(again)]).toEqual([400, "invalid_grant"]);
    expect(again.headers.get("Cache-Control")).toBe("no-store");

    const late = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    await env.DB.prepare("UPDATE oauth_codes SET expires_at = ?").bind(Date.now() - 1).run();
    const lapsed = await exchange({ code: late.code, client_id: client, code_verifier: verifier });
    expect([lapsed.status, await errorOf(lapsed)]).toEqual([400, "invalid_grant"]);
    expect((await agentRow(late.agentId))!.revoked_at).not.toBeNull();
    // Two at the same moment: one wins, and the other is a second use, which ends what the winner was given.
    const racing = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    const results = await Promise.all([1, 2].map(() => exchange({ code: racing.code, client_id: client, code_verifier: verifier })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const won = (await results.find((r) => r.status === 200)!.json()) as TokenAnswer;
    expect(await status(won.access_token)).toBe(401);
  });

  it("ends what a code gave when the code is presented again, as RFC 6749 asks", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { verifier, challenge } = await pkce();
    const granted = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    const first = (await (await exchange({ code: granted.code, client_id: client, code_verifier: verifier })).json()) as TokenAnswer;
    expect(await status(first.access_token)).toBe(200);
    const again = await exchange({ code: granted.code, client_id: client, code_verifier: verifier });
    expect([again.status, await errorOf(again)]).toEqual([400, "invalid_grant"]);
    expect(await status(first.access_token)).toBe(401);
    const refreshed = await refresh({ refresh_token: first.refresh_token, client_id: client });
    expect([refreshed.status, await errorOf(refreshed)]).toEqual([400, "invalid_grant"]);
    expect((await agentRow(granted.agentId))!.revoked_at).not.toBeNull();
  });

  it("keeps a fresh connection through a sweep that runs while its code is being traded", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { verifier, challenge } = await pkce();
    const granted = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    // Every batch the trade writes is preceded by a sweep, as if another request ran one at that moment.
    const sweeping = {
      prepare: (query: string) => env.DB.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        await sweep(env.DB, Date.now(), true);
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const tokens = await exchangeCode(sweeping, { code: granted.code, clientId: client, redirectUri: REDIRECT, verifier });
    expect((await agentRow(granted.agentId))!.revoked_at).toBeNull();
    expect(await status(tokens.accessToken)).toBe(200);
  });

  it("refuses a verifier that isn't the code's, and a code made for another address or another app, and spends the code", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const other = (await register({ client_name: "Other" })).body.client_id;
    const { verifier, challenge } = await pkce();
    const made = async () => consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    const wrong = (await pkce()).verifier;

    for (const [what, fields] of [
      ["a verifier that isn't the one", { client_id: client, code_verifier: wrong }],
      ["a verifier that is too short", { client_id: client, code_verifier: verifier.slice(0, 20) }],
      ["a challenge in place of the verifier", { client_id: client, code_verifier: challenge }],
      ["another address", { client_id: client, code_verifier: verifier, redirect_uri: `${REDIRECT}/` }],
      ["another app", { client_id: other, code_verifier: verifier }],
    ] as const) {
      const granted = await made();
      const res = await exchange({ code: granted.code, ...fields });
      expect([what, res.status, await errorOf(res)], what).toEqual([what, 400, "invalid_grant"]);
      // A try that failed spent the code, even for the app that has the right answers; and its agent holds nothing.
      const right = await exchange({ code: granted.code, client_id: client, code_verifier: verifier });
      expect([what, right.status], what).toEqual([what, 400]);
      expect((await agentRow(granted.agentId))!.revoked_at, what).not.toBeNull();
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE agent_id = ?").bind(granted.agentId).first<{ n: number }>())!.n).toBe(0);
    }
  });

  it("is refused to another person who has the code: they can't redeem it as their own app with their own challenge", async () => {
    const ada = await newMember();
    const eve = await newMember("Eve");
    const client = (await register()).body.client_id;
    const evesClient = (await register({ client_name: "Eve's app" })).body.client_id;
    const { verifier, challenge } = await pkce();
    const granted = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    const evesPkce = await pkce();
    const res = await exchange({ code: granted.code, client_id: evesClient, code_verifier: evesPkce.verifier });
    expect([res.status, await errorOf(res)]).toEqual([400, "invalid_grant"]);
    expect((await exchange({ code: granted.code, client_id: client, code_verifier: verifier })).status).toBe(400);
    expect(await listAgents(env.DB, eve.personId)).toEqual([]);
  });

  it("is asked right: an error for each thing missing or unknown, in the shape RFC 6749 gives", async () => {
    const ada = await newMember();
    const { client, verifier, granted } = await connect(ada);
    const cases: [string, Response, number, string][] = [
      ["no grant type", await send("/oauth/token", form({})), 400, "invalid_request"],
      ["a grant type nobody has", await send("/oauth/token", form({ grant_type: "password", username: "a" })), 400, "unsupported_grant_type"],
      ["client credentials", await send("/oauth/token", form({ grant_type: "client_credentials" })), 400, "unsupported_grant_type"],
      ["no code", await exchange({ client_id: client, code_verifier: verifier }), 400, "invalid_request"],
      ["no verifier", await exchange({ code: granted.code, client_id: client }), 400, "invalid_request"],
      ["no client", await exchange({ code: granted.code, code_verifier: verifier }), 400, "invalid_request"],
      ["a client nobody registered", await exchange({ code: granted.code, client_id: "nobody", code_verifier: verifier }), 401, "invalid_client"],
      ["a code that is a made-up string", await exchange({ code: "cink_ac_nothing", client_id: client, code_verifier: verifier }), 400, "invalid_grant"],
      ["a code that is another kind of token", await exchange({ code: "cink_x", client_id: client, code_verifier: verifier }), 400, "invalid_grant"],
      ["a resource that isn't /mcp", await exchange({ code: granted.code, client_id: client, code_verifier: verifier, resource: "https://other.example/mcp" }), 400, "invalid_target"],
      ["a repeated parameter", await send("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&grant_type=refresh_token" }), 400, "invalid_request"],
      ["a body of another type", await send("/oauth/token", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "grant_type=refresh_token" }), 400, "invalid_request"],
      ["a body that is too large", await send("/oauth/token", form({ grant_type: "refresh_token", refresh_token: "x".repeat(20_000) })), 400, "invalid_request"],
      ["a GET", await send("/oauth/token"), 405, "invalid_request"],
    ];
    for (const [what, res, code, error] of cases) {
      expect([what, res.status, await errorOf(res.clone())], what).toEqual([what, code, error]);
      expect(res.headers.get("Cache-Control"), what).toBe("no-store");
    }
  });

  it("takes JSON when it is sent, if every field is text", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { verifier, challenge } = await pkce();
    const granted = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to) });
    const res = await send("/oauth/token", asJson({ grant_type: "authorization_code", code: granted.code, client_id: client, redirect_uri: REDIRECT, code_verifier: verifier }));
    expect(res.status).toBe(200);
    const bad = await send("/oauth/token", asJson({ grant_type: "refresh_token", refresh_token: 5 }));
    expect([bad.status, await errorOf(bad)]).toEqual([400, "invalid_request"]);
  });

  it("gives tokens that don't outlive the agent", async () => {
    const ada = await newMember();
    const client = (await register()).body.client_id;
    const { verifier, challenge } = await pkce();
    const granted = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(client, challenge, ada)).to), expiresInDays: 1 });
    const soon = Date.now() + 30 * 60_000;
    await env.DB.prepare("UPDATE agents SET expires_at = ? WHERE id = ?").bind(soon, granted.agentId).run();
    const tokens = (await (await exchange({ code: granted.code, client_id: client, code_verifier: verifier })).json()) as TokenAnswer;
    expect(tokens.expires_in).toBeLessThanOrEqual(1800);
    expect(tokens.expires_in).toBeGreaterThan(1700);
    const ends = (await env.DB.prepare("SELECT expires_at FROM oauth_tokens WHERE agent_id = ?").bind(granted.agentId).all<{ expires_at: number }>()).results;
    expect(ends.map((e) => e.expires_at)).toEqual([soon, soon]);
    // At the agent's end the token stops.
    expect(await authenticateAgent(env.DB, tokens.access_token, soon - 1)).toMatchObject({ agentId: granted.agentId });
    expect(await authenticateAgent(env.DB, tokens.access_token, soon)).toBeNull();
  });

  it("stops at the end of its hour, and an agent that never expires has only the token's own end", async () => {
    const ada = await newMember();
    const { tokens, agentId } = await connect(ada, { expiresInDays: "never" });
    const at = (await env.DB.prepare("SELECT expires_at FROM oauth_tokens WHERE kind = 'access' AND agent_id = ?").bind(agentId).first<{ expires_at: number }>())!.expires_at;
    expect(await authenticateAgent(env.DB, tokens.access_token, at - 1)).not.toBeNull();
    expect(await authenticateAgent(env.DB, tokens.access_token, at)).toBeNull();
    expect(at - Date.now()).toBeLessThanOrEqual(HOUR);
  });
});

describe("a connection is an agent", () => {
  it("is on the agent list as connected from the app, and disconnecting it ends every token at once", async () => {
    const ada = await newMember();
    const { tokens, agentId, client } = await connect(ada);
    const pasted = await connectAgent(env.DB, ada.personId, "Pasted");
    const listed = await listAgents(env.DB, ada.personId);
    expect(listed.find((a) => a.id === agentId)).toMatchObject({ name: "Chat", revokedAt: null, tokenPrefix: "oauth", app: "Chat" });
    expect(listed.find((a) => a.id === pasted.agent.id)).toMatchObject({ name: "Pasted", app: null });
    expect((await agentRow(agentId))!.client_id).toBe(client);
    const second = (await (await refresh({ refresh_token: tokens.refresh_token, client_id: client })).json()) as TokenAnswer;
    expect(await status(tokens.access_token)).toBe(200);
    expect(await status(second.access_token)).toBe(200);

    await disconnectAgent(env.DB, ada.personId, agentId);
    expect([await status(tokens.access_token), await status(second.access_token)]).toEqual([401, 401]);
    for (const refresh_token of [second.refresh_token, tokens.refresh_token]) {
      const res = await refresh({ refresh_token, client_id: client });
      expect([res.status, await errorOf(res)]).toEqual([400, "invalid_grant"]);
    }
    const asked = await send(`/api/workspaces/${ada.workspaceId}/uploads/aaaaaaaaaaaa`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(asked.status).toBe(401);
  });

  it("is held to an edit from the next call, and to the agent's end", async () => {
    const ada = await newMember();
    const { tokens, agentId } = await connect(ada);
    expect((await tool(tokens.access_token, "create_note", { text: "# One" })).isError).toBe(false);
    await editAgent(env.DB, ada.personId, agentId, { readOnly: true });
    expect((await tool(tokens.access_token, "create_note", { text: "# Two" })).text).toContain("A read-only token can't note.create");
    await env.DB.prepare("UPDATE agents SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, agentId).run();
    expect(await status(tokens.access_token)).toBe(401);
  });

  it("is ended when its member signs out everywhere", async () => {
    const ada = await newMember();
    const { tokens } = await connect(ada);
    expect(await status(tokens.access_token)).toBe(200);
    await perform(env.DB, ada, { type: "member.signOut", memberId: ada.personId });
    expect(await status(tokens.access_token)).toBe(401);
  });

  it("is refused a write when read-only, on every tool that writes", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Fixed" });
    const { tokens } = await connect(ada, { readOnly: true });
    expect((await tool(tokens.access_token, "read_note", { id: note.id })).isError).toBe(false);
    expect((await tool(tokens.access_token, "create_note", { text: "# New" })).text).toContain("read-only");
    expect((await tool(tokens.access_token, "write_note", { id: note.id, baseRevision: 1, text: "# Changed" })).text).toContain("read-only");
    expect((await tool(tokens.access_token, "trash_note", { id: note.id })).text).toContain("read-only");
    expect((await tool(tokens.access_token, "create_folder", { name: "New" })).text).toContain("read-only");
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe("# Fixed");
  });

  it("is pinned to the workspace the member chose", async () => {
    const ada = await newMember();
    const bob = await addMember(ada, "editor", "Bob");
    const { tokens } = await connect(bob, { workspaceId: ada.workspaceId });
    expect((await tool(tokens.access_token, "list_workspaces")).json().workspaces.map((w: { id: string }) => w.id)).toEqual([ada.workspaceId]);
    const [own] = (await whoAmI(env.DB, bob.personId)).workspaces.filter((w) => w.id !== ada.workspaceId);
    expect((await tool(tokens.access_token, "list_notes", { workspaceId: own!.id })).text).toBe("not_found: No such workspace");
    const free = await connect(bob);
    expect((await tool(free.tokens.access_token, "list_workspaces")).json().workspaces).toHaveLength(2);
  });

  it("sees only the folders it was limited to, on every tool and on the upload routes", async () => {
    const ada = await newMember();
    const inside = await perform(env.DB, ada, { type: "folder.create", name: "Inside" });
    const outside = await perform(env.DB, ada, { type: "folder.create", name: "Outside" });
    const inNote = await perform(env.DB, ada, { type: "note.create", folderId: inside.id, text: "# In words" });
    const outNote = await perform(env.DB, ada, { type: "note.create", folderId: outside.id, text: "# Out words" });
    const inFile = await upload(ada, "in.png", PNG, { folderId: inside.id });
    const outFile = await upload(ada, "out.png", PNG, { folderId: outside.id });
    const { tokens } = await connect(ada, { workspaceId: ada.workspaceId, folderIds: [inside.id] });
    const claude = tokens.access_token;

    expect((await tool(claude, "read_note", { id: inNote.id })).isError).toBe(false);
    const absent = await tool(claude, "read_note", { id: "zzzzzzzzzzzz" });
    expect((await tool(claude, "read_note", { id: outNote.id })).text).toBe(absent.text);
    expect(absent).toMatchObject({ isError: true, text: "not_found: No such note" });
    expect((await tool(claude, "list_notes")).json().notes.map((n: { id: string }) => n.id)).toEqual([inNote.id]);
    expect((await tool(claude, "write_note", { id: outNote.id, baseRevision: 1, text: "# Overwritten" })).isError).toBe(true);
    expect((await tool(claude, "create_note", { folderId: outside.id, text: "# Planted" })).isError).toBe(true);
    expect((await perform(env.DB, ada, { type: "note.read", id: outNote.id })).text).toBe("# Out words");

    const bearer = { Authorization: `Bearer ${claude}` };
    const bytes = (id: string) => send(`/api/workspaces/${ada.workspaceId}/uploads/${id}`, { headers: bearer });
    expect((await bytes(inFile.id)).status).toBe(200);
    const none = await bytes("zzzzzzzzzzzz");
    const refused = await bytes(outFile.id);
    expect([refused.status, await refused.text()]).toEqual([404, await none.text()]);
    const post = (folderId: string) => send(`/api/workspaces/${ada.workspaceId}/uploads`, { method: "POST", headers: { ...bearer, "Content-Type": "application/octet-stream", "Content-Length": String(PNG.byteLength), "X-Ink-Upload": encodeURIComponent(JSON.stringify({ name: "new.png", folderId })) }, body: PNG });
    expect((await post(outside.id)).status).toBe(404);
    expect((await post(inside.id)).status).toBe(201);
  });

  it("reaches no more than the same member's pasted token: the same answers, a viewer who can't write, and nothing private", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "viewer", "Eve Viewer");
    const open = await perform(env.DB, ada, { type: "note.create", text: "# Open note" });
    const priv = await perform(env.DB, ada, { type: "note.create", text: "# Private note" });
    await perform(env.DB, ada, { type: "note.setPrivate", id: priv.id, private: true });
    const pasted = await connectAgent(env.DB, eve.personId, "Pasted", { workspaceId: ada.workspaceId });
    const { tokens } = await connect(eve, { workspaceId: ada.workspaceId });
    const calls: [string, Record<string, unknown>][] = [
      ["list_notes", {}],
      ["read_note", { id: open.id }],
      ["read_note", { id: priv.id }],
      ["create_note", { text: "# Eve's" }],
      ["write_note", { id: open.id, baseRevision: 1, text: "# Eve rewrote" }],
      ["trash_note", { id: open.id }],
      ["create_folder", { name: "Mine" }],
      ["list_workspaces", {}],
      ["search", { query: "Private" }],
      ["note_history", { id: priv.id }],
    ];
    for (const [name, args] of calls) {
      const viaOAuth = await tool(tokens.access_token, name, args);
      const viaPasted = await tool(pasted.token, name, args);
      expect([viaOAuth.isError, viaOAuth.text], name).toEqual([viaPasted.isError, viaPasted.text]);
    }
    expect((await tool(tokens.access_token, "read_note", { id: priv.id })).text).toBe("not_found: No such note");
    expect((await tool(tokens.access_token, "create_note", { text: "# Eve's" })).isError).toBe(true);
    expect((await perform(env.DB, ada, { type: "note.read", id: open.id })).text).toBe("# Open note");
  });
});

describe("refreshing", () => {
  it("gives new tokens and spends the refresh token, which lasts 30 days from now", async () => {
    const ada = await newMember();
    const { tokens, client, agentId } = await connect(ada);
    const res = await refresh({ refresh_token: tokens.refresh_token, client_id: client });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const next = (await res.json()) as TokenAnswer;
    expect(next).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await status(next.access_token)).toBe(200);
    // The one before still works until its hour is up: it was not used twice.
    expect(await status(tokens.access_token)).toBe(200);
    const family = (await env.DB.prepare("SELECT DISTINCT family FROM oauth_tokens WHERE agent_id = ?").bind(agentId).all()).results;
    expect(family).toHaveLength(1);
    const refreshEnd = (await env.DB.prepare("SELECT MAX(expires_at) AS e FROM oauth_tokens WHERE kind = 'refresh' AND used_at IS NULL AND agent_id = ?").bind(agentId).first<{ e: number }>())!.e;
    expect(refreshEnd - Date.now()).toBeGreaterThan(30 * DAY - 60_000);
    const third = (await (await refresh({ refresh_token: next.refresh_token, client_id: client })).json()) as TokenAnswer;
    expect(await status(third.access_token)).toBe(200);
  });

  it("ends the whole authorization when a refresh token is used again after the time a retry takes", async () => {
    const ada = await newMember();
    const { tokens, client, agentId } = await connect(ada);
    const next = (await (await refresh({ refresh_token: tokens.refresh_token, client_id: client })).json()) as TokenAnswer;
    expect(await status(next.access_token)).toBe(200);
    await env.DB.prepare("UPDATE oauth_tokens SET used_at = ? WHERE used_at IS NOT NULL AND agent_id = ?").bind(Date.now() - 31_000, agentId).run();

    const reused = await refresh({ refresh_token: tokens.refresh_token, client_id: client });
    expect([reused.status, await errorOf(reused)]).toEqual([400, "invalid_grant"]);
    // Whoever holds any of it, the thief or the app, is out: every access token, and the newest refresh token.
    expect(await status(next.access_token)).toBe(401);
    expect(await status(tokens.access_token)).toBe(401);
    const newest = await refresh({ refresh_token: next.refresh_token, client_id: client });
    expect([newest.status, await errorOf(newest)]).toEqual([400, "invalid_grant"]);
    expect((await agentRow(agentId))!.revoked_at).not.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE agent_id = ?").bind(agentId).first<{ n: number }>())!.n).toBe(0);
  });

  it("refuses a refresh token used again within 30 seconds without ending anything, as a retry after a lost answer", async () => {
    const ada = await newMember();
    const { tokens, client, agentId } = await connect(ada);
    const next = (await (await refresh({ refresh_token: tokens.refresh_token, client_id: client })).json()) as TokenAnswer;
    await env.DB.prepare("UPDATE oauth_tokens SET used_at = ? WHERE used_at IS NOT NULL AND agent_id = ?").bind(Date.now() - 5_000, agentId).run();

    const retried = await refresh({ refresh_token: tokens.refresh_token, client_id: client });
    expect([retried.status, await errorOf(retried)]).toEqual([400, "invalid_grant"]);
    // It reissues nothing, and ends nothing: the app has the tokens it was last answered with, if it got that answer.
    expect((await agentRow(agentId))!.revoked_at).toBeNull();
    expect(await status(next.access_token)).toBe(200);
    expect(await status(tokens.access_token)).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE agent_id = ? AND kind = 'refresh'").bind(agentId).first<{ n: number }>())!.n).toBe(2);
    const onward = await refresh({ refresh_token: next.refresh_token, client_id: client });
    expect(onward.status).toBe(200);
    // Once the time is up, the same token is a reuse.
    await env.DB.prepare("UPDATE oauth_tokens SET used_at = ? WHERE hash = (SELECT hash FROM oauth_tokens WHERE kind = 'refresh' AND used_at IS NOT NULL AND agent_id = ? ORDER BY used_at LIMIT 1)").bind(Date.now() - 31_000, agentId).run();
    expect((await refresh({ refresh_token: tokens.refresh_token, client_id: client })).status).toBe(400);
    expect((await agentRow(agentId))!.revoked_at).not.toBeNull();
  });

  it("is spent by one of two tries at the same moment: the winner's tokens work and the loser ends nothing", async () => {
    const ada = await newMember();
    const { tokens, client, agentId } = await connect(ada);
    const results = await Promise.all([1, 2].map(() => refresh({ refresh_token: tokens.refresh_token, client_id: client })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const won = (await results.find((r) => r.status === 200)!.json()) as TokenAnswer;
    const lost = results.find((r) => r.status === 400)!;
    expect(await errorOf(lost)).toBe("invalid_grant");
    expect(await status(won.access_token)).toBe(200);
    expect((await agentRow(agentId))!.revoked_at).toBeNull();
    // The winner's refresh token is good, and the pair that lost left no tokens behind.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE agent_id = ?").bind(agentId).first<{ n: number }>())!.n).toBe(4);
    expect((await refresh({ refresh_token: won.refresh_token, client_id: client })).status).toBe(200);
  });

  it("leaves a spent refresh token with a successor: if the new tokens can't be stored, it is not spent", async () => {
    const ada = await newMember();
    const { tokens, client, agentId } = await connect(ada);
    // A trigger makes the second insert fail, as a fault in the store would.
    await env.DB.prepare("CREATE TRIGGER fail_refresh BEFORE INSERT ON oauth_tokens WHEN NEW.kind = 'refresh' BEGIN SELECT RAISE(ABORT, 'no room'); END").run();
    try {
      const failed = await refresh({ refresh_token: tokens.refresh_token, client_id: client });
      expect(failed.status).toBe(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_refresh").run();
    }
    const used = (await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE agent_id = ? AND used_at IS NOT NULL").bind(agentId).first<{ n: number }>())!.n;
    expect(used).toBe(0);
    expect((await refresh({ refresh_token: tokens.refresh_token, client_id: client })).status).toBe(200);
  });

  it("is refused for an agent that has expired or been disconnected, and for a refresh token that has", async () => {
    const ada = await newMember();
    const expired = await connect(ada);
    await env.DB.prepare("UPDATE agents SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, expired.agentId).run();
    const a = await refresh({ refresh_token: expired.tokens.refresh_token, client_id: expired.client });
    expect([a.status, await errorOf(a)]).toEqual([400, "invalid_grant"]);
    expect(await status(expired.tokens.access_token)).toBe(401);

    const gone = await connect(ada);
    await disconnectAgent(env.DB, ada.personId, gone.agentId);
    const b = await refresh({ refresh_token: gone.tokens.refresh_token, client_id: gone.client });
    expect([b.status, await errorOf(b)]).toEqual([400, "invalid_grant"]);

    const lapsed = await connect(ada);
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'refresh' AND agent_id = ?").bind(Date.now() - 1, lapsed.agentId).run();
    const c = await refresh({ refresh_token: lapsed.tokens.refresh_token, client_id: lapsed.client });
    expect([c.status, await errorOf(c)]).toEqual([400, "invalid_grant"]);
    expect(await status(lapsed.tokens.access_token)).toBe(200);
  });

  it("is refused to another app, or when the token is not a refresh token, without ending anything", async () => {
    const ada = await newMember();
    const { tokens, client, agentId } = await connect(ada);
    const other = (await register({ client_name: "Other" })).body.client_id;
    for (const [what, fields] of [
      ["another app", { refresh_token: tokens.refresh_token, client_id: other }],
      ["an access token", { refresh_token: tokens.access_token, client_id: client }],
      ["a pasted agent token", { refresh_token: (await connectAgent(env.DB, ada.personId, "Pasted")).token, client_id: client }],
      ["nonsense", { refresh_token: "cink_rt_nothing", client_id: client }],
    ] as const) {
      const res = await refresh(fields);
      expect([what, res.status, await errorOf(res)]).toEqual([what, 400, "invalid_grant"]);
    }
    expect((await refresh({ refresh_token: tokens.refresh_token, client_id: "nobody" })).status).toBe(401);
    expect((await refresh({ refresh_token: tokens.refresh_token })).status).toBe(400);
    expect((await agentRow(agentId))!.revoked_at).toBeNull();
    expect(await status(tokens.access_token)).toBe(200);
    expect((await refresh({ refresh_token: tokens.refresh_token, client_id: client })).status).toBe(200);
  });
});

describe("what is a token and what is not", () => {
  it("never takes a refresh token, a code or the hash of one as a Bearer token, on /mcp or the upload routes", async () => {
    const ada = await newMember();
    const { tokens, granted } = await connect(ada);
    const hash = (await env.DB.prepare("SELECT hash FROM oauth_tokens WHERE kind = 'access'").first<{ hash: string }>())!.hash;
    for (const bad of [tokens.refresh_token, granted.code, hash, `cink_at_${tokens.access_token.slice(8)}x`, tokens.access_token.toUpperCase(), "cink_at_", "cink_rt_", tokens.access_token.replace("cink_at_", "cink_")]) {
      expect(await status(bad), bad.slice(0, 12)).toBe(401);
      const res = await send(`/api/workspaces/${ada.workspaceId}/uploads/aaaaaaaaaaaa`, { headers: { Authorization: `Bearer ${bad}` } });
      expect(res.status, bad.slice(0, 12)).toBe(401);
    }
    expect(await status(tokens.access_token)).toBe(200);
    expect(await authenticateAgent(env.DB, tokens.refresh_token)).toBeNull();
  });

  it("still takes a pasted agent token that happens to begin with cink_at_", async () => {
    const ada = await newMember();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Unlucky");
    const lucky = `cink_at_${token.slice(5)}`.slice(0, token.length);
    await env.DB.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").bind(await hashToken(lucky), agent.id).run();
    expect(await status(lucky)).toBe(200);
  });

  it("opens the upload routes for an access token, as for a pasted one", async () => {
    const ada = await newMember();
    const file = await upload(ada, "dot.png");
    const { tokens } = await connect(ada);
    const res = await send(`/api/workspaces/${ada.workspaceId}/uploads/${file.id}`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);
  });
});

describe("revoking", () => {
  it("ends the authorization from either token, and says 200 to anything", async () => {
    const ada = await newMember();
    const byAccess = await connect(ada);
    const revoked = await send("/oauth/revoke", form({ token: byAccess.tokens.access_token, token_type_hint: "access_token", client_id: byAccess.client }));
    expect([revoked.status, await revoked.text()]).toEqual([200, ""]);
    expect(revoked.headers.get("Cache-Control")).toBe("no-store");
    expect(await status(byAccess.tokens.access_token)).toBe(401);
    expect((await refresh({ refresh_token: byAccess.tokens.refresh_token, client_id: byAccess.client })).status).toBe(400);
    expect((await agentRow(byAccess.agentId))!.revoked_at).not.toBeNull();

    const byRefresh = await connect(ada);
    expect((await send("/oauth/revoke", form({ token: byRefresh.tokens.refresh_token }))).status).toBe(200);
    expect(await status(byRefresh.tokens.access_token)).toBe(401);
    expect((await refresh({ refresh_token: byRefresh.tokens.refresh_token, client_id: byRefresh.client })).status).toBe(400);

    for (const body of [form({}), form({ token: "" }), form({ token: "cink_rt_unknown" }), form({ token: "garbage" }), asJson({ token: "x" }), asJson({ token: 5 }), { method: "POST", headers: { "Content-Type": "text/plain" }, body: "token=x" }, asJson("not an object")]) {
      expect((await send("/oauth/revoke", body)).status).toBe(200);
    }
    expect((await send("/oauth/revoke")).status).toBe(405);
  });

  it("leaves a token alone when another app names itself as revoking it", async () => {
    const ada = await newMember();
    const mine = await connect(ada);
    const other = (await register({ client_name: "Other" })).body.client_id;
    expect((await send("/oauth/revoke", form({ token: mine.tokens.refresh_token, client_id: other }))).status).toBe(200);
    expect((await send("/oauth/revoke", form({ token: mine.tokens.access_token, client_id: other }))).status).toBe(200);
    expect(await status(mine.tokens.access_token)).toBe(200);
    expect((await agentRow(mine.agentId))!.revoked_at).toBeNull();
    expect((await send("/oauth/revoke", form({ token: mine.tokens.refresh_token, client_id: mine.client }))).status).toBe(200);
    expect(await status(mine.tokens.access_token)).toBe(401);
  });

  it("can't be used to disconnect an agent that was connected on the Agents page", async () => {
    const ada = await newMember();
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Pasted");
    const other = await connect(ada);
    expect((await send("/oauth/revoke", form({ token }))).status).toBe(200);
    expect((await send("/oauth/revoke", form({ token: other.tokens.access_token.replace("cink_at_", "cink_") }))).status).toBe(200);
    expect(await status(token)).toBe(200);
    expect((await agentRow(agent.id))!.revoked_at).toBeNull();
    expect(await status(other.tokens.access_token)).toBe(200);
  });
});

describe("CORS", () => {
  it("lets any site read the metadata, register, trade a code and revoke, with no credentials, and answers a preflight", async () => {
    const from = { Origin: "https://claude.ai" };
    const ada = await newMember();
    const { tokens } = await connect(ada);
    const open = [
      send("/.well-known/oauth-protected-resource", { headers: from }),
      send("/.well-known/oauth-protected-resource/mcp", { headers: from }),
      send("/.well-known/oauth-authorization-server", { headers: from }),
      send("/oauth/register", { ...asJson({ redirect_uris: [REDIRECT] }), headers: { ...from, "Content-Type": "application/json" } }),
      send("/oauth/token", { ...form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: "nobody" }), headers: { ...from, "Content-Type": "application/x-www-form-urlencoded" } }),
      send("/oauth/revoke", { ...form({ token: "x" }), headers: { ...from, "Content-Type": "application/x-www-form-urlencoded" } }),
    ];
    for (const res of await Promise.all(open)) {
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
    for (const path of ["/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
      const res = await send(path, { method: "OPTIONS", headers: { ...from, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
      expect([path, res.status, res.headers.get("Access-Control-Allow-Origin"), res.headers.get("Access-Control-Allow-Methods"), res.headers.get("Access-Control-Allow-Headers")?.toLowerCase().split(", ").sort()]).toEqual([path, 204, "*", "GET, POST, OPTIONS", ["accept", "authorization", "content-type", "mcp-protocol-version"]]);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
    // An error is readable too, so an app in a browser sees why.
    const error = await send("/oauth/token", { ...form({ grant_type: "password" }), headers: { ...from, "Content-Type": "application/x-www-form-urlencoded" } });
    expect([error.status, error.headers.get("Access-Control-Allow-Origin")]).toEqual([400, "*"]);
  });
});

describe("bodies", () => {
  it("is read as it comes and given up on past 16 KB, so a body sent in chunks with no length can't be held whole", async () => {
    for (const [path, type] of [["/oauth/token", "application/x-www-form-urlencoded"], ["/oauth/register", "application/json"], ["/oauth/revoke", "application/x-www-form-urlencoded"]] as const) {
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(8192).fill(97));
          if (pulled >= 400) controller.close();
        },
      });
      const res = await send(path, { method: "POST", headers: { "Content-Type": type }, body: stream, duplex: "half" } as RequestInit);
      expect(res.status, path).toBe(path === "/oauth/revoke" ? 200 : 400);
      expect(pulled, `${path} read ${pulled} chunks of 8 KB`).toBeLessThan(10);
    }
  });
});

describe("clearing out", () => {
  it("disconnects the agent of a connection that holds nothing that works: tokens run out, or a code never traded", async () => {
    const ada = await newMember();
    const live = await connect(ada);
    const lapsed = await connect(ada);
    const pasted = await connectAgent(env.DB, ada.personId, "Pasted");
    const waitingClient = (await register()).body.client_id;
    const leftClient = (await register({ client_name: "Left" })).body.client_id;
    const { challenge } = await pkce();
    const waiting = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(waitingClient, challenge, ada)).to) });
    const abandoned = await consent(env.DB, ada.personId, { requestId: requestOf((await authorize(leftClient, challenge, ada)).to) });
    await env.DB.prepare("UPDATE oauth_codes SET expires_at = ? WHERE agent_id = ?").bind(Date.now() - 1, abandoned.agentId).run();
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE agent_id = ?").bind(Date.now() - 1, lapsed.agentId).run();
    // A refresh token still good keeps the connection, whatever has become of its access token.
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE agent_id = ? AND kind = 'access'").bind(Date.now() - 1, live.agentId).run();

    await sweep(env.DB, Date.now(), true);

    const revoked = async (id: string) => (await agentRow(id))!.revoked_at !== null;
    expect(await revoked(live.agentId)).toBe(false);
    expect(await revoked(waiting.agentId)).toBe(false);
    expect(await revoked(pasted.agent.id)).toBe(false);
    expect(await revoked(lapsed.agentId)).toBe(true);
    expect(await revoked(abandoned.agentId)).toBe(true);
    expect((await refresh({ refresh_token: live.tokens.refresh_token, client_id: live.client })).status).toBe(200);
  });

  it("runs at most once a minute unless it is made to, and the Worker's timer makes it", async () => {
    const ada = await newMember();
    const lapse = (id: string) => env.DB.prepare("INSERT OR REPLACE INTO oauth_requests (id, client_id, redirect_uri, code_challenge, person_id, created_at) SELECT ?, id, 'https://chat.example/cb', 'c', ?, ? FROM oauth_clients LIMIT 1").bind(id, ada.personId, Date.now() - 3_600_000).run();
    const there = async (id: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_requests WHERE id = ?").bind(id).first<{ n: number }>())!.n;
    await register();
    const start = Date.now() + 10 * 60_000;
    await sweep(env.DB, start);
    await lapse("lapsed-1");
    await sweep(env.DB, start + 10_000);
    expect(await there("lapsed-1")).toBe(1);
    await sweep(env.DB, start + 10_000, true);
    expect(await there("lapsed-1")).toBe(0);
    await lapse("lapsed-2");
    await sweep(env.DB, start + 90_000);
    expect(await there("lapsed-2")).toBe(0);

    await lapse("lapsed-3");
    await worker.scheduled({ scheduledTime: Date.now(), cron: "17 * * * *", type: "scheduled", noRetry() {} } as never, { ...env, SESSION_SECRET: SECRET });
    expect(await there("lapsed-3")).toBe(0);
  });
});
