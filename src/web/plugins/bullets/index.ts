import type { Plugin } from "../../plugin-api.ts";
import { bulletCommands, bulletEditing, type Kept } from "./outlining.ts";

const isKept = (value: unknown): value is Record<string, Kept[]> =>
  typeof value === "object" && value !== null && Object.values(value).every((list) => Array.isArray(list) && list.every((k) => typeof k?.line === "number" && typeof k?.text === "string"));

/** Off a Mac, Alt+← and Alt+→ are the browser's Back and Forward, and the app's. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Bullets that work as an outline: Tab and Shift+Tab, or Alt+→ and Alt+←, put a bullet under the
 * one before it or back out, Alt+↑ and Alt+↓ move it among its siblings, and past the first or last
 * of them into the list beside it at its depth. Each takes what is under the bullet with it, and the
 * bullets after it that the selection takes in. A numbered list is numbered in order again after
 * each, or keeps the one number every item has, as in 1., 1., 1. A bullet with something under it
 * folds. What is folded is how this browser shows the note, kept in the plugin's storage for each
 * note, and is never written into the note.
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
      ["moveRight", "Move bullet right", MAC ? "alt+arrowright" : "alt+shift+arrowright"],
      ["moveLeft", "Move bullet left", MAC ? "alt+arrowleft" : "alt+shift+arrowleft"],
      ["toggleFold", "Fold or unfold bullet", "mod+shift+."],
    ] as const;
    for (const [name, title, key] of commands) host.commands.register({ id: `bullets.${name}`, title, keys: [key], group: "Editor", ...bulletCommands[name] });
  },
};
