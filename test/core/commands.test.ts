import { describe, expect, it } from "vitest";
import { chordFor, chordLabel, chordOf, onPlatform } from "../../src/web/keybindings.ts";
import { matching } from "../../src/web/plugins/lib/match.ts";

describe("keybindings", () => {
  const press = (key: string, held: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}, mac = false) =>
    chordOf({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held }, mac);

  it("writes a key press as a chord, with Ctrl as mod off a Mac", () => {
    expect(press("P", { ctrlKey: true, shiftKey: true })).toBe("mod+shift+p");
    expect(press("p", { ctrlKey: true })).toBe("mod+p");
    expect(press(".", { ctrlKey: true })).toBe("mod+.");
    expect(press("o", { metaKey: true })).toBe("meta+o");
    expect(press("p")).toBe("p");
    expect(press("k", { ctrlKey: true, altKey: true })).toBe("mod+alt+k");
  });

  it("tells ⌘ from Control on a Mac, so ⌘O is not Control+O", () => {
    expect(press("P", { metaKey: true, shiftKey: true }, true)).toBe("mod+shift+p");
    expect(press("o", { metaKey: true }, true)).toBe("mod+o");
    expect(press(".", { metaKey: true }, true)).toBe("mod+.");
    expect(press("o", { ctrlKey: true }, true)).toBe("ctrl+o");
    expect(press("k", { metaKey: true, ctrlKey: true, shiftKey: true }, true)).toBe("mod+ctrl+shift+k");
  });

  it("reads a ctrl chord as mod off a Mac, where they are one key, and leaves it on a Mac", () => {
    expect(onPlatform("ctrl+o", false)).toBe("mod+o");
    expect(onPlatform("mod+ctrl+shift+k", false)).toBe("mod+shift+k");
    expect(onPlatform("ctrl+o", true)).toBe("ctrl+o");
    expect(onPlatform("mod+shift+p", false)).toBe("mod+shift+p");
  });

  it("finds the chord bound to a command", () => {
    const bindings = { "mod+p": "notes.quickOpen", "mod+shift+p": "commands.show" };

    expect(chordFor("commands.show", bindings)).toBe("mod+shift+p");
    expect(chordFor("note.new", bindings)).toBeUndefined();
  });

  it("labels a chord for a Mac and for other keyboards", () => {
    expect(chordLabel("mod+shift+p", true)).toBe("⇧⌘P");
    expect(chordLabel("mod+shift+p", false)).toBe("Ctrl+Shift+P");
    expect(chordLabel("mod+.", true)).toBe("⌘.");
    expect(chordLabel("ctrl+o", true)).toBe("⌃O");
    expect(chordLabel("ctrl+o", false)).toBe("Ctrl+O");
  });
});

describe("matching what was typed", () => {
  const titles = ["Meeting notes", "Plan", "Trip planning", "Pool rules", "People and plans"];
  const match = (typed: string) => matching(titles, typed, (t) => t);

  it("puts titles that start with it first, then those that contain it, then those with its letters in order", () => {
    expect(match("pl")).toEqual(["Plan", "Trip planning", "People and plans", "Pool rules"]);
  });

  it("ignores case and the spaces around it, and returns everything when nothing is typed", () => {
    expect(match("  PLAN ")).toEqual(["Plan", "Trip planning", "People and plans"]);
    expect(match("")).toEqual(titles);
    expect(match("xyz")).toEqual([]);
  });
});
