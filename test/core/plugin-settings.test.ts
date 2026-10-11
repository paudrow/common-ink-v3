import { describe, expect, it } from "vitest";
import { readChord } from "../../src/web/keybindings.ts";
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
  });
});

describe("a chord", () => {
  it("is modifiers in any order and case, then one key", () => {
    expect(readChord("mod+shift+p")).toEqual({ chord: "mod+shift+p" });
    expect(readChord("SHIFT + alt + Mod + K")).toEqual({ chord: "mod+alt+shift+k" });
    expect(readChord("f1")).toEqual({ chord: "f1" });
    expect(readChord("F12")).toEqual({ chord: "f12" });
    expect(readChord("Escape")).toEqual({ chord: "escape" });
    expect(readChord("shift+escape")).toEqual({ chord: "shift+escape" });
    expect(readChord("mod+enter")).toEqual({ chord: "mod+enter" });
    expect(readChord("alt+arrowup")).toEqual({ chord: "alt+arrowup" });
    expect(readChord("mod+,")).toEqual({ chord: "mod+," });
  });

  it("is refused with what is wrong with it", () => {
    expect(readChord("")).toEqual({ reason: '"" has no key after its modifiers' });
    expect(readChord("mod+shift")).toEqual({ reason: '"mod+shift" has no key after its modifiers' });
    expect(readChord("ctrl+k")).toEqual({ reason: '"ctrl" in "ctrl+k" isn\'t a modifier. Use mod, alt, or shift, then one key' });
    expect(readChord("mod+mod+k")).toEqual({ reason: '"mod+mod+k" names a modifier twice' });
    for (const typed of ["k", "shift+k", "enter", "backspace", "tab", "delete", "arrowup", "shift+enter", "f", "f100"]) {
      expect(readChord(typed), typed).toEqual({ reason: `"${typed}" would run while typing. Add mod or alt, which only Escape and the F keys go without` });
    }
    expect(readChord("mod+k l")).toEqual({ reason: '"mod+k l" isn\'t one key. Join a chord with +, such as mod+shift+k' });
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
