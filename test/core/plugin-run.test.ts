import { describe, expect, it } from "vitest";
import { Manifest, type DraftSummary, type FullTrust, type InstalledPlugin, type Permission } from "../../src/core/plugins.ts";
import { CHANGED_SINCE_GRANT, DRAFT_FULL_TRUST, NOT_GRANTED, NOT_TURNED_ON, OWN_RECORDS, decideRun, whyNotTrusted } from "../../src/web/pluginRun.ts";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const permission = (capability: Permission["capability"], state: Permission["state"], origins: string[] = []): Permission => ({ capability, reason: "Because", origins, state, locked: false, decidedBy: null, decidedVia: null, voided: false, requests: [] });
const plugin = (capabilities: Permission[], fullTrust: FullTrust | null = null): InstalledPlugin => ({
  id: "plugin000001",
  thirdParty: true,
  manifest: Manifest.parse({ name: "Tally", capabilities: capabilities.map((p) => ({ name: p.capability, reason: p.reason, ...(p.capability === "network" && { origins: p.origins }) })) }),
  codeHash: HASH,
  fullTrust,
  installedBy: "Ada",
  installedVia: null,
  updatedBy: null,
  updatedVia: null,
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
    expect(decideRun(tally, draft([asks("full-trust")]))).toEqual({ as: "refused", plugin: tally, why: DRAFT_FULL_TRUST });
    expect(decideRun(tally, draft([], { manifest: JSON.stringify({ name: "Tabs and splits" }) }))).toMatchObject({ as: "refused", plugin: tally });
  });
});

describe("what a plugin that asks for full trust runs as", () => {
  const trust = (more: Partial<FullTrust> = {}): FullTrust => ({ grantedHash: HASH, changedSince: false, on: true, turnedOnBy: null, ...more });
  const deep = (fullTrust: FullTrust | null, more: Permission[] = []) => plugin([permission("full-trust", fullTrust?.grantedHash ? "allowed" : "off"), ...more], fullTrust);

  it("is in the page only with an admin's grant of the code it is now and the member's own turning it on", () => {
    expect(decideRun(deep(trust()), undefined)).toEqual({ as: "full-trust", plugin: deep(trust()), grantedHash: HASH });
    expect(whyNotTrusted(deep(trust()))).toBeNull();
  });

  it("is nowhere otherwise, with one line that says which of the two is missing, and none of it runs shut off instead", () => {
    const cases: [FullTrust | null, string][] = [
      [trust({ grantedHash: null, on: false }), NOT_GRANTED],
      [trust({ grantedHash: null, on: true }), NOT_GRANTED],
      [trust({ grantedHash: null, changedSince: true, on: false }), CHANGED_SINCE_GRANT],
      [trust({ on: false }), NOT_TURNED_ON],
      // A grant of other code than the record says the plugin is, whatever else the record says.
      [trust({ grantedHash: OTHER }), NOT_GRANTED],
      // A record that says nothing of full trust for a plugin that asks for it, as an agent's would.
      [null, NOT_GRANTED],
    ];
    for (const [state, why] of cases) {
      const asking = deep(state, [permission("notes.read", "allowed")]);
      expect(decideRun(asking, undefined), why).toEqual({ as: "refused", plugin: asking, why });
      expect(whyNotTrusted(asking)).toBe(why);
    }
    expect(whyNotTrusted(plugin([permission("notes.read", "allowed")]))).toBeNull();
  });

  it("never runs a draft that asks for it, of a plugin that has it or of one that doesn't, and runs a draft that doesn't ask shut off without it", () => {
    const granted = deep(trust(), [permission("notes.read", "allowed")]);
    for (const original of [granted, plugin([permission("notes.read", "allowed")])]) {
      expect(decideRun(original, draft([asks("notes.read"), asks("full-trust")]))).toEqual({ as: "refused", plugin: original, why: DRAFT_FULL_TRUST });
    }
    const mine = decideRun(granted, draft([asks("notes.read")]));
    expect(mine).toMatchObject({ as: "draft", plugin: { fullTrust: null } });
    expect(allowedIn(mine)).toEqual([["notes.read", []]]);
    // And one that isn't running leaves the original as it is.
    expect(decideRun(granted, draft([asks("full-trust")], { running: false })).as).toBe("full-trust");
  });
});

describe("what one of Common Ink's own that runs shut off runs as", () => {
  it("is the app's own code with what its manifest declares, allowed from the start and decided by nobody", () => {
    expect(OWN_RECORDS.map((p) => [p.id, p.thirdParty, p.codeHash, p.permissions.map((perm) => [perm.capability, perm.state, perm.locked])])).toEqual([
      ["word-count", false, null, [["notes.read", "allowed", true]]],
      ["quick-timer", false, null, []],
      ["weather", false, null, [["network", "allowed", true]]],
      ["sample-calendar", false, null, []],
      ["coin", false, null, []],
      ["dice", false, null, []],
    ]);
    for (const own of OWN_RECORDS) expect(decideRun(own, undefined)).toEqual({ as: "sandbox", plugin: own });
  });

  it("runs a member's copy under the name it had, with what the original declares and the copy still asks for, and never more", () => {
    const timer = OWN_RECORDS.find((p) => p.id === "quick-timer")!;
    const count = OWN_RECORDS.find((p) => p.id === "word-count")!;
    const mine = (name: string, capabilities: object[]): DraftSummary => ({ pluginId: "x", manifest: JSON.stringify({ name, capabilities }), codeHash: OTHER, baseHash: null, running: true, updatedAt: 2 });

    const grabby = decideRun(timer, mine("Quick timer", [asks("notes.read"), asks("notes.write"), asks("network", { origins: ["https://evil.example"] })]));
    expect(grabby.as).toBe("draft");
    expect(allowedIn(grabby)).toEqual([]);
    // Its code has a name now, which is how the app tells a copy from what it came with.
    expect(grabby.plugin).toMatchObject({ thirdParty: false, codeHash: OTHER });
    expect(allowedIn(decideRun(count, mine("Word count", [asks("notes.read"), asks("members.read")])))).toEqual([["notes.read", []]]);
    // The name is the app's own only for a copy of the app's own.
    expect(decideRun(plugin([]), mine("Word count", []))).toMatchObject({ as: "refused" });
  });
});
