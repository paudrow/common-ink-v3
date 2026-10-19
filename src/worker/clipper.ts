import { whoAmI } from "../core/accounts.ts";
import { CLIPPER_DAYS, authenticateClipper, clipperExtensionIds, clipperRedirect, connectClipper, listClipperGrants, revokeClipperGrant } from "../core/clipper.ts";
import { sessionPersonId } from "./auth.ts";
import { PAGE, written } from "./headers.ts";
import { bearerToken } from "./mcp/mcp.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Common Ink</title><link rel="icon" href="/favicon.svg">
<style>:root{color-scheme:light dark;--bg:#fbfaf8;--ink:#1f1e1c;--muted:#6f6b66;--line:#e7e4df;--accent:#5b5bd6;--on:#fff;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:28rem;margin:18vh auto;padding:0 1.5rem;line-height:1.5;background:var(--bg);color:var(--ink)}p{color:var(--muted)}code{font-size:.85em;word-break:break-all}button{font:inherit;background:var(--accent);color:var(--on);border:0;border-radius:6px;padding:.55rem 1rem;cursor:pointer}@media(prefers-color-scheme:dark){:root{--bg:#171716;--ink:#e8e6e3;--muted:#a8a39b;--accent:#8f8ff0}}</style></head>
<body><h1 style="font-size:1.25rem;font-weight:600">${escape(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/** Sign-in for the clipper. The member allows it here, and the token comes back only in the fragment. */
export async function handleClipper(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/clipper/revoke") return revoke(req, env);
  const allowed = clipperExtensionIds(env.CLIPPER_EXTENSION_IDS);
  const back = clipperRedirect(url.searchParams.get("redirect") ?? (req.method === "POST" ? await postedRedirect(req) : null), allowed);
  if (!back) return page("That address can't receive a clipper", "<p>Only the Common Ink Clipper can sign in here. Open it and choose Sign in again.</p>", 400);
  const { redirect, extensionId } = back;
  const personId = await sessionPersonId(req, env, url);
  if (!personId) {
    const next = `/clipper/connect?${new URLSearchParams({ redirect })}`;
    return new Response(null, { status: 302, headers: { Location: `/auth/google?${new URLSearchParams({ next })}`, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    const name = (await whoAmI(env.DB, personId)).person.name;
    // Allow answers with a redirect to the extension, which a form may follow only to an origin its page's form-action names.
    const policy = written({ ...PAGE, "form-action": ["'self'", new URL(redirect).origin] });
    return page(
      "Allow Common Ink Clipper",
      `<p>Save notes as ${escape(name)}. The clipper can list your workspaces and folders, create notes, and upload the pictures and files it clips. It can't read, change or delete anything.</p>
<p>Extension ID <code>${escape(extensionId)}</code>. It stays signed in for ${CLIPPER_DAYS} days, until you sign out in the clipper, or until you revoke it in Settings.</p>
<form method="post" action="/clipper/connect"><input type="hidden" name="redirect" value="${escape(redirect)}"><button type="submit">Allow</button></form>`,
      200,
      { "Content-Security-Policy": policy },
    );
  }
  if (req.method !== "POST") return page("Allow the clipper from its page", "", 405);
  if (req.headers.get("Origin") !== url.origin) return page("Allow the clipper from Common Ink", "", 403);
  const { token } = await connectClipper(env.DB, personId, extensionId);
  const to = new URL(redirect);
  to.hash = new URLSearchParams({ token }).toString();
  return new Response(null, { status: 302, headers: { Location: to.href, "Cache-Control": "no-store" } });
}

/** The clipper signing itself out: its own token, as a bearer, ends its grant. */
async function revoke(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = bearerToken(req);
  const grant = token ? await authenticateClipper(env.DB, token) : null;
  if (!grant) return json({ error: "unauthorized", message: "Send the clipper's own token: Authorization: Bearer cink_…" }, 401);
  await revokeClipperGrant(env.DB, grant.personId, grant.grantId);
  return done();
}

/** A signed-in member's own clipper grants, listed and revoked from Settings. */
export async function handleClipperApi(req: Request, env: Env, url: URL): Promise<Response> {
  const personId = await sessionPersonId(req, env, url);
  if (!personId) return json({ error: "signed_out" }, 401);
  if (url.pathname === "/api/clipper") return req.method === "GET" ? json({ grants: await listClipperGrants(env.DB, personId) }) : json({ error: "method_not_allowed" }, 405);
  const one = /^\/api\/clipper\/([a-z0-9]{12})$/.exec(url.pathname);
  if (!one) return json({ error: "not_found" }, 404);
  if (req.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);
  // The session cookie rides along on any request to us, so a revoke comes from Common Ink's own pages.
  if (req.headers.get("Origin") !== url.origin) return json({ error: "forbidden", message: "The clipper is revoked from Common Ink itself" }, 403);
  return (await revokeClipperGrant(env.DB, personId, one[1]!)) ? done() : json({ error: "not_found", message: "No such clipper sign-in" }, 404);
}

async function postedRedirect(req: Request): Promise<string | null> {
  const type = req.headers.get("Content-Type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) return null;
  try {
    return (await req.clone().formData()).get("redirect")?.toString() ?? null;
  } catch {
    return null;
  }
}
