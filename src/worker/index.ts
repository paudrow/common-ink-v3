import { whoAmI } from "../core/accounts.ts";
import { perform } from "../core/operations.ts";
import { OpError, type OpErrorCode } from "../core/protocol.ts";
import { handleAuth, sessionPersonId } from "./auth.ts";
import { handleAgentsApi } from "./mcp/agents-api.ts";
import { handleMcp } from "./mcp/mcp.ts";
import { redirectFor } from "./hosts.ts";
import { SW_PATH, swResponse } from "./sw.ts";

const STATUS: Record<OpErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404 };

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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const moved = redirectFor(url);
    if (moved) return new Response(null, { status: moved.status, headers: { Location: moved.location } });
    if (url.pathname === SW_PATH && (req.method === "GET" || req.method === "HEAD")) return swResponse();
    if (url.pathname.startsWith("/auth/")) return handleAuth(req, env, url);
    if (url.pathname === "/mcp") return handleMcp(req, env);
    if (url.pathname === "/api/agents" || url.pathname.startsWith("/api/agents/")) return handleAgentsApi(req, env, url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
