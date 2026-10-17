import { sessionHolds, signIn, whoAmI } from "../core/accounts.ts";
import { authorizeUrl, covers, exchange, isGoogleSource, REACHING_SCOPES, revoke, SOURCE_SCOPES, type Asking, type GoogleConfig, type GoogleSourceId, type GoogleTokens } from "./google.ts";
import { connectionOf, keepTokens } from "./sources/connections.ts";
import { PROVIDER as GOOGLE } from "./sources/google.ts";
import { vault } from "./vault.ts";
import { b64url, cookie, setCookie, sign, verify } from "./session.ts";

const SESSION_COOKIE = "__Host-ink_session";
const STATE_COOKIE = "__Host-ink_google";
const SESSION_SECONDS = 30 * 86_400;
const STATE_SECONDS = 600;

const DEV_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+-common-ink-v3\.draftox\.workers\.dev)$/;

/**
 * Dev sign-in is set only by the dev server and scripts/preview.ts. The host check keeps it off the
 * production domain, but production versions share the workers.dev hosts with Previews.
 */
export const devSignIn = (env: Env, url: URL) => env.DEV_SIGN_IN === "1" && DEV_HOSTS.test(url.hostname);

const DEV_USER = { email: "dev@common.ink", name: "Dev User" };

/**
 * Who a request is from. On this machine and on Previews, nobody signed in is the dev user. A session
 * that was ended, by its person signing out everywhere or by an admin, is nobody's, there too.
 */
export async function sessionPersonId(req: Request, env: Env, url: URL): Promise<string | null> {
  const data = env.SESSION_SECRET ? await verify<{ personId?: string; ended?: number }>(cookie(req, SESSION_COOKIE), env.SESSION_SECRET) : null;
  if (typeof data?.personId === "string") return (await sessionHolds(env.DB, data.personId, data.ended ?? 0)) ? data.personId : null;
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

const DATA_SOURCES = Object.keys(SOURCE_SCOPES) as GoogleSourceId[];
/** The data sources a person agreed to in full. Google lets them untick each thing asked for. */
const agreedTo = (tokens: GoogleTokens | null) => DATA_SOURCES.filter((id) => covers(id, tokens?.scopes ?? []));

/**
 * Ends at Google what a person just agreed to, when it reaches into their calendar or contacts and
 * nothing here will keep it. An unkept token still opens their data for an hour, and the agreement
 * stands at Google until someone ends it. A token that only says who they are is left to lapse.
 */
async function discard(tokens: GoogleTokens | null): Promise<void> {
  if (tokens?.scopes.some((scope) => REACHING_SCOPES.includes(scope))) await revoke(tokens.refreshToken ?? tokens.accessToken);
}

/**
 * Keeps what Google handed over for a person, sealed, so their calendar and contacts can be read
 * later, or ends it at Google when it can't be kept or opens no data source in full. Answers
 * whether what is now held can outlast the hour: false when a data source was agreed to and Google
 * gave no refresh token, now or before.
 */
async function keepGrant(env: Env, personId: string, email: string, tokens: GoogleTokens | null, now = Date.now()): Promise<boolean> {
  const sealed = vault(env.TOKEN_KEY);
  if (!sealed || !tokens || !agreedTo(tokens).length) {
    await discard(tokens);
    return true;
  }
  await keepTokens(env.DB, sealed, personId, GOOGLE, email, tokens, now);
  return tokens.refreshToken !== null || (await connectionOf(env.DB, personId, GOOGLE))?.refreshToken != null;
}

async function startSession(env: Env, identity: { email: string; name: string }, next: string): Promise<Response> {
  const { personId, sessionsEnded } = await signIn(env.DB, identity);
  const headers = new Headers({ Location: safeNext(next) });
  headers.append("Set-Cookie", setCookie(SESSION_COOKIE, await sign({ personId, ended: sessionsEnded }, env.SESSION_SECRET, SESSION_SECONDS), SESSION_SECONDS));
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

  /** Sends the browser to Google, remembering in a cookie what the answer must match. `connect` is the person agreeing to data sources, already signed in. */
  const toGoogle = async (config: GoogleConfig, next: string, asking: Asking, connect?: string) => {
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const { verifier, challenge } = await pkce();
    const state = await sign({ nonce, verifier, next, ...(connect ? { connect } : {}) }, secret, STATE_SECONDS);
    const headers = new Headers({ Location: authorizeUrl(config, redirectUri, nonce, challenge, asking) });
    headers.append("Set-Cookie", setCookie(STATE_COOKIE, state, STATE_SECONDS));
    return headers;
  };

  if (url.pathname === "/auth/google") {
    if (!google) return page("Google sign-in isn't set up", "<p>This Common Ink has no Google client.</p>", 503);
    return new Response(null, { status: 302, headers: await toGoogle(google, safeNext(url.searchParams.get("next")), { for: "sign-in", sources: vault(env.TOKEN_KEY) !== null }) });
  }

  // Agreeing to a data source, again or for the first time. It is asked as the account the person is
  // signed in with, and Google shows what is being agreed to, so they can take a source back or add one.
  if (url.pathname === "/auth/google/connect") {
    if (!google) return page("Google isn't set up", "<p>This Common Ink has no Google client.</p>", 503);
    const personId = await sessionPersonId(req, env, url);
    if (!personId) return new Response(null, { status: 302, headers: { Location: "/auth/google" } });
    const sources = url.searchParams.getAll("source");
    if (!sources.length || !sources.every(isGoogleSource)) return new Response("Not found", { status: 404 });
    const { email } = (await whoAmI(env.DB, personId)).person;
    const edit = url.searchParams.get("edit") === "1";
    return new Response(null, { status: 302, headers: await toGoogle(google, safeNext(url.searchParams.get("next")), { for: "connect", email, sources, edit }, personId) });
  }

  if (url.pathname === "/auth/google/callback") {
    if (!google) return page("Google sign-in isn't set up", "<p>This Common Ink has no Google client.</p>", 503);
    const state = await verify<{ nonce: string; verifier: string; next: string; connect?: string }>(cookie(req, STATE_COOKIE), secret);
    const back = (to: string) => {
      const headers = new Headers({ Location: safeNext(to) });
      headers.append("Set-Cookie", setCookie(STATE_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    };
    if (url.searchParams.get("error")) {
      // Someone who was only asked about data sources and said no is still signed in, and goes back to where they were.
      if (state?.connect && url.searchParams.get("state") === state.nonce) return back(state.next);
      return page("You didn't allow sign-in", `<p>Google says you didn't allow Common Ink to know who you are. <a href="/auth/google">Try again</a>.</p>`, 400);
    }
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
    if (state.connect) {
      // The answer is kept for the person who asked, in the browser that asked, and only if it is their own account's.
      const personId = await sessionPersonId(req, env, url);
      const person = personId === state.connect ? (await whoAmI(env.DB, personId)).person : null;
      if (!person || person.email !== granted.email) await discard(granted.tokens);
      if (!person) return page("Sign in again", `<p>You were signed out before Google answered. <a href="/auth/google">Sign in</a>.</p>`, 400);
      if (person.email !== granted.email) {
        return page("That's another Google account", `<p>You're signed in to Common Ink as ${escape(person.email)}, and Google answered for ${escape(granted.email)}. Your data sources come from the account you sign in with. <a href="${escape(safeNext(state.next))}">Go back</a>, or <a href="/auth/google?${escape(new URLSearchParams({ next: safeNext(state.next) }).toString())}">sign in with Google</a> as that account.</p>`, 400);
      }
      await keepGrant(env, person.id, granted.email, granted.tokens);
      return back(state.next);
    }
    // The list says who may use this Common Ink at all. An invite says which workspace, and lets nobody past the list.
    // Where dev sign-in is on, anyone can already be anyone, so the list keeps nobody out.
    if (!devSignIn(env, url) && !allowedEmails(env.ALLOWED_EMAILS).has(granted.email)) {
      await discard(granted.tokens);
      return page("Not on the list", `<p>${escape(granted.email)} can't use this Common Ink yet. <a href="/auth/google">Use another account</a>.</p>`, 403);
    }
    const { personId } = await signIn(env.DB, granted);
    const lasting = await keepGrant(env, personId, granted.email, granted.tokens);
    // Google hands a refresh token to an account only the first time it agrees. One that agreed before
    // this Common Ink kept tokens is asked once more, so its data sources don't stop working within the hour.
    return startSession(env, granted, lasting ? state.next : `/auth/google/connect?${new URLSearchParams([...agreedTo(granted.tokens).map((id) => ["source", id]), ["next", state.next]])}`);
  }

  return new Response("Not found", { status: 404 });
}
