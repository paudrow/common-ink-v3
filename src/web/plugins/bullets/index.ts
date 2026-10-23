import type { Plugin } from "../../plugin-api.ts";
import { bulletDragging } from "./dragging.ts";
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
 * each, or keeps the one number every item has, as in 1., 1., 1. A key selects a bullet with what is
 * under it. A bullet with something under it folds, by its keys or the disclosure beside it. What is
 * folded is how this browser shows the note, kept in the plugin's storage for each note, and is
 * never written into the note. A bullet is dragged by its mark to another place.
 */
export const bullets: Plugin = {
  id: "bullets",
  name: "Outline bullets",
  description: "Lists that work as an outline: indent, move, select and fold a bullet with what is under it.",
  icon: "outline",
  activate(host) {
    const stored = host.storage.get("folds");
    const folds: Record<string, Kept[]> = isKept(stored) ? { ...stored } : {};
    const keep = (noteId: string) => (folded: Kept[]) => {
      if (folded.length) folds[noteId] = folded;
      else delete folds[noteId];
      host.storage.set("folds", folds);
    };
    host.editorExtensions.register({ id: "bullets", extension: ({ noteId }) => [bulletEditing(folds[noteId] ?? [], keep(noteId)), bulletDragging] });

    const commands = [
      ["indent", "Indent bullet", "tab", "Editor"],
      ["outdent", "Outdent bullet", "shift+tab", "Editor"],
      ["moveUp", "Move bullet up", "alt+arrowup", "Editor"],
      ["moveDown", "Move bullet down", "alt+arrowdown", "Editor"],
      ["moveRight", "Move bullet right", MAC ? "alt+arrowright" : "alt+shift+arrowright", "Editor"],
      ["moveLeft", "Move bullet left", MAC ? "alt+arrowleft" : "alt+shift+arrowleft", "Editor"],
      ["select", "Select bullet with what is under it", "mod+shift+l", "Editor"],
      ["toggleFold", "Fold or unfold bullet", "mod+shift+.", "Folding"],
      ["fold", "Fold bullet", "mod+alt+[", "Folding"],
      ["unfold", "Unfold bullet", "mod+alt+]", "Folding"],
      ["foldAll", "Fold all bullets", undefined, "Folding"],
      ["unfoldAll", "Unfold all bullets", undefined, "Folding"],
    ] as const;
    for (const [name, title, key, group] of commands) host.commands.register({ id: `bullets.${name}`, title, keys: key && [key], group, ...bulletCommands[name] });
  },
};
