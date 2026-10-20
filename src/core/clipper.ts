import { TOKEN_PREFIX, hashToken } from "./agents.ts";
import { newId } from "./ids.ts";
import type { ClipperGrantView } from "./protocol.ts";

/** How often a clipper's "last used" time is rewritten. */
const LAST_USED_EVERY = 10 * 60_000;
/** How long a clipper stays signed in before the member allows it again. */
export const CLIPPER_DAYS = 90;
const CLIPPER_MS = CLIPPER_DAYS * 24 * 60 * 60_000;

/** The MCP tools the clipper calls. A clipper token reaches nothing else. */
export const CLIPPER_TOOLS: ReadonlySet<string> = new Set(["list_workspaces", "list_folders", "create_note"]);

export interface ClipperGrant {
  grantId: string;
  personId: string;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const EXTENSION_ID = /^[a-p]{32}$/;

/** The extension ids allowed to sign in, from `CLIPPER_EXTENSION_IDS`: separated by commas, anything that is not an id left out. */
export const clipperExtensionIds = (setting: string | undefined): string[] =>
  (setting ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => EXTENSION_ID.test(id));

/**
 * The address Chrome sends a clipper back to after the member allows it, and the extension it is
 * for. Only the return address of an extension in `allowed` is accepted, so the token in the
 * fragment reaches neither another site nor another extension.
 */
export function clipperRedirect(value: string | null, allowed: readonly string[]): { redirect: string; extensionId: string } | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  const extensionId = /^([a-p]{32})\.chromiumapp\.org$/.exec(url.hostname)?.[1];
  if (!extensionId || !allowed.includes(extensionId)) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return { redirect: `${url.origin}/`, extensionId };
}

/**
 * Allows the clipper for the person of `session`. A previous grant stops working. The token is shown only
 * this once. The grant holds the sign-out count of the session that allowed it, so it ends when the person
 * is signed out everywhere, by themselves or by an admin, as their browser sessions do. Null, and nothing
 * written, when they were signed out everywhere after that session began, however close to now.
 */
export async function connectClipper(db: D1Database, session: { personId: string; ended: number }, extensionId: string, now = Date.now()): Promise<{ grantId: string; token: string } | null> {
  const { personId, ended } = session;
  const token = TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const grantId = newId();
  const [, made] = await db.batch([
    db
      .prepare("UPDATE clipper_grants SET revoked_at = ?1 WHERE person_id = ?2 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM people WHERE id = ?2 AND sessions_ended = ?3)")
      .bind(now, personId, ended),
    db
      .prepare(
        `INSERT INTO clipper_grants (id, person_id, token_prefix, token_hash, extension_id, created_at, expires_at, sessions_ended)
           SELECT ?, id, ?, ?, ?, ?, ?, sessions_ended FROM people WHERE id = ? AND sessions_ended = ?`,
      )
      .bind(grantId, token.slice(0, TOKEN_PREFIX.length + 4), await hashToken(token), extensionId, now, now + CLIPPER_MS, personId, ended),
  ]);
  return made!.meta.changes ? { grantId, token } : null;
}

/** What makes a grant work: not revoked, not past its time, and the person not signed out everywhere since. */
const LIVE = "g.revoked_at IS NULL AND g.expires_at > ? AND g.sessions_ended = (SELECT sessions_ended FROM people p WHERE p.id = g.person_id)";

/** The member a clipper token stands for, or null when it is unknown, malformed, revoked, past its time, or signed out everywhere since. */
export async function authenticateClipper(db: D1Database, token: string, now = Date.now()): Promise<ClipperGrant | null> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = await db
    .prepare(`SELECT g.id, g.person_id, g.last_used_at FROM clipper_grants g WHERE g.token_hash = ? AND ${LIVE}`)
    .bind(await hashToken(token), now)
    .first<{ id: string; person_id: string; last_used_at: number | null }>();
  if (!row) return null;
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_EVERY) {
    await db.prepare("UPDATE clipper_grants SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }
  return { grantId: row.id, personId: row.person_id };
}

/** The member's own clipper grants that still work. */
export async function listClipperGrants(db: D1Database, personId: string, now = Date.now()): Promise<ClipperGrantView[]> {
  const { results } = await db
    .prepare(`SELECT g.id, g.extension_id, g.created_at, g.last_used_at, g.expires_at FROM clipper_grants g WHERE g.person_id = ? AND ${LIVE} ORDER BY g.created_at DESC`)
    .bind(personId, now)
    .all<{ id: string; extension_id: string; created_at: number; last_used_at: number | null; expires_at: number }>();
  return results.map((row) => ({ id: row.id, extensionId: row.extension_id, createdAt: row.created_at, lastUsedAt: row.last_used_at, expiresAt: row.expires_at }));
}

/** Ends one of the member's own clipper grants. False when they have no such grant, someone else's included. */
export async function revokeClipperGrant(db: D1Database, personId: string, grantId: string, now = Date.now()): Promise<boolean> {
  const done = await db.prepare("UPDATE clipper_grants SET revoked_at = ? WHERE id = ? AND person_id = ? AND revoked_at IS NULL").bind(now, grantId, personId).run();
  return done.meta.changes > 0;
}
