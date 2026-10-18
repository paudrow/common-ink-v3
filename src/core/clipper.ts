import { TOKEN_PREFIX, hashToken } from "./agents.ts";
import { newId } from "./ids.ts";

/** How often a clipper's "last used" time is rewritten. */
const LAST_USED_EVERY = 10 * 60_000;

export interface ClipperGrant {
  grantId: string;
  personId: string;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * The address Chrome sends a clipper back to after the member allows it. Only that browser's own
 * extension host is accepted, so the token in the fragment cannot be aimed at another site.
 */
export function clipperRedirect(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (!/^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname)) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return `${url.origin}/`;
}

/** Allows the clipper for `personId`. A previous grant stops working. The token is shown only this once. */
export async function connectClipper(db: D1Database, personId: string, now = Date.now()): Promise<{ grantId: string; token: string }> {
  const token = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const grantId = newId();
  await db.prepare("UPDATE clipper_grants SET revoked_at = ? WHERE person_id = ? AND revoked_at IS NULL").bind(now, personId).run();
  await db
    .prepare("INSERT INTO clipper_grants (id, person_id, token_prefix, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(grantId, personId, token.slice(0, TOKEN_PREFIX.length + 4), await hashToken(token), now)
    .run();
  return { grantId, token };
}

/** The member a clipper token stands for, or null when it is unknown, malformed, or revoked. */
export async function authenticateClipper(db: D1Database, token: string, now = Date.now()): Promise<ClipperGrant | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = await db
    .prepare("SELECT id, person_id, last_used_at FROM clipper_grants WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await hashToken(token))
    .first<{ id: string; person_id: string; last_used_at: number | null }>();
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_EVERY) {
    await db.prepare("UPDATE clipper_grants SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return { grantId: row.id, personId: row.person_id };
}
