import { afterEach, describe, expect, it, vi } from "vitest";
import { advance, bind, chordFor, chordLabel, chordOf, chordsForFrames, frameCommand, keyboardLayout, onLayout, onPlatform, overlap, pressing, readLayout, typed } from "../../src/web/keybindings.ts";
import { matching, starting } from "../../src/web/plugins/lib/match.ts";

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

  it("writes what a key types on the member's keyboard where a Mac's Option, held with ⌘ or ⌃, writes another character for it", () => {
    const pressed = (key: string, code: string, held: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>>, layout?: Record<string, string>) =>
      chordOf({ key, code, metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, ...held }, true, layout);
    // On Dvorak, [ and ] are where a US keyboard has - and =, and the key where US has [ types /.
    const dvorak = { Minus: "[", Equal: "]", BracketLeft: "/", BracketRight: "=", KeyK: "t", KeyY: "f" };
    expect(pressed("“", "Minus", { metaKey: true }, dvorak)).toBe("mod+alt+[");
    expect(pressed("‘", "Equal", { metaKey: true }, dvorak)).toBe("mod+alt+]");
    expect(pressed("÷", "BracketLeft", { metaKey: true }, dvorak)).toBe("mod+alt+/");
    expect(pressed("†", "KeyK", { metaKey: true }, dvorak)).toBe("mod+alt+t");
    // On a German keyboard Option types [ itself, with the 5: that is [ already.
    expect(pressed("[", "Digit5", { metaKey: true }, { Digit5: "5", BracketLeft: "ü" })).toBe("mod+alt+[");
    // Where the browser can't say what the keyboard types, as Safari can't, a key is what a US keyboard's types.
    expect(pressed("“", "BracketLeft", { metaKey: true })).toBe("mod+alt+[");
    expect(pressed("†", "KeyT", { metaKey: true })).toBe("mod+alt+t");
    expect(pressed("º", "Digit0", { ctrlKey: true })).toBe("ctrl+alt+0");
    expect(pressed("”", "BracketLeft", { metaKey: true, shiftKey: true })).toBe("mod+alt+shift+[");
    // A key that writes what it says is left as it is, and so is Option alone, which types its character.
    expect(pressed("[", "BracketLeft", { metaKey: true })).toBe("mod+alt+[");
    expect(pressed("Enter", "Enter", { metaKey: true })).toBe("mod+alt+enter");
    expect(pressed("“", "BracketLeft", {})).toBe("alt+“");
  });

  it("writes the key on the keyboard for a sign that Ctrl and Alt together, as AltGr, type off a Mac, so typing it runs no chord of the sign", () => {
    const pressed = (key: string, code: string) => chordOf({ key, code, metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }, false);
    // AltGr+8 and AltGr+Q on a German keyboard.
    expect(pressed("[", "Digit8")).toBe("mod+alt+8");
    expect(pressed("@", "KeyQ")).toBe("mod+alt+q");
    expect(pressed("[", "BracketLeft")).toBe("mod+alt+[");
    // AltGr+5 on a French keyboard, whose 5 key types (.
    expect(chordOf({ key: "[", code: "Digit5", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }, false, { Digit5: "(" })).toBe("mod+alt+(");
    // AltGr on a German keyboard's + key, which a chord writes by name.
    expect(chordOf({ key: "~", code: "BracketRight", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }, false, { BracketRight: "+" })).toBe("mod+alt+plus");
    // A letter is the letter written, wherever a keyboard has it: A is where Q is on a French one.
    expect(pressed("a", "KeyQ")).toBe("mod+alt+a");
    expect(chordOf({ key: "[", code: "Digit8", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, false)).toBe("mod+[");
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

  it("knows the keys a button, a link or a checkbox acts on itself: Enter and Space, alone or with Shift", () => {
    for (const keys of ["enter", "shift+enter", "enter j"]) expect(pressing(keys), keys).toBe("enter");
    for (const keys of ["space", "shift+space"]) expect(pressing(keys), keys).toBe("space");
    for (const keys of ["j", "mod+enter", "alt+space", "g enter", "escape"]) expect(pressing(keys), keys).toBe(null);
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
      shared: {},
      conflicts: [{ commandId: "note.new", reason: "g is the first key of g g, the keys for Vim: first row (vim.first), and of g t, the keys for Vim: next tab (vim.nextTab). Where both can run, g runs New note and the longer keys never run." }],
    });
    expect(bind([first, down, { id: "note.new", title: "New note", chords: ["j k"], chosen: true }]).conflicts).toEqual([
      { commandId: "note.new", reason: "j k begins with j, the key for Vim: down a row (vim.down). Where both can run, j runs Vim: down a row and j k never runs." },
    ]);
    // Defaults that overlap are the app's own to keep apart, and nobody's mistake to be told of.
    expect(bind([first, { id: "note.new", title: "New note", chords: ["g"], chosen: false }]).conflicts).toEqual([]);
    expect(bind([first, tab, down, { id: "note.new", title: "New note", chords: ["g n", "ctrl+w h"], chosen: true }]).conflicts).toEqual([]);
  });

  it("shares a key two commands have by default between them, and gives it to one alone where the member chose it", () => {
    const fieldDown = { id: "vim.field.down", title: "Vim: next row, from a field", chords: ["ctrl+j", "ctrl+n"], chosen: false, placed: true };
    const paneDown = { id: "vim.window.down", title: "Vim: go to the region below", chords: ["ctrl+w j", "ctrl+j"], chosen: false, placed: true };
    expect(bind([fieldDown, paneDown])).toMatchObject({ keybindings: { "ctrl+j": "vim.field.down", "ctrl+n": "vim.field.down", "ctrl+w j": "vim.window.down" }, shared: { "ctrl+j": ["vim.field.down", "vim.window.down"] }, conflicts: [] });
    const mine = { ...paneDown, chords: ["ctrl+j"], chosen: true };
    expect(bind([fieldDown, mine])).toMatchObject({ keybindings: { "ctrl+j": "vim.window.down" }, shared: {} });
    expect(bind([fieldDown, mine]).conflicts).toHaveLength(1);
    // Two that run anywhere don't share: the first would always run.
    expect(bind([{ ...fieldDown, placed: false }, { ...paneDown, placed: false }]).shared).toEqual({});
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
    // A sign is typed with Shift on most keyboards, and reads as the sign. A letter with Shift still says so.
    expect(chordLabel("shift+?", true)).toBe("?");
    expect(chordLabel("shift+?", false)).toBe("?");
    expect(chordLabel("shift+g", false)).toBe("Shift+G");
    expect(chordLabel("mod+shift+.", true)).toBe("⇧⌘.");
    expect([chordLabel("alt+arrowup", true), chordLabel("shift+tab", false), chordLabel("alt+enter", true), chordLabel("escape", false), chordLabel("f1", true)]).toEqual(["⌥↑", "Shift+Tab", "⌥Enter", "Esc", "F1"]);
  });

  it("gives a plugin frame the chords that run wherever focus is, and leaves a text field the ones that type or that a field keeps", () => {
    const commands = [
      { id: "open" },
      { id: "undo", leaveToFields: true },
      { id: "shortcuts" },
      { id: "down", when: () => true },
      { id: "back", when: () => true, escapesFrames: true },
    ];
    const keybindings = { "mod+p": "open", "mod+z": "undo", "shift+?": "shortcuts", j: "down", "ctrl+o": "back" };

    expect(chordsForFrames(commands, keybindings)).toEqual([
      { chord: "mod+p", field: false },
      { chord: "mod+z", field: true },
      { chord: "shift+?", field: true },
      { chord: "ctrl+o", field: false },
    ]);
    expect(frameCommand("mod+p", commands, keybindings)).toBe("open");
    expect(frameCommand("mod+z", commands, keybindings)).toBe("undo");
    expect(frameCommand("j", commands, keybindings)).toBeNull();
    expect(frameCommand("ctrl+o", commands, keybindings)).toBe("back");
    expect(frameCommand("mod+q", commands, keybindings)).toBeNull();
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

describe("items that start with what was typed", () => {
  const embeds = ["Timer timer", "Stopwatch stopwatch", "Kanban board kanban", "Standup notes standup"];
  const start = (typed: string) => starting(embeds, typed, (t) => t);

  it("offers those whose text starts with it, then those with a word that does", () => {
    expect(start("st")).toEqual(["Stopwatch stopwatch", "Standup notes standup"]);
    expect(start("B")).toEqual(["Kanban board kanban"]);
    expect(start("no")).toEqual(["Standup notes standup"]);
    expect(start("")).toEqual(embeds);
    expect(starting(["To-do list to-do"], "to-d", (t) => t)).toEqual(["To-do list to-do"]);
    expect(starting(["To-do list to-do"], "do", (t) => t)).toEqual(["To-do list to-do"]);
  });

  it("offers nothing for letters that are only inside a word or scattered through it", () => {
    for (const typed of ["or", "h", "a", "an", "watch", "tmr", "kb"]) expect([typed, start(typed)]).toEqual([typed, []]);
  });
});

describe("the member's keyboard layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is read from the browser, a key whose letter isn't one keys are written with being the US keyboard's, and is told when it changes", async () => {
    const layouts = [new Map([["Minus", "["], ["KeyT", "е"], ["KeyK", "T"]]), new Map([["Minus", "["], ["KeyT", "е"], ["KeyK", "T"]]), new Map<string, string>()];
    vi.stubGlobal("navigator", { keyboard: { getLayoutMap: () => Promise.resolve(layouts.shift()) } });
    const heard = vi.fn();
    const stop = onLayout(heard);
    const read = async () => {
      readLayout();
      await new Promise((done) => setTimeout(done));
    };

    await read();
    expect([keyboardLayout().Minus, keyboardLayout().KeyT, keyboardLayout().KeyK, keyboardLayout().BracketLeft]).toEqual(["[", "t", "t", "["]);
    expect(heard).toHaveBeenCalledTimes(1);
    await read();
    expect(heard).toHaveBeenCalledTimes(1);
    await read();
    expect(keyboardLayout().Minus).toBe("-");
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});
