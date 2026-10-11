/** Which command each chord runs. `mod` is ⌘ or Ctrl. */
export const KEYBINDINGS: Readonly<Record<string, string>> = {
  "mod+.": "view.toggleWritingMode",
  "mod+p": "notes.quickOpen",
  "mod+shift+p": "commands.show",
};

interface Pressed {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** A key press written the way `KEYBINDINGS` writes it: modifiers in the order mod, alt, shift, then the key. */
export const chordOf = (e: Pressed) => [(e.metaKey || e.ctrlKey) && "mod", e.altKey && "alt", e.shiftKey && "shift", e.key.toLowerCase()].filter(Boolean).join("+");

export const chordFor = (commandId: string, bindings = KEYBINDINGS) => Object.keys(bindings).find((chord) => bindings[chord] === commandId);

const SYMBOLS: Record<string, string> = { mod: "⌘", alt: "⌥", shift: "⇧" };
const WORDS: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift" };

/** A chord as a person reads it: `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere. */
export function chordLabel(chord: string, mac: boolean) {
  const keys = chord.split("+");
  const key = keys.pop()!.toUpperCase();
  return mac ? `${keys.reverse().map((k) => SYMBOLS[k]).join("")}${key}` : [...keys.map((k) => WORDS[k]), key].join("+");
}
