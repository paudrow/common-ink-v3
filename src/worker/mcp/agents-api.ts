// Connecting and disconnecting agents, from a signed-in member's session. The token is in the answer to
// the connect call and nowhere else: only its hash is kept.
import { connectAgent, disconnectAgent, listAgents } from "../../core/agents.ts";
import { OpError, type OpErrorCode } from "../../core/protocol.ts";
import { sessionPersonId } from "../auth.ts";

const STATUS: Record<OpErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404 };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** A null in the body means "not given". */
const stripNull = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

export async function handleAgentsApi(req: Request, env: Env, url: URL): Promise<Response> {
  const personId = await sessionPersonId(req, env, url);
  if (!personId) return json({ error: "signed_out" }, 401);

  const one = /^\/api\/agents\/([a-z0-9]{12})$/.exec(url.pathname);
  const isList = url.pathname === "/api/agents";
  if (!isList && !one) return json({ error: "not_found" }, 404);

  if (isList && req.method === "GET") return json({ agents: await listAgents(env.DB, personId) });

  if ((isList && req.method === "POST") || (one && req.method === "DELETE")) {
    // The session cookie rides along on any request to us, so changes come from Common Ink's own pages.
    if (req.headers.get("Origin") !== url.origin) return json({ error: "forbidden", message: "Agents are connected from Common Ink itself" }, 403);
    try {
      if (one) {
        await disconnectAgent(env.DB, personId, one[1]!);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      if (!req.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "invalid", message: "Send JSON" }, 400);
      let body: { name?: unknown; label?: unknown; expiresInDays?: unknown; workspaceId?: unknown; readOnly?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid", message: "The body isn't JSON" }, 400);
      }
      if (typeof body?.name !== "string") return json({ error: "invalid", message: "Give the agent a name" }, 400);
      const { name, ...options } = body;
      return json(await connectAgent(env.DB, personId, name, stripNull(options) as never), 201);
    } catch (err) {
      if (err instanceof OpError) return json({ error: err.code, message: err.message }, STATUS[err.code]);
      throw err;
    }
  }

  return json({ error: "method_not_allowed" }, 405);
}
