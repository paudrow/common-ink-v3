// The MCP endpoint, https://<host>/mcp: Streamable HTTP in its stateless form, one JSON-RPC message (or a
// batch) per POST, answered as JSON. An agent signs in with the bearer token its member made for it; it
// never has a session cookie, so a web page can't make it act. See docs/mcp.md.
import { authenticateAgent, type ConnectedAgent } from "../../core/agents.ts";
import { BROKE } from "../../core/protocol.ts";
import { callTool, toolList } from "./tools.ts";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1_200_000;

const SERVER = { name: "common-ink", version: "0.1.0" };
const INSTRUCTIONS =
  "Common Ink is a markdown notes workspace. You act as the member who connected you, with their role, and your edits are recorded under your own name. Read a note before writing it, and send its revision as baseRevision.";

type Id = string | number | null;
interface Request_ {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

const reply = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

const unauthorized = () => json({ error: "unauthorized", message: "Send a Common Ink agent token: Authorization: Bearer cink_…" }, 401, { "WWW-Authenticate": 'Bearer realm="Common Ink"' });

export const bearerToken = (req: Request): string | null => /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "")?.[1] ?? null;

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  const token = bearerToken(req);
  const agent = token ? await authenticateAgent(env.DB, token) : null;
  if (!agent) return unauthorized();

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
  const out: unknown[] = [];
  for (const message of messages) {
    // One message that hits a fault is answered so, under its own id, and the rest of a batch is still answered.
    const answer = await handleMessage(env, agent, message).catch((err: unknown) => {
      console.error("An MCP message broke", err);
      const id = (message as { id?: unknown } | null)?.id;
      return fail(typeof id === "string" || typeof id === "number" ? id : null, -32603, BROKE);
    });
    if (answer) out.push(answer);
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  return json(batch ? out : out[0]);
}

async function handleMessage(env: Env, agent: ConnectedAgent, message: unknown): Promise<unknown | null> {
  const m = (typeof message === "object" && message !== null ? message : {}) as Request_;
  const hasId = m.id !== undefined;
  const id: Id = hasId && (typeof m.id === "string" || typeof m.id === "number" || m.id === null) ? m.id : null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(id, -32600, "Not a JSON-RPC 2.0 request");
  // A notification has no id and gets no answer.
  if (!hasId) return null;
  const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Record<string, unknown>;

  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return reply(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: toolList() });
    case "tools/call": {
      if (typeof params.name !== "string") return fail(id, -32602, "Name the tool to call");
      const args = params.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) return fail(id, -32602, "arguments must be an object");
      const result = await callTool(env.DB, agent, params.name, args as Record<string, unknown>);
      return result ? reply(id, result) : fail(id, -32602, `No such tool: ${params.name}`);
    }
    default:
      return fail(id, -32601, `No such method: ${m.method}`);
  }
}
