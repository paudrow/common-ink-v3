import type { CommandInfo } from "../../plugin-api.ts";

/** The headings the keyboard shortcuts come under first, in this order. Any other plugin's heading follows them, and Other is last. */
const FIRST = ["Navigation", "Sidebar", "Notes", "Editor", "Vim"];

/**
 * The sidebar's own keys, which are no command's, each with the commands that do the same in vim
 * mode, whose keys are listed with them while it is on. The sidebar is one list, from its pages
 * through its folders to its tags.
 */
const SIDEBAR: readonly { title: string; keys: readonly string[]; commands: readonly string[] }[] = [
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
/** Where a command that says no heading of its own is listed. */
export const OTHER = "Other";

export interface ShortcutGroup {
  name: string;
  commands: CommandInfo[];
}

/** The commands that have keys now, under their headings, each heading's commands in the order they are listed. */
export function shortcutGroups(commands: readonly CommandInfo[]): ShortcutGroup[] {
  const groups = new Map<string, CommandInfo[]>();
  for (const c of commands) if (c.keys.length) groups.set(c.group ?? OTHER, [...(groups.get(c.group ?? OTHER) ?? []), c]);
  const sidebar = SIDEBAR.map(({ title, keys, commands: ids }, n): CommandInfo => {
    const all = [...new Set([...keys, ...ids.flatMap((id) => commands.find((c) => c.id === id)?.keys ?? [])])];
    return { id: `sidebar.${n}`, title, shortcut: all[0], keys: all, group: "Sidebar" };
  }).filter((row) => row.keys.length);
  groups.set("Sidebar", [...sidebar, ...(groups.get("Sidebar") ?? [])]);
  const rank = (name: string) => (name === OTHER ? FIRST.length + 1 : FIRST.includes(name) ? FIRST.indexOf(name) : FIRST.length);
  return [...groups].map(([name, listed]) => ({ name, commands: listed })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
