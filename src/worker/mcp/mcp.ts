// The MCP endpoint, https://<host>/mcp: Streamable HTTP in its stateless form, one JSON-RPC message (or a
// batch) per POST, answered as JSON. It speaks MCP 2026-07-28, where each request carries its version in
// params._meta, beside the earlier versions that begin with initialize. An agent signs in with the bearer
// token its member made for it; it never has a session cookie, so a web page can't make it act. See docs/mcp.md.
import { authenticateAgent } from "../../core/agents.ts";
import { authenticateClipper } from "../../core/clipper.ts";
import type { Sources } from "../../core/sources.ts";
import { logFault } from "../../core/logs.ts";
import { BROKE } from "../../core/protocol.ts";
import { ASK_NOTE_SYNTAX } from "../../core/noteSyntax.ts";
import { metadataUrl } from "../oauth.ts";
import { callTool, toolList, type Caller, type Reached } from "./tools.ts";

const SUPPORTED = { modern: ["2026-07-28"], legacy: ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] };
const ALL_VERSIONS = [...SUPPORTED.modern, ...SUPPORTED.legacy];
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
/** Tools change only when the server is deployed. */
const TTL_MS = 3_600_000;
/** Room for upload_file's base64 of a file of MAX_INLINE_UPLOAD_BYTES, and the rest of the message. */
const MAX_BODY = 6_000_000;
/** One request is one Worker invocation, with a fixed number of subrequests, so a batch is held to a few messages. */
const MAX_BATCH = 20;
/** What an agent is told when it has made more tool calls than MCP_CALLS allows it in a minute (wrangler.jsonc). */
export const RATE_LIMITED = "rate_limited: Too many calls. An agent makes at most 300 a minute. Wait a minute, then call again.";

const SERVER = { name: "common-ink", version: "0.1.0" };
const INSTRUCTIONS =
  `Common Ink is a markdown notes workspace. You act as the member who connected you, with their role, and your edits are recorded under your own name. Read a note before writing it, and send its revision as baseRevision. To change some lines and leave the rest, call edit_note. ${ASK_NOTE_SYNTAX}`;

type Id = string | number | null;
interface Request_ {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}
type Params = Record<string, unknown>;
/** A modern message names its version in params._meta and has no initialize; a legacy one began with initialize. */
type Era = { kind: "legacy" } | { kind: "modern"; meta: Params };
/** A message's answer and the HTTP status a single-message POST is answered with. */
type Answer = { message: Out | null; status: number };
type Out = { jsonrpc: "2.0"; id: Id; result: object } | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string; data?: unknown } };

const reply = (id: Id, result: object): Out => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string, data?: unknown): Out => ({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });

const paramsOf = (m: Request_): Params => (typeof m.params === "object" && m.params !== null ? m.params : {}) as Params;

function eraOf(m: Request_): Era {
  const given = paramsOf(m)._meta;
  const meta = (typeof given === "object" && given !== null ? given : {}) as Params;
  return m.method === "server/discover" || VERSION_KEY in meta || CAPABILITIES_KEY in meta ? { kind: "modern", meta } : { kind: "legacy" };
}

/** A modern request's version, capabilities and mirrored headers, or the error that refuses it. */
function refuseModern(id: Id, meta: Params, m: Request_, headers: Headers): Out | null {
  const version = meta[VERSION_KEY];
  const capabilities = meta[CAPABILITIES_KEY];
  if (typeof version !== "string") return fail(id, -32602, `params._meta["${VERSION_KEY}"] is required`);
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) return fail(id, -32602, `params._meta["${CAPABILITIES_KEY}"] is required, an object`);
  if (!SUPPORTED.modern.includes(version)) return fail(id, -32022, "Unsupported protocol version", { supported: ALL_VERSIONS, requested: version });
  if (m.method === "tools/call" && typeof paramsOf(m).name !== "string") return fail(id, -32602, "Name the tool to call");
  const mirrored: Array<[string, unknown]> = [["MCP-Protocol-Version", version], ["Mcp-Method", m.method]];
  if (m.method === "tools/call") mirrored.push(["Mcp-Name", paramsOf(m).name]);
  for (const [name, body] of mirrored) {
    const raw = headers.get(name);
    const value = raw !== null && name === "Mcp-Name" ? decodeSentinel(raw) : raw;
    if (value === null) return fail(id, -32020, `Header mismatch: the ${name} header is missing`);
    if (value !== body) return fail(id, -32020, `Header mismatch: ${name} header value '${raw}' does not match body value '${String(body)}'`);
  }
  return null;
}

/** A header value that can't be plain ASCII is sent as =?base64?<UTF-8 as base64>?=. */
function decodeSentinel(value: string): string {
  const sentinel = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!sentinel) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(sentinel[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

/** The HTTP status of a modern error, where the spec names one. Any other error is the model's to read, so it comes back as 200. */
const STATUS_OF: Record<number, number> = { [-32600]: 400, [-32601]: 404, [-32603]: 500 };

/** A modern result says it is complete and which server answered; a modern error carries its HTTP status. */
function finish(era: Era, out: Out | null): Answer {
  if (era.kind === "legacy" || out === null) return { message: out, status: 200 };
  if ("error" in out) return { message: out, status: STATUS_OF[out.error.code] ?? 200 };
  return { message: { ...out, result: { ...out.result, resultType: "complete", _meta: { ...(out.result as { _meta?: object })._meta, "io.modelcontextprotocol/serverInfo": SERVER } } }, status: 200 };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/**
 * What a request without a good token is told: the realm, and where an OAuth client finds out how to sign in (RFC 9728).
 * One that sent a token is told it was no good (RFC 6750), which is how an OAuth client knows to refresh or sign in again.
 */
const challenge = (url: URL, sent: boolean) => `Bearer realm="Common Ink"${sent ? ', error="invalid_token"' : ""}, resource_metadata="${metadataUrl(url)}"`;

const unauthorized = (url: URL, sent: boolean) =>
  json({ error: "unauthorized", message: "Send a Common Ink agent token or an OAuth access token: Authorization: Bearer cink_…" }, 401, { "WWW-Authenticate": challenge(url, sent) });

export const bearerToken = (req: Request): string | null => /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1] ?? null;

export async function handleMcp(req: Request, env: Env, sources?: Sources): Promise<Response> {
  const token = bearerToken(req);
  const agent = token ? await authenticateAgent(env.DB, token) : null;
  const clipper = !agent && token ? await authenticateClipper(env.DB, token) : null;
  if (!agent && !clipper) return unauthorized(new URL(req.url), token !== null);
  // A clipper grant is the member who allowed it, limited to the clipper's tools. The note is theirs, and it is not an agent.
  const caller: Caller = agent ?? {
    agentId: clipper!.grantId,
    personId: clipper!.personId,
    name: "Clipper",
    workspaceId: null,
    readOnly: false,
    folderIds: null,
    clipper: true,
  };

  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "POST JSON-RPC messages to /mcp" }, 405, { Allow: "POST" });
  if (!req.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "unsupported_media_type", message: "Send application/json" }, 415);
  const declared = Number(req.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY) return json({ error: "too_large" }, 413);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(fail(null, -32700, "The body isn't JSON"), 400);
  }

  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as unknown[];
  if (batch && messages.length === 0) return json(fail(null, -32600, "An empty batch"), 400);
  if (messages.length > MAX_BATCH) return json(fail(null, -32600, `A batch holds at most ${MAX_BATCH} messages`), 400);
  // A batch is for the versions before 2026-07-28, so one modern message in it is refused before anything is done.
  if (batch && messages.some((message) => eraOf(asRequest(message)).kind === "modern"))
    return json(fail(null, -32600, "A batch is for protocol versions before 2026-07-28; send one message per request"), 400);
  const out: Answer[] = [];
  for (const m of messages.map(asRequest)) {
    // One message that hits a fault is answered so, under its own id, and the rest of a batch is still answered.
    const answer = await handleMessage(env, caller, m, sources, { origin: new URL(req.url).origin, bucket: env.FILES }, req.headers).catch((err: unknown) => {
      logFault("An MCP message", err);
      return finish(eraOf(m), fail(typeof m.id === "string" || typeof m.id === "number" ? m.id : null, -32603, BROKE));
    });
    if (answer.message) out.push(answer);
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  return batch ? json(out.map((answer) => answer.message)) : json(out[0]!.message, out[0]!.status);
}

const asRequest = (message: unknown) => (typeof message === "object" && message !== null ? message : {}) as Request_;

async function handleMessage(env: Env, agent: Caller, m: Request_, sources: Sources | undefined, reached: Reached, headers: Headers): Promise<Answer> {
  const era = eraOf(m);
  const hasId = m.id !== undefined;
  const id: Id = hasId && (typeof m.id === "string" || typeof m.id === "number" || m.id === null) ? m.id : null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return finish(era, fail(id, -32600, "Not a JSON-RPC 2.0 request"));
  // A notification has no id and gets no answer.
  if (!hasId) return finish(era, null);
  if (era.kind === "modern") {
    const refused = refuseModern(id, era.meta, m, headers);
    if (refused) return { message: refused, status: 400 };
  }
  return finish(era, await answerMethod(env, agent, era, id, m.method, paramsOf(m), sources, reached));
}

async function answerMethod(env: Env, agent: Caller, era: Era, id: Id, method: string, params: Params, sources: Sources | undefined, reached: Reached): Promise<Out> {
  switch (method) {
    case "initialize": {
      if (era.kind === "modern") break;
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return reply(id, {
        protocolVersion: SUPPORTED.legacy.includes(asked) ? asked : SUPPORTED.legacy[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      if (era.kind === "modern") break;
      return reply(id, {});
    case "server/discover":
      return reply(id, { supportedVersions: ALL_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: TTL_MS, cacheScope: "public" });
    case "tools/list":
      // What a token sees depends on the token: a clipper's grant lists fewer tools.
      return reply(id, era.kind === "modern" ? { tools: toolList(agent), ttlMs: TTL_MS, cacheScope: "private" } : { tools: toolList(agent) });
    case "tools/call": {
      if (typeof params.name !== "string") return fail(id, -32602, "Name the tool to call");
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) return fail(id, -32602, "arguments must be an object");
      if (!env.MCP_CALLS) throw new Error("The MCP_CALLS rate limit isn't bound");
      // A fault in the limiter lets the call through: it guards against a runaway agent, and isn't worth every agent's calls.
      const allowed = await env.MCP_CALLS.limit({ key: agent.agentId }).then(
        (outcome) => outcome.success,
        (err: unknown) => (logFault("The MCP_CALLS rate limit", err), true),
      );
      if (!allowed) return reply(id, { content: [{ type: "text", text: RATE_LIMITED }], isError: true });
      const result = await callTool(env.DB, agent, params.name, args as Record<string, unknown>, sources, reached);
      return result ? reply(id, result) : fail(id, -32602, `No such tool: ${params.name}`);
    }
  }
  return fail(id, -32601, `No such method: ${method}`);
}
