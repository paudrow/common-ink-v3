import { arrive, whoAmI, workspaceOfInvite, workspaceOfNote } from "../core/accounts.ts";
import { perform, type Actor, type Visitor } from "../core/operations.ts";
import { OpError, type OpErrorCode, type OpInput } from "../core/protocol.ts";
import { redeemFrame } from "../core/pluginRecord.ts";
import { clearUploads, purgeTrash } from "../core/purge.ts";
import { SIGN_IN_FIRST } from "../core/standing.ts";
import { devSignIn, handleAuth, sessionPersonId } from "./auth.ts";
import { handleAgentsApi } from "./mcp/agents-api.ts";
import { handleMcp } from "./mcp/mcp.ts";
import { handleFiles } from "./files.ts";
import { embedResponse, framing } from "./frames.ts";
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
const CARRIES_BYTES: ReadonlySet<unknown> = new Set(["upload.create", "upload.open", "shared.upload"]);

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
    return json(await whoAmI(env.DB, personId, devSignIn(env, url)));
  }

  // Where an address leads for this person. Each answers the same for "there is none" and "it isn't yours".
  const lookup = /^\/api\/(notes|invites)\/([a-z0-9]{12})$/.exec(url.pathname);
  if (lookup && req.method === "GET") {
    if (lookup[1] === "invites") await arrive(env.DB, personId);
    const workspaceId = await (lookup[1] === "notes" ? workspaceOfNote : workspaceOfInvite)(env.DB, personId, lookup[2]!);
    return workspaceId ? json({ workspaceId }) : json({ error: "not_found" }, 404);
  }

  // A plugin's operations come from the app too, which says in the address which install it made the frame for. Nothing the plugin sent names it.
  // `/draft` is the member's own copy of that plugin: whose draft is never said, since it is the session's person's.
  const opsRoute = /^\/api\/workspaces\/([a-z0-9]{12})(?:\/plugins\/([a-z0-9]{12})(\/draft)?)?\/ops$/.exec(url.pathname);
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
    if (CARRIES_BYTES.has((op as { type?: unknown } | null)?.type)) return json({ error: "invalid", message: "A file's bytes come and go at /api/workspaces/<id>/uploads" }, 400);
    try {
      return json(await perform(env.DB, actor, op as never, Date.now(), sourcesFor(env, url), { bucket: env.FILES }));
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
    const embed = await embedResponse(url, env, (token) => redeemFrame(env.DB, token, Date.now()));
    if (embed) return embed;
    if (url.pathname === SW_PATH && (req.method === "GET" || req.method === "HEAD")) return swResponse();
    if (url.pathname.startsWith("/auth/")) return handleAuth(req, env, url);
    if (url.pathname === "/mcp") return handleMcp(req, env, sourcesFor(env, url));
    if (url.pathname === "/api/agents" || url.pathname.startsWith("/api/agents/")) return handleAgentsApi(req, env, url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);
    const page = framing(await env.ASSETS.fetch(req), url, env);
    if (!SHARED_PAGE.test(url.pathname)) return page;
    const unlisted = new Response(page.body, page);
    for (const [name, value] of Object.entries(UNLISTED)) unlisted.headers.set(name, value);
    return unlisted;
  },
  // The one job on a timer: removing the notes and uploads whose 30 days in Trash are up, and uploads that never finished. A run that doesn't finish is carried on by the next.
  async scheduled(controller, env) {
    const { removed, failed, more } = await purgeTrash(env.DB, controller.scheduledTime);
    if (removed || failed.length) console.log(`Removed ${removed} notes from Trash${failed.length ? `, and couldn't remove ${failed.length}` : ""}${more ? ", with more waiting" : ""}`);
    const uploads = await clearUploads(env.DB, env.FILES, controller.scheduledTime);
    if (uploads.removed || uploads.failed.length) console.log(`Removed ${uploads.removed} uploads${uploads.failed.length ? `, and couldn't remove ${uploads.failed.length}` : ""}${uploads.more ? ", with more waiting" : ""}`);
  },
} satisfies ExportedHandler<Env>;
