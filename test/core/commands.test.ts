import { describe, expect, it } from "vitest";
import { advance, bind, chordFor, chordLabel, chordOf, onPlatform, overlap, typed } from "../../src/web/keybindings.ts";
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

  it("writes the space bar and the plus key by name, which a chord is joined and a sequence is spaced with", () => {
    expect(press(" ")).toBe("space");
    expect(press(" ", { ctrlKey: true })).toBe("mod+space");
    expect(press("+", { shiftKey: true })).toBe("shift+plus");
  });

  it("knows the keys that would otherwise type, by the chord they begin with", () => {
    for (const keys of ["j", "shift+g", "g g", "enter", "space", "/", "backspace", "j mod+k"]) expect(typed(keys), keys).toBe(true);
    for (const keys of ["mod+j", "ctrl+w h", "alt+shift+g", "escape", "shift+escape", "f2", "f12 j", "mod+k l"]) expect(typed(keys), keys).toBe(false);
  });

  it("says how two commands' keys stand to each other: the same, or one the first keys of the other", () => {
    expect(overlap("g g", "g g")).toBe("same");
    expect(overlap("g", "g g")).toBe("begins");
    expect(overlap("ctrl+w", "ctrl+w h")).toBe("begins");
    expect(overlap("g g", "g")).toBe("follows");
    expect(overlap("g g j", "g g")).toBe("follows");
    expect(overlap("g", "g+g")).toBeNull();
    expect(overlap("g t", "g g")).toBeNull();
    expect(overlap("mod+g", "g g")).toBeNull();
  });

  it("flags keys a member chose that begin another command's sequence or go on from another's keys, and still binds both", () => {
    const first = { id: "vim.first", title: "Vim: first row", chords: ["g g"], chosen: false };
    const tab = { id: "vim.nextTab", title: "Vim: next tab", chords: ["g t"], chosen: false };
    const down = { id: "vim.down", title: "Vim: down a row", chords: ["j"], chosen: false };

    expect(bind([first, tab, down, { id: "note.new", title: "New note", chords: ["g"], chosen: true }])).toEqual({
      keybindings: { g: "note.new", "g g": "vim.first", "g t": "vim.nextTab", j: "vim.down" },
      conflicts: [{ commandId: "note.new", reason: "g is the first key of g g, the keys for Vim: first row (vim.first), and of g t, the keys for Vim: next tab (vim.nextTab). Where both can run, g runs New note and the longer keys never run." }],
    });
    expect(bind([first, down, { id: "note.new", title: "New note", chords: ["j k"], chosen: true }]).conflicts).toEqual([
      { commandId: "note.new", reason: "j k begins with j, the key for Vim: down a row (vim.down). Where both can run, j runs Vim: down a row and j k never runs." },
    ]);
    // Defaults that overlap are the app's own to keep apart, and nobody's mistake to be told of.
    expect(bind([first, { id: "note.new", title: "New note", chords: ["g"], chosen: false }]).conflicts).toEqual([]);
    expect(bind([first, tab, down, { id: "note.new", title: "New note", chords: ["g n", "ctrl+w h"], chosen: true }]).conflicts).toEqual([]);
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

  it("reads and labels keys pressed one after another, chord by chord", () => {
    expect(onPlatform("ctrl+w h", false)).toBe("mod+w h");
    expect(onPlatform("ctrl+w h", true)).toBe("ctrl+w h");
    expect(onPlatform("g shift+t", false)).toBe("g shift+t");
    expect(chordLabel("g g", true)).toBe("G G");
    expect(chordLabel("ctrl+w h", true)).toBe("⌃W H");
    expect(chordLabel("ctrl+w h", false)).toBe("Ctrl+W H");
    expect(chordLabel("g shift+t", false)).toBe("G Shift+T");
  });

  it("runs a sequence on its last key, and takes the keys that begin one only while a command that can run goes on from them", () => {
    const ready = ["j", "g g", "g t", "mod+w h", "mod+p"];

    expect(advance("", "j", ready)).toEqual({ run: "j" });
    expect(advance("", "g", ready)).toEqual({ pending: "g" });
    expect(advance("g", "g", ready)).toEqual({ run: "g g" });
    expect(advance("g", "t", ready)).toEqual({ run: "g t" });
    expect(advance("mod+w", "h", ready)).toEqual({ run: "mod+w h" });
    // A key nobody has is left to whatever has focus, and so is one that begins a sequence no command can finish now.
    expect(advance("", "x", ready)).toBeNull();
    expect(advance("", "g", ["j", "mod+p"])).toBeNull();
    expect(advance("", "h", ready)).toBeNull();
  });

  it("gives up a sequence on a key that doesn't go on from it: the key runs what it runs alone, and otherwise goes nowhere", () => {
    const ready = ["j", "g g", "mod+w h", "mod+p"];

    expect(advance("g", "j", ready)).toEqual({ run: "j" });
    expect(advance("g", "mod+p", ready)).toEqual({ run: "mod+p" });
    expect(advance("mod+w", "g", ready)).toEqual({ pending: "g" });
    // Ctrl-w and then x in a note must not delete a letter.
    expect(advance("mod+w", "x", ready)).toBe("dropped");
    expect(advance("g", "escape", ready)).toBe("dropped");
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
