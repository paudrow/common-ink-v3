// OAuth for /mcp: what a hosted chat app needs to find the sign-in, register itself, send the member to
// consent, and trade the code for tokens. The decisions are in src/core/oauth.ts; this is the HTTP of it.
//   /.well-known/oauth-protected-resource[/mcp]  (RFC 9728)  where /mcp says to sign in
//   /.well-known/oauth-authorization-server      (RFC 8414)  the endpoints below
//   POST /oauth/register                         (RFC 7591)  an app registers itself
//   GET  /oauth/authorize                                    checks a request, sends the browser on to /connect
//   POST /oauth/token                                        a code or a refresh token for tokens
//   POST /oauth/revoke                           (RFC 7009)
// The consent page and the answer it posts are not here. See docs/mcp.md.
import { hashToken } from "../core/agents.ts";
import { CHALLENGE, MAX_STATE, OAuthError, clientOf, exchangeCode, normalized, redirectBack, refreshTokens, registerClient, revokeToken, startRequest, type Tokens } from "../core/oauth.ts";
import { escape, page, sessionPersonId } from "./auth.ts";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
/** The most a body of any of these is: they carry a code, a token or a few addresses. */
const MAX_BODY = 16_384;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const failure = (err: OAuthError) => json({ error: err.error, error_description: err.message }, err.status);
const wrongMethod = (allow: string) => json({ error: "invalid_request", error_description: `Use ${allow}` }, 405, { Allow: allow });

/** Where /mcp is: the resource the tokens are for (RFC 8707), and the one address a client may name as `resource`. */
export const resourceOf = (url: URL) => `${url.origin}/mcp`;

/** What /mcp's 401 points a client at, so it can find where to sign in. */
export const metadataUrl = (url: URL) => `${url.origin}/.well-known/oauth-protected-resource`;

const protectedResource = (url: URL) => ({
  resource: resourceOf(url),
  authorization_servers: [url.origin],
  bearer_methods_supported: ["header"],
  resource_name: "Common Ink",
});

const authorizationServer = (url: URL) => ({
  issuer: url.origin,
  authorization_endpoint: `${url.origin}/oauth/authorize`,
  token_endpoint: `${url.origin}/oauth/token`,
  registration_endpoint: `${url.origin}/oauth/register`,
  revocation_endpoint: `${url.origin}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  authorization_response_iss_parameter_supported: true,
});

const metadata = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "public, max-age=300" } });

/**
 * A body as text, at most MAX_BODY long. It is read as it arrives and given up on past that, so a body
 * sent in chunks with no Content-Length can't be held whole. (`req.text()` on a form warns that the body may not be text.)
 */
async function bodyOf(req: Request, tooLarge: () => OAuthError): Promise<string> {
  if (Number(req.headers.get("Content-Length") ?? 0) > MAX_BODY) throw tooLarge();
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      void reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The form a request came in: `application/x-www-form-urlencoded`, as RFC 6749 requires, or a flat JSON object, which is lenient. A repeated parameter is refused, as the RFC says. */
async function parameters(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("Content-Type")?.toLowerCase() ?? "";
  const text = await bodyOf(req, () => new OAuthError("invalid_request", "The request is too large"));
  if (type.startsWith("application/json")) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_request", "The body isn't JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new OAuthError("invalid_request", "Send a JSON object");
    const out = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string") throw new OAuthError("invalid_request", `${key} is text`);
      out.set(key, value);
    }
    return out;
  }
  if (!type.startsWith("application/x-www-form-urlencoded")) throw new OAuthError("invalid_request", "Send application/x-www-form-urlencoded");
  const out = new URLSearchParams(text);
  if (new Set(out.keys()).size !== [...out.keys()].length) throw new OAuthError("invalid_request", "A parameter was repeated");
  return out;
}

const needed = (p: URLSearchParams, ...names: string[]): string[] => {
  const values = names.map((name) => p.get(name));
  const missing = names.filter((_, i) => !values[i]);
  if (missing.length) throw new OAuthError("invalid_request", `Missing ${missing.join(", ")}`);
  return values as string[];
};

/**
 * The network an address is in, as caps count it. One host is usually given a whole IPv6 /64, and could
 * change its address within it at will, so an IPv6 address counts as its /64. An IPv4 address, or one
 * written inside an IPv6 address, counts as itself.
 */
function network(address: string): string {
  const v4 = /(\d{1,3}(\.\d{1,3}){3})$/.exec(address);
  if (v4 || !address.includes(":")) return v4 ? v4[1]! : address;
  const [head = "", tail] = address.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/** What caps count a request's sender by: a hash of its network, salted with the session secret, kept for that and logged nowhere. Null when the address isn't known. */
async function senderOf(req: Request, env: Env): Promise<string | null> {
  const address = req.headers.get("CF-Connecting-IP");
  return address ? hashToken(`oauth-sender\u0000${env.SESSION_SECRET ?? ""}\u0000${network(address)}`) : null;
}

const tokensAnswer = (t: Tokens) => json({ access_token: t.accessToken, token_type: "Bearer", expires_in: t.expiresIn, refresh_token: t.refreshToken });

async function register(req: Request, env: Env): Promise<Response> {
  const text = await bodyOf(req, () => new OAuthError("invalid_client_metadata", "The request is too large"));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new OAuthError("invalid_client_metadata", "The body isn't JSON");
  }
  const client = await registerClient(env.DB, body, Date.now(), await senderOf(req, env));
  return json(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

async function token(req: Request, env: Env, url: URL): Promise<Response> {
  const p = await parameters(req);
  if (p.has("resource") && p.get("resource") !== resourceOf(url)) throw new OAuthError("invalid_target", `resource is ${resourceOf(url)}`);
  const grant = p.get("grant_type");
  if (!grant) throw new OAuthError("invalid_request", "Missing grant_type");
  if (grant === "authorization_code") {
    const [code, clientId, redirectUri, verifier] = needed(p, "code", "client_id", "redirect_uri", "code_verifier");
    return tokensAnswer(await exchangeCode(env.DB, { code: code!, clientId: clientId!, redirectUri: redirectUri!, verifier: verifier! }));
  }
  if (grant === "refresh_token") {
    const [refreshToken, clientId] = needed(p, "refresh_token", "client_id");
    return tokensAnswer(await refreshTokens(env.DB, { refreshToken: refreshToken!, clientId: clientId! }));
  }
  throw new OAuthError("unsupported_grant_type", "grant_type is authorization_code or refresh_token");
}

/** RFC 7009: the answer is 200 whatever the token was, so it tells no one which tokens exist. */
async function revoke(req: Request, env: Env): Promise<Response> {
  try {
    const p = await parameters(req);
    const value = p.get("token");
    if (value) await revokeToken(env.DB, value, p.get("client_id"));
  } catch (err) {
    if (!(err instanceof OAuthError)) throw err;
  }
  return new Response(null, { status: 200, headers: NO_STORE });
}

/** Said on a page in the browser, never by redirecting: until a member has agreed, an error sent to an address anyone could register would make this an open redirector (RFC 9700, 4.11.2). */
const refusal = (what: string, status = 400) => page("Can't connect", `<p>${escape(what)}</p>`, status);

/**
 * Checks the request an app sends the member's browser with and keeps it, then sends the browser to
 * Common Ink's own page for the member to answer: /connect, after signing in if need be. Nothing is
 * decided or changed by this address, so opening it again only makes another request that lapses.
 *
 * It never redirects to the app's address with an error. Registration is open, so an address that is
 * registered is not thereby trusted, and a redirect from here would be one for anyone to send a link through.
 * What is wrong is said on a page, with a link back to the app that the member may follow.
 */
async function authorize(req: Request, env: Env, url: URL): Promise<Response> {
  const q = url.searchParams;
  if (new Set(q.keys()).size !== [...q.keys()].length) return refusal("The request repeats a parameter, so it can't be read.");
  const client = await clientOf(env.DB, q.get("client_id") ?? "");
  if (!client) return refusal("The app that sent you here isn't registered with Common Ink. Go back and connect it again.");
  // Registered addresses are kept as a browser writes them, so the one asked for is compared as written the same way.
  const redirectUri = normalized(q.get("redirect_uri") ?? "");
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return refusal("The app asked to be sent back to an address it didn't register. Nothing was connected.");

  const state = q.get("state");
  const wrong = (error: string, description: string) => {
    const link = redirectBack(redirectUri, { error, error_description: description, state, iss: url.origin });
    return page("Can't connect", `<p>${escape(description)}</p><p><a href="${escape(link)}">Return to ${escape(new URL(redirectUri).host)}</a></p>`, 400);
  };
  if (state !== null && state.length > MAX_STATE) return wrong("invalid_request", `The app's request is too long to be read (state is at most ${MAX_STATE} characters).`);
  if (q.get("response_type") !== "code") return wrong("unsupported_response_type", "The app asked for something other than a code, which Common Ink doesn't give.");
  const challenge = q.get("code_challenge");
  if (!challenge || !CHALLENGE.test(challenge)) return wrong("invalid_request", "The app didn't send the proof (PKCE, S256) that Common Ink requires of it.");
  if (q.get("code_challenge_method") !== "S256") return wrong("invalid_request", "The app didn't ask for the proof (PKCE) in the one way Common Ink takes, S256.");
  const resource = q.get("resource");
  if (resource !== null && resource !== resourceOf(url)) return wrong("invalid_target", `The app asked to sign in to something that isn't Common Ink's ${resourceOf(url)}.`);

  let id: string;
  try {
    id = await startRequest(env.DB, { clientId: client.id, redirectUri, state, codeChallenge: challenge, resource }, Date.now(), await senderOf(req, env));
  } catch (err) {
    if (err instanceof OAuthError) return refusal(err.message, err.status);
    throw err;
  }
  const connect = `/connect?request=${id}`;
  const signedIn = await sessionPersonId(req, env, url);
  return new Response(null, { status: 302, headers: { Location: signedIn ? connect : `/auth/google?next=${encodeURIComponent(connect)}`, "Cache-Control": "no-store" } });
}

/** A preflight, answered for the routes that allow other sites (their headers are added in headers.ts). */
const preflight = () => new Response(null, { status: 204 });

export async function handleOAuth(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const known = path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-authorization-server" || /^\/oauth\/(authorize|register|token|revoke)$/.test(path);
  if (!known) return json({ error: "not_found" }, 404);
  const opens = path !== "/oauth/authorize";
  if (req.method === "OPTIONS" && opens) return preflight();
  try {
    if (path.startsWith("/.well-known/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return wrongMethod("GET, HEAD, OPTIONS");
      return metadata(path.startsWith("/.well-known/oauth-protected-resource") ? protectedResource(url) : authorizationServer(url));
    }
    if (path === "/oauth/authorize") return req.method === "GET" ? await authorize(req, env, url) : wrongMethod("GET");
    if (req.method !== "POST") return wrongMethod("POST, OPTIONS");
    if (path === "/oauth/register") return await register(req, env);
    if (path === "/oauth/token") return await token(req, env, url);
    return await revoke(req, env);
  } catch (err) {
    if (err instanceof OAuthError) return failure(err);
    throw err;
  }
}
