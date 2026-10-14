import { whoAmI } from "../core/accounts.ts";
import { perform } from "../core/operations.ts";
import { BROKE, OpError, type OpErrorCode } from "../core/protocol.ts";
import { handleAuth, sessionPersonId } from "./auth.ts";
import { handleAgentsApi } from "./mcp/agents-api.ts";
import { handleMcp } from "./mcp/mcp.ts";
import { embedResponse } from "./frames.ts";
import { secured } from "./headers.ts";
import { redirectFor } from "./hosts.ts";
import { SW_PATH, swResponse } from "./sw.ts";

const STATUS: Record<OpErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const personId = await sessionPersonId(req, env, url);
  if (!personId) return json({ error: "signed_out" }, 401);

  if (url.pathname === "/api/me" && req.method === "GET") return json(await whoAmI(env.DB, personId));

  const opsRoute = /^\/api\/workspaces\/([a-z0-9]{12})\/ops$/.exec(url.pathname);
  if (opsRoute && req.method === "POST") {
    if (req.headers.get("Origin") !== url.origin || !req.headers.get("Content-Type")?.startsWith("application/json")) {
      return json({ error: "forbidden", message: "Operations come as JSON from Common Ink itself" }, 403);
    }
    let op: unknown;
    try {
      op = await req.json();
    } catch {
      return json({ error: "invalid", message: "The body isn't JSON" }, 400);
    }
    try {
      return json(await perform(env.DB, { kind: "member", personId, workspaceId: opsRoute[1]! }, op as never));
    } catch (err) {
      if (err instanceof OpError) return json({ error: err.code, message: err.message }, STATUS[err.code]);
      throw err;
    }
  }

  return json({ error: "not_found" }, 404);
}

/** A fault that is no request's doing is logged, and answered in the shape its client reads: a bare 500 is a page of HTML to a client that asked for JSON. */
async function answered(what: string, answer: () => Promise<Response>, broke: () => Response): Promise<Response> {
  try {
    return await answer();
  } catch (err) {
    console.error(`${what} broke`, err);
    return broke();
  }
}

function route(req: Request, env: Env, url: URL): Response | Promise<Response> {
  const moved = redirectFor(url);
  if (moved) return new Response(null, { status: moved.status, headers: { Location: moved.location } });
  const embed = embedResponse(url, env);
  if (embed) return embed;
  if (url.pathname === SW_PATH && (req.method === "GET" || req.method === "HEAD")) return swResponse();
  if (url.pathname.startsWith("/auth/")) return handleAuth(req, env, url);
  if (url.pathname === "/mcp") return answered("/mcp", () => handleMcp(req, env), () => json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: BROKE } }, 500));
  const broke = () => json({ error: "unknown", message: BROKE }, 500);
  if (url.pathname === "/api/agents" || url.pathname.startsWith("/api/agents/")) return answered(url.pathname, () => handleAgentsApi(req, env, url), broke);
  if (url.pathname.startsWith("/api/")) return answered(url.pathname, () => handleApi(req, env, url), broke);
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    return secured(await route(req, env, url), url, env);
  },
} satisfies ExportedHandler<Env>;
