import { describe, expect, it } from "vitest";
import { chordOf, readKeys } from "../../src/web/keybindings.ts";
import type { Setting } from "../../src/web/plugin-api.ts";
import { documentOf, editSetting, readSetting } from "../../src/web/settings.ts";

const reasonFor = (setting: Setting, value: unknown) => {
  const read = readSetting(setting, value);
  return "reason" in read ? read.reason : null;
};

describe("a setting's value", () => {
  it("is true or false for a boolean", () => {
    const on: Setting = { type: "boolean", default: true, title: "On" };

    expect(readSetting(on, false)).toEqual({ value: false });
    expect(reasonFor(on, "false")).toBe('Expected true or false, not "false"');
    expect(reasonFor(on, null)).toBe("Expected true or false, not null");
  });

  it("is text for a string, one of its choices when it has them, and no longer than it allows", () => {
    const theme: Setting = { type: "string", default: "system", enum: ["system", "light", "dark"], title: "Theme" };
    const folder: Setting = { type: "string", default: "Daily", maxLength: 5, title: "Folder" };

    expect(readSetting(theme, "dark")).toEqual({ value: "dark" });
    expect(reasonFor(theme, "purple")).toBe('Expected one of "system", "light", "dark", not "purple"');
    expect(reasonFor(theme, 3)).toBe("Expected text in quotes, not 3");
    expect(readSetting(folder, "Notes")).toEqual({ value: "Notes" });
    expect(reasonFor(folder, "Journal")).toBe("Expected at most 5 characters");
  });

  it("is text for a folder: a folder's id, or empty for the default", () => {
    const folder: Setting = { type: "folder", default: "", defaultFolder: "Daily", title: "Folder" };

    expect(readSetting(folder, "k3f9q2m8x1ab")).toEqual({ value: "k3f9q2m8x1ab" });
    expect(readSetting(folder, "")).toEqual({ value: "" });
    expect(reasonFor(folder, 3)).toBe("Expected a folder's id in quotes, not 3");
  });

  it("is a number within its bounds, and whole for an integer", () => {
    const scale: Setting = { type: "number", default: 1, minimum: 0.5, maximum: 2, title: "Scale" };
    const size: Setting = { type: "integer", default: 100, minimum: 75, title: "Size" };

    expect(readSetting(scale, 1.5)).toEqual({ value: 1.5 });
    expect(reasonFor(scale, 0.25)).toBe("Expected 0.5 or more, not 0.25");
    expect(reasonFor(scale, 3)).toBe("Expected 2 or less, not 3");
    expect(reasonFor(scale, "1")).toBe('Expected a number, not "1"');
    expect(readSetting(size, 120)).toEqual({ value: 120 });
    expect(reasonFor(size, 99.5)).toBe("Expected a whole number, not 99.5");
  });

  it("is a list of chords, each put the way a key press is written, with a repeat left out", () => {
    const keys: Setting = { type: "chords", default: [], title: "Keys" };

    expect(readSetting(keys, ["Shift+Mod+P", "mod+shift+p", "f1"])).toEqual({ value: ["mod+shift+p", "f1"] });
    expect(readSetting(keys, [])).toEqual({ value: [] });
    expect(reasonFor(keys, "mod+k")).toBe('Expected a list of keys, such as ["mod+k"], not "mod+k"');
    expect(reasonFor(keys, ["mod+k", 3])).toBe('Expected a list of keys, such as ["mod+k"], not ["mod+k",3]');
    expect(reasonFor(keys, ["mod+"])).toBe('"mod+" has no key after its modifiers');
    expect(readSetting(keys, ["G G", "g g", "ctrl+w H", "j"])).toEqual({ value: ["g g", "ctrl+w h", "j"] });
  });
});

describe("a command's keys as a member writes them", () => {
  it("are modifiers in any order and case, then one key", () => {
    expect(readKeys("mod+shift+p")).toEqual({ keys: "mod+shift+p" });
    expect(readKeys("SHIFT + alt + Mod + K")).toEqual({ keys: "mod+alt+shift+k" });
    expect(readKeys("f1")).toEqual({ keys: "f1" });
    expect(readKeys("F12")).toEqual({ keys: "f12" });
    expect(readKeys("Escape")).toEqual({ keys: "escape" });
    expect(readKeys("shift+escape")).toEqual({ keys: "shift+escape" });
    expect(readKeys("mod+enter")).toEqual({ keys: "mod+enter" });
    expect(readKeys("alt+arrowup")).toEqual({ keys: "alt+arrowup" });
    expect(readKeys("mod+,")).toEqual({ keys: "mod+," });
    expect(readKeys("Ctrl+O")).toEqual({ keys: "ctrl+o" });
    expect(readKeys("mod+space")).toEqual({ keys: "mod+space" });
  });

  it("may be a key with no modifier, as the keys that run commands are read", () => {
    for (const bare of ["k", "shift+k", "enter", "backspace", "tab", "delete", "arrowup", "shift+enter", "f", "f100", "/"]) expect(readKeys(bare), bare).toEqual({ keys: bare });
    expect(readKeys("Shift+G")).toEqual({ keys: "shift+g" });
  });

  it("may be several chords pressed one after another, written with spaces between them", () => {
    expect(readKeys("g g")).toEqual({ keys: "g g" });
    expect(readKeys("Ctrl+W h")).toEqual({ keys: "ctrl+w h" });
    expect(readKeys("  G   Shift + T ")).toEqual({ keys: "g shift+t" });
    expect(readKeys("mod+k l")).toEqual({ keys: "mod+k l" });
    expect(readKeys("mod+k shift+mod+l escape")).toEqual({ keys: "mod+k mod+shift+l escape" });
  });

  it("are refused with what is wrong with them", () => {
    expect(readKeys("")).toEqual({ reason: '"" has no key after its modifiers' });
    expect(readKeys("   ")).toEqual({ reason: '"   " has no key after its modifiers' });
    expect(readKeys("mod+shift")).toEqual({ reason: '"mod+shift" has no key after its modifiers' });
    expect(readKeys("cmd+k")).toEqual({ reason: '"cmd" in "cmd+k" isn\'t a modifier. Use mod, ctrl, alt, or shift, then one key' });
    expect(readKeys("mod+mod+k")).toEqual({ reason: '"mod+mod+k" names a modifier twice' });
    expect(readKeys("g mod+")).toEqual({ reason: '"mod+" in "g mod+" has no key after its modifiers' });
    expect(readKeys("ctrl+w cmd+h")).toEqual({ reason: '"cmd" in "ctrl+w cmd+h" isn\'t a modifier. Use mod, ctrl, alt, or shift, then one key' });
  });

  it("are read the same as the keys pressed for them are written, whatever is pressed", () => {
    const press = (key: string, held: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => chordOf({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held }, true);
    const pressed = [press("g"), press("G", { shiftKey: true }), press("w", { ctrlKey: true }), press(" "), press("+", { shiftKey: true }), press("ArrowUp", { altKey: true }), press("/")];

    expect(pressed).toEqual(["g", "shift+g", "ctrl+w", "space", "shift+plus", "alt+arrowup", "/"]);
    for (const chord of pressed) expect(readKeys(chord), chord).toEqual({ keys: chord });
    expect(readKeys(pressed.join(" "))).toEqual({ keys: pressed.join(" ") });
  });
});

describe("the settings document as text", () => {
  it("is a JSON object or nothing", () => {
    expect(documentOf('{"a": 1}')).toEqual({ a: 1 });
    for (const text of ["", "[]", "null", "3", '{"a": 1,}']) expect(documentOf(text), text).toBeNull();
  });

  it("takes an edit to one key, leaving the others and their order as they were", () => {
    const text = '{"z.last": [1, 2], "a.first": "kept"}';

    expect(editSetting(text, "m.new", true)).toBe('{\n  "z.last": [\n    1,\n    2\n  ],\n  "a.first": "kept",\n  "m.new": true\n}');
    expect(Object.keys(JSON.parse(editSetting(text, "z.last", 3)))).toEqual(["z.last", "a.first"]);
    expect(editSetting(text, "z.last", undefined)).toBe('{\n  "a.first": "kept"\n}');
    expect(editSetting('{"only": 1}', "only", undefined)).toBe("{}");
  });
});
