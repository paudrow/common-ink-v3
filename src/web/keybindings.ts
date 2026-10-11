interface Pressed {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The keys whose own character is what keys are written with: a chord is joined with + and a sequence is spaced. */
const NAMED: Record<string, string> = { " ": "space", "+": "plus" };

/** A key press written the way a command writes its keys: modifiers in the order mod, alt, shift, then the key. `mod` is ⌘ or Ctrl. */
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

const MODIFIERS = ["mod", "alt", "shift"];

/** A chord as a member wrote it, put the way `chordOf` writes a key press, or why it isn't one. */
export function readChord(text: string): { chord: string } | { reason: string } {
  const parts = text.toLowerCase().split("+").map((part) => part.trim());
  const key = parts.pop()!;
  const stray = parts.find((part) => !MODIFIERS.includes(part));
  if (stray !== undefined) return { reason: `"${stray}" in "${text}" isn't a modifier. Use mod, alt, or shift, then one key` };
  if (!key || MODIFIERS.includes(key)) return { reason: `"${text}" has no key after its modifiers` };
  if (/\s/.test(key)) return { reason: `"${text}" isn't one key. Join a chord with +, such as mod+shift+k` };
  if (new Set(parts).size < parts.length) return { reason: `"${text}" names a modifier twice` };
  if (!parts.includes("mod") && !parts.includes("alt") && key !== "escape" && !/^f\d{1,2}$/.test(key)) return { reason: `"${text}" would run while typing. Add mod or alt, which only Escape and the F keys go without` };
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
