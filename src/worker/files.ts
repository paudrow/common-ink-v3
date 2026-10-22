// Where an upload's bytes come in and go out, and an export's go out. Nothing else serves them: there is no address for a
// file in the bucket, and none that is good for longer than the one request it answers. Each request
// is decided by the core as a read of a note is, so access that was taken away stops the next one.
//
// The bytes are whatever somebody uploaded, served from the app's own host, so every answer is made
// unable to act as a page of the app: see `SEALED`.
import { sessionHolds } from "../core/accounts.ts";
import { disposition, fileClass } from "../core/filetypes.ts";
import { agentActor, perform, type Actor, type Visitor } from "../core/operations.ts";
import { OpError, PART_BYTES, type OpErrorCode, type OpenedUpload } from "../core/protocol.ts";
import { passHolder } from "../core/uploads.ts";
import { SIGN_IN_FIRST } from "../core/standing.ts";
import { listed, sessionOf, sessionPersonId, tokenHolder } from "./auth.ts";
import { sign, verify } from "./session.ts";
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
 * - Anything not on the list of pictures, video and sound is a download (`Content-Disposition`), an
 *   SVG too, which still draws as the source of an image, and a PDF: the browser's own viewer draws
 *   one in a page of its making that the sandbox doesn't reach, which at the app's address would be
 *   the app's origin. A PDF is shown in place only from the site kept for files (below).
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

function served(req: Request, { upload, body, etag, range }: OpenedUpload, more: Record<string, string> = {}, inline?: boolean): Response {
  const headers = new Headers({ ...SEALED, ...more, ETag: etag, "Content-Type": upload.type, "Content-Disposition": disposition(upload.type, upload.name, inline) });
  if (!body) return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(range ? range.length : upload.size));
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${upload.size}`);
  if (req.method === "HEAD") {
    void body.cancel();
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** Who is asking for a workspace's files: an agent by its token, a clipper allowed by the member (which may only upload), or else the person signed in. A token is never a cookie, so no page can send it. */
async function asker(req: Request, env: Env, url: URL, workspaceId: string): Promise<{ actor: Actor; byToken: boolean; clipper?: true; ended?: number } | Response> {
  const token = bearerToken(req);
  if (token) {
    const holder = await tokenHolder(env, url, token);
    if (holder && "agent" in holder) return { byToken: true, actor: agentActor(holder.agent, workspaceId) };
    if (holder) return { byToken: true, clipper: true, actor: { kind: "member", personId: holder.clipper.personId, workspaceId } satisfies Actor };
    return json({ error: "unauthorized", message: "Send a Common Ink agent token or an OAuth access token: Authorization: Bearer cink_…" }, 401, { "WWW-Authenticate": 'Bearer realm="Common Ink"' });
  }
  const session = await sessionOf(req, env, url);
  return session ? { byToken: false, actor: { kind: "member", personId: session.personId, workspaceId }, ended: session.ended } : json({ error: "signed_out" }, 401);
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
  if (Number(length) > PART_BYTES) return json({ error: "invalid", message: `A file sent in one request can be at most ${PART_BYTES / 1024 / 1024} MB. Send a larger one in parts: upload.start` }, 413);
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

const EXPORT = /^\/api\/workspaces\/([a-z0-9]{12})\/export$/;

/**
 * A part of an export, at the address export.plan gave: a zip written as it is sent. It is the
 * asker's own copy of what they can see, decided as each read is, so it is sealed as an upload's
 * bytes are, always a download, and kept by no cache.
 */
async function exported(req: Request, env: Env, url: URL, workspaceId: string): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  const who = await asker(req, env, url, workspaceId);
  if (who instanceof Response) return who;
  if (who.clipper) return json({ error: "forbidden", message: "The clipper can only upload files" }, 403);
  const asked = url.searchParams;
  const op = { type: "export.open", notes: asked.get("notes") === "1", ...(asked.has("after") ? { after: asked.get("after") } : {}), ...(asked.has("through") ? { through: asked.get("through") } : {}) };
  try {
    const { workspace, body } = await perform(env.DB, who.actor, op as never, Date.now(), undefined, { bucket: env.FILES });
    const [part, of] = [asked.get("part"), asked.get("of")].map((n) => (n && /^\d{1,5}$/.test(n) ? Number(n) : 1)) as [number, number];
    const name = of > 1 ? `${workspace} export, part ${part} of ${of}.zip` : `${workspace} export.zip`;
    const { "Accept-Ranges": _, ...sealed } = SEALED;
    return new Response(body, { headers: { ...sealed, "Cache-Control": "no-store", "Content-Type": "application/zip", "Content-Disposition": disposition("application/zip", name, false) } });
  } catch (err) {
    return refused(err);
  }
}

const PART = /^\/api\/upload-parts\/([A-Za-z0-9_-]{43})\/(\d{1,5})$/;

/**
 * A part of an upload, `PUT` to the address its start gave. The address is all it takes: no session
 * or token comes with it, so an agent's own shell sends the bytes with curl and they never pass
 * through the model. Whoever started the upload is asked again, as they are now, whether they may.
 */
async function part(req: Request, env: Env, secret: string, number: number): Promise<Response> {
  if (req.method !== "PUT") return json({ error: "method_not_allowed" }, 405, { Allow: "PUT" });
  const holder = await passHolder(env.DB, secret, Date.now());
  if (!holder || !(await listed(env, new URL(req.url), holder.actor.personId))) return json({ error: "gone", message: "This address has lapsed or was never one. Ask for a fresh one with upload.resume (resume_upload)" }, 410);
  const length = req.headers.get("Content-Length");
  try {
    return json(
      await perform(env.DB, holder.actor, { type: "upload.part", id: holder.uploadId, number }, Date.now(), undefined, {
        bucket: env.FILES,
        body: req.body,
        pass: secret,
        ...(length && /^\d+$/.test(length) ? { declared: Number(length) } : {}),
      }),
    );
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

/** The site kept for opening files in a tab, when `FILE_ORIGIN` names one. */
export function fileOrigin(env: { FILE_ORIGIN?: string }): string | null {
  if (!env.FILE_ORIGIN) return null;
  const url = new URL(env.FILE_ORIGIN);
  if (url.protocol !== "https:" && !/(^|\.)localhost$/.test(url.hostname)) throw new Error("FILE_ORIGIN must be an https address");
  return url.origin;
}

/** How long an address on the file site is good for: long enough for the browser's viewer to read the whole file. */
const SITE_SECONDS = 600;
const SITE_FILE = /^\/file\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
/** What an address on the file site is signed with: a key of its own, so it can never be taken for a session, nor a session for it. */
const siteKey = (env: Env) => `${env.SESSION_SECRET}\u0000file-site`;
interface SiteFile extends Record<string, unknown> {
  workspaceId: string;
  uploadId: string;
  personId: string;
  /** How many times they had been signed out everywhere when the session that asked began: the address ends with that session. */
  ended: number;
}

/**
 * Where a member's PDF opens in a tab: on the file site, at an address that names it and them and
 * lapses in ten minutes. Null where it is downloaded: no file site, an agent, a file that isn't a PDF.
 */
async function siteAddress(env: Env, actor: Actor, workspaceId: string, id: string, ended: number | undefined): Promise<string | null> {
  const origin = fileOrigin(env);
  if (!origin || actor.kind !== "member" || ended === undefined || !env.SESSION_SECRET) return null;
  const upload = await perform(env.DB, actor, { type: "upload.read", id });
  if (fileClass(upload) !== "pdf") return null;
  return `${origin}/file/${await sign({ workspaceId, uploadId: id, personId: actor.personId, ended } satisfies SiteFile, siteKey(env), SITE_SECONDS)}`;
}

/**
 * What the file site answers, or null for a request that is the app's. With `FILE_ORIGIN` set, that
 * host answers a PDF at an address the app gave out, shown in place, and nothing else: no session
 * reaches it, and whoever the address names is asked again on every request whether they may still
 * see the file, and whether the session it came from still holds and they are still on the list, so an
 * address outlives no grant and no sign-out. Its origin is not the app's, so the browser's viewer
 * draws there with nothing of the app's to reach.
 */
export function fileSiteResponse(req: Request, env: Env, url: URL): Promise<Response> | null {
  const origin = fileOrigin(env);
  if (!origin || url.origin !== origin) return null;
  const gone = () => new Response("This address of a file has lapsed or was never one. Open the file again from Common Ink.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...UNLISTED } });
  return (async () => {
    const at = SITE_FILE.exec(url.pathname);
    if (!at || !reads(req) || !env.SESSION_SECRET) return gone();
    const named = await verify<SiteFile>(at[1], siteKey(env));
    if (!named || typeof named.ended !== "number" || !(await sessionHolds(env.DB, named.personId, named.ended)) || !(await listed(env, url, named.personId))) return gone();
    try {
      const opened = await perform(env.DB, { kind: "member", personId: named.personId, workspaceId: named.workspaceId }, { type: "upload.open", id: named.uploadId }, Date.now(), undefined, { bucket: env.FILES, asked: req.headers });
      if (fileClass(opened.upload) !== "pdf") {
        void opened.body?.cancel();
        return gone();
      }
      return served(req, opened, UNLISTED, true);
    } catch (err) {
      if (err instanceof OpError) return gone();
      throw err;
    }
  })();
}

/**
 * Where a member's browser is sent instead when another site asked it for a file or an export. The session rides
 * along on a link followed from anywhere, and a download looks different from a refusal, so answering would tell that
 * site whether its visitor can see the workspace. Everyone is sent to the same place in the app, which asks again
 * from its own page. A token isn't sent by a browser, and a browser says where its own and typed requests come from.
 */
function fromElsewhere(req: Request, into: string): Response | null {
  const site = req.headers.get("Sec-Fetch-Site");
  if (!site || site === "same-origin" || site === "none" || bearerToken(req)) return null;
  return new Response(null, { status: 303, headers: { Location: into, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/** Answers a request that is for an upload's bytes, in or out. Null for any other. */
export async function handleFiles(req: Request, env: Env, url: URL): Promise<Response | null> {
  const sent = PART.exec(url.pathname);
  if (sent) return part(req, env, sent[1]!, Number(sent[2]));
  const shared = SHARED_UPLOAD.exec(url.pathname);
  if (shared) return reads(req) ? sharedUpload(req, env, url, shared[1]!, shared[2]!) : json({ error: "method_not_allowed" }, 405, UNLISTED);
  const exporting = EXPORT.exec(url.pathname);
  if (exporting) return fromElsewhere(req, "/") ?? exported(req, env, url, exporting[1]!);
  const route = UPLOADS.exec(url.pathname);
  if (!route) return null;
  const [, workspaceId, id] = route;
  if (!id) return req.method === "POST" ? upload(req, env, url, workspaceId!) : json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  if (!reads(req)) return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD" });
  const elsewhere = fromElsewhere(req, `/uploads/${id}`);
  if (elsewhere) return elsewhere;
  const who = await asker(req, env, url, workspaceId!);
  if (who instanceof Response) return who;
  // The clipper sends files and never reads them: its token stands for the member, who can see far more than it clipped.
  if (who.clipper) return json({ error: "forbidden", message: "The clipper can only upload files" }, 403);
  try {
    // Asked to open in a tab: a PDF goes to the file site, where there is one, and anything else is answered here as ever.
    const site = url.searchParams.get("open") === "tab" ? await siteAddress(env, who.actor, workspaceId!, id, who.ended) : null;
    if (site) return new Response(null, { status: 302, headers: { Location: site, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    return served(req, await perform(env.DB, who.actor, { type: "upload.open", id }, Date.now(), undefined, { bucket: env.FILES, asked: req.headers }));
  } catch (err) {
    return refused(err);
  }
}
