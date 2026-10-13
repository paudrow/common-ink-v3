import { OWN_SANDBOXED, OWN_SANDBOXED_IDS } from "../core/ownPlugins.ts";
import { readManifest, type DraftSummary, type InstalledPlugin, type Manifest, type Permission } from "../core/plugins.ts";

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
  /** Not at all, and why, in words for the member. */
  | { as: "refused"; plugin: InstalledPlugin; why: string };

/** What `original` runs as for the member whose draft of it, if they have one, is `draft`. */
export function decideRun(original: InstalledPlugin, draft: DraftSummary | undefined): Run {
  if (!draft?.running) return { as: "sandbox", plugin: original };
  // A copy of one of the app's own may keep its name: it runs in that plugin's place, for its author alone.
  const read = readManifest(draft.manifest, !original.thirdParty);
  if ("reason" in read) return { as: "refused", plugin: original, why: `Your draft's manifest can't be read, so it isn't running: ${read.reason}` };
  // Never more than the original is allowed: a capability the draft adds, or one the original has that is off, is off.
  const allowed = (capability: string) => original.permissions.find((p) => p.capability === capability && p.state === "allowed");
  const permissions = read.manifest.capabilities.map((c): Permission => allowed(c.name) ?? { capability: c.name, reason: c.reason, origins: [], state: "off", locked: true, decidedBy: null, voided: false, requests: [] });
  return { as: "draft", codeHash: draft.codeHash, plugin: { ...original, manifest: read.manifest, codeHash: draft.codeHash, permissions } };
}
