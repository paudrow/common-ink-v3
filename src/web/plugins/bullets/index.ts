import type { Plugin } from "../../plugin-api.ts";
import { bulletCommands, bulletEditing, type Kept } from "./outlining.ts";

const isKept = (value: unknown): value is Record<string, Kept[]> =>
  typeof value === "object" && value !== null && Object.values(value).every((list) => Array.isArray(list) && list.every((k) => typeof k?.line === "number" && typeof k?.text === "string"));

/**
 * Bullets that work as an outline: Tab and Shift+Tab put a bullet under the one before it or back
 * out, Alt+↑ and Alt+↓ move it among its siblings, and each takes what is under the bullet with it.
 * A bullet with something under it folds. What is folded is how this browser shows the note, kept
 * in the plugin's storage for each note, and is never written into the note.
 */
export const bullets: Plugin = {
  id: "bullets",
  name: "Outline bullets",
  description: "Lists that work as an outline: indent, move and fold a bullet with what is under it.",
  icon: "outline",
  activate(host) {
    const stored = host.storage.get("folds");
    const folds: Record<string, Kept[]> = isKept(stored) ? { ...stored } : {};
    const keep = (noteId: string) => (folded: Kept[]) => {
      if (folded.length) folds[noteId] = folded;
      else delete folds[noteId];
      host.storage.set("folds", folds);
    };
    host.editorExtensions.register({ id: "bullets", extension: ({ noteId }) => bulletEditing(folds[noteId] ?? [], keep(noteId)) });

    const commands = [
      ["indent", "Indent bullet", "tab"],
      ["outdent", "Outdent bullet", "shift+tab"],
      ["moveUp", "Move bullet up", "alt+arrowup"],
      ["moveDown", "Move bullet down", "alt+arrowdown"],
      ["toggleFold", "Fold or unfold bullet", "mod+shift+."],
    ] as const;
    for (const [name, title, key] of commands) host.commands.register({ id: `bullets.${name}`, title, keys: [key], group: "Editor", ...bulletCommands[name] });
  },
};
