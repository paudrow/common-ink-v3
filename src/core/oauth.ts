// OAuth 2.1 for the MCP endpoint, so a hosted chat app (claude.ai, ChatGPT) that can't send a pasted token
// can still connect as an agent. The Worker is both the authorization server and the resource server.
//
// A connection made this way IS an agent: consenting makes a row in `agents`, with the limits the member
// chose, and everything that holds for an agent holds for it. What is different is how its token is
// obtained: an app registers itself, the member consents in the browser, and the app trades the code it is
// handed (with its PKCE verifier) for an access token that lasts an hour and a refresh token that lasts
// 30 days and is replaced each time it is used. Neither outlives the agent, and neither is looked up
// without the agent: disconnecting, editing or expiring the agent changes what its tokens may do at once.
//
// Codes and tokens are 256 random bits kept only as SHA-256 hashes, as an agent's token is. Nothing here
// logs one, and an error never quotes one.
import { ACCESS_PREFIX, SIGNED_OUT_MEANWHILE, b64url, hashToken, prepareAgent } from "./agents.ts";
import { newId } from "./ids.ts";
import { MAX_AGENT_NAME, OpError, type ConnectOptions } from "./protocol.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a request waits for the member, a code waits for the app, and the two kinds of token last. */
export const REQUEST_MS = 10 * MINUTE;
export const CODE_MS = MINUTE;
export const ACCESS_MS = HOUR;
export const REFRESH_MS = 30 * DAY;
/** Anyone can register an app, so one that never sends anyone to sign in is forgotten after an hour, and one that never gets a grant after a day. */
export const UNSTARTED_CLIENT_MS = HOUR;
export const UNUSED_CLIENT_MS = DAY;
/** How many apps that never got a grant there can be, and how many requests waiting for a member. Past the first, the oldest app that never sent anyone to sign in makes room; past the second, more are refused. */
export const MAX_UNUSED_CLIENTS = 1000;
export const MAX_PENDING_REQUESTS = 2000;
/** And per app, so one app can't fill the room for all, and per address an app is registered from, per hour. */
export const MAX_PENDING_PER_CLIENT = 20;
export const MAX_REGISTRATIONS_PER_HOUR = 20;
/** Per person, fewer than an app's room, so one member can't fill an app's. */
export const MAX_PENDING_PER_PERSON = 10;
/** A refresh token that is used again within this long of its use is a retry after a lost answer, not a copy. */
export const RETRY_MS = 30_000;
/** How often a sweep runs at most. */
const SWEEP_EVERY = MINUTE;
export const MAX_REDIRECT_URIS = 5;
export const MAX_CLIENT_NAME = 100;

export const CODE_PREFIX = "cink_ac_";
export const REFRESH_PREFIX = "cink_rt_";

/** The errors RFC 6749, 7591 and 8707 name, with the status each is answered with. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "temporarily_unavailable";

export class OAuthError extends Error {
  constructor(
    readonly error: OAuthErrorCode,
    description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

/** Asked for a request that is gone, taken, or not this person's: all are answered alike, so nobody learns which. */
export const NO_SUCH_REQUEST = "This sign-in request has expired, or isn't yours. Start again from the app you are connecting";

const secret = (prefix: string) => prefix + b64url(crypto.getRandomValues(new Uint8Array(32)));

// ---- Registration (RFC 7591) ----

export interface Client {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
}

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string;
  created_at: number;
}

const toClient = (r: ClientRow): Client => ({ id: r.id, name: r.name, redirectUris: JSON.parse(r.redirect_uris) as string[], createdAt: r.created_at });

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Control characters, line breaks, zero-width characters and the marks that reverse the way text runs, which a name could use to pass as another. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

/** Why `uri` can't be a redirect address, or null if it can: https, or http to this machine (a desktop app listens there); no fragment, no credentials. */
function redirectProblem(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri || uri.length > 2000) return "Each redirect_uri is an address of at most 2000 characters";
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "A redirect_uri isn't an address";
  }
  if (uri.includes("#")) return "A redirect_uri has no fragment";
  if (url.username || url.password) return "A redirect_uri has no user name or password";
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  return "A redirect_uri is https, or http on localhost, 127.0.0.1 or [::1]";
}

/** An address as a browser writes it, so two ways of writing one address are one: the host in lower case and in punycode, the default port gone. Null if it isn't an address. */
export function normalized(uri: string): string | null {
  try {
    return new URL(uri).href;
  } catch {
    return null;
  }
}

/** When the last sweep began in this isolate. See `sweep`. */
let lastSweep = 0;

/** Apps that are waiting for a grant and not yet forgotten: `?1` is an hour ago, `?2` a day ago. */
const WAITING_CLIENT = "last_used_at IS NULL AND created_at > ?2 AND (requested_at IS NOT NULL OR created_at > ?1)";

/**
 * Removes what has lapsed: requests nobody answered, codes past their end, tokens long past their end,
 * apps that never got a grant, and the agents of OAuth connections that hold nothing that works: no
 * code still to trade, and every token run out. Run when someone starts something, so no timer is needed
 * (and from the Worker's hourly timer too, for a quiet day).
 *
 * It writes, and an isolate answers many requests, so it runs at most once a minute in each unless
 * `force` is set. Nothing depends on its having run: what has lapsed is refused by its own end time
 * wherever it is read, and the caps count only what is live.
 */
export async function sweep(db: D1Database, now = Date.now(), force = false): Promise<void> {
  if (!force && now - lastSweep < SWEEP_EVERY) return;
  lastSweep = now;
  await db.batch([
    // Before the codes and tokens go, while they say who still holds something.
    db
      .prepare(
        `UPDATE agents SET revoked_at = ?1 WHERE revoked_at IS NULL AND client_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.agent_id = agents.id AND c.expires_at > ?1 AND c.used_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.agent_id = agents.id AND t.expires_at > ?1 AND (t.kind = 'access' OR t.used_at IS NULL))`,
      )
      .bind(now),
    db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_requests WHERE created_at < ?").bind(now - REQUEST_MS),
    // A used refresh token is kept to the end of its life, so reusing it is still seen; a day more, for the clocks.
    db.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(now - DAY),
    db
      .prepare(
        `DELETE FROM oauth_clients WHERE last_used_at IS NULL AND NOT (${WAITING_CLIENT})
           AND NOT EXISTS (SELECT 1 FROM agents WHERE client_id = oauth_clients.id)
           AND NOT EXISTS (SELECT 1 FROM oauth_requests WHERE client_id = oauth_clients.id)
           AND NOT EXISTS (SELECT 1 FROM oauth_codes WHERE client_id = oauth_clients.id)`,
      )
      .bind(now - UNSTARTED_CLIENT_MS, now - UNUSED_CLIENT_MS),
  ]);
}

/**
 * Registers an app as RFC 7591 describes, for a public client only: one with no secret, which proves
 * itself with PKCE. An app that asks for another way to authenticate is registered as `none`, which
 * the answer says (the RFC lets a server choose). Anyone can register, so an app that never gets a
 * grant is forgotten (see UNSTARTED_CLIENT_MS), only so many wait at once (a new one takes the place of the
 * oldest that never sent anyone to sign in), and one address registers only so many an hour: `from` is a hash of it, kept to count by and for nothing else. What the app calls itself is kept as
 * given and shown as unverified.
 */
export async function registerClient(db: D1Database, body: unknown, now = Date.now(), from: string | null = null): Promise<Client> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Send a JSON object");
  const m = body as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || !uris.length) throw new OAuthError("invalid_redirect_uri", "Give redirect_uris: at least one address");
  if (uris.length > MAX_REDIRECT_URIS) throw new OAuthError("invalid_redirect_uri", `Give at most ${MAX_REDIRECT_URIS} redirect_uris`);
  for (const uri of uris) {
    const problem = redirectProblem(uri);
    if (problem) throw new OAuthError("invalid_redirect_uri", problem);
  }
  const redirectUris = [...new Set((uris as string[]).map((uri) => normalized(uri)!))];
  const asked = (key: string, allowed: readonly string[], needs?: string) => {
    const list = m[key];
    if (list === undefined) return;
    if (!Array.isArray(list) || !list.every((v) => typeof v === "string" && allowed.includes(v)) || (needs && !list.includes(needs))) {
      throw new OAuthError("invalid_client_metadata", `${key} can be ${allowed.join(", ")}${needs ? `, and has to include ${needs}` : ""}`);
    }
  };
  asked("grant_types", ["authorization_code", "refresh_token"], "authorization_code");
  asked("response_types", ["code"], "code");
  if (m.token_endpoint_auth_method !== undefined && typeof m.token_endpoint_auth_method !== "string") throw new OAuthError("invalid_client_metadata", "token_endpoint_auth_method is text");
  let name = "Unnamed app";
  if (m.client_name !== undefined) {
    if (typeof m.client_name !== "string" || m.client_name.length > MAX_CLIENT_NAME || UNSAFE_NAME.test(m.client_name)) {
      throw new OAuthError("invalid_client_metadata", `client_name is text of at most ${MAX_CLIENT_NAME} characters`);
    }
    name = m.client_name.trim() || name;
  }

  // Refused before anything is written, counting only what is live, so a flood of refusals costs reads alone.
  if (from) {
    const lately = await db.prepare("SELECT COUNT(*) AS n FROM oauth_clients WHERE registered_from = ? AND created_at > ?").bind(from, now - HOUR).first<{ n: number }>();
    if ((lately?.n ?? 0) >= MAX_REGISTRATIONS_PER_HOUR) throw new OAuthError("temporarily_unavailable", "This address has registered too many apps this hour. Try again later", 429);
  }
  const waiting = await db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients WHERE ${WAITING_CLIENT}`).bind(now - UNSTARTED_CLIENT_MS, now - UNUSED_CLIENT_MS).first<{ n: number }>();
  if ((waiting?.n ?? 0) >= MAX_UNUSED_CLIENTS) {
    // An app that is used sends someone to sign in as soon as it registers, so the oldest that hasn't is the one least likely to.
    const evicted = await db
      .prepare("DELETE FROM oauth_clients WHERE id = (SELECT id FROM oauth_clients WHERE last_used_at IS NULL AND requested_at IS NULL AND created_at > ? ORDER BY created_at LIMIT 1) RETURNING id")
      .bind(now - UNSTARTED_CLIENT_MS)
      .first();
    if (!evicted) throw new OAuthError("temporarily_unavailable", "Too many apps have registered and not yet connected. Try again later", 503);
  }
  await sweep(db, now);
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await db.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at, registered_from) VALUES (?, ?, ?, ?, ?)").bind(id, name, JSON.stringify(redirectUris), now, from).run();
  return { id, name, redirectUris, createdAt: now };
}

export async function clientOf(db: D1Database, id: string): Promise<Client | null> {
  if (!id || id.length > 100) return null;
  const row = await db.prepare("SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?").bind(id).first<ClientRow>();
  return row ? toClient(row) : null;
}

// ---- Authorization requests ----

export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const MAX_STATE = 2000;

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
}

/** What a request's id is kept as. The id is in the address of the consent page, so only a hash of it is stored, as for a code. */
const keyOf = (requestId: string) => hashToken(requestId);

/**
 * Keeps what /oauth/authorize was sent (already checked there), for the page where `personId`, who is
 * signed in, answers it. Gives the request's id: 256 random bits, good for ten minutes, and theirs alone.
 * Too many waiting, in all, for this app or for this person, is refused.
 */
export async function startRequest(db: D1Database, personId: string, r: AuthRequest, now = Date.now()): Promise<string> {
  const pending = await db
    .prepare("SELECT COUNT(*) AS n, COUNT(CASE WHEN client_id = ?1 THEN 1 END) AS mine, COUNT(CASE WHEN person_id = ?2 THEN 1 END) AS theirs FROM oauth_requests WHERE created_at > ?3")
    .bind(r.clientId, personId, now - REQUEST_MS)
    .first<{ n: number; mine: number; theirs: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_REQUESTS) throw new OAuthError("temporarily_unavailable", "Too many sign-ins are waiting. Try again in a few minutes", 503);
  if ((pending?.mine ?? 0) >= MAX_PENDING_PER_CLIENT) throw new OAuthError("temporarily_unavailable", "This app has too many sign-ins waiting. Finish one, or try again in a few minutes", 429);
  if ((pending?.theirs ?? 0) >= MAX_PENDING_PER_PERSON) throw new OAuthError("temporarily_unavailable", "You have too many sign-ins waiting. Finish one, or try again in a few minutes", 429);
  await sweep(db, now);
  const id = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db
      .prepare("INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, resource, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(await keyOf(id), r.clientId, r.redirectUri, r.state, r.codeChallenge, r.resource, personId, now),
    db.prepare("UPDATE oauth_clients SET requested_at = ? WHERE id = ? AND requested_at IS NULL").bind(now, r.clientId),
  ]);
  return id;
}

/** What the consent page shows about a request: who is asking and where the member goes, never the address itself, whose look could mislead. */
export interface RequestView {
  clientName: string;
  /** Where the member goes after answering, as an address bar writes it: an international name in punycode. */
  redirectHost: string;
}

/**
 * The request a person opens, to show them who is asking. It belongs to the person who started it:
 * for anyone else it is as if there were none, and so is it once it has lapsed.
 */
export async function openRequest(db: D1Database, personId: string, requestId: string, now = Date.now()): Promise<RequestView> {
  const row = await db
    .prepare("SELECT r.redirect_uri, c.name FROM oauth_requests r JOIN oauth_clients c ON c.id = r.client_id WHERE r.id = ? AND r.person_id = ? AND r.created_at > ?")
    .bind(await keyOf(requestId), personId, now - REQUEST_MS)
    .first<{ redirect_uri: string; name: string }>();
  if (!row) throw new OpError("not_found", NO_SUCH_REQUEST);
  return { clientName: row.name, redirectHost: new URL(row.redirect_uri).host };
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  name: string;
}

/** The request `personId` may answer: one they started. Any other is no request. */
async function ownRequest(db: D1Database, personId: string, requestId: string, now: number): Promise<RequestRow> {
  const row = await db
    .prepare("SELECT r.id, r.client_id, r.redirect_uri, r.state, r.code_challenge, c.name FROM oauth_requests r JOIN oauth_clients c ON c.id = r.client_id WHERE r.id = ? AND r.person_id = ? AND r.created_at > ?")
    .bind(await keyOf(requestId), personId, now - REQUEST_MS)
    .first<RequestRow>();
  if (!row) throw new OpError("not_found", NO_SUCH_REQUEST);
  return row;
}

/** Takes `personId`'s request, once: whichever answer gets this is the one, and none after. */
async function claim(db: D1Database, personId: string, requestId: string, now: number): Promise<void> {
  const taken = await db
    .prepare("DELETE FROM oauth_requests WHERE id = ? AND person_id = ? AND created_at > ? RETURNING id")
    .bind(await keyOf(requestId), personId, now - REQUEST_MS)
    .first();
  if (!taken) throw new OpError("not_found", NO_SUCH_REQUEST);
}

/** The most of a name that an agent's name can hold, cut between characters. */
const fit = (name: string, max: number) => {
  let out = "";
  for (const ch of name) if ((out + ch).length <= max) out += ch;
  return out.trim();
};

/**
 * `redirectUri` with what the app is told appended to its query: the code or the error, the state it
 * sent, and `iss` (RFC 9207), which tells an app that talks to several servers which one answered.
 */
export function redirectBack(redirectUri: string, answer: Record<string, string | null | undefined>): string {
  const to = new URL(redirectUri);
  for (const [key, value] of Object.entries(answer)) if (value) to.searchParams.set(key, value);
  return to.toString();
}

export interface Consent {
  requestId: string;
  /** What the agent is called. Left out, it is the app's own name, cut to fit. */
  name?: string;
}

/**
 * A member consents to a request. `personId` is the signed-in member, from the session and never from
 * what the page sent, so it is a parameter of its own. The agent is made with the limits they chose, held to what the Agents
 * page can give, and a code for the app to trade for its tokens. The request belongs to the person who
 * started it and is answered once. Nothing is made if any option is refused, and the request
 * stays to be answered again.
 */
export async function consent(db: D1Database, personId: string, choices: Consent & ConnectOptions, now = Date.now(), ended?: number): Promise<{ agentId: string; code: string; redirectUri: string; state: string | null }> {
  const { requestId, name, ...options } = choices;
  const request = await ownRequest(db, personId, requestId, now);
  const { id: agentId, insert } = await prepareAgent(
    db,
    personId,
    name ?? (fit(request.name, MAX_AGENT_NAME) || "App"),
    options,
    // The agent's own token is never issued: this is a hash nothing hashes to.
    { tokenPrefix: "oauth", tokenHash: await hashToken(secret("unissued_")), clientId: request.client_id },
    now,
    ended,
  );
  await claim(db, personId, requestId, now);
  const code = secret(CODE_PREFIX);
  const clientId = request.client_id;
  const [, , , made] = await db.batch([
    // A later consent for this app replaces the earlier connection, so it does not add another agent.
    db.prepare("DELETE FROM oauth_tokens WHERE agent_id IN (SELECT id FROM agents WHERE person_id = ? AND client_id = ? AND revoked_at IS NULL)").bind(personId, clientId),
    db.prepare("DELETE FROM oauth_codes WHERE agent_id IN (SELECT id FROM agents WHERE person_id = ? AND client_id = ? AND revoked_at IS NULL)").bind(personId, clientId),
    db.prepare("UPDATE agents SET revoked_at = ? WHERE person_id = ? AND client_id = ? AND revoked_at IS NULL").bind(now, personId, clientId),
    insert,
    // The code is for the agent just made, so a consent whose agent wasn't made, its person signed out everywhere meanwhile, gives no code either.
    db
      .prepare("INSERT INTO oauth_codes (hash, client_id, redirect_uri, code_challenge, agent_id, expires_at) SELECT ?, ?, ?, ?, id, ? FROM agents WHERE id = ?")
      .bind(await hashToken(code), request.client_id, request.redirect_uri, request.code_challenge, now + CODE_MS, agentId),
    db.prepare("UPDATE oauth_clients SET last_used_at = ? WHERE id = ?").bind(now, request.client_id),
  ]);
  if (!made!.meta.changes) throw new OpError("conflict", SIGNED_OUT_MEANWHILE);
  return { agentId, code, redirectUri: request.redirect_uri, state: request.state };
}

/** A member says no. The request is answered, and the app is to be told `access_denied` at the address it gave. */
export async function deny(db: D1Database, personId: string, requestId: string, now = Date.now()): Promise<{ redirectUri: string; state: string | null }> {
  const request = await ownRequest(db, personId, requestId, now);
  await claim(db, personId, requestId, now);
  return { redirectUri: request.redirect_uri, state: request.state };
}

// ---- Tokens ----

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lasts. */
  expiresIn: number;
}

interface Grantee {
  id: string;
  expires_at: number | null;
}

/**
 * The statements that make a new pair of tokens for an agent, neither outliving the agent, and the
 * tokens. With `afterSpend`, each insert is made only if the statement before it changed a row, so
 * they follow a refresh token's spending in the one batch and only if that spending won.
 */
async function issue(db: D1Database, agent: Grantee, family: string, now: number, afterSpend = false): Promise<{ tokens: Tokens; statements: D1PreparedStatement[] }> {
  const end = (lasting: number) => Math.min(now + lasting, agent.expires_at ?? Infinity);
  const access = secret(ACCESS_PREFIX);
  const refresh = secret(REFRESH_PREFIX);
  const accessEnd = end(ACCESS_MS);
  const add = async (token: string, kind: string, expiresAt: number) =>
    db.prepare(`INSERT INTO oauth_tokens (hash, agent_id, kind, family, expires_at) SELECT ?, ?, ?, ?, ?${afterSpend ? " WHERE changes() > 0" : ""}`).bind(await hashToken(token), agent.id, kind, family, expiresAt);
  return {
    statements: [await add(access, "access", accessEnd), await add(refresh, "refresh", end(REFRESH_MS))],
    tokens: { accessToken: access, refreshToken: refresh, expiresIn: Math.floor((accessEnd - now) / 1000) },
  };
}

/** Ends an authorization: every token it gave is gone, and so is its agent, which stays on the Agents page as disconnected. */
async function endGrant(db: D1Database, agentId: string, now: number): Promise<void> {
  await db.batch([db.prepare("DELETE FROM oauth_tokens WHERE agent_id = ?").bind(agentId), db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, agentId)]);
}

const grantError = (what: string) => new OAuthError("invalid_grant", what);

/** An agent that has no tokens, because its code was spoilt or never traded, has nothing to hold: it is disconnected. */
const abandon = (db: D1Database, agentId: string, now: number) =>
  db.prepare("UPDATE agents SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM oauth_tokens WHERE agent_id = ?2)").bind(now, agentId);

async function challengeOf(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/**
 * Trades a code for tokens. A code works once. The app has to be the one the code was made for, at the
 * address it was made for, with the verifier its challenge came from, and a try that fails spends it.
 * A traded code is kept until it would have lapsed, so a second try is seen: it may be someone who
 * stole the code, so what the first try was given ends, as RFC 6749 (4.1.2) asks.
 */
export async function exchangeCode(db: D1Database, p: { code: string; clientId: string; redirectUri: string; verifier: string }, now = Date.now()): Promise<Tokens> {
  if (!(await clientOf(db, p.clientId))) throw new OAuthError("invalid_client", "No app is registered with that client_id", 401);
  const gone = () => grantError("That code isn't one this server made, or it was used or has lapsed");
  if (!p.code.startsWith(CODE_PREFIX) || p.code.length > 200) throw gone();
  const hash = await hashToken(p.code);
  const row = await db
    .prepare("SELECT client_id, redirect_uri, code_challenge, agent_id, expires_at, used_at FROM oauth_codes WHERE hash = ?")
    .bind(hash)
    .first<{ client_id: string; redirect_uri: string; code_challenge: string; agent_id: string; expires_at: number; used_at: number | null }>();
  if (!row || (row.used_at !== null && row.expires_at <= now)) throw gone();
  const reused = async () => {
    await endGrant(db, row.agent_id, now);
    return grantError("That code was already used, so what it gave has ended. Connect again");
  };
  if (row.used_at !== null) throw await reused();
  const spend = db.prepare("UPDATE oauth_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL").bind(now, hash);
  const refused = async (what: string) => {
    await db.batch([spend, abandon(db, row.agent_id, now)]);
    return grantError(what);
  };
  if (row.expires_at <= now) throw await refused("That code has lapsed");
  if (row.client_id !== p.clientId) throw await refused("That code was made for another app");
  if (row.redirect_uri !== normalized(p.redirectUri)) throw await refused("redirect_uri isn't the one the code was made for");
  if (!VERIFIER.test(p.verifier) || (await challengeOf(p.verifier)) !== row.code_challenge) throw await refused("code_verifier doesn't match the code_challenge");
  const agent = await db.prepare("SELECT id, expires_at FROM agents WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").bind(row.agent_id, now).first<Grantee>();
  if (!agent) throw await refused("The agent this was for has been disconnected, or has expired");
  // The spending and the tokens are one batch, so the agent holds the unspent code or its tokens at every
  // moment, and a sweep between the two never finds it holding nothing.
  const { tokens, statements } = await issue(db, agent, newId(), now, true);
  const [spent] = await db.batch([spend, ...statements]);
  if (!spent!.meta.changes) throw await reused();
  return tokens;
}

/**
 * Trades a refresh token for new tokens, and the refresh token is spent. One that is used again after
 * more than `RETRY_MS` was copied by someone, and no one can say which holder is the app, so the
 * authorization ends: every token of it stops, and its agent is disconnected. Used again within that
 * time, or at the same moment as the try that wins, it is refused and nothing else happens: the app
 * may only be retrying after an answer was lost. An agent that is disconnected or expired refreshes nothing.
 */
export async function refreshTokens(db: D1Database, p: { refreshToken: string; clientId: string }, now = Date.now()): Promise<Tokens> {
  if (!(await clientOf(db, p.clientId))) throw new OAuthError("invalid_client", "No app is registered with that client_id", 401);
  const gone = () => grantError("That refresh token isn't one this server made, or it has lapsed");
  if (!p.refreshToken.startsWith(REFRESH_PREFIX) || p.refreshToken.length > 200) throw gone();
  const hash = await hashToken(p.refreshToken);
  const row = await db
    .prepare(
      `SELECT t.agent_id, t.family, t.expires_at, t.used_at, a.client_id, a.revoked_at, a.expires_at AS agent_expires_at
       FROM oauth_tokens t JOIN agents a ON a.id = t.agent_id WHERE t.hash = ? AND t.kind = 'refresh'`,
    )
    .bind(hash)
    .first<{ agent_id: string; family: string; expires_at: number; used_at: number | null; client_id: string | null; revoked_at: number | null; agent_expires_at: number | null }>();
  if (!row) throw gone();
  if (row.used_at !== null) {
    if (now - row.used_at < RETRY_MS) throw grantError("That refresh token was just used. Use the one you were given with the answer");
    await endGrant(db, row.agent_id, now);
    throw grantError("That refresh token was already used, so this authorization has ended. Connect again");
  }
  if (row.client_id !== p.clientId) throw gone();
  if (row.expires_at <= now || row.revoked_at !== null || (row.agent_expires_at !== null && row.agent_expires_at <= now)) throw gone();
  // The spending and the new tokens are one batch, so a spent token always has a successor, and only a try
  // that spends it gets them. Of two at the same moment the other changes nothing and is refused.
  const { tokens, statements } = await issue(db, { id: row.agent_id, expires_at: row.agent_expires_at }, row.family, now, true);
  const [spent] = await db.batch([db.prepare("UPDATE oauth_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL").bind(now, hash), ...statements]);
  if (!spent!.meta.changes) throw grantError("That refresh token was just used. Use the one you were given with the answer");
  return tokens;
}

/**
 * Revokes a token (RFC 7009), which ends the authorization it belongs to: its other tokens stop, and
 * its agent is disconnected. A token that is unknown, spent or lapsed is nothing to revoke, and not an
 * error. An app that names itself can revoke only its own tokens; a token of another is left alone.
 */
export async function revokeToken(db: D1Database, token: string, clientId: string | null = null, now = Date.now()): Promise<void> {
  if ((!token.startsWith(ACCESS_PREFIX) && !token.startsWith(REFRESH_PREFIX)) || token.length > 200) return;
  const row = await db
    .prepare("SELECT t.agent_id, a.client_id FROM oauth_tokens t JOIN agents a ON a.id = t.agent_id WHERE t.hash = ?")
    .bind(await hashToken(token))
    .first<{ agent_id: string; client_id: string | null }>();
  if (row && (clientId === null || row.client_id === clientId)) await endGrant(db, row.agent_id, now);
}
