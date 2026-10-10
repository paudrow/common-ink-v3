const SIGN_IN_SCOPES = ["openid", "email", "profile"];
/** Calendar and contacts, asked for at sign-in so those data sources need no separate setup. */
const DATA_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
];

const GOOGLE_TIMEOUT_MS = 30_000;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export function authorizeUrl(config: GoogleConfig, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [...SIGN_IN_SCOPES, ...DATA_SCOPES].join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export interface Granted {
  email: string;
  name: string;
}

/**
 * Trade the code from Google's redirect for who signed in. The ID token comes straight from Google over
 * TLS in answer to our client secret, so OpenID Connect lets us read it without checking its signature.
 */
export async function exchange(config: GoogleConfig, code: string, redirectUri: string, verifier: string): Promise<Granted> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status})`);
  const token = (await res.json()) as { id_token?: string };
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
  return { email: claims.email.toLowerCase(), name: claims.name ?? claims.email };
}
