import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../../src/core/plugins.ts";
import type { Embed, Plugin, PluginHost } from "../../src/web/plugin-api.ts";
import { adapt, marked, type Reach } from "../../src/web/remote/adapter.tsx";

// The frame focus guard listens to the page from the moment it is read, and there is no page here.
vi.hoisted(() => vi.stubGlobal("document", { addEventListener() {} }));

const installed: InstalledPlugin = {
  id: "plugin000001",
  thirdParty: true,
  manifest: {
    name: "Word counter",
    version: "1",
    capabilities: [],
    commands: [{ id: "count", title: "Count notes" }],
    views: [
      { slot: "inspector", id: "words", label: "Words" },
      { slot: "page", id: "totals", label: "Dashboard" },
    ],
    embeds: [{ name: "timer", title: "Timer", height: 96 }],
    settings: {},
  },
  codeHash: "0".repeat(64),
  installedBy: "Ada",
  installedAt: 1,
  updatedAt: 1,
  permissions: [],
};

const reach: Reach = { record: () => installed, code: async () => "", perform: async () => null, grant: async () => null, refused: () => {} };

/** Everything a plugin registers when it starts, by what it was registered as. */
function registered(plugin: Plugin) {
  const commands: { id: string; title: string }[] = [];
  const views: [slot: string, view: Record<string, unknown>][] = [];
  const embeds: Embed[] = [];
  const host = {
    plugin: { id: plugin.id, name: plugin.name },
    settings: { get: () => undefined, subscribe: () => () => {} },
    commands: { register: (c: { id: string; title: string }) => (commands.push(c), () => {}) },
    views: { register: (slot: string, view: Record<string, unknown>) => (views.push([slot, view]), () => {}) },
    embeds: { register: (e: Embed) => (embeds.push(e), () => {}) },
  } as unknown as PluginHost;
  plugin.activate(host);
  return { commands, views, embeds };
}

describe("an installed plugin, as the app lists what it adds", () => {
  it("says it is a plugin, and whose, wherever its own words would otherwise stand alone: a page's link, an inspector's tab, and an embed in the menu", () => {
    const { commands, views, embeds } = registered(adapt(installed, reach));

    expect(marked("Word counter", "Words")).toBe("Word counter plugin: Words");
    expect(commands.map((c) => [c.id, c.title])).toEqual([["plugin000001.count", "Word counter plugin: Count notes"]]);
    expect(views.map(([slot, view]) => [slot, view.id, view.label])).toEqual([
      ["inspector", "plugin000001.words", "Word counter plugin: Words"],
      ["page", "plugin000001.totals", "Word counter plugin: Dashboard"],
    ]);
    expect(embeds.map((e) => [e.name, e.title])).toEqual([["x-timer", "Word counter plugin: Timer"]]);
  });

  it("never asks for its page to be the one shown at /", () => {
    const { views } = registered(adapt(installed, reach));

    expect(views.filter(([, view]) => "home" in view)).toEqual([]);
  });
});

describe("the embeds that come with the app", () => {
  it("are named in the plugins' own files with no name starting x-, which is where an installed plugin's embeds are", () => {
    const sources = import.meta.glob<string>("../../src/web/plugins/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
    const named = Object.entries(sources).flatMap(([path, source]) => [...source.matchAll(/["'`]x-[^"'`]*["'`]/g)].map((m) => `${path.replace("../../", "")} writes ${m[0]}`));

    expect(Object.keys(sources).length).toBeGreaterThan(30);
    expect(named).toEqual([]);
  });
});
