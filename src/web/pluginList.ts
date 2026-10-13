import type { MouseEvent } from "react";
import { ownSandboxed } from "../core/ownPlugins.ts";
import type { InstalledPlugin, Manifest, PluginRecord } from "../core/plugins.ts";
import type { IconName } from "./icons.tsx";
import type { PluginState } from "./pluginHost.ts";

export const PLUGINS_PATH = "/plugins";

/** A link to an address in the app, which a plain click follows without loading the app again. */
export const within = (go: (path: string) => void, path: string) => ({
  href: path,
  onClick: (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(path);
  },
});

/** One plugin as the Plugins page lists it, whichever kind it is. */
export interface Listed {
  id: string;
  name: string;
  /** One line on what it is for. Null for one that says nothing of itself. */
  description: string | null;
  icon: IconName;
  kind: "built-in" | "third-party";
  /** The plugin as the app runs it. Null for an installed one the app hasn't made a plugin of yet. */
  state: PluginState | null;
  /** What the workspace's record says of it: every third-party plugin has one, and of the built-ins only HTML embeds. */
  record: InstalledPlugin | null;
  /** For one of Common Ink's own that runs shut off from the app: the manifest it declares itself in. Null for one compiled into the app, which runs inside it. */
  own: Manifest | null;
}

/** What kind a plugin is, and for one that comes with the app where it runs: inside the app with everything the member has, or shut off from it with what its manifest declares. */
export const kindLabel = (plugin: Pick<Listed, "kind" | "own">): string => (plugin.kind === "third-party" ? "Third-party" : plugin.own ? "Built-in, sandboxed" : "Built-in, full access");

/**
 * Every plugin a member can turn on or off: the ones that come with the app, in their order, then
 * the ones the workspace installed. A third-party plugin is listed from the record, so its words
 * are the manifest's whether or not it is running.
 */
export function listPlugins(states: readonly PluginState[], record: PluginRecord | null): Listed[] {
  const builtIn = states
    .filter((state) => !state.required && !state.installed)
    .map((state): Listed => ({
      id: state.id,
      name: state.name,
      description: state.description,
      icon: state.icon ?? "plugin",
      kind: "built-in",
      state,
      record: record?.plugins.find((p) => !p.thirdParty && p.id === state.id) ?? null,
      // Said of a plugin the host says came with the app, so no installed plugin is shown as sandboxed built-in by an id it chose.
      own: state.builtIn ? ownSandboxed(state.id) : null,
    }));
  const thirdParty = (record?.plugins ?? [])
    .filter((p) => p.thirdParty)
    .map((p): Listed => ({
      id: p.id,
      name: p.manifest.name,
      description: p.manifest.description ?? null,
      icon: "plugin",
      kind: "third-party",
      state: states.find((state) => state.installed && state.id === p.id) ?? null,
      record: p,
      own: null,
    }));
  return [...builtIn, ...thirdParty];
}

/** Whether a plugin is found by what was typed: in its name, its description, or its kind. */
export function matchesPlugin(plugin: Listed, typed: string): boolean {
  const needle = typed.trim().toLowerCase();
  return !needle || [plugin.name, plugin.description ?? "", kindLabel(plugin)].some((text) => text.toLowerCase().includes(needle));
}

/** How many members are waiting on an admin for something of this plugin's. */
export const waitingOn = (plugin: Listed): number => new Set(plugin.record?.permissions.flatMap((p) => p.requests.map((r) => r.by.id)) ?? []).size;
