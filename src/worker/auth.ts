import { NotThatPerson, sessionHolds, signIn, whoAmI } from "../core/accounts.ts";
import { count } from "../core/usage.ts";
import { authenticateAgent, type ConnectedAgent } from "../core/agents.ts";
import { authenticateClipper, type ClipperGrant } from "../core/clipper.ts";
import { authorizeUrl, covers, exchange, isGoogleSource, REACHING_SCOPES, revoke, SOURCE_SCOPES, type Asking, type GoogleConfig, type GoogleSourceId, type GoogleTokens } from "./google.ts";
import { connectionOf, keepTokens } from "./sources/connections.ts";
import { PROVIDER as GOOGLE } from "./sources/google.ts";
import { vault } from "./vault.ts";
import { PREVIEW_HOSTS, THIS_MACHINE } from "./hosts.ts";
import { b64url, cookie, setCookie, sign, verify } from "./session.ts";

const SESSION_COOKIE = "__Host-ink_session";
const STATE_COOKIE = "__Host-ink_google";
const SESSION_SECONDS = 30 * 86_400;
const STATE_SECONDS = 600;

/**
 * Dev sign-in is set only by the dev server and scripts/preview.ts. On this machine it is the dev
 * server's, which may also hold a Google client for trying sign-in. Anywhere else it is a Preview's,
 * which has no Google client and no allowlist: where either is set this is production, and one stray
 * DEV_SIGN_IN must not make anyone anyone there.
 */
export const devSignIn = (env: Env, url: URL) =>
  env.DEV_SIGN_IN === "1" && (THIS_MACHINE.test(url.hostname) || (PREVIEW_HOSTS.test(url.hostname) && !env.GOOGLE_CLIENT_ID && !env.ALLOWED_EMAILS));

const DEV_USER = { email: "dev@common.ink", name: "Dev User" };

/**
 * Who a request is from. On this machine and on Previews, nobody signed in is the dev user. A session
 * that was ended, by its person signing out everywhere or by an admin, is nobody's, there too.
 */
export async function sessionPersonId(req: Request, env: Env, url: URL): Promise<string | null> {
  return (await sessionOf(req, env, url))?.personId ?? null;
}

/** The session a request is from, with how many times its person had been signed out everywhere when it began. */
export async function sessionOf(req: Request, env: Env, url: URL): Promise<{ personId: string; ended: number } | null> {
  const data = env.SESSION_SECRET ? await verify<{ t?: string; personId?: string; ended?: number }>(cookie(req, SESSION_COOKIE), env.SESSION_SECRET) : null;
  // Each value signed with SESSION_SECRET says what it is, so one can't pass for another. Sessions began before that carry no tag, and lapse within 30 days of it.
  if (typeof data?.personId === "string" && (data.t ?? "session") === "session") {
    const ended = data.ended ?? 0;
    return (await sessionHolds(env.DB, data.personId, ended)) && (await listed(env, url, data.personId)) ? { personId: data.personId, ended } : null;
  }
  if (!devSignIn(env, url)) return null;
  const dev = await signIn(env.DB, DEV_USER);
  return { personId: dev.personId, ended: dev.sessionsEnded };
}

const allowedEmails = (value: string | undefined) => new Set((value ?? "").split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));

/**
 * Whether a person may still use this Common Ink: their email is on ALLOWED_EMAILS. Taking someone off
 * the list ends every way they had in at once, their sessions, agents, OAuth apps and clipper, as if
 * they had been signed out everywhere; putting them back lets those work again. Wherever Google
 * sign-in is set up the list is checked, as sign-in checks it, so an empty list lets nobody in. Where
 * it isn't, nobody signs in by Google, and where dev sign-in is on anyone is anyone.
 */
export async function listed(env: Env, url: URL, personId: string): Promise<boolean> {
  if (devSignIn(env, url) || !env.GOOGLE_CLIENT_ID) return true;
  const allowed = allowedEmails(env.ALLOWED_EMAILS);
  const email = await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(personId).first<string>("email");
  return email !== null && allowed.has(email);
}

/** Who a bearer token stands for, an agent (or OAuth app) or a clipper, while its person is still on the list. */
export async function tokenHolder(env: Env, url: URL, token: string): Promise<{ agent: ConnectedAgent } | { clipper: ClipperGrant } | null> {
  const agent = await authenticateAgent(env.DB, token);
  if (agent) return (await listed(env, url, agent.personId)) ? { agent } : null;
  const clipper = await authenticateClipper(env.DB, token);
  return clipper && (await listed(env, url, clipper.personId)) ? { clipper } : null;
}

export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Common Ink</title><link rel="icon" href="/favicon.svg">
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:28rem;margin:20vh auto;padding:0 1.5rem;line-height:1.5}a{color:#5b5bd6}</style></head>
<body><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** The longest address sign-in sends you back to: it rides in a cookie through Google and back. */
export const MAX_NEXT = 1000;

/** Only paths on this site, read the way a browser reads a Location, so sign-in can't send you elsewhere. */
function safeNext(next: string | null): string {
  const base = "https://next.invalid";
  if (!next?.startsWith("/")) return "/";
  try {
    const u = new URL(next, base);
    const path = `${u.pathname}${u.search}${u.hash}`;
    return u.origin === base && !path.startsWith("//") && path.length <= MAX_NEXT ? path : "/";
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
  await count({ event: "sign_in", workspaceId: null, personId, kind: "person" });
  const headers = new Headers({ Location: safeNext(next) });
  headers.append("Set-Cookie", setCookie(SESSION_COOKIE, await sign({ t: "session", personId, ended: sessionsEnded }, env.SESSION_SECRET, SESSION_SECONDS), SESSION_SECONDS));
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
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Sign in as someone with GET", { status: 405, headers: { Allow: "GET, HEAD" } });
    const identity = { email: url.searchParams.get("email") || DEV_USER.email, name: url.searchParams.get("name") || DEV_USER.name };
    if (identity.email.length > 254 || !identity.email.includes("@")) return new Response("An email has an @ and at most 254 characters", { status: 400 });
    if (identity.name.length > 100) return new Response("A name has at most 100 characters", { status: 400 });
    return startSession(env, identity, url.searchParams.get("next") ?? "/");
  }

  const google: GoogleConfig | null = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null;
  const redirectUri = `${url.origin}/auth/google/callback`;

  /** Sends the browser to Google, remembering in a cookie what the answer must match. `connect` is the person agreeing to data sources, already signed in. */
  const toGoogle = async (config: GoogleConfig, next: string, asking: Asking, connect?: string) => {
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const { verifier, challenge } = await pkce();
    const state = await sign({ t: "state", nonce, verifier, next, ...(connect ? { connect } : {}) }, secret, STATE_SECONDS);
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
    const signed = await verify<{ t?: string; nonce: string; verifier: string; next: string; connect?: string }>(cookie(req, STATE_COOKIE), secret);
    const state = signed?.t === "state" ? signed : null;
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
      // Ending it at Google ends the whole agreement, so it is left to lapse when another person here keeps one from that account: on a shared browser, Google may answer for them.
      if (!person || person.email !== granted.email) {
        const keptHere = await env.DB.prepare("SELECT 1 FROM source_connections WHERE provider = ? AND account = ?").bind(GOOGLE, granted.email).first();
        if (!keptHere) await discard(granted.tokens);
      }
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
    let personId: string;
    try {
      ({ personId } = await signIn(env.DB, granted));
    } catch (err) {
      if (!(err instanceof NotThatPerson)) throw err;
      await discard(granted.tokens);
      return page(
        "That's not the account this email signs in with",
        `<p>${escape(granted.email)} signs in to Common Ink with another Google account than this one. An email that passed to someone else doesn't take over the person who had it. <a href="/auth/google">Use another account</a>, or ask an admin.</p>`,
        403,
      );
    }
    const lasting = await keepGrant(env, personId, granted.email, granted.tokens);
    // Google hands a refresh token to an account only the first time it agrees. One that agreed before
    // this Common Ink kept tokens is asked once more, so its data sources don't stop working within the hour.
    return startSession(env, granted, lasting ? state.next : `/auth/google/connect?${new URLSearchParams([...agreedTo(granted.tokens).map((id) => ["source", id]), ["next", state.next]])}`);
  }

  return new Response("Not found", { status: 404 });
}
