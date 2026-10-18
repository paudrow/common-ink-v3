import { whoAmI } from "../core/accounts.ts";
import { clipperRedirect, connectClipper } from "../core/clipper.ts";
import { sessionPersonId } from "./auth.ts";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Common Ink</title><link rel="icon" href="/favicon.svg">
<style>:root{color-scheme:light dark;--bg:#fbfaf8;--ink:#1f1e1c;--muted:#6f6b66;--line:#e7e4df;--accent:#5b5bd6;--on:#fff;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:28rem;margin:18vh auto;padding:0 1.5rem;line-height:1.5;background:var(--bg);color:var(--ink)}p{color:var(--muted)}button{font:inherit;background:var(--accent);color:var(--on);border:0;border-radius:6px;padding:.55rem 1rem;cursor:pointer}@media(prefers-color-scheme:dark){:root{--bg:#171716;--ink:#e8e6e3;--muted:#a8a39b;--accent:#8f8ff0}}</style></head>
<body><h1 style="font-size:1.25rem;font-weight:600">${escape(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Sign-in for the clipper. The member allows it here, and the token comes back only in the fragment. */
export async function handleClipper(req: Request, env: Env, url: URL): Promise<Response> {
  const redirect = clipperRedirect(url.searchParams.get("redirect") ?? (req.method === "POST" ? await postedRedirect(req) : null));
  if (!redirect) return page("That address can't receive a clipper", "<p>Open the clipper and choose Sign in again.</p>", 400);
  const personId = await sessionPersonId(req, env, url);
  if (!personId) {
    const next = `/clipper/connect?${new URLSearchParams({ redirect })}`;
    return new Response(null, { status: 302, headers: { Location: `/auth/google?${new URLSearchParams({ next })}`, "Cache-Control": "no-store" } });
  }
  if (req.method === "GET") {
    const name = (await whoAmI(env.DB, personId)).person.name;
    return page(
      "Allow Common Ink Clipper",
      `<p>Save notes as ${escape(name)}. The clipper can create notes and upload files in your workspaces.</p>
<form method="post" action="/clipper/connect"><input type="hidden" name="redirect" value="${escape(redirect)}"><button type="submit">Allow</button></form>`,
    );
  }
  if (req.method !== "POST") return page("Allow the clipper from its page", "", 405);
  if (req.headers.get("Origin") !== url.origin) return page("Allow the clipper from Common Ink", "", 403);
  const { token } = await connectClipper(env.DB, personId);
  const back = new URL(redirect);
  back.hash = new URLSearchParams({ token }).toString();
  return new Response(null, { status: 302, headers: { Location: back.href, "Cache-Control": "no-store" } });
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
