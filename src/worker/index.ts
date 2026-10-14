import { arrive, whoAmI, workspaceOfInvite, workspaceOfNote } from "../core/accounts.ts";
import { perform, type Visitor } from "../core/operations.ts";
import { BROKE, OpError, type MeHere, type OpErrorCode, type OpInput } from "../core/protocol.ts";
import { SIGN_IN_FIRST } from "../core/standing.ts";
import { handleAuth, sessionPersonId } from "./auth.ts";
import { handleAgentsApi } from "./mcp/agents-api.ts";
import { handleMcp } from "./mcp/mcp.ts";
import { embedOrigin, embedResponse } from "./frames.ts";
import { secured } from "./headers.ts";
import { redirectFor } from "./hosts.ts";
import { SW_PATH, swResponse } from "./sw.ts";

const STATUS: Record<OpErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409 };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Kept off every answer about a link, and off the page a link opens: it is found by nobody who wasn't sent it, and its address goes to no other site. */
const UNLISTED = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
const SHARED_PAGE = /^\/s\/[A-Za-z0-9_-]{20,64}$/;
const SHARED_API = /^\/api\/shared\/([A-Za-z0-9_-]{20,64})(?:\/notes\/([a-z0-9]{12}))?$/;

/**
 * What a link opens, for whoever holds it. A public link is answered without looking for a session,
 * and nothing here ever starts one. Each answer is read from the link as it stands, and none is
 * stored anywhere, so a link that was taken away opens nothing from that moment.
 */
async function handleShared(req: Request, env: Env, url: URL, token: string, noteId: string | undefined): Promise<Response> {
  const unlisted = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...UNLISTED } });
  if (req.method !== "GET") return unlisted({ error: "method_not_allowed" }, 405);
  const op: OpInput = noteId ? { type: "shared.read", id: noteId } : { type: "shared.open" };
  const as = (personId: string | null) => perform(env.DB, { kind: "visitor", token, personId } satisfies Visitor, op);
  try {
    try {
      return unlisted(await as(null));
    } catch (err) {
      if (!(err instanceof OpError && err.message === SIGN_IN_FIRST)) throw err;
      const personId = await sessionPersonId(req, env, url);
      return personId ? unlisted(await as(personId)) : unlisted({ error: "signed_out", message: SIGN_IN_FIRST }, 401);
    }
  } catch (err) {
    if (err instanceof OpError) return unlisted({ error: err.code, message: err.message }, STATUS[err.code]);
    throw err;
  }
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const shared = SHARED_API.exec(url.pathname);
  if (shared) return handleShared(req, env, url, shared[1]!, shared[2]);

  const personId = await sessionPersonId(req, env, url);
  if (!personId) return json({ error: "signed_out" }, 401);

  if (url.pathname === "/api/me" && req.method === "GET") {
    // Opening the app is arriving: an invite made since the person signed in takes effect here.
    await arrive(env.DB, personId);
    return json({ ...(await whoAmI(env.DB, personId)), setup: { embedSite: embedOrigin(env) !== null } } satisfies MeHere);
  }

  // Where an address leads for this person. Each answers the same for "there is none" and "it isn't yours".
  const lookup = /^\/api\/(notes|invites)\/([a-z0-9]{12})$/.exec(url.pathname);
  if (lookup && req.method === "GET") {
    if (lookup[1] === "invites") await arrive(env.DB, personId);
    const workspaceId = await (lookup[1] === "notes" ? workspaceOfNote : workspaceOfInvite)(env.DB, personId, lookup[2]!);
    return workspaceId ? json({ workspaceId }) : json({ error: "not_found" }, 404);
  }

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
  return SHARED_PAGE.test(url.pathname) ? env.ASSETS.fetch(req).then(unlistedPage) : env.ASSETS.fetch(req);
}

const unlistedPage = (page: Response) => {
  const unlisted = new Response(page.body, page);
  for (const [name, value] of Object.entries(UNLISTED)) unlisted.headers.set(name, value);
  return unlisted;
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    return secured(await route(req, env, url), url, env);
  },
} satisfies ExportedHandler<Env>;
