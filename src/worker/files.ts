// Where an upload's bytes come in and go out. Nothing else serves them: there is no address for a
// file in the bucket, and none that is good for longer than the one request it answers. Each request
// is decided by the core as a read of a note is, so access that was taken away stops the next one.
//
// The bytes are whatever somebody uploaded, served from the app's own host, so every answer is made
// unable to act as a page of the app: see `SEALED`.
import { authenticateAgent } from "../core/agents.ts";
import { disposition } from "../core/filetypes.ts";
import { agentActor, perform, type Actor, type Visitor } from "../core/operations.ts";
import { MAX_UPLOAD_BYTES, OpError, type OpErrorCode, type OpenedUpload } from "../core/protocol.ts";
import { SIGN_IN_FIRST } from "../core/standing.ts";
import { sessionPersonId } from "./auth.ts";
import { bearerToken } from "./mcp/mcp.ts";

const STATUS: Record<OpErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503 };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const refused = (err: unknown, headers: Record<string, string> = {}) => {
  if (err instanceof OpError) return json({ error: err.code, message: err.message }, STATUS[err.code], headers);
  throw err;
};

/**
 * What every answer that carries an upload's bytes is sent with.
 *
 * - `nosniff`, with a type the server chose from its own short list: a browser reads the bytes as
 *   that type or not at all, whatever they look like.
 * - `sandbox` makes a file opened as a page a document with no origin and no script, so even a type
 *   that got through by mistake can't reach the member's session. It may show itself, and nothing else.
 * - Anything not on the list of pictures, video, sound and PDF is a download (`Content-Disposition`), an
 *   SVG too, which still draws as the source of an image. A PDF opened in a tab is drawn by the
 *   browser's own viewer, in a page of the browser's making that the sandbox doesn't reach (ADR 0008).
 * - `same-origin` keeps another site, and an HTML embed's frame, from loading the bytes with the member's session.
 * - `private, no-cache` lets only the member's own browser keep a copy, and has it ask before each
 *   use, which is answered through the same check. No shared cache keeps one.
 */
const SEALED = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-cache",
  "Accept-Ranges": "bytes",
  Vary: "Cookie, Authorization",
} as const;

function served(req: Request, { upload, body, etag, range }: OpenedUpload, more: Record<string, string> = {}): Response {
  const headers = new Headers({ ...SEALED, ...more, ETag: etag, "Content-Type": upload.type, "Content-Disposition": disposition(upload.type, upload.name) });
  if (!body) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(range ? range.length : upload.size));
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${upload.size}`);
  if (req.method === "HEAD") {
    void body.cancel();
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** Who is asking for a workspace's files: an agent by its token, or else the person signed in. An agent's token is never a cookie, so no page can send it. */
async function asker(req: Request, env: Env, url: URL, workspaceId: string): Promise<{ actor: Actor; byToken: boolean } | Response> {
  const token = bearerToken(req);
  if (token) {
    const agent = await authenticateAgent(env.DB, token);
    if (!agent) return json({ error: "unauthorized", message: "Send a Common Ink agent token: Authorization: Bearer cink_…" }, 401, { "WWW-Authenticate": 'Bearer realm="Common Ink"' });
    return { byToken: true, actor: agentActor(agent, workspaceId) };
  }
  const personId = await sessionPersonId(req, env, url);
  return personId ? { byToken: false, actor: { kind: "member", personId, workspaceId } } : json({ error: "signed_out" }, 401);
}

const UPLOADS = /^\/api\/workspaces\/([a-z0-9]{12})\/uploads(?:\/([a-z0-9]{12}))?$/;
const SHARED_UPLOAD = /^\/api\/shared\/([A-Za-z0-9_-]{20,64})\/uploads\/([a-z0-9]{12})$/;
const UNLISTED = { "X-Robots-Tag": "noindex, nofollow" };
const reads = (req: Request) => req.method === "GET" || req.method === "HEAD";

/** The name of the header an upload's operation comes in, as JSON written with encodeURIComponent. Its bytes are the body. */
export const UPLOAD_HEADER = "X-Ink-Upload";

async function upload(req: Request, env: Env, url: URL, workspaceId: string): Promise<Response> {
  const who = await asker(req, env, url, workspaceId);
  if (who instanceof Response) return who;
  // A person's session comes with any request their browser makes, so the request must be the app's own. A page elsewhere can't set this header or this type.
  if (!who.byToken && req.headers.get("Origin") !== url.origin) return json({ error: "forbidden", message: "Uploads come from Common Ink itself" }, 403);
  if (!req.headers.get("Content-Type")?.startsWith("application/octet-stream")) return json({ error: "invalid", message: "Send the file's bytes as application/octet-stream" }, 415);
  const length = req.headers.get("Content-Length");
  if (!length || !/^\d+$/.test(length)) return json({ error: "invalid", message: "Say how many bytes are coming, as Content-Length" }, 411);
  if (Number(length) > MAX_UPLOAD_BYTES) return json({ error: "invalid", message: `A file can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }, 413);
  let named: unknown;
  try {
    named = JSON.parse(decodeURIComponent(req.headers.get(UPLOAD_HEADER) ?? ""));
  } catch {
    return json({ error: "invalid", message: `Name the file in ${UPLOAD_HEADER}, as JSON written with encodeURIComponent` }, 400);
  }
  if (typeof named !== "object" || named === null) return json({ error: "invalid", message: `${UPLOAD_HEADER} isn't an object` }, 400);
  try {
    return json(await perform(env.DB, who.actor, { ...named, type: "upload.create", size: Number(length) } as never, Date.now(), undefined, { bucket: env.FILES, body: req.body }), 201);
  } catch (err) {
    return refused(err);
  }
}

/** What a link's holder is answered: as `handleShared` answers for a note, without a session unless the link asks for one. */
async function sharedUpload(req: Request, env: Env, url: URL, token: string, id: string): Promise<Response> {
  const as = (personId: string | null) => perform(env.DB, { kind: "visitor", token, personId } satisfies Visitor, { type: "shared.upload", id }, Date.now(), undefined, { bucket: env.FILES, asked: req.headers });
  try {
    try {
      return served(req, await as(null), UNLISTED);
    } catch (err) {
      if (!(err instanceof OpError && err.message === SIGN_IN_FIRST)) throw err;
      const personId = await sessionPersonId(req, env, url);
      return personId ? served(req, await as(personId), UNLISTED) : json({ error: "signed_out", message: SIGN_IN_FIRST }, 401, UNLISTED);
    }
  } catch (err) {
    return refused(err, UNLISTED);
  }
}

/** Answers a request that is for an upload's bytes, in or out. Null for any other. */
export async function handleFiles(req: Request, env: Env, url: URL): Promise<Response | null> {
  const shared = SHARED_UPLOAD.exec(url.pathname);
  if (shared) return reads(req) ? sharedUpload(req, env, url, shared[1]!, shared[2]!) : json({ error: "method_not_allowed" }, 405, UNLISTED);
  const route = UPLOADS.exec(url.pathname);
  if (!route) return null;
  const [, workspaceId, id] = route;
  if (!id) return req.method === "POST" ? upload(req, env, url, workspaceId!) : json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  if (!reads(req)) return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
  const who = await asker(req, env, url, workspaceId!);
  if (who instanceof Response) return who;
  try {
    return served(req, await perform(env.DB, who.actor, { type: "upload.open", id }, Date.now(), undefined, { bucket: env.FILES, asked: req.headers }));
  } catch (err) {
    return refused(err);
  }
}
