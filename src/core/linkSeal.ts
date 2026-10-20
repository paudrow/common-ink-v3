// A share link's token, as the database keeps it: looked up by its hash, and kept sealed so the
// sharing dialog can show the address again. Whoever reads the database, or a backup of it, has
// neither an address that opens anything nor a way to make one.
//
// The key is the Worker's: src/worker/index.ts hands it here before it answers anything, from
// SESSION_SECRET, which every deployment has and the database never holds. Tests hand it a key of
// their own in test/core/setup.ts.

import { hashToken } from "./agents.ts";
import { OpError } from "./protocol.ts";

export interface Sealer {
  seal(plain: string, boundTo: string): Promise<string>;
  open(sealed: string | null, boundTo: string): Promise<string | null>;
}

let sealer: Sealer | null = null;

/** The key links are sealed under from now on, in this isolate. */
export function sealLinksWith(next: Sealer): void {
  sealer = next;
}

/** A sealed value is bound to its grant, so one copied onto another grant opens as nothing. */
const boundTo = (grantId: string) => `share-link:${grantId}`;
/** What vault.ts writes. A token kept before links were sealed is 43 characters of base64url, with no dot. */
const SEALED = /^v1\./;

export const linkHash = hashToken;

/** `token` sealed for the grant `grantId`. Refused where there is no key, so no link is ever kept in the clear. */
export async function sealedLink(grantId: string, token: string): Promise<string> {
  if (!sealer) throw new OpError("unavailable", "Links can't be made here: SESSION_SECRET is shorter than 32 characters");
  return sealer.seal(token, boundTo(grantId));
}

/** The token a grant keeps, opened. One kept before links were sealed is as it was, until `sealOldLinks` comes to it. */
export async function openedLink(grantId: string, kept: string): Promise<string | null> {
  if (!SEALED.test(kept)) return kept;
  return sealer ? sealer.open(kept, boundTo(grantId)) : null;
}

/**
 * Seals the links kept in the clear before links were sealed, up to `limit` of them, and answers how
 * many. A link keeps its address: only how it is kept changes. Run again, it does the rest.
 */
export async function sealOldLinks(db: D1Database, limit = 500): Promise<number> {
  if (!sealer) return 0;
  const { results } = await db.prepare("SELECT id, token FROM grants WHERE token_hash IS NULL AND kind <> 'person' LIMIT ?").bind(limit).all<{ id: string; token: string }>();
  const old = results.filter((row) => !SEALED.test(row.token));
  if (!old.length) return 0;
  await db.batch(
    await Promise.all(
      old.map(async (row) => db.prepare("UPDATE grants SET token = ?, token_hash = ? WHERE id = ? AND token = ?").bind(await sealedLink(row.id, row.token), await linkHash(row.token), row.id, row.token)),
    ),
  );
  return old.length;
}
