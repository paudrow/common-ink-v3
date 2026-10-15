import { describe, expect, it } from "vitest";
import type { CommandInfo } from "../../src/web/plugin-api.ts";
import { shortcutGroups } from "../../src/web/plugins/lib/shortcutGroups.ts";

const command = (id: string, keys: string[], group?: string): CommandInfo => ({ id, title: id, shortcut: keys[0], keys, group });

describe("the keyboard shortcuts sheet", () => {
  it("lists only commands with keys, under Navigation, Notes, Editor and Vim first, then a plugin's own heading, and Other last", () => {
    const groups = shortcutGroups([
      command("timer", ["mod+t"]),
      command("vim.down", ["J"], "Vim"),
      command("bullets.indent", ["Tab"], "Editor"),
      command("kanban.move", ["⌥→"], "Kanban"),
      command("note.new", [], "Notes"),
      command("note.save", ["⌘S"], "Notes"),
      command("go.note", ["⌘P"], "Navigation"),
      command("undo", ["⌘Z"], "Editor"),
    ]);
    expect(groups.map((g) => [g.name, g.commands.map((c) => c.id)])).toEqual([
      ["Navigation", ["go.note"]],
      ["Notes", ["note.save"]],
      ["Editor", ["bullets.indent", "undo"]],
      ["Vim", ["vim.down"]],
      ["Kanban", ["kanban.move"]],
      ["Other", ["timer"]],
    ]);
  });
});
