/** Which command each chord runs. `mod` is ⌘ or Ctrl. */
export const KEYBINDINGS: Readonly<Record<string, string>> = {
  "mod+.": "view.toggleWritingMode",
  "mod+\\": "view.toggleSidebar",
  "mod+p": "notes.quickOpen",
  "mod+shift+p": "commands.show",
  "mod+z": "history.undo",
  "mod+shift+z": "history.redo",
  "mod+y": "history.redo",
};

/** Commands a text field has its own answer to. A key bound to one is left to the field while it has focus. */
export const FIELD_COMMANDS: ReadonlySet<string> = new Set(["history.undo", "history.redo"]);

interface Pressed {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The keys whose own character is what keys are written with: a chord is joined with + and a sequence is spaced. */
const NAMED: Record<string, string> = { " ": "space", "+": "plus" };

/** A key press written the way `KEYBINDINGS` writes it: modifiers in the order mod, alt, shift, then the key. */
export const chordOf = (e: Pressed) => [(e.metaKey || e.ctrlKey) && "mod", e.altKey && "alt", e.shiftKey && "shift", NAMED[e.key] ?? e.key.toLowerCase()].filter(Boolean).join("+");

/** A key that is held with another and is no press of its own. */
export const isModifier = (key: string) => key === "Shift" || key === "Control" || key === "Alt" || key === "Meta";

/**
 * What a key press comes to, after the chords in `pending` that began a sequence: it runs the
 * command with those keys, or waits for the rest of a sequence, or is nobody's. `ready` are the keys
 * of the commands that can run now. A press that fits nothing after `pending` is taken for itself,
 * as if nothing had been begun, and is dropped when it is nothing by itself either: a sequence
 * given up never types its last key into whatever has focus.
 */
export function advance(pending: string, chord: string, ready: readonly string[]): { run: string } | { pending: string } | "dropped" | null {
  for (const keys of pending ? [`${pending} ${chord}`, chord] : [chord]) {
    if (ready.includes(keys)) return { run: keys };
    if (ready.some((k) => k.startsWith(`${keys} `))) return { pending: keys };
  }
  return pending ? "dropped" : null;
}

/**
 * Whether a press of these keys would otherwise type: the chord they begin with has no mod or alt
 * in it and is neither Escape nor an F key. Such keys are left to whatever is being typed in.
 */
export function typed(keys: string) {
  const parts = keys.split(" ")[0]!.split("+");
  const key = parts.pop()!;
  return !parts.some((part) => part !== "shift") && key !== "escape" && !/^f\d{1,2}$/.test(key);
}

export const chordFor = (commandId: string, bindings = KEYBINDINGS) => Object.keys(bindings).find((chord) => bindings[chord] === commandId);

const SYMBOLS: Record<string, string> = { mod: "⌘", alt: "⌥", shift: "⇧" };
const WORDS: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift" };

/** A command's keys as a person reads them: `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere, and `G G` for one chord after another. */
export function chordLabel(keys: string, mac: boolean) {
  return keys
    .split(" ")
    .map((chord) => {
      const parts = chord.split("+");
      const key = parts.pop()!.toUpperCase();
      return mac ? `${parts.reverse().map((k) => SYMBOLS[k]).join("")}${key}` : [...parts.map((k) => WORDS[k]), key].join("+");
    })
    .join(" ");
}
