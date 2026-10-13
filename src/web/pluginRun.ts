import { readManifest, type DraftSummary, type InstalledPlugin, type Permission } from "../core/plugins.ts";

/*
 * What each installed plugin runs as, for this member, now. It is decided here, in one place, from
 * the workspace's record and the member's own drafts: nothing a plugin says of itself is part of
 * it. It is pure, and `pluginRuntime.ts` makes plugins of its answers.
 */

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
  const read = readManifest(draft.manifest);
  if ("reason" in read) return { as: "refused", plugin: original, why: `Your draft's manifest can't be read, so it isn't running: ${read.reason}` };
  // Never more than the original is allowed: a capability the draft adds, or one the original has that is off, is off.
  const allowed = (capability: string) => original.permissions.find((p) => p.capability === capability && p.state === "allowed");
  const permissions = read.manifest.capabilities.map((c): Permission => allowed(c.name) ?? { capability: c.name, reason: c.reason, origins: [], state: "off", locked: true, decidedBy: null, voided: false, requests: [] });
  return { as: "draft", codeHash: draft.codeHash, plugin: { ...original, manifest: read.manifest, codeHash: draft.codeHash, permissions } };
}
