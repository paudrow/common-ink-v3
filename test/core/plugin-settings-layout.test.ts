import { describe, expect, it } from "vitest";
import type { MemberSettings } from "../../src/web/pluginHost.ts";
import { KEYBINDING, resolve, type Declared } from "../../src/web/settings.ts";
import { categoriesOf, filterLayout, holdersOf, layoutOf, overlapsOf, shortcutsOf } from "../../src/web/settingsLayout.ts";

const group = (id: string, name: string) => ({ id, name });
const CORE = group("core", "Common Ink");
const VIM = group("vim", "Vim mode");
const DAILY = group("daily", "Daily notes");
const KEYS = group("keybindings", "Keybindings");

const DECLARED: readonly Declared[] = [
  { key: "core.theme", setting: { type: "string", default: "system", enum: ["system", "light", "dark"], title: "Theme", description: "Light or dark." }, group: CORE, active: true },
  { key: "core.editorTextSize", setting: { type: "integer", default: 100, title: "Editor text size" }, group: CORE, active: true },
  { key: "daily.enabled", setting: { type: "boolean", default: true, title: "On" }, group: DAILY, active: true, switch: true },
  { key: "daily.folder", setting: { type: "string", default: "Daily", title: "Daily notes folder" }, group: DAILY, active: true },
  { key: "tabs.enabled", setting: { type: "boolean", default: true, title: "On" }, group: group("tabs", "Tabs and splits"), active: true, switch: true },
  { key: "vim.enabled", setting: { type: "boolean", default: false, title: "On" }, group: VIM, active: true, switch: true },
  { key: "vim.screenLines", setting: { type: "boolean", default: false, title: "j and k move by the rows on screen" }, group: VIM, active: false },
  { key: `${KEYBINDING}history.undo`, setting: { type: "chords", default: ["mod+z"], title: "Undo" }, group: KEYS, active: true },
  { key: `${KEYBINDING}view.toggleWritingMode`, setting: { type: "chords", default: ["mod+."], title: "Toggle writing mode" }, group: KEYS, active: true },
  { key: `${KEYBINDING}view.toggleInspector`, setting: { type: "chords", default: [], title: "Toggle inspector" }, group: KEYS, active: true },
];

const settingsOf = (document: Record<string, unknown>): MemberSettings => ({ declared: DECLARED, document, ...resolve(DECLARED, document) });
const shape = (layout: ReturnType<typeof layoutOf>) => ({ categories: layout.categories.map((c) => [c.name, c.rows.map((d) => d.key)]), shortcuts: layout.shortcuts.map((s) => s.commandId) });

describe("the Settings page's layout", () => {
  it("lists the app's own settings by category, then each plugin that declares options, and never a plugin's switch or a keybinding", () => {
    expect(categoriesOf(DECLARED).map((c) => [c.id, c.name, c.pluginId, c.rows.map((d) => d.key)])).toEqual([
      ["editor", "Editor", null, ["core.editorTextSize"]],
      ["appearance", "Appearance", null, ["core.theme"]],
      ["plugins/daily", "Daily notes", "daily", ["daily.folder"]],
      ["plugins/vim", "Vim mode", "vim", ["vim.screenLines"]],
    ]);
  });

  it("puts a setting of the app's own that no category names under General, so a new one is never lost", () => {
    const added: Declared = { key: "core.spellcheck", setting: { type: "boolean", default: true, title: "Check spelling" }, group: CORE, active: true };

    expect(categoriesOf([...DECLARED, added]).map((c) => [c.id, c.rows.map((d) => d.key)])).toContainEqual(["general", ["core.spellcheck"]]);
  });

  it("lists every command with the chords that run it, its defaults, and whether the chords are the member's", () => {
    const shortcuts = shortcutsOf(settingsOf({ "keybindings.view.toggleInspector": ["mod+shift+i"], "keybindings.history.undo": ["cmd+z"] }));

    expect(shortcuts.map((s) => [s.commandId, s.title, s.chords, s.defaults, s.yours, s.problems.length])).toEqual([
      ["history.undo", "Undo", ["mod+z"], ["mod+z"], true, 1],
      ["view.toggleWritingMode", "Toggle writing mode", ["mod+."], ["mod+."], false, 0],
      ["view.toggleInspector", "Toggle inspector", ["mod+shift+i"], [], true, 0],
    ]);
  });

  it("finds a setting by its title, key, description or category, and a shortcut by its command, its id or its keys as written and as read", () => {
    const settings = settingsOf({});
    const found = (needle: string, mac = true) => shape(filterLayout(layoutOf(settings), { needle, modified: false }, settings.document, mac));

    expect(found("theme")).toEqual({ categories: [["Appearance", ["core.theme"]]], shortcuts: [] });
    expect(found("texts")).toEqual({ categories: [["Editor", ["core.editorTextSize"]]], shortcuts: [] });
    expect(found("light or")).toEqual({ categories: [["Appearance", ["core.theme"]]], shortcuts: [] });
    expect(found("vim mode")).toEqual({ categories: [["Vim mode", ["vim.screenLines"]]], shortcuts: [] });
    expect(found("toggle")).toEqual({ categories: [], shortcuts: ["view.toggleWritingMode", "view.toggleInspector"] });
    expect(found("history.")).toEqual({ categories: [], shortcuts: ["history.undo"] });
    expect(found("mod+z")).toEqual({ categories: [], shortcuts: ["history.undo"] });
    expect(found("⌘z")).toEqual({ categories: [], shortcuts: ["history.undo"] });
    expect(found("ctrl+z", false)).toEqual({ categories: [], shortcuts: ["history.undo"] });
    expect(found("enabled")).toEqual({ categories: [], shortcuts: [] });
  });

  it("shows only what the member changed when asked to, in every category and in the shortcuts", () => {
    const settings = settingsOf({ "core.theme": "dark", "vim.screenLines": true, "tabs.enabled": false, "keybindings.view.toggleInspector": ["mod+shift+i"] });
    const modified = (needle: string) => shape(filterLayout(layoutOf(settings), { needle, modified: true }, settings.document, true));

    expect(modified("")).toEqual({ categories: [["Appearance", ["core.theme"]], ["Vim mode", ["vim.screenLines"]]], shortcuts: ["view.toggleInspector"] });
    expect(modified("vim")).toEqual({ categories: [["Vim mode", ["vim.screenLines"]]], shortcuts: [] });
  });

  it("names the other commands that already have a chord, reading ctrl as mod off a Mac", () => {
    const shortcuts = shortcutsOf(settingsOf({ "keybindings.view.toggleInspector": ["ctrl+z"] }));
    const holders = (chord: string, commandId: string, mac: boolean) => holdersOf(chord, shortcuts, commandId, mac).map((s) => s.commandId);

    expect(holders("mod+z", "view.toggleWritingMode", true)).toEqual(["history.undo"]);
    expect(holders("mod+z", "view.toggleWritingMode", false)).toEqual(["history.undo", "view.toggleInspector"]);
    expect(holders("mod+z", "history.undo", true)).toEqual([]);
    expect(holders("mod+shift+k", "history.undo", true)).toEqual([]);
  });

  it("names the other commands whose keys a sequence begins or goes on from, reading ctrl as mod off a Mac", () => {
    const shortcuts = shortcutsOf(settingsOf({ "keybindings.view.toggleInspector": ["ctrl+k i"], "keybindings.view.toggleWritingMode": ["g g"] }));
    const overlaps = (keys: string, commandId: string, mac: boolean) => overlapsOf(keys, shortcuts, commandId, mac).map((o) => [o.shortcut.commandId, o.keys, o.how]);

    expect(overlaps("g", "history.undo", true)).toEqual([["view.toggleWritingMode", "g g", "begins"]]);
    expect(overlaps("g g j", "history.undo", true)).toEqual([["view.toggleWritingMode", "g g", "follows"]]);
    expect(overlaps("g g", "history.undo", true)).toEqual([]);
    expect(overlaps("g", "view.toggleWritingMode", true)).toEqual([]);
    expect(overlaps("mod+k", "history.undo", true)).toEqual([]);
    expect(overlaps("mod+k", "history.undo", false)).toEqual([["view.toggleInspector", "ctrl+k i", "begins"]]);
    expect(overlaps("mod+z y", "view.toggleInspector", true)).toEqual([["history.undo", "mod+z", "follows"]]);
  });
});
