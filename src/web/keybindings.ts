interface Pressed {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIERS = ["mod", "ctrl", "alt", "shift"];
/** The keys whose own character is what keys are written with: a chord is joined with + and a sequence is spaced. */
const NAMED: Record<string, string> = { " ": "space", "+": "plus" };

/**
 * A key press written the way a command writes its keys: modifiers in the order mod, ctrl, alt,
 * shift, then the key. `mod` is ⌘ on a Mac and Ctrl elsewhere. `ctrl` is the Control key, which
 * only a Mac tells apart from `mod`. Off a Mac the Windows key is `meta`, which no chord has.
 */
export const chordOf = (e: Pressed, mac: boolean) =>
  [(mac ? e.metaKey : e.ctrlKey) && "mod", mac ? e.ctrlKey && "ctrl" : e.metaKey && "meta", e.altKey && "alt", e.shiftKey && "shift", NAMED[e.key] ?? e.key.toLowerCase()].filter(Boolean).join("+");

/**
 * A command's keys as this platform's key presses are written: off a Mac, `ctrl` is `mod`. Keys may
 * be several chords pressed one after another, written with spaces between them, such as `g g`.
 */
export function onPlatform(keys: string, mac: boolean) {
  if (mac) return keys;
  return keys
    .split(" ")
    .map((chord) => {
      const parts = chord.split("+").map((part) => (part === "ctrl" ? "mod" : part));
      const key = parts.pop()!;
      return [...MODIFIERS.filter((m) => parts.includes(m)), key].join("+");
    })
    .join(" ");
}

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
 * Whether a press of these keys would otherwise type: the chord they begin with has no mod, ctrl or
 * alt in it and is neither Escape nor an F key. Such keys are left to whatever is being typed in,
 * unless their command says for itself when it runs.
 */
export function typed(keys: string) {
  const parts = keys.split(" ")[0]!.split("+");
  const key = parts.pop()!;
  return !parts.some((part) => part !== "shift") && key !== "escape" && !/^f\d{1,2}$/.test(key);
}

/**
 * A command's keys as a member wrote them, put the way `chordOf` writes key presses, or why they
 * aren't keys. They are what the app runs a command on: one chord, with or without a modifier, or
 * several pressed one after another, written with spaces between them.
 */
export function readKeys(text: string): { keys: string } | { reason: string } {
  const written = text.toLowerCase().trim().replace(/\s*\+\s*/g, "+").split(/\s+/);
  const chords: string[] = [];
  for (const chord of written) {
    const within = written.length > 1 ? `"${chord}" in "${text}"` : `"${text}"`;
    const parts = chord.split("+");
    const key = parts.pop()!;
    const stray = parts.find((part) => !MODIFIERS.includes(part));
    if (stray !== undefined) return { reason: `"${stray}" in "${text}" isn't a modifier. Use mod, ctrl, alt, or shift, then one key` };
    if (!key || MODIFIERS.includes(key)) return { reason: `${within} has no key after its modifiers` };
    if (new Set(parts).size < parts.length) return { reason: `${within} names a modifier twice` };
    chords.push([...MODIFIERS.filter((m) => parts.includes(m)), key].join("+"));
  }
  return { keys: chords.join(" ") };
}

/** How one command's keys stand to another's: the same, or the first keys of the other's sequence, or going on from the other's. */
export const overlap = (keys: string, others: string): "same" | "begins" | "follows" | null =>
  keys === others ? "same" : others.startsWith(`${keys} `) ? "begins" : keys.startsWith(`${others} `) ? "follows" : null;

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
 * Keys the member chose that are the first keys of another command's sequence, or go on from
 * another's keys, are a conflict too: the shorter keys run on their last press, so the longer never do.
 */
export function bind(commands: readonly Bindable[]) {
  const keybindings: Record<string, string> = {};
  for (const chosen of [true, false]) for (const c of commands) if (c.chosen === chosen) for (const chord of c.chords) keybindings[chord] ??= c.id;
  const conflicts = commands
    .filter((c) => c.chosen)
    .flatMap((c) =>
      c.chords.flatMap((chord) => {
        const found: { commandId: string; reason: string }[] = [];
        const others = commands.filter((o) => o.id !== c.id);
        const same = others.filter((o) => o.chords.includes(chord));
        if (same.length) {
          const runs = commands.find((o) => o.id === keybindings[chord])!;
          const keyless = same.filter((o) => !Object.values(keybindings).includes(o.id)).map((o) => ` ${o.title} is left with no key.`);
          found.push({ commandId: c.id, reason: `${chord} is also the key for ${same.map((o) => `${o.title} (${o.id})`).join(" and ")}. It runs ${runs.title}.${keyless.join("")}` });
        }
        const standing = (how: "begins" | "follows") => others.flatMap((o) => o.chords.filter((held) => overlap(chord, held) === how).map((held) => ({ held, o })));
        const longer = standing("begins");
        if (longer.length) {
          const named = longer.map(({ held, o }) => `${held}, the keys for ${o.title} (${o.id})`).join(", and of ");
          found.push({ commandId: c.id, reason: `${chord} is the first key of ${named}. Where both can run, ${chord} runs ${commands.find((o) => o.id === keybindings[chord])!.title} and the longer keys never run.` });
        }
        for (const { held, o } of standing("follows")) found.push({ commandId: c.id, reason: `${chord} begins with ${held}, the key for ${o.title} (${o.id}). Where both can run, ${held} runs ${commands.find((r) => r.id === keybindings[held])!.title} and ${chord} never runs.` });
        return found;
      }),
    );
  return { keybindings, conflicts };
}

export const chordFor = (commandId: string, bindings: Readonly<Record<string, string>>) => Object.keys(bindings).find((chord) => bindings[chord] === commandId);

const SYMBOLS: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const WORDS: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift" };

/** A command's keys as a person reads them: `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere, and `G G` for one chord after another. */
export function chordLabel(keys: string, mac: boolean) {
  return onPlatform(keys, mac)
    .split(" ")
    .map((chord) => {
      const parts = chord.split("+");
      const key = parts.pop()!.toUpperCase();
      return mac ? `${parts.reverse().map((k) => SYMBOLS[k]).join("")}${key}` : [...parts.map((k) => WORDS[k]), key].join("+");
    })
    .join(" ");
}
