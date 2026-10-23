// Counts of usage, written to Workers Analytics Engine (the USAGE dataset in wrangler.jsonc). The dev server,
// Previews and the built Worker CI tests run have no USAGE, and count nothing.

import type { Counter, Usage } from "../core/usage.ts";

/**
 * Where each part of a count is in a data point, which usage-query.ts reads by the same names. Analytics
 * Engine keeps the time it was written. The index is what Analytics Engine samples by, so a workspace's
 * counts are kept or sampled together.
 */
export const COLUMNS = { workspace: "index1", event: "blob1", kind: "blob2", detail: "blob3", member: "blob4", count: "double1" } as const;

/** Said in place of a workspace for what is no workspace's, such as signing in. */
export const NO_WORKSPACE = "-";

let keyed: { secret: string; key: Promise<CryptoKey> } | null = null;

/** The key members are hashed under: SESSION_SECRET's, for this use alone, so no hash here is a session's or a link's. */
function memberKey(secret: string): Promise<CryptoKey> {
  if (keyed?.secret !== secret) {
    const key = crypto.subtle.importKey("raw", new TextEncoder().encode(`usage-member:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyed = { secret, key };
  }
  return keyed.key;
}

/** Who did something, as the counts say: the same for one person each time, and nothing anyone without SESSION_SECRET can turn back into them. */
export async function memberHash(secret: string, personId: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await memberKey(secret), new TextEncoder().encode(personId)));
  return [...mac.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The data point a count is written as. */
export async function dataPoint(secret: string, usage: Usage): Promise<AnalyticsEngineDataPoint> {
  return {
    indexes: [usage.workspaceId ?? NO_WORKSPACE],
    blobs: [usage.event, usage.kind, usage.detail ?? "", usage.personId ? await memberHash(secret, usage.personId) : ""],
    doubles: [usage.count ?? 1],
  };
}

/** Where this Worker's counts go, or null where it has no USAGE dataset. */
export function usageCounter(env: { USAGE?: AnalyticsEngineDataset; SESSION_SECRET?: string }): Counter | null {
  const { USAGE: dataset, SESSION_SECRET: secret } = env;
  if (!dataset || !secret) return null;
  return { count: async (usage) => dataset.writeDataPoint(await dataPoint(secret, usage)) };
}
