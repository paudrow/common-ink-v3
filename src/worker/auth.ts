import { signIn } from "../core/accounts.ts";
import { authorizeUrl, exchange, type GoogleConfig } from "./google.ts";
import { b64url, cookie, setCookie, sign, verify } from "./session.ts";

const SESSION_COOKIE = "__Host-ink_session";
const STATE_COOKIE = "__Host-ink_google";
const SESSION_SECONDS = 30 * 86_400;
const STATE_SECONDS = 600;

const DEV_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+-common-ink-v3\.draftox\.workers\.dev)$/;

/** Dev sign-in works only on this machine and on Previews, even if DEV_SIGN_IN leaks into production. */
export const devSignIn = (env: Env, url: URL) => env.DEV_SIGN_IN === "1" && DEV_HOSTS.test(url.hostname);

const DEV_USER = { email: "dev@common.ink", name: "Dev User" };

/** Who a request is from. On this machine and on Previews, nobody signed in is the dev user. */
export async function sessionPersonId(req: Request, env: Env, url: URL): Promise<string | null> {
  const data = env.SESSION_SECRET ? await verify<{ personId?: string }>(cookie(req, SESSION_COOKIE), env.SESSION_SECRET) : null;
  if (typeof data?.personId === "string") return data.personId;
  return devSignIn(env, url) ? (await signIn(env.DB, DEV_USER)).personId : null;
}

const allowedEmails = (value: string | undefined) => new Set((value ?? "").split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Common Ink</title><link rel="icon" href="/favicon.svg">
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:28rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5}a{color:#5b5bd6}</style></head>
<body><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Only paths on this site, read the way a browser reads a Location, so sign-in can't send you elsewhere. */
function safeNext(next: string | null): string {
  const base = "https://next.invalid";
  if (!next?.startsWith("/")) return "/";
  try {
    const u = new URL(next, base);
    const path = `${u.pathname}${u.search}${u.hash}`;
    return u.origin === base && !path.startsWith("//") && path.length <= 1000 ? path : "/";
  } catch {
    return "/";
  }
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) };
}

async function startSession(env: Env, identity: { email: string; name: string }, next: string): Promise<Response> {
  const { personId } = await signIn(env.DB, identity);
  const headers = new Headers({ Location: safeNext(next) });
  headers.append("Set-Cookie", setCookie(SESSION_COOKIE, await sign({ personId }, env.SESSION_SECRET, SESSION_SECONDS), SESSION_SECONDS));
  headers.append("Set-Cookie", setCookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  const secret = env.SESSION_SECRET;
  if (!secret) return page("Sign-in isn't set up", "<p>This Common Ink has no SESSION_SECRET.</p>", 503);

  if (url.pathname === "/auth/sign-out" && req.method === "POST") {
    if (req.headers.get("Origin") !== url.origin) return new Response("Sign out from Common Ink itself", { status: 403 });
    return new Response(null, { status: 204, headers: { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) } });
  }

  if (url.pathname === "/auth/dev") {
    if (!devSignIn(env, url)) return new Response("Not found", { status: 404 });
    const site = req.headers.get("Sec-Fetch-Site");
    if (site && site !== "same-origin" && site !== "none") return new Response("Switch people from Common Ink itself", { status: 403 });
    const identity = { email: url.searchParams.get("email") || DEV_USER.email, name: url.searchParams.get("name") || DEV_USER.name };
    return startSession(env, identity, url.searchParams.get("next") ?? "/");
  }

  const google: GoogleConfig | null = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null;
  const redirectUri = `${url.origin}/auth/google/callback`;

  if (url.pathname === "/auth/google") {
    if (!google) return page("Google sign-in isn't set up", "<p>This Common Ink has no Google client.</p>", 503);
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const { verifier, challenge } = await pkce();
    const state = await sign({ nonce, verifier, next: safeNext(url.searchParams.get("next")) }, secret, STATE_SECONDS);
    return new Response(null, {
      status: 302,
      headers: { Location: authorizeUrl(google, redirectUri, nonce, challenge), "Set-Cookie": setCookie(STATE_COOKIE, state, STATE_SECONDS) },
    });
  }

  if (url.pathname === "/auth/google/callback") {
    if (!google) return page("Google sign-in isn't set up", "<p>This Common Ink has no Google client.</p>", 503);
    if (url.searchParams.get("error")) return page("You didn't allow sign-in", `<p>Google says you didn't allow Common Ink to know who you are. <a href="/auth/google">Try again</a>.</p>`, 400);
    const state = await verify<{ nonce: string; verifier: string; next: string }>(cookie(req, STATE_COOKIE), secret);
    const code = url.searchParams.get("code");
    if (!state || !code || url.searchParams.get("state") !== state.nonce) {
      return page("Sign-in didn't finish", `<p>It took too long or came from somewhere else. <a href="/auth/google">Try again</a>.</p>`, 400);
    }
    let granted;
    try {
      granted = await exchange(google, code, redirectUri, state.verifier);
    } catch (err) {
      return page("Sign-in didn't finish", `<p>${escape((err as Error).message)}. <a href="/auth/google">Try again</a>.</p>`, 400);
    }
    if (!allowedEmails(env.ALLOWED_EMAILS).has(granted.email)) {
      return page("Not on the list", `<p>${escape(granted.email)} can't use this Common Ink yet. <a href="/auth/google">Use another account</a>.</p>`, 403);
    }
    return startSession(env, granted, state.next);
  }

  return new Response("Not found", { status: 404 });
}
