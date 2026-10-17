import { chordLabel, onPlatform, overlap } from "./keybindings.ts";
import type { MemberSettings } from "./pluginHost.ts";
import { KEYBINDING, type Declared, type Problem, type SettingsDocument } from "./settings.ts";

/** One entry in the list down the left of the Settings page, and the settings it holds. */
export interface Category {
  /** What follows `/settings/` in its address. */
  id: string;
  name: string;
  /** The plugin whose options these are, which the list puts under "Plugins". Null for the app's own. */
  pluginId: string | null;
  rows: readonly Declared[];
}

/** One command in the keyboard shortcuts table. */
export interface Shortcut {
  commandId: string;
  title: string;
  /** The setting that holds its chords. */
  key: string;
  /** The chords that run it now. */
  chords: readonly string[];
  defaults: readonly string[];
  /** Whether the member's document says anything of it, valid or not. */
  yours: boolean;
  problems: readonly Problem[];
}

export interface Layout {
  categories: readonly Category[];
  shortcuts: readonly Shortcut[];
}

export interface Filter {
  /** What was typed in the search box, trimmed and in lower case. */
  needle: string;
  /** Whether only what the member changed from its default is shown. */
  modified: boolean;
}

export const KEYBOARD = { id: "keyboard", name: "Keyboard shortcuts" } as const;
export const UNKNOWN = { id: "unknown", name: "Not recognized" } as const;
/** Who is signed in, and signing out everywhere. It is the person's, in every workspace, and no setting. */
export const ACCOUNT = { id: "account", name: "Account" } as const;
const GENERAL = { id: "general", name: "General" };

/** The app's own settings, by the category each is listed under. One that is in no row is under General. */
const OWN: readonly { id: string; name: string; keys: readonly string[] }[] = [
  { id: "editor", name: "Editor", keys: ["core.editorFont", "core.editorFontFamily", "core.editorTextSize", "core.editorLineHeight", "core.editorReadingWidth"] },
  { id: "appearance", name: "Appearance", keys: ["core.theme", "core.textSize"] },
];

/** The id of the app's own plugin, whose settings are split among {@link OWN}. */
const APP = "core";

const isKeybinding = (d: Declared) => d.key.startsWith(KEYBINDING);

/**
 * The settings in their categories, in the order of the list: the app's own, then each plugin that
 * declares options. A plugin's switch is the Plugins page's and keybindings have their own table,
 * so neither is in any category.
 */
export function categoriesOf(declared: readonly Declared[]): Category[] {
  const categories = new Map<string, Category & { rows: Declared[] }>();
  const into = (id: string, name: string, pluginId: string | null, d?: Declared) => {
    if (!categories.has(id)) categories.set(id, { id, name, pluginId, rows: [] });
    if (d) categories.get(id)!.rows.push(d);
  };
  for (const own of OWN) into(own.id, own.name, null);
  for (const d of declared) {
    if (d.switch || isKeybinding(d)) continue;
    const own = OWN.find((o) => o.keys.includes(d.key)) ?? (d.group.id === APP ? GENERAL : null);
    if (own) into(own.id, own.name, null, d);
    else into(`plugins/${d.group.id}`, d.group.name, d.group.id, d);
  }
  const all = [...categories.values()].filter((c) => c.rows.length > 0);
  return [...all.filter((c) => c.pluginId === null), ...all.filter((c) => c.pluginId !== null)];
}

/** Every command there is, with the chords that run it and whether they are the member's. */
export function shortcutsOf({ declared, values, problems, document }: MemberSettings): Shortcut[] {
  return declared.filter(isKeybinding).map((d) => ({
    commandId: d.key.slice(KEYBINDING.length),
    title: d.setting.title,
    key: d.key,
    chords: values[d.key] as readonly string[],
    defaults: d.setting.default as readonly string[],
    yours: Object.hasOwn(document, d.key),
    problems: problems.filter((p) => p.key === d.key),
  }));
}

export const layoutOf = (settings: MemberSettings): Layout => ({ categories: categoriesOf(settings.declared), shortcuts: shortcutsOf(settings) });

const has = (needle: string, ...texts: (string | undefined)[]) => texts.some((text) => text?.toLowerCase().includes(needle));

/** What the layout holds of what is searched for: a setting by its title, key, description or category, and a shortcut by its command or its keys, as written or as read. */
export function filterLayout({ categories, shortcuts }: Layout, { needle, modified }: Filter, document: SettingsDocument, mac: boolean): Layout {
  const setting = (c: Category, d: Declared) => (!modified || Object.hasOwn(document, d.key)) && (!needle || has(needle, d.setting.title, d.key, d.setting.description, c.name));
  const shortcut = (s: Shortcut) => (!modified || s.yours) && (!needle || has(needle, s.title, s.commandId, ...s.chords, ...s.chords.map((chord) => chordLabel(chord, mac))));
  return {
    categories: categories.map((c) => ({ ...c, rows: c.rows.filter((d) => setting(c, d)) })).filter((c) => c.rows.length > 0),
    shortcuts: shortcuts.filter(shortcut),
  };
}

/** The other commands a chord already runs or is written for, which recording it for `commandId` would take it from or share it with. */
export const holdersOf = (chord: string, shortcuts: readonly Shortcut[], commandId: string, mac: boolean): Shortcut[] =>
  shortcuts.filter((s) => s.commandId !== commandId && s.chords.some((held) => onPlatform(held, mac) === onPlatform(chord, mac)));

/** The other commands whose keys these would begin, or go on from: where both can run, only the shorter keys ever do. */
export const overlapsOf = (keys: string, shortcuts: readonly Shortcut[], commandId: string, mac: boolean): { shortcut: Shortcut; keys: string; how: "begins" | "follows" }[] =>
  shortcuts
    .filter((s) => s.commandId !== commandId)
    .flatMap((shortcut) =>
      shortcut.chords.flatMap((held) => {
        const how = overlap(onPlatform(keys, mac), onPlatform(held, mac));
        return how === "begins" || how === "follows" ? [{ shortcut, keys: held, how }] : [];
      }),
    );
