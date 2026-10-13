import { describe, expect, it } from "vitest";
import type { PluginState } from "../../src/web/pluginHost.ts";
import { listPlugins, matchesPlugin } from "../../src/web/pluginList.ts";

const state = (id: string, name: string, more: Partial<PluginState> = {}): PluginState => ({ id, name, enabled: true, required: false, builtIn: true, error: null, description: null, icon: null, screenshots: [], adds: null, ...more });

const STATES = [
  state("core", "Common Ink", { required: true }),
  state("tabs", "Tabs and splits", { description: "Open notes in tabs, and side by side in splits.", icon: "tabs" }),
  state("stopwatch", "Stopwatch", { enabled: false }),
];

describe("the Plugins page's list", () => {
  it("lists the plugins a member can turn off, each with its own words and picture", () => {
    expect(listPlugins(STATES).map((p) => [p.id, p.name, p.icon, p.description, p.state.enabled])).toEqual([
      ["tabs", "Tabs and splits", "tabs", "Open notes in tabs, and side by side in splits.", true],
      ["stopwatch", "Stopwatch", "plugin", null, false],
    ]);
  });

  it("finds a plugin by its name or its description", () => {
    const found = (typed: string) => listPlugins(STATES).filter((p) => matchesPlugin(p, typed)).map((p) => p.id);

    expect(found("  ")).toEqual(["tabs", "stopwatch"]);
    expect(found("SPLITS")).toEqual(["tabs"]);
    expect(found("side by side")).toEqual(["tabs"]);
    expect(found("nothing like it")).toEqual([]);
  });
});
