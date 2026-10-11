interface Pressed {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIERS = ["mod", "ctrl", "alt", "shift"];

/**
 * A key press written the way a command writes its keys: modifiers in the order mod, ctrl, alt,
 * shift, then the key. `mod` is ⌘ on a Mac and Ctrl elsewhere. `ctrl` is the Control key, which
 * only a Mac tells apart from `mod`. Off a Mac the Windows key is `meta`, which no chord has.
 */
export const chordOf = (e: Pressed, mac: boolean) =>
  [(mac ? e.metaKey : e.ctrlKey) && "mod", mac ? e.ctrlKey && "ctrl" : e.metaKey && "meta", e.altKey && "alt", e.shiftKey && "shift", e.key.toLowerCase()].filter(Boolean).join("+");

/** A chord as this platform's key presses are written: off a Mac, `ctrl` is `mod`. */
export function onPlatform(chord: string, mac: boolean) {
  if (mac) return chord;
  const parts = chord.split("+").map((part) => (part === "ctrl" ? "mod" : part));
  const key = parts.pop()!;
  return [...MODIFIERS.filter((m) => parts.includes(m)), key].join("+");
}

/** A chord as a member wrote it, put the way `chordOf` writes a key press, or why it isn't one. */
export function readChord(text: string): { chord: string } | { reason: string } {
  const parts = text.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.pop()!;
  const stray = parts.find((part) => !MODIFIERS.includes(part));
  if (stray !== undefined) return { reason: `"${stray}" in "${text}" isn't a modifier. Use mod, ctrl, alt, or shift, then one key` };
  if (!key || MODIFIERS.includes(key)) return { reason: `"${text}" has no key after its modifiers` };
  if (/\s/.test(key)) return { reason: `"${text}" isn't one key. Join a chord with +, such as mod+shift+k` };
  if (new Set(parts).size < parts.length) return { reason: `"${text}" names a modifier twice` };
  if (!parts.some((part) => part !== "shift") && key !== "escape" && !/^f\d{1,2}$/.test(key)) return { reason: `"${text}" would run while typing. Add mod, ctrl, or alt, which only Escape and the F keys go without` };
  return { chord: [...MODIFIERS.filter((m) => parts.includes(m)), key].join("+") };
}

export interface Bindable {
  id: string;
  title: string;
  chords: readonly string[];
  /** Whether the member chose these chords. A chosen chord is taken before another command's default. */
  chosen: boolean;
}

/**
 * Which command each chord runs. A command the member bound keeps its chords over one that only has
 * them by default; between two of a kind, the first keeps it. A chord the member gave to a command
 * that another command also has is a conflict, and is still bound. The conflict names a command it
 * leaves with no key at all, since that command may be the only way to do what it does: undo is.
 */
export function bind(commands: readonly Bindable[]) {
  const keybindings: Record<string, string> = {};
  for (const chosen of [true, false]) for (const c of commands) if (c.chosen === chosen) for (const chord of c.chords) keybindings[chord] ??= c.id;
  const conflicts = commands
    .filter((c) => c.chosen)
    .flatMap((c) =>
      c.chords.flatMap((chord) => {
        const others = commands.filter((o) => o.id !== c.id && o.chords.includes(chord));
        if (!others.length) return [];
        const runs = commands.find((o) => o.id === keybindings[chord])!;
        const keyless = others.filter((o) => !Object.values(keybindings).includes(o.id)).map((o) => ` ${o.title} is left with no key.`);
        return [{ commandId: c.id, reason: `${chord} is also the key for ${others.map((o) => `${o.title} (${o.id})`).join(" and ")}. It runs ${runs.title}.${keyless.join("")}` }];
      }),
    );
  return { keybindings, conflicts };
}

export const chordFor = (commandId: string, bindings: Readonly<Record<string, string>>) => Object.keys(bindings).find((chord) => bindings[chord] === commandId);

const SYMBOLS: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const WORDS: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift" };

/** A chord as a person reads it: `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere. */
export function chordLabel(chord: string, mac: boolean) {
  const keys = onPlatform(chord, mac).split("+");
  const key = keys.pop()!.toUpperCase();
  return mac ? `${keys.reverse().map((k) => SYMBOLS[k]).join("")}${key}` : [...keys.map((k) => WORDS[k]), key].join("+");
}
