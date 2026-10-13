import type { MouseEvent } from "react";
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

/** One plugin as the Plugins page lists it. */
export interface Listed {
  id: string;
  name: string;
  /** One line on what it is for. Null for one that says nothing of itself. */
  description: string | null;
  icon: IconName;
  /** The plugin as the app runs it. */
  state: PluginState;
}

/** Every plugin a member can turn on or off, in the app's order. */
export function listPlugins(states: readonly PluginState[]): Listed[] {
  return states.filter((state) => !state.required).map((state): Listed => ({ id: state.id, name: state.name, description: state.description, icon: state.icon ?? "plugin", state }));
}

/** Whether a plugin is found by what was typed: in its name or its description. */
export function matchesPlugin(plugin: Listed, typed: string): boolean {
  const needle = typed.trim().toLowerCase();
  return !needle || [plugin.name, plugin.description ?? ""].some((text) => text.toLowerCase().includes(needle));
}
