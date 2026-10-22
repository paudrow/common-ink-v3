// How often one caller may ask for the costly or guessable things, with Cloudflare's rate limiting
// bindings (wrangler.jsonc `ratelimits`). Each binding holds its own count per key over a minute,
// across the Worker's locations, closely but not exactly. A caller past it is answered 429 before
// anything is read or written.

import { hashToken } from "../core/agents.ts";
import { devSignIn } from "./auth.ts";

/** Each limit: its binding, what it is for, and what it is counted by. The numbers are in wrangler.jsonc. */
export const LIMITS = {
  /** Each sign-in's answer from Google costs a call to Google with the client secret: 10 a minute per address. */
  SIGN_IN_LIMIT: "the sign-ins from one address",
  /** A link's page and its API are open to anyone holding a token, and cost a database read each: 60 a minute per address. */
  LINK_LIMIT: "the link pages opened from one address",
  /** OAuth registration and tokens are open to any app: 30 a minute per address. */
  OAUTH_LIMIT: "the OAuth requests from one address",
  /** A member's operations: 300 a minute each. */
  OPS_LIMIT: "one person's operations",
  /** An agent's or a clipper's MCP calls: 300 a minute per token. */
  MCP_LIMIT: "one token's MCP calls",
  /** Each recording transcribed is paid for by the minute of it: 6 a minute per person, on top of their operations. */
  TRANSCRIBE_LIMIT: "one person's transcriptions",
} as const;

export type Limit = keyof typeof LIMITS;

const tooMany = (limit: Limit) =>
  Response.json({ error: "rate_limited", message: `Too many requests: ${LIMITS[limit]} are limited each minute. Try again in a minute.` }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });

/**
 * Null while `key` is within `limit`, or the 429 to answer. Not counted where the binding is missing,
 * where there is no key (a request that came by no Cloudflare edge has no address), or where dev
 * sign-in makes anyone anyone, as on this machine and on Previews, whose tests ask as fast as they can.
 */
export async function overLimit(env: Env, url: URL, limit: Limit, key: string | null): Promise<Response | null> {
  const binding = env[limit];
  if (!binding || key === null || devSignIn(env, url)) return null;
  const { success } = await binding.limit({ key });
  return success ? null : tooMany(limit);
}

/** The address a request came from, as Cloudflare's edge says. */
export const addressOf = (req: Request) => req.headers.get("CF-Connecting-IP");

/** A bearer token counted by its hash, so the token itself is handed to nothing. */
export const tokenKey = async (token: string | null) => (token ? hashToken(token) : null);

/** Which limit an address's path counts toward by the caller's address, if any. Operations and /mcp are counted by who asks, once that is known. */
export function limitByAddress(pathname: string): Limit | null {
  if (pathname === "/auth/google/callback") return "SIGN_IN_LIMIT";
  if (/^\/s\/|^\/api\/shared\//.test(pathname)) return "LINK_LIMIT";
  if (pathname === "/oauth/register" || pathname === "/oauth/token") return "OAUTH_LIMIT";
  return null;
}
