import { describe, expect, it } from "vitest";
import type { InstalledPlugin, Permission, PluginRecord } from "../../src/core/plugins.ts";
import type { PluginState } from "../../src/web/pluginHost.ts";
import { listPlugins, matchesPlugin, waitingOn } from "../../src/web/pluginList.ts";

const state = (id: string, name: string, more: Partial<PluginState> = {}): PluginState => ({ id, name, enabled: true, required: false, builtIn: true, error: null, installed: false, description: null, icon: null, screenshots: [], adds: null, ...more });
const permission = (askedBy: string[]): Permission => ({ capability: "notes.read", reason: "To count", origins: [], state: "off", locked: false, decidedBy: null, voided: false, requests: askedBy.map((id) => ({ by: { id, name: id }, at: 1, origins: [] })) });
const installed = (id: string, name: string, more: Partial<InstalledPlugin> = {}, manifest: object = {}): InstalledPlugin => ({
  id,
  thirdParty: true,
  manifest: { name, version: "1", capabilities: [], commands: [], views: [], embeds: [], settings: {}, ...manifest },
  codeHash: "abc",
  installedBy: "Ada",
  installedAt: 1,
  updatedAt: 1,
  permissions: [],
  ...more,
});

const STATES = [
  state("core", "Common Ink", { required: true }),
  state("tabs", "Tabs and splits", { description: "Open notes in tabs, and side by side in splits.", icon: "tabs" }),
  state("html", "HTML embeds", { enabled: false }),
  state("p1", "Word counter", { installed: true, enabled: false }),
];
const RECORD: PluginRecord = {
  canManage: true,
  plugins: [
    installed("html", "HTML embeds", { thirdParty: false, codeHash: null }),
    installed("p1", "Word counter", { permissions: [permission(["mel", "sam"]), { ...permission(["mel"]), capability: "todos.read" }] }, { description: "Counts the words in a note." }),
    installed("p2", "Not started yet"),
  ],
};

describe("the Plugins page's list", () => {
  it("lists the built-ins a member can turn off, then the workspace's plugins from its record, each with its own words and picture", () => {
    expect(listPlugins(STATES, RECORD).map((p) => [p.id, p.name, p.kind, p.icon, p.description, p.state?.enabled ?? null, p.record?.id ?? null])).toEqual([
      ["tabs", "Tabs and splits", "built-in", "tabs", "Open notes in tabs, and side by side in splits.", true, null],
      ["html", "HTML embeds", "built-in", "plugin", null, false, "html"],
      ["p1", "Word counter", "third-party", "plugin", "Counts the words in a note.", false, "p1"],
      ["p2", "Not started yet", "third-party", "plugin", null, null, "p2"],
    ]);
  });

  it("lists the built-ins alone until the record has been read, and leaves out one the record no longer has", () => {
    expect(listPlugins(STATES, null).map((p) => p.id)).toEqual(["tabs", "html"]);
    expect(listPlugins(STATES, { canManage: false, plugins: [] }).map((p) => p.id)).toEqual(["tabs", "html"]);
  });

  it("finds a plugin by its name, its description, or whether it is built in", () => {
    const found = (typed: string) => listPlugins(STATES, RECORD).filter((p) => matchesPlugin(p, typed)).map((p) => p.id);

    expect(found("  ")).toEqual(["tabs", "html", "p1", "p2"]);
    expect(found("SPLITS")).toEqual(["tabs"]);
    expect(found("counts the")).toEqual(["p1"]);
    expect(found("third-party")).toEqual(["p1", "p2"]);
    expect(found("built-in")).toEqual(["tabs", "html"]);
    expect(found("nothing like it")).toEqual([]);
  });

  it("counts the members waiting on an admin once each, however much each asked for", () => {
    const [, , counter, quiet] = listPlugins(STATES, RECORD);

    expect(waitingOn(counter!)).toBe(2);
    expect(waitingOn(quiet!)).toBe(0);
  });
});
