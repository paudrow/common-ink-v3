const SIGN_IN_SCOPES = ["openid", "email", "profile"];

/** What each Google data source needs agreed to. A source is connected only while every one of its scopes is. */
export const SOURCE_SCOPES = {
  "google-calendar": ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
  "google-contacts": ["https://www.googleapis.com/auth/contacts.readonly"],
} as const;
export type GoogleSourceId = keyof typeof SOURCE_SCOPES;
export const isGoogleSource = (id: string): id is GoogleSourceId => Object.hasOwn(SOURCE_SCOPES, id);

/**
 * What lets Common Ink change a data source whose scopes only read it. It reads it too. It is asked
 * for only when the member asks to edit, so nobody agrees to more than they use.
 */
export const WRITE_SCOPES: Partial<Record<GoogleSourceId, string>> = { "google-contacts": "https://www.googleapis.com/auth/contacts" };

/** Whether what was agreed to lets Common Ink change a data source, beyond reading it. */
export const writes = (id: GoogleSourceId, scopes: readonly string[]) => WRITE_SCOPES[id] !== undefined && scopes.includes(WRITE_SCOPES[id]);

/** Whether what was agreed to covers a data source: every scope it needs, or the one that changes it as well. */
export const covers = (id: GoogleSourceId, scopes: readonly string[]) => SOURCE_SCOPES[id].every((scope) => scopes.includes(scope)) || writes(id, scopes);

/** Calendar and contacts, asked for at sign-in so those data sources need no separate setup. */
export const DATA_SCOPES: readonly string[] = Object.values(SOURCE_SCOPES).flat();

/** Every scope that reaches into a person's data, read or changed. */
export const REACHING_SCOPES: readonly string[] = [...DATA_SCOPES, ...Object.values(WRITE_SCOPES)];

const GOOGLE_TIMEOUT_MS = 30_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Why Google is being asked. Signing in asks who the person is and lets them pick an account. It
 * asks for every data source as well only when `sources` says this Common Ink can keep what comes
 * back: nobody is asked for their calendar by a deployment that would throw the answer away.
 * Connecting asks for the data sources named, as the account already signed in, and makes Google
 * show what is being agreed to: only then does it hand back a refresh token for an account that
 * has agreed before.
 */
export type Asking = { for: "sign-in"; sources: boolean } | { for: "connect"; email: string; sources: readonly GoogleSourceId[]; edit?: boolean };

export function authorizeUrl(config: GoogleConfig, redirectUri: string, state: string, challenge: string, asking: Asking): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...SIGN_IN_SCOPES, ...(asking.for === "connect" ? asking.sources.flatMap((id) => [...SOURCE_SCOPES[id], ...(asking.edit && WRITE_SCOPES[id] ? [WRITE_SCOPES[id]] : [])]) : asking.sources ? DATA_SCOPES : [])].join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    // Without this Google gives a token that lasts an hour and no way to get another.
    ...(asking.for === "connect" || asking.sources ? { access_type: "offline" } : {}),
    ...(asking.for === "connect" ? { prompt: "consent", login_hint: asking.email } : { prompt: "select_account" }),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** What Google hands over for a person. Never logged, never sent to a browser, and kept only sealed. */
export interface GoogleTokens {
  accessToken: string;
  /** Absent when Google gave none: it does only the first time an account agrees, or when asked to show what is agreed to. */
  refreshToken: string | null;
  expiresAt: number;
  /** What the person agreed to, which may be less than was asked: Google lets them untick each one. */
  scopes: string[];
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

const tokensOf = (answer: TokenAnswer, now: number): GoogleTokens | null =>
  typeof answer.access_token === "string" && answer.access_token
    ? { accessToken: answer.access_token, refreshToken: answer.refresh_token || null, expiresAt: now + (Number(answer.expires_in) || 0) * 1000, scopes: (answer.scope ?? "").split(/\s+/).filter(Boolean) }
    : null;

export interface Granted {
  email: string;
  name: string;
  tokens: GoogleTokens | null;
}

/**
 * Trade the code from Google's redirect for who signed in. The ID token comes straight from Google over
 * TLS in answer to our client secret, so OpenID Connect lets us read it without checking its signature.
 */
export async function exchange(config: GoogleConfig, code: string, redirectUri: string, verifier: string, outbound: typeof fetch = fetch, now = Date.now()): Promise<Granted> {
  const res = await outbound(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status})`);
  const token = (await res.json()) as TokenAnswer;
  const payload = (token.id_token ?? "").split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "";
  const claims = JSON.parse(payload ? new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))) : "{}") as {
    aud?: string;
    iss?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  if (claims.aud !== config.clientId || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "")) throw new Error("Google's answer wasn't for this app");
  if (!claims.email || claims.email_verified !== true) throw new Error("Google didn't confirm an email address");
  return { email: claims.email.toLowerCase(), name: claims.name ?? claims.email, tokens: tokensOf(token, now) };
}

/**
 * A new access token for a refresh token. Null when Google no longer takes the refresh token: the
 * person took the access away, or it lapsed. Anything else that goes wrong throws, and says nothing
 * about the grant.
 */
export async function refresh(config: GoogleConfig, refreshToken: string, outbound: typeof fetch = fetch, now = Date.now()): Promise<GoogleTokens | null> {
  const res = await outbound(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  if (res.status === 400 || res.status === 401) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    if (error === "invalid_grant") return null;
  }
  if (!res.ok) throw new Error(`Google didn't renew access (${res.status})`);
  const tokens = tokensOf((await res.json()) as TokenAnswer, now);
  if (!tokens) throw new Error("Google renewed access with no token");
  return tokens;
}

/** Ends everything the person agreed to for this app. True when Google says it is ended, or that the token was already worth nothing. */
export async function revoke(token: string, outbound: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await outbound(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}
