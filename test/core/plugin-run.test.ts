import { describe, expect, it } from "vitest";
import { Manifest, type DraftSummary, type InstalledPlugin, type Permission } from "../../src/core/plugins.ts";
import { decideRun } from "../../src/web/pluginRun.ts";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const permission = (capability: Permission["capability"], state: Permission["state"], origins: string[] = []): Permission => ({ capability, reason: "Because", origins, state, locked: false, decidedBy: null, voided: false, requests: [] });
const plugin = (capabilities: Permission[]): InstalledPlugin => ({
  id: "plugin000001",
  thirdParty: true,
  manifest: Manifest.parse({ name: "Tally", capabilities: capabilities.map((p) => ({ name: p.capability, reason: p.reason, ...(p.capability === "network" && { origins: p.origins }) })) }),
  codeHash: HASH,
  installedBy: "Ada",
  installedAt: 1,
  updatedAt: 1,
  permissions: capabilities,
});
const draft = (capabilities: object[], more: Partial<DraftSummary> = {}): DraftSummary => ({ pluginId: "plugin000001", manifest: JSON.stringify({ name: "Tally mine", capabilities }), codeHash: OTHER, baseHash: HASH, running: true, updatedAt: 2, ...more });
const asks = (name: string, more: object = {}) => ({ name, reason: "Mine", ...more });
const allowedIn = (run: ReturnType<typeof decideRun>) => run.plugin.permissions.filter((p) => p.state === "allowed").map((p) => [p.capability, p.origins]);

describe("what an installed plugin runs as", () => {
  it("is the workspace's own code, shut off, with no draft or one that isn't running", () => {
    const tally = plugin([permission("notes.read", "allowed")]);
    expect(decideRun(tally, undefined)).toEqual({ as: "sandbox", plugin: tally });
    expect(decideRun(tally, draft([asks("notes.read")], { running: false }))).toEqual({ as: "sandbox", plugin: tally });
  });

  it("runs a draft with what the original is allowed and the draft still asks for, and never more", () => {
    const tally = plugin([permission("notes.read", "allowed"), permission("notes.write", "off"), permission("network", "allowed", ["https://ok.example"])]);
    const run = decideRun(tally, draft([asks("notes.read"), asks("notes.write"), asks("todos.read"), asks("network", { origins: ["https://evil.example"] })]));
    expect(run).toMatchObject({ as: "draft", codeHash: OTHER, plugin: { id: "plugin000001", codeHash: OTHER, manifest: { name: "Tally mine" } } });
    // The sites are the ones an admin allowed the original, whatever the draft lists.
    expect(allowedIn(run)).toEqual([
      ["notes.read", []],
      ["network", ["https://ok.example"]],
    ]);
    expect(run.plugin.permissions.filter((p) => p.state !== "allowed").map((p) => [p.capability, p.state, p.locked])).toEqual([
      ["notes.write", "off", true],
      ["todos.read", "off", true],
    ]);
    expect(allowedIn(decideRun(tally, draft([])))).toEqual([]);
  });

  it("runs nothing of a draft whose manifest isn't one, the original included, and says why", () => {
    const tally = plugin([permission("notes.read", "allowed")]);
    expect(decideRun(tally, draft([], { manifest: "{ not json" }))).toEqual({ as: "refused", plugin: tally, why: "Your draft's manifest can't be read, so it isn't running: The manifest isn't JSON" });
    expect(decideRun(tally, draft([asks("full-trust")]))).toMatchObject({ as: "refused", plugin: tally });
    expect(decideRun(tally, draft([], { manifest: JSON.stringify({ name: "Tabs and splits" }) }))).toMatchObject({ as: "refused", plugin: tally });
  });
});
