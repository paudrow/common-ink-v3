import { OWN_SANDBOXED, OWN_SANDBOXED_IDS } from "../core/ownPlugins.ts";
import { FULL_TRUST, asksFullTrust, readManifest, type DraftSummary, type InstalledPlugin, type Manifest, type Permission } from "../core/plugins.ts";

/*
 * What each plugin that isn't compiled into the app runs as, for this member, now. It is decided here, in one place, from
 * the workspace's record and the member's own drafts: nothing a plugin says of itself is part of
 * it. It is pure, and `pluginRuntime.ts` makes plugins of its answers.
 */

/** A plugin of Common Ink's own that runs shut off, as the record would tell of it: what it declares is allowed, since it comes with the app. Its code has no name, which is how the app's own is told from a copy of it. */
export const ownRecord = (id: string, manifest: Manifest): InstalledPlugin => ({
  id,
  thirdParty: false,
  manifest,
  codeHash: null,
  fullTrust: null,
  installedBy: null,
  installedAt: null,
  updatedAt: null,
  permissions: manifest.capabilities.map((c): Permission => ({ capability: c.name, reason: c.reason, origins: c.origins ?? [], state: "allowed", locked: true, decidedBy: null, voided: false, requests: [] })),
});

export const OWN_RECORDS: readonly InstalledPlugin[] = OWN_SANDBOXED_IDS.map((id) => ownRecord(id, OWN_SANDBOXED[id]));

export type Run =
  /** Shut off, in frames, as the record has it. */
  | { as: "sandbox"; plugin: InstalledPlugin }
  /** The member's own draft, shut off, with what the original is allowed and the draft still asks for. */
  | { as: "draft"; plugin: InstalledPlugin; codeHash: string }
  /** In the page, once the app has itself found the code to be the code named here. */
  | { as: "full-trust"; plugin: InstalledPlugin; grantedHash: string }
  /** Not at all, and why, in words for the member. */
  | { as: "refused"; plugin: InstalledPlugin; why: string };

export const NOT_GRANTED = "It isn't running: no admin has granted it full trust.";
export const CHANGED_SINCE_GRANT = "It isn't running: its code changed since an admin granted it full trust.";
export const NOT_TURNED_ON = "It isn't running for you: an admin granted it full trust, and you haven't turned it on.";
export const DRAFT_FULL_TRUST = "Your draft asks for full trust, so it isn't running. Full trust is granted by an admin to the exact code they read: publish the draft and have that code granted.";
export const WRONG_CODE = "It isn't running: the code the server sent isn't the code that was granted full trust.";

/**
 * Why a plugin that asks for full trust isn't running for whoever the record was read for, in one
 * line, or null when both things it runs by hold: the grant is of the code it is now, and they
 * turned it on. Null too for a plugin that doesn't ask.
 */
export function whyNotTrusted(plugin: InstalledPlugin): string | null {
  if (!asksFullTrust(plugin.manifest)) return null;
  const trust = plugin.fullTrust;
  if (!trust || trust.grantedHash === null || trust.grantedHash !== plugin.codeHash) return trust?.changedSince ? CHANGED_SINCE_GRANT : NOT_GRANTED;
  return trust.on ? null : NOT_TURNED_ON;
}

/** What `original` runs as for the member whose draft of it, if they have one, is `draft`. */
export function decideRun(original: InstalledPlugin, draft: DraftSummary | undefined): Run {
  if (draft?.running) {
    // A copy of one of the app's own may keep its name: it runs in that plugin's place, for its author alone.
    const read = readManifest(draft.manifest, !original.thirdParty);
    if ("reason" in read) return { as: "refused", plugin: original, why: `Your draft's manifest can't be read, so it isn't running: ${read.reason}` };
    // No admin read a draft's code, so it is never in the page, and none of it runs shut off instead.
    if (asksFullTrust(read.manifest)) return { as: "refused", plugin: original, why: DRAFT_FULL_TRUST };
    // Never more than the original is allowed: a capability the draft adds, or one the original has that is off, is off. Full trust is not a reach a frame can have.
    const allowed = (capability: string) => original.permissions.find((p) => p.capability === capability && p.state === "allowed" && capability !== FULL_TRUST);
    const permissions = read.manifest.capabilities.map((c): Permission => allowed(c.name) ?? { capability: c.name, reason: c.reason, origins: [], state: "off", locked: true, decidedBy: null, voided: false, requests: [] });
    return { as: "draft", codeHash: draft.codeHash, plugin: { ...original, manifest: read.manifest, codeHash: draft.codeHash, fullTrust: null, permissions } };
  }
  if (!asksFullTrust(original.manifest)) return { as: "sandbox", plugin: original };
  // In the page or nowhere: one that isn't granted and turned on runs no part of itself shut off.
  const why = whyNotTrusted(original);
  return why === null ? { as: "full-trust", plugin: original, grantedHash: original.fullTrust!.grantedHash! } : { as: "refused", plugin: original, why };
}
