// The consent page's API. The person comes from the session, never from the body.
import { OpError, type OpErrorCode } from "../core/protocol.ts";
import { consent, deny, openRequest, redirectBack } from "../core/oauth.ts";
import { sessionPersonId } from "./auth.ts";
import { MAX_FORM_BYTES, TooLarge, cappedJson } from "./body.ts";

const STATUS: Record<OpErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleOAuthConsent(req: Request, env: Env, url: URL): Promise<Response> {
  const personId = await sessionPersonId(req, env, url);
  if (!personId) return json({ error: "signed_out", message: "Sign in to answer this." }, 401);
  if (req.method !== "GET" && req.headers.get("Origin") !== url.origin) return json({ error: "forbidden", message: "A connection is answered from Common Ink itself" }, 403);

  try {
    if (url.pathname === "/api/oauth/request") {
      if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const requestId = url.searchParams.get("request") ?? "";
      const view = await openRequest(env.DB, personId, requestId);
      return json({ clientName: view.clientName, redirectHost: view.redirectHost });
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!req.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "invalid", message: "Send JSON" }, 400);
    const body = (await cappedJson(req, MAX_FORM_BYTES)) as { requestId?: unknown; name?: unknown; workspaceId?: unknown; readOnly?: unknown; folderIds?: unknown; expiresInDays?: unknown };
    if (typeof body.requestId !== "string") return json({ error: "invalid", message: "Say which request" }, 400);
    if (url.pathname === "/api/oauth/deny") {
      const refused = await deny(env.DB, personId, body.requestId);
      return json({ redirect: redirectBack(refused.redirectUri, { error: "access_denied", state: refused.state, iss: url.origin }) });
    }
    const { requestId, name, ...options } = body;
    const granted = await consent(env.DB, personId, { requestId, ...(typeof name === "string" && name.trim() ? { name } : {}), ...options } as never);
    return json({ redirect: redirectBack(granted.redirectUri, { code: granted.code, state: granted.state, iss: url.origin }) });
  } catch (err) {
    if (err instanceof OpError) return json({ error: err.code, message: err.message }, STATUS[err.code]);
    if (err instanceof SyntaxError) return json({ error: "invalid", message: "The body isn't JSON" }, 400);
    if (err instanceof TooLarge) return json({ error: "invalid", message: err.message }, 413);
    throw err;
  }
}
