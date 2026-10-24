import { describe, expect, it } from "vitest";
import type { CommandInfo } from "../../src/web/plugin-api.ts";
import { shortcutGroups } from "../../src/web/plugins/lib/shortcutGroups.ts";

const command = (id: string, keys: string[], group?: string): CommandInfo => ({ id, title: id, shortcut: keys[0], keys, group });

describe("the keyboard shortcuts sheet", () => {
  it("lists only commands with keys, under Navigation, Sidebar, Notes, Editor and Vim first, then a plugin's own heading, and Other last", () => {
    const groups = shortcutGroups([
      command("timer", ["mod+t"]),
      command("sidebar.own", ["F6"], "Sidebar"),
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
      ["Sidebar", ["sidebar.0", "sidebar.1", "sidebar.2", "sidebar.3", "sidebar.4", "sidebar.5", "sidebar.6", "sidebar.own"]],
      ["Notes", ["note.save"]],
      ["Editor", ["bullets.indent", "undo"]],
      ["Vim", ["vim.down"]],
      ["Kanban", ["kanban.move"]],
      ["Lists", ["lists.1", "lists.2", "lists.4"]],
      ["Other", ["timer"]],
    ]);
  });

  it("lists the sidebar's own keys under a heading of their own, with vim's keys for each while vim mode is on", () => {
    const rows = (commands: CommandInfo[]) => shortcutGroups(commands).find((g) => g.name === "Sidebar")!.commands.map((c) => [c.title, c.keys]);
    expect(rows([])).toEqual([
      ["Next or previous row", ["↓", "↑"]],
      ["First or last row", ["Home", "End"]],
      ["Open a folder or More out, or shut it", ["→", "←"]],
      ["Open the row and go to it", ["Enter"]],
      ["Open the row and stay in the sidebar", ["Space"]],
      ["Open the row to the side and go to it", ["Shift+Enter"]],
      ["Open the row to the side and stay in the sidebar", ["Shift+Space"]],
    ]);
    const vim = [
      command("vim.list.down", ["J"], "Vim"),
      command("vim.list.up", ["K"], "Vim"),
      command("vim.list.first", ["G G"], "Vim"),
      command("vim.list.last", ["⇧G"], "Vim"),
      command("vim.list.toggle", ["Z A"], "Vim"),
      command("vim.list.out", ["H"], "Vim"),
      command("vim.list.open", ["Enter", "L"], "Vim"),
      command("vim.list.preview", ["Space"], "Vim"),
      command("vim.window.left", ["⌃W H"], "Vim"),
      command("vim.window.previous", ["⌃W P"], "Vim"),
    ];
    expect(rows(vim)).toEqual([
      ["Next or previous row", ["↓", "↑", "J", "K"]],
      ["First or last row", ["Home", "End", "G G", "⇧G"]],
      ["Open a folder or More out, or shut it", ["→", "←", "Z A", "H"]],
      ["Open the row and go to it", ["Enter", "L"]],
      ["Open the row and stay in the sidebar", ["Space"]],
      ["Open the row to the side and go to it", ["Shift+Enter"]],
      ["Open the row to the side and stay in the sidebar", ["Shift+Space"]],
      ["Go to the sidebar, on the row of what is open", ["⌃W H"]],
      ["Go back to the region you were in", ["⌃W P"]],
    ]);
  });

  it("lists selecting a list's rows and undoing what was done to them under Lists, each command once, with vim's keys and the pointer's", () => {
    const groups = shortcutGroups(
      [
        command("list.selectDown", ["⇧↓"], "Lists"),
        command("list.selectUp", ["⇧↑"], "Lists"),
        command("list.clearSelection", ["Esc"], "Lists"),
        command("list.sort", ["S"], "Lists"),
        command("history.undo", ["⌘Z"], "Editor"),
        command("history.redo", ["⇧⌘Z", "⌘Y"], "Editor"),
        command("vim.list.visual", ["⇧V"], "Vim"),
        command("vim.list.undo", ["U"], "Vim"),
        command("vim.list.redo", ["⌃R"], "Vim"),
      ],
      { shift: "⇧", mod: "⌘" },
    );
    expect(groups.find((g) => g.name === "Lists")!.commands.map((c) => [c.title, c.keys, c.then])).toEqual([
      ["Select the next or previous row too", ["⇧↓", "⇧↑", "⇧V"], undefined],
      ["Select the rows from the last one selected", ["⇧"], "click a row"],
      ["Select a row, or unselect it", ["⌘"], "click it"],
      ["Clear the selection", ["Esc"], undefined],
      ["Act on every selected row", [], "The row's own keys, buttons and menu"],
      ["Undo what was done to a list's rows", ["⌘Z", "U"], undefined],
      ["Redo it", ["⇧⌘Z", "⌘Y", "⌃R"], undefined],
      ["list.sort", ["S"], undefined],
    ]);
    // The note's undo is the Editor's still.
    expect(groups.find((g) => g.name === "Editor")!.commands.map((c) => c.id)).toEqual(["history.undo", "history.redo"]);
  });
});
