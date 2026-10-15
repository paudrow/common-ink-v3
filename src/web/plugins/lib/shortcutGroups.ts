import type { CommandInfo } from "../../plugin-api.ts";

/** The headings the keyboard shortcuts come under first, in this order. Any other plugin's heading follows them, and Other is last. */
const FIRST = ["Navigation", "Notes", "Editor", "Vim"];
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
  const rank = (name: string) => (name === OTHER ? FIRST.length + 1 : FIRST.includes(name) ? FIRST.indexOf(name) : FIRST.length);
  return [...groups].map(([name, listed]) => ({ name, commands: listed })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
