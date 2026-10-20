import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import type { Actor } from "../../src/core/operations.ts";
import worker from "../../src/worker/index.ts";
import { routeOf, sentryTarget } from "../../src/worker/report.ts";
import { sign } from "../../src/worker/session.ts";
import { newMember } from "./members.ts";

afterEach(() => vi.restoreAllMocks());

const SECRET = "test-secret";
const RAY = "8f1e2d3c4b5a6978-LHR";
const VERSION = { id: "5d3c0a6e-version", tag: "", timestamp: "2026-10-19T00:00:00Z" };
const DSN = "https://abc123@o1.ingest.sentry.io/4507";

const sessionOf = async (member: Actor) => `__Host-ink_session=${encodeURIComponent(await sign({ personId: member.personId }, SECRET, 3600))}`;

/** The test's database, but every statement whose SQL matches `when` throws `err` as it is prepared. */
function breaking(when: RegExp, err: Error): D1Database {
  return new Proxy(env.DB, {
    get(db, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (when.test(sql)) throw err;
          return db.prepare(sql);
        };
      const value = Reflect.get(db, key) as unknown;
      return typeof value === "function" ? value.bind(db) : value;
    },
  });
}

/** What the Worker told Workers Logs of faults. */
function faultsLogged() {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => logged.mock.calls.map(([line]) => line as unknown).filter((line) => typeof line === "object" && line !== null && "fault" in line);
}

async function ask(req: Request, more: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req as never, { ...env, SESSION_SECRET: SECRET, CF_VERSION_METADATA: VERSION, ...more }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("telling of faults", () => {
  it("reports an operation that broke once, by its route's pattern and its type, with nothing of the note in it", async () => {
    const faults = faultsLogged();
    const ada = await newMember();
    const req = new Request(`https://ink.test/api/workspaces/${ada.workspaceId}/ops`, {
      method: "POST",
      headers: { Origin: "https://ink.test", "Content-Type": "application/json", Cookie: await sessionOf(ada), "CF-Ray": RAY },
      body: JSON.stringify({ type: "note.create", text: "# Dear diary" }),
    });
    const res = await ask(req, { DB: breaking(/INSERT INTO notes/, new Error(`D1_ERROR: CHECK constraint failed: "# Dear diary"`)) });

    expect([res.status, await res.json()]).toEqual([500, { error: "unknown", message: expect.any(String) }]);
    expect(faults()).toEqual([
      {
        fault: {
          source: "worker",
          route: "/api/workspaces/*/ops",
          requestId: RAY,
          op: "note.create",
          status: 500,
          name: "Error",
          message: `D1_ERROR: CHECK constraint failed: "…"`,
          stack: expect.stringMatching(/^Error: D1_ERROR: CHECK constraint failed: "…"\n\s+at /),
        },
      },
    ]);
  });

  it("reports an agent's tool call that broke by the tool, though MCP answers it in a 200", async () => {
    const faults = faultsLogged();
    const ada = await newMember();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const req = new Request("https://ink.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "CF-Ray": RAY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "create_note", arguments: { text: "# Dear diary" } } }),
    });
    const res = await ask(req, { DB: breaking(/INSERT INTO notes/, new Error("D1_ERROR: disk I/O error")) });

    expect([res.status, await res.json()]).toEqual([200, { jsonrpc: "2.0", id: 7, error: { code: -32603, message: expect.any(String) } }]);
    expect(faults()).toEqual([
      { fault: { source: "worker", route: "/mcp", requestId: RAY, op: "tools/call:create_note", status: 200, name: "Error", message: "D1_ERROR: disk I/O error", stack: expect.stringMatching(/^Error: D1_ERROR/) } },
    ]);
  });

  it("reports the hourly job's fault by what it was doing", async () => {
    const faults = faultsLogged();
    const ctx = createExecutionContext();
    await worker.scheduled!({ scheduledTime: Date.now(), cron: "17 * * * *", noRetry() {} } as ScheduledController, { ...env, DB: breaking(/./, new Error("D1_ERROR: database is locked")) } as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(faults()).toEqual([
      { fault: { source: "job", route: "cron", requestId: null, op: "purgeTrash", status: null, name: "Error", message: "D1_ERROR: database is locked", stack: expect.stringMatching(/^Error: D1_ERROR/) } },
    ]);
  });

  it("sends a fault to Sentry as an envelope when SENTRY_DSN is set, and only then", async () => {
    faultsLogged();
    const sent = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const broken = { DB: breaking(/SELECT 1/, new Error("D1_ERROR: Network connection lost.")) };
    const health = () => new Request("https://ink.test/health", { headers: { "CF-Ray": RAY } });

    await ask(health(), broken);
    expect(sent.mock.calls).toEqual([]);

    // The same fault again within the minute, as from the next uptime check, goes to Workers Logs alone.
    await ask(health(), { ...broken, SENTRY_DSN: DSN });
    await ask(health(), { ...broken, SENTRY_DSN: DSN });
    expect(sent.mock.calls.map(([to, init]) => [String(to), init?.method, (init?.headers as Record<string, string>)["X-Sentry-Auth"]])).toEqual([
      ["https://o1.ingest.sentry.io/api/4507/envelope/", "POST", "Sentry sentry_version=7, sentry_key=abc123, sentry_client=common-ink/1"],
    ]);
    const [head, item, event] = String(sent.mock.calls[0]![1]!.body).trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(head).toEqual({ event_id: expect.stringMatching(/^[0-9a-f]{32}$/), sent_at: expect.any(String), dsn: DSN });
    expect(item).toEqual({ type: "event" });
    expect(event).toEqual({
      event_id: head!.event_id,
      timestamp: expect.any(Number),
      platform: "javascript",
      level: "error",
      logger: "worker",
      transaction: "/health",
      release: VERSION.id,
      tags: { source: "worker", route: "/health", status: "503", request_id: RAY },
      exception: { values: [{ type: "Error", value: "D1_ERROR: Network connection lost." }] },
      extra: { stack: expect.stringMatching(/^Error: D1_ERROR: Network connection lost\.\n/) },
    });
  });

  it("hears a fault from a signed-in member's page on the app's own origin, and from nobody else", async () => {
    const faults = faultsLogged();
    const ada = await newMember();
    const body = JSON.stringify({ route: "/s/AbCdEfGhIjKlMnOpQrStUvWx", name: "TypeError", message: "Cannot read properties of undefined (reading 'Dear diary')", stack: "TypeError: x\n    at draw (https://ink.test/assets/index-abc.js:1:2)" });
    const told = async (headers: Record<string, string>) => (await ask(new Request("https://ink.test/api/faults", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }))).status;

    expect(await told({ Origin: "https://ink.test", Cookie: await sessionOf(ada) })).toBe(204);
    expect(await told({ Origin: "https://evil.example", Cookie: await sessionOf(ada) })).toBe(403);
    expect(await told({ Origin: "https://ink.test" })).toBe(401);
    // A script sending more than any page would is turned away within the minute.
    const grace = await newMember("Grace Hopper");
    const flood = [];
    for (let i = 0; i < 21; i++) flood.push(await told({ Origin: "https://ink.test", Cookie: await sessionOf(grace) }));
    expect([flood.slice(0, 20).every((status) => status === 204), flood[20]]).toEqual([true, 429]);
    expect(faults().slice(0, 1)).toEqual([
      {
        fault: {
          source: "client",
          route: "/s/*",
          requestId: null,
          op: null,
          status: null,
          name: "TypeError",
          message: "Cannot read properties of undefined (reading '…')",
          stack: "TypeError: x\n    at draw (https://ink.test/assets/index-abc.js:1:2)",
        },
      },
    ]);
  });

  it("names a route by its pattern of known words, never an id, a token or a name", () => {
    expect(
      [
        "/api/workspaces/abcdefghijkl/plugins/calendar/draft/ops",
        "/api/shared/AbCdEfGhIjKlMnOpQrStUvWx/notes/abcdefghijkl",
        "/api/upload-parts/q3_Zr-0b7XkLw9TnV2yHcUeJfA5mPdS1oGiRxNtB8Yh/3",
        "/note/abcdefghijkl",
        "/tag/secret-project",
        "/.well-known/oauth-protected-resource/mcp",
        "/",
      ].map(routeOf),
    ).toEqual(["/api/workspaces/*/plugins/*/draft/ops", "/api/shared/*/notes/*", "/api/upload-parts/*/3", "/note/*", "/*/*", "/.well-known/oauth-protected-resource/mcp", "/"]);
  });

  it("reads a DSN as where to send and the key, and anything else as no DSN", () => {
    expect([DSN, "https://abc123@sentry.example/4507/", "http://abc123@o1.ingest.sentry.io/4507", "https://o1.ingest.sentry.io/4507", "not a dsn"].map(sentryTarget)).toEqual([
      { endpoint: "https://o1.ingest.sentry.io/api/4507/envelope/", key: "abc123" },
      { endpoint: "https://sentry.example/api/4507/envelope/", key: "abc123" },
      null,
      null,
      null,
    ]);
  });
});

describe("/health", () => {
  it("answers whoever asks with the Worker's version when the database answers, and 503 when it doesn't", async () => {
    faultsLogged();
    const health = async (more: Partial<Env> = {}) => {
      const res = await ask(new Request("https://ink.test/health"), more);
      return [res.status, res.headers.get("Cache-Control"), await res.json()];
    };
    expect(await health()).toEqual([200, "no-store", { ok: true, version: VERSION.id }]);
    expect(await health({ DB: breaking(/SELECT 1/, new Error("D1_ERROR: Network connection lost.")) })).toEqual([503, "no-store", { ok: false, version: VERSION.id }]);
  });
});
