import type { CommandInfo } from "../../plugin-api.ts";

/** The headings the keyboard shortcuts come under first, in this order. Any other plugin's heading follows them, and Other is last. */
const FIRST = ["Navigation", "Sidebar", "Notes", "Editor", "Vim"];

/**
 * A row of the sheet that is no one command's: its own keys, and the commands whose keys do the same,
 * which are listed with them while there are any. `then` is said after the keys, as what is done with
 * the pointer is: Shift, and a click on a row.
 */
interface Own {
  title: string;
  keys: readonly string[];
  commands: readonly string[];
  then?: string;
}

/**
 * The sidebar's own keys, each with the commands that do the same in vim mode, whose keys are listed
 * with them while it is on. The sidebar is one list, from its pages through its folders to its tags.
 */
const SIDEBAR: readonly Own[] = [
  { title: "Next or previous row", keys: ["↓", "↑"], commands: ["vim.list.down", "vim.list.up"] },
  { title: "First or last row", keys: ["Home", "End"], commands: ["vim.list.first", "vim.list.last"] },
  { title: "Open a folder or More out, or shut it", keys: ["→", "←"], commands: ["vim.list.toggle", "vim.list.out"] },
  { title: "Open the row and go to it", keys: ["Enter"], commands: ["vim.list.open"] },
  { title: "Open the row and stay in the sidebar", keys: ["Space"], commands: ["vim.list.preview"] },
  { title: "Open the row to the side and go to it", keys: ["Shift+Enter"], commands: [] },
  { title: "Open the row to the side and stay in the sidebar", keys: ["Shift+Space"], commands: [] },
  { title: "Go to the sidebar, on the row of what is open", keys: [], commands: ["vim.window.left"] },
  { title: "Go back to the region you were in", keys: [], commands: ["vim.window.previous"] },
];
/** How the sheet writes Shift and the key that is ⌘ on a Mac and Ctrl elsewhere, with a click. */
export interface Pointer {
  shift: string;
  mod: string;
}

/**
 * What is done to the rows of any list whose rows can be selected, besides each row's own keys:
 * selecting several, by the keys or the pointer, and taking back what was done to them. Vim's keys
 * are listed with them while it is on.
 */
const lists = ({ shift, mod }: Pointer): readonly Own[] => [
  { title: "Select the next or previous row too", keys: [], commands: ["list.selectDown", "list.selectUp", "vim.list.visual"] },
  { title: "Select the rows from the last one selected", keys: [shift], commands: [], then: "click a row" },
  { title: "Select a row, or unselect it", keys: [mod], commands: [], then: "click it" },
  { title: "Clear the selection", keys: [], commands: ["list.clearSelection"] },
  { title: "Act on every selected row", keys: [], commands: [], then: "The row's own keys, buttons and menu" },
  { title: "Undo what was done to a list's rows", keys: [], commands: ["history.undo", "vim.list.undo"] },
  { title: "Redo it", keys: [], commands: ["history.redo", "vim.list.redo"] },
];

/** Where a command that says no heading of its own is listed. */
export const OTHER = "Other";

/** A row of the sheet: a command, or a row of the sheet's own, with what is said after its keys. */
export interface Shortcut extends CommandInfo {
  then?: string;
}

export interface ShortcutGroup {
  name: string;
  commands: Shortcut[];
}

/**
 * The commands that have keys now, under their headings, each heading's commands in the order they
 * are listed. The sidebar's and the lists' own rows come first under theirs, and a command one of
 * them is made of is not listed under that heading again.
 */
export function shortcutGroups(commands: readonly CommandInfo[], pointer: Pointer = { shift: "Shift", mod: "Ctrl" }): ShortcutGroup[] {
  const groups = new Map<string, Shortcut[]>();
  for (const c of commands) if (c.keys.length) groups.set(c.group ?? OTHER, [...(groups.get(c.group ?? OTHER) ?? []), c]);
  for (const [group, rows] of [["Sidebar", SIDEBAR], ["Lists", lists(pointer)]] as const) {
    const own = rows
      .map(({ title, keys, commands: ids, then }, n): Shortcut => {
        const all = [...new Set([...keys, ...ids.flatMap((id) => commands.find((c) => c.id === id)?.keys ?? [])])];
        return { id: `${group.toLowerCase()}.${n}`, title, shortcut: all[0], keys: all, group, ...(then && { then }) };
      })
      .filter((row) => row.keys.length || row.then);
    const made = new Set(rows.flatMap((row) => row.commands));
    groups.set(group, [...own, ...(groups.get(group) ?? []).filter((c) => !made.has(c.id))]);
  }
  const rank = (name: string) => (name === OTHER ? FIRST.length + 1 : FIRST.includes(name) ? FIRST.indexOf(name) : FIRST.length);
  return [...groups].map(([name, listed]) => ({ name, commands: listed })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
