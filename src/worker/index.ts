import { arrive, whoAmI, workspaceOfInvite, workspaceOfNote } from "../core/accounts.ts";
import { perform, trustedCode, type Actor, type Visitor } from "../core/operations.ts";
import { redeemFrame } from "../core/pluginRecord.ts";
import { BROKE, OpError, type MeHere, type OpErrorCode, type OpInput } from "../core/protocol.ts";
import { sealLinksWith, sealOldLinks } from "../core/linkSeal.ts";
import { sweep } from "../core/oauth.ts";
import { eraseWorkspaces, pruneDeletions, redoRequested } from "../core/erase.ts";
import { clearUploads, purgeTrash } from "../core/purge.ts";
import { SIGN_IN_FIRST } from "../core/standing.ts";
import { devSignIn, handleAuth, sessionPersonId } from "./auth.ts";
import { MAX_OP_BYTES, TooLarge, cappedJson } from "./body.ts";
import { chargingOf, handleBillingApi, handleStripeWebhook } from "./billing.ts";
import { handleClipper, handleClipperApi } from "./clipper.ts";
import { handleAgentsApi } from "./mcp/agents-api.ts";
import { handleMcp } from "./mcp/mcp.ts";
import { handleOAuth } from "./oauth.ts";
import { handleOAuthConsent } from "./oauthConsent.ts";
import { fileOrigin, fileSiteResponse, handleFiles } from "./files.ts";
import { embedOrigin, embedResponse } from "./frames.ts";
import { crossOrigin, secured } from "./headers.ts";
import { redirectFor } from "./hosts.ts";
import { addressOf, limitByAddress, overLimit, tokenKey } from "./limits.ts";
import { bearerToken } from "./mcp/mcp.ts";
import { handleClientFault, opName, report, reportOf, told, traceOf, type Report, type Trace } from "./report.ts";
import { siteResponse } from "./site/index.ts";
import { sourcesFor } from "./sources/index.ts";
import { SW_PATH, swResponse } from "./sw.ts";
import { vault } from "./vault.ts";

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
const CARRIES_BYTES: ReadonlySet<unknown> = new Set(["upload.create", "upload.open", "upload.part", "shared.upload", "export.open"]);

async function handleApi(req: Request, env: Env, url: URL, trace: Trace): Promise<Response> {
  const files = await handleFiles(req, env, url);
  if (files) return files;
  const shared = SHARED_API.exec(url.pathname);
  if (shared) return handleShared(req, env, url, shared[1]!, shared[2]);

  const personId = await sessionPersonId(req, env, url);
  if (!personId) return json({ error: "signed_out" }, 401);

  if (url.pathname === "/api/billing" || url.pathname.startsWith("/api/billing/")) {
    // Each POST here asks Stripe for something, so it counts against the person's operations.
    const busy = req.method === "POST" && (await overLimit(env, url, "OPS_LIMIT", personId));
    if (busy) return busy;
    return handleBillingApi(req, env, url, personId);
  }

  if (url.pathname === "/api/me" && req.method === "GET") {
    // Opening the app is arriving: an invite made since the person signed in takes effect here.
    await arrive(env.DB, personId);
    return json({ ...(await whoAmI(env.DB, personId, devSignIn(env, url), chargingOf(env))), setup: { embedSite: embedOrigin(env) !== null, fileSite: fileOrigin(env) !== null } } satisfies MeHere);
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
    const busy = await overLimit(env, url, "OPS_LIMIT", personId);
    if (busy) return busy;
    let op: unknown;
    try {
      op = await cappedJson(req, MAX_OP_BYTES);
    } catch (err) {
      if (err instanceof TooLarge) return json({ error: "invalid", message: `An operation is at most ${MAX_OP_BYTES / 1_000_000} MB` }, 413);
      return json({ error: "invalid", message: "The body isn't JSON" }, 400);
    }
    trace.op = opName((op as { type?: unknown } | null)?.type);
    if (CARRIES_BYTES.has((op as { type?: unknown } | null)?.type)) return json({ error: "invalid", message: "A file's bytes come and go at /api/workspaces/<id>/uploads, a part of one at the address upload.start gives, and an export's at the addresses export.plan gives" }, 400);
    try {
      return json(await perform(env.DB, actor, op as never, Date.now(), sourcesFor(env, url), { bucket: env.FILES }, chargingOf(env)));
    } catch (err) {
      if (err instanceof OpError) return json({ error: err.code, message: err.message }, STATUS[err.code]);
      throw err;
    }
  }

  return json({ error: "not_found" }, 404);
}

/** A fault that is no request's doing is kept on the request's trace to be reported, and answered in the shape its client reads: a bare 500 is a page of HTML to a client that asked for JSON. */
async function answered(trace: Trace, answer: () => Promise<Response>, broke: () => Response): Promise<Response> {
  try {
    return await answer();
  } catch (err) {
    trace.fault = err;
    return broke();
  }
}

/**
 * For uptime checks: 200 with the Worker's version when it can reach its database, 503 when it can't.
 * It needs no sign-in and says nothing else, and costs one `SELECT 1`.
 */
async function health(env: Env, trace: Trace): Promise<Response> {
  const version = env.CF_VERSION_METADATA.id;
  try {
    await env.DB.prepare("SELECT 1").first();
    return json({ ok: true, version });
  } catch (err) {
    trace.fault = err;
    return json({ ok: false, version }, 503);
  }
}

async function route(req: Request, env: Env, url: URL, trace: Trace, tell: (report: Report) => void): Promise<Response> {
  const moved = redirectFor(url);
  if (moved) return new Response(null, { status: moved.status, headers: { Location: moved.location } });
  const byAddress = limitByAddress(url.pathname);
  const limited = byAddress && (await overLimit(env, url, byAddress, addressOf(req)));
  if (limited) return limited;
  if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) return health(env, trace);
  const embed = await embedResponse(url, env, (token) => redeemFrame(env.DB, token, Date.now()));
  if (embed) return embed;
  const fileSite = fileSiteResponse(req, env, url);
  if (fileSite) return fileSite;
  if (url.pathname === SW_PATH && (req.method === "GET" || req.method === "HEAD")) return swResponse();
  if (url.pathname.startsWith("/auth/")) return handleAuth(req, env, url);
  if (url.pathname === "/clipper/connect" || url.pathname === "/clipper/revoke") return handleClipper(req, env, url);
  // Making deletions again after a restore, as asked by scripts/redo-deletions.ts. The address names a request it put in the bucket, so only someone who can write there can ask.
  const redo = /^\/redo-deletions\/([0-9a-f]{64})$/.exec(url.pathname);
  if (redo && req.method === "POST") {
    return answered(trace, async () => {
      try {
        const done = await redoRequested({ db: env.DB, bucket: env.FILES, sources: sourcesFor(env, url), charging: chargingOf(env), now: Date.now() }, redo[1]!);
        return done ? json(done) : json({ error: "not_found" }, 404);
      } catch (err) {
        if (err instanceof OpError) return json({ error: err.code, message: err.message }, STATUS[err.code]);
        throw err;
      }
    }, () => json({ error: "unknown", message: BROKE }, 500));
  }
  if (url.pathname === "/mcp") {
    const busy = await overLimit(env, url, "MCP_LIMIT", await tokenKey(bearerToken(req)));
    return busy ?? answered(trace, () => handleMcp(req, env, sourcesFor(env, url), trace), () => json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: BROKE } }, 500));
  }
  if (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/oauth-")) {
    return answered(trace, () => handleOAuth(req, env, url), () => json({ error: "server_error", error_description: BROKE }, 500));
  }
  const broke = () => json({ error: "unknown", message: BROKE }, 500);
  if (url.pathname === "/api/agents" || url.pathname.startsWith("/api/agents/")) return answered(trace, () => handleAgentsApi(req, env, url), broke);
  if (url.pathname === "/api/clipper" || url.pathname.startsWith("/api/clipper/")) return answered(trace, () => handleClipperApi(req, env, url), broke);
  // Stripe's webhook has no session, and is signed instead.
  if (url.pathname === "/api/stripe/webhook") return answered(trace, () => handleStripeWebhook(req, env), broke);
  if (url.pathname === "/api/oauth/request" || url.pathname === "/api/oauth/consent" || url.pathname === "/api/oauth/deny") return answered(trace, () => handleOAuthConsent(req, env, url), broke);
  if (url.pathname === "/api/faults") return answered(trace, () => handleClientFault(req, env, url, tell), broke);
  if (url.pathname.startsWith("/api/")) return answered(trace, () => handleApi(req, env, url, trace), broke);
  const site = await siteResponse(req, env, url);
  if (site) return site;
  return SHARED_PAGE.test(url.pathname) ? env.ASSETS.fetch(req).then(unlistedPage) : env.ASSETS.fetch(req);
}

const unlistedPage = (page: Response) => {
  const unlisted = new Response(page.body, page);
  for (const [name, value] of Object.entries(UNLISTED)) unlisted.headers.set(name, value);
  return unlisted;
};

/** Hands the core the key share links are sealed under. A SESSION_SECRET too short for one leaves links unmade, and never kept in the clear. */
function keyLinks(env: Env): void {
  const sealer = vault(env.SESSION_SECRET);
  if (sealer) sealLinksWith(sealer);
}

export default {
  // Tests call it without a context, and a report's send then runs unwaited.
  async fetch(req, env, ctx?: ExecutionContext) {
    keyLinks(env);
    const url = new URL(req.url);
    const trace = traceOf(req, url);
    const tell = (fault: Report) => report(env, (sent) => ctx?.waitUntil(sent), fault);
    // Whatever breaks is reported redacted here, and not by the runtime as it was thrown.
    const answer = await answered(trace, async () => route(req, env, url, trace, tell), () => new Response("Common Ink broke. Try again in a moment.", { status: 500 }));
    const fault = reportOf(trace, answer.status);
    if (fault) tell(fault);
    return secured(crossOrigin(answer, req, url), url, env);
  },
  // The one job on a timer: removing the notes and uploads whose 30 days in Trash are up, uploads that never finished, and what deleted workspaces held. A run that doesn't finish is carried on by the next.
  async scheduled(controller, env, ctx) {
    const broke = (what: string, err: unknown) => report(env, (sent) => ctx.waitUntil(sent), { source: "job", route: "cron", requestId: null, op: what, status: null, ...told(err) });
    keyLinks(env);
    let purged;
    try {
      purged = await purgeTrash(env.DB, controller.scheduledTime);
    } catch (err) {
      return broke("purgeTrash", err);
    }
    const { removed, failed, more } = purged;
    if (removed || failed.length) console.log(`Removed ${removed} notes from Trash${failed.length ? `, and couldn't remove ${failed.length}` : ""}${more ? ", with more waiting" : ""}`);
    let uploads;
    try {
      uploads = await clearUploads(env.DB, env.FILES, controller.scheduledTime);
    } catch (err) {
      return broke("clearUploads", err);
    }
    if (uploads.removed || uploads.failed.length) console.log(`Removed ${uploads.removed} uploads${uploads.failed.length ? `, and couldn't remove ${uploads.failed.length}` : ""}${uploads.more ? ", with more waiting" : ""}`);
    try {
      const sealed = await sealOldLinks(env.DB);
      if (sealed) console.log(`Sealed ${sealed} links kept from before links were sealed`);
    } catch (err) {
      broke("sealOldLinks", err);
    }
    try {
      const { erased, more } = await eraseWorkspaces(env.DB, env.FILES);
      if (erased.length || more) console.log(`Erased ${erased.length} deleted workspaces${more ? ", with more waiting" : ""}`);
    } catch (err) {
      broke("eraseWorkspaces", err);
    }
    try {
      const pruned = await pruneDeletions(env.FILES, controller.scheduledTime);
      if (pruned) console.log(`Removed ${pruned} records of deletions too old for a restore to bring back`);
    } catch (err) {
      broke("pruneDeletions", err);
    }
    // What OAuth sign-ins left behind that nobody came back to. Also done when someone starts one, so this is for a quiet day.
    try {
      await sweep(env.DB, controller.scheduledTime, true);
    } catch (err) {
      broke("oauth.sweep", err);
    }
  },
} satisfies ExportedHandler<Env>;
