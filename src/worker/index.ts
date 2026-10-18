import { arrive, whoAmI, workspaceOfInvite, workspaceOfNote } from "../core/accounts.ts";
import { perform, trustedCode, type Actor, type Visitor } from "../core/operations.ts";
import { redeemFrame } from "../core/pluginRecord.ts";
import { BROKE, OpError, type MeHere, type OpErrorCode, type OpInput } from "../core/protocol.ts";
import { logFault } from "../core/logs.ts";
import { sweep } from "../core/oauth.ts";
import { clearUploads, purgeTrash } from "../core/purge.ts";
import { SIGN_IN_FIRST } from "../core/standing.ts";
import { devSignIn, handleAuth, sessionPersonId } from "./auth.ts";
import { handleClipper } from "./clipper.ts";
import { handleAgentsApi } from "./mcp/agents-api.ts";
import { handleMcp } from "./mcp/mcp.ts";
import { handleOAuth } from "./oauth.ts";
import { handleOAuthConsent } from "./oauthConsent.ts";
import { fileOrigin, fileSiteResponse, handleFiles } from "./files.ts";
import { embedOrigin, embedResponse } from "./frames.ts";
import { crossOrigin, secured } from "./headers.ts";
import { redirectFor } from "./hosts.ts";
import { sourcesFor } from "./sources/index.ts";
import { SW_PATH, swResponse } from "./sw.ts";

const STATUS: Record<OpErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 };

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

/** Operations whose bytes come or go with the request, each at an address of its own in files.ts. */
const CARRIES_BYTES: ReadonlySet<unknown> = new Set(["upload.create", "upload.open", "upload.part", "shared.upload"]);

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const files = await handleFiles(req, env, url);
  if (files) return files;
  const shared = SHARED_API.exec(url.pathname);
  if (shared) return handleShared(req, env, url, shared[1]!, shared[2]);

  const personId = await sessionPersonId(req, env, url);
  if (!personId) return json({ error: "signed_out" }, 401);

  if (url.pathname === "/api/me" && req.method === "GET") {
    // Opening the app is arriving: an invite made since the person signed in takes effect here.
    await arrive(env.DB, personId);
    return json({ ...(await whoAmI(env.DB, personId, devSignIn(env, url))), setup: { embedSite: embedOrigin(env) !== null, fileSite: fileOrigin(env) !== null } } satisfies MeHere);
  }

  // Where an address leads for this person. Each answers the same for "there is none" and "it isn't yours".
  const lookup = /^\/api\/(notes|invites)\/([a-z0-9]{12})$/.exec(url.pathname);
  if (lookup && req.method === "GET") {
    if (lookup[1] === "invites") await arrive(env.DB, personId);
    const workspaceId = await (lookup[1] === "notes" ? workspaceOfNote : workspaceOfInvite)(env.DB, personId, lookup[2]!);
    return workspaceId ? json({ workspaceId }) : json({ error: "not_found" }, 404);
  }

  // A full-trust plugin's code as a module, for the app's page to load under its own policy. It is the body of a function handed `host` and `modules`.
  const trusted = /^\/api\/workspaces\/([a-z0-9]{12})\/plugins\/([a-z0-9]{12})\/trusted\/([0-9a-f]{64})\.js$/.exec(url.pathname);
  if (trusted && req.method === "GET") {
    const [, workspaceId, pluginId, hash] = trusted as unknown as [string, string, string, string];
    const code = await trustedCode(env.DB, { kind: "member", personId, workspaceId }, pluginId, hash);
    if (code === null) return json({ error: "not_found" }, 404);
    return new Response(`export default function (host, modules) {"use strict";\n${code}\n}\n//# sourceURL=ink-plugin-${pluginId}.js\n`, {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" },
    });
  }

  // A plugin's operations come from the app too, which says in the address which install it made the frame for. Nothing the plugin sent names it.
  // The id is an install's, or that of one of Common Ink's own plugins that run shut off. `/draft` is the member's own copy of that plugin: whose draft is never said, since it is the session's person's.
  const opsRoute = /^\/api\/workspaces\/([a-z0-9]{12})(?:\/plugins\/([a-z0-9]{12}|[a-z][a-z-]{0,39})(\/draft)?)?\/ops$/.exec(url.pathname);
  if (opsRoute && req.method === "POST") {
    const [, workspaceId, pluginId, draft] = opsRoute as unknown as [string, string, string | undefined, string | undefined];
    const actor: Actor = pluginId ? { kind: "plugin", pluginId, personId, workspaceId, draft: draft !== undefined } : { kind: "member", personId, workspaceId };
    if (req.headers.get("Origin") !== url.origin || !req.headers.get("Content-Type")?.startsWith("application/json")) {
      return json({ error: "forbidden", message: "Operations come as JSON from Common Ink itself" }, 403);
    }
    let op: unknown;
    try {
      op = await req.json();
    } catch {
      return json({ error: "invalid", message: "The body isn't JSON" }, 400);
    }
    if (CARRIES_BYTES.has((op as { type?: unknown } | null)?.type)) return json({ error: "invalid", message: "A file's bytes come and go at /api/workspaces/<id>/uploads, and a part of one at the address upload.start gives" }, 400);
    try {
      return json(await perform(env.DB, actor, op as never, Date.now(), sourcesFor(env, url), { bucket: env.FILES }));
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
    logFault(what, err);
    return broke();
  }
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const moved = redirectFor(url);
  if (moved) return new Response(null, { status: moved.status, headers: { Location: moved.location } });
  const embed = await embedResponse(url, env, (token) => redeemFrame(env.DB, token, Date.now()));
  if (embed) return embed;
  const fileSite = fileSiteResponse(req, env, url);
  if (fileSite) return fileSite;
  if (url.pathname === SW_PATH && (req.method === "GET" || req.method === "HEAD")) return swResponse();
  if (url.pathname.startsWith("/auth/")) return handleAuth(req, env, url);
  if (url.pathname === "/clipper/connect") return handleClipper(req, env, url);
  if (url.pathname === "/mcp") return answered("/mcp", () => handleMcp(req, env, sourcesFor(env, url)), () => json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: BROKE } }, 500));
  if (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/oauth-")) {
    return answered(url.pathname, () => handleOAuth(req, env, url), () => json({ error: "server_error", error_description: BROKE }, 500));
  }
  const broke = () => json({ error: "unknown", message: BROKE }, 500);
  if (url.pathname === "/api/agents" || url.pathname.startsWith("/api/agents/")) return answered(url.pathname, () => handleAgentsApi(req, env, url), broke);
  if (url.pathname === "/api/oauth/request" || url.pathname === "/api/oauth/consent" || url.pathname === "/api/oauth/deny") return answered(url.pathname, () => handleOAuthConsent(req, env, url), broke);
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
    // Whatever breaks is logged redacted here, and not by the runtime as it was thrown.
    const answer = await answered(url.pathname, async () => route(req, env, url), () => new Response("Common Ink broke. Try again in a moment.", { status: 500 }));
    return secured(crossOrigin(answer, req, url), url, env);
  },
  // The one job on a timer: removing the notes and uploads whose 30 days in Trash are up, and uploads that never finished. A run that doesn't finish is carried on by the next.
  async scheduled(controller, env) {
    let purged;
    try {
      purged = await purgeTrash(env.DB, controller.scheduledTime);
    } catch (err) {
      return logFault("Removing notes from Trash", err);
    }
    const { removed, failed, more } = purged;
    if (removed || failed.length) console.log(`Removed ${removed} notes from Trash${failed.length ? `, and couldn't remove ${failed.length}` : ""}${more ? ", with more waiting" : ""}`);
    const uploads = await clearUploads(env.DB, env.FILES, controller.scheduledTime);
    if (uploads.removed || uploads.failed.length) console.log(`Removed ${uploads.removed} uploads${uploads.failed.length ? `, and couldn't remove ${uploads.failed.length}` : ""}${uploads.more ? ", with more waiting" : ""}`);
    // What OAuth sign-ins left behind that nobody came back to. Also done when someone starts one, so this is for a quiet day.
    try {
      await sweep(env.DB, controller.scheduledTime, true);
    } catch (err) {
      logFault("Clearing out OAuth sign-ins", err);
    }
  },
} satisfies ExportedHandler<Env>;
