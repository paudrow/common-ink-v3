import { describe, expect, it } from "vitest";
import { createCommands } from "../../src/web/commands.ts";
import { chordFor, chordLabel, chordOf } from "../../src/web/keybindings.ts";
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
