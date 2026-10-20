import { readKeys } from "./keybindings.ts";
import type { Setting, SettingValue } from "./plugin-api.ts";

/** A member's settings as they wrote them: any JSON object. Only some of its keys are settings. */
export type SettingsDocument = Readonly<Record<string, unknown>>;

/** The start of the key that holds a command's chords, followed by the command's id. */
export const KEYBINDING = "keybindings.";

/** One setting in the schema: its key in the document, and who declared it. */
export interface Declared {
  key: string;
  setting: Setting;
  /** What it is shown under: the plugin that declared it, or Keybindings. */
  group: { id: string; name: string };
  /** False when its plugin is off, so it changes nothing for now. */
  active: boolean;
  /** True for the setting that turns its plugin on and off, which is the Plugins page's to show and no part of the Settings page. */
  switch?: true;
}

export interface Problem {
  key: string;
  /** An invalid value is left out and the default used. An unknown key does nothing. A conflict is flagged and still applies. */
  kind: "invalid" | "unknown" | "conflict";
  reason: string;
}

export interface Resolved {
  /** Every declared setting's value: the member's where it is valid, the default otherwise (or what the setting says an unreadable value reads as). */
  values: Readonly<Record<string, SettingValue>>;
  problems: readonly Problem[];
  /** The keys whose value is the member's. */
  chosen: ReadonlySet<string>;
}

const shown = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/** The value a setting takes from what the member wrote for it, or why it can't. */
export function readSetting(setting: Setting, value: unknown): { value: SettingValue } | { reason: string } {
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean" ? { value } : { reason: `Expected true or false, not ${shown(value)}` };
    case "string":
      if (typeof value !== "string") return { reason: `Expected text in quotes, not ${shown(value)}` };
      if (setting.enum && !setting.enum.includes(value)) return { reason: `Expected one of ${setting.enum.map(shown).join(", ")}, not ${shown(value)}` };
      if (setting.maxLength !== undefined && value.length > setting.maxLength) return { reason: `Expected at most ${setting.maxLength} characters` };
      return { value };
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return { reason: `Expected a number, not ${shown(value)}` };
      if (setting.type === "integer" && !Number.isInteger(value)) return { reason: `Expected a whole number, not ${value}` };
      if (setting.minimum !== undefined && value < setting.minimum) return { reason: `Expected ${setting.minimum} or more, not ${value}` };
      if (setting.maximum !== undefined && value > setting.maximum) return { reason: `Expected ${setting.maximum} or less, not ${value}` };
      return { value };
    case "chords": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return { reason: `Expected a list of keys, such as ["mod+k"], not ${shown(value)}` };
      const chords: string[] = [];
      for (const text of value as string[]) {
        const read = readKeys(text);
        if ("reason" in read) return read;
        if (!chords.includes(read.keys)) chords.push(read.keys);
      }
      return { value: chords };
    }
    case "folder":
      return typeof value === "string" ? { value } : { reason: `Expected a folder's id in quotes, not ${shown(value)}` };
    case "list":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return { reason: `Expected a list of words in quotes, such as ["one", "two"], not ${shown(value)}` };
      if (value.length > setting.maxItems) return { reason: `Expected at most ${setting.maxItems} of them` };
      if (value.some((v: string) => v.length > setting.maxLength)) return { reason: `Expected each to be at most ${setting.maxLength} characters` };
      return { value: [...new Set(value as string[])] };
  }
}

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The defaults, overlaid with each value in the document that is valid. One bad key costs only itself. */
export function resolve(declared: readonly Declared[], document: SettingsDocument): Resolved {
  const values: Record<string, SettingValue> = {};
  const problems: Problem[] = [];
  const chosen = new Set<string>();
  for (const { key, setting } of declared) {
    values[key] = setting.default;
    if (!Object.hasOwn(document, key)) continue;
    const read = readSetting(setting, document[key]);
    if ("reason" in read) {
      const unreadable = setting.type === "string" ? setting.unreadable : undefined;
      if (unreadable !== undefined) values[key] = unreadable;
      problems.push({ key, kind: "invalid", reason: `${read.reason}. ${unreadable === undefined ? "The default is used" : `${JSON.stringify(unreadable)} is used`}.` });
    } else {
      values[key] = read.value;
      chosen.add(key);
    }
  }
  // A setting that follows another is that one's value until the member sets it.
  for (const { key, setting } of declared) {
    const follows = setting.type === "number" || setting.type === "integer" ? setting.follows : undefined;
    if (follows && !chosen.has(key) && typeof values[follows.key] === "number") values[key] = values[follows.key]!;
  }
  for (const key of Object.keys(document)) {
    if (Object.hasOwn(values, key)) continue;
    const reason = key.startsWith(KEYBINDING)
      ? `There's no command "${key.slice(KEYBINDING.length)}". It may belong to a plugin that is off.`
      : "There's no setting by this name. It may belong to a plugin that isn't installed.";
    problems.push({ key, kind: "unknown", reason });
  }
  return { values, problems, chosen };
}

/** The document a text holds, or null when it isn't a JSON object. */
export function documentOf(text: string): SettingsDocument | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SettingsDocument) : null;
  } catch {
    return null;
  }
}

/** The document's text with one key set, or taken out when `value` is undefined. Every other key is kept as it was. */
export function editSetting(text: string, key: string, value: unknown): string {
  const document = documentOf(text) ?? {};
  const next = value === undefined ? Object.fromEntries(Object.entries(document).filter(([k]) => k !== key)) : { ...document, [key]: value };
  return JSON.stringify(next, null, 2);
}
