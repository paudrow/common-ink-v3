import { describe, expect, it } from "vitest";
import { createCommands } from "../../src/web/commands.ts";
import { advance, chordFor, chordLabel, chordOf, typed } from "../../src/web/keybindings.ts";
import { matching } from "../../src/web/match.ts";

describe("commands", () => {
  it("lists what's registered in the order it was registered, and runs a command by its id", () => {
    const commands = createCommands();
    const ran: string[] = [];
    commands.register({ id: "note.new", title: "New note", run: () => ran.push("new") });
    commands.register({ id: "view.toggleInspector", title: "Toggle inspector", run: () => ran.push("inspector") });

    expect(commands.list().map((c) => [c.id, c.title])).toEqual([
      ["note.new", "New note"],
      ["view.toggleInspector", "Toggle inspector"],
    ]);
    expect(commands.run("view.toggleInspector")).toBe(true);
    expect(ran).toEqual(["inspector"]);
  });

  it("says so when asked to run a command nobody registered", () => {
    expect(createCommands().run("note.new")).toBe(false);
  });

  it("takes a command back out, leaving one registered later under the same id", () => {
    const commands = createCommands();
    const ran: string[] = [];
    const unregister = commands.register({ id: "note.new", title: "New note", run: () => ran.push("first") });

    expect(() => commands.register({ id: "note.new", title: "Another", run: () => {} })).toThrow("There's already a command with the id note.new");
    unregister();
    expect(commands.list()).toEqual([]);

    commands.register({ id: "note.new", title: "New note", run: () => ran.push("second") });
    unregister();
    commands.run("note.new");
    expect(ran).toEqual(["second"]);
  });
});

describe("keybindings", () => {
  const press = (key: string, held: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    chordOf({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...held });

  it("writes a key press as a chord, with ⌘ and Ctrl both as mod", () => {
    expect(press("P", { metaKey: true, shiftKey: true })).toBe("mod+shift+p");
    expect(press("p", { ctrlKey: true })).toBe("mod+p");
    expect(press(".", { metaKey: true })).toBe("mod+.");
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
    for (const keys of ["mod+j", "mod+w h", "alt+shift+g", "escape", "shift+escape", "f2", "f12 j", "mod+k l"]) expect(typed(keys), keys).toBe(false);
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
  });

  it("labels keys pressed one after another, chord by chord", () => {
    expect(chordLabel("g g", true)).toBe("G G");
    expect(chordLabel("mod+w h", true)).toBe("⌘W H");
    expect(chordLabel("mod+w h", false)).toBe("Ctrl+W H");
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
