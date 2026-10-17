import type { Setting, SettingValue } from "./plugin-api.ts";

/** The fonts a note's text can be set in, by the name the member picks, and the CSS family each is. The bundled ones are the app's own files, under `public/fonts`. */
export const FONTS = {
  "iA Writer Mono": '"iA Writer Mono", var(--mono)',
  "IBM Plex Mono": '"IBM Plex Mono", var(--mono)',
  "Source Serif": '"Source Serif 4", Georgia, serif',
  "System sans": "var(--prose)",
  Custom: null,
} as const satisfies Record<string, string | null>;

export type FontName = keyof typeof FONTS;
export const FONT_NAMES = Object.keys(FONTS) as FontName[];
/** The family the bundled font named is loaded as, for the ones that are files of the app's. */
export const BUNDLED: Partial<Record<FontName, string>> = { "iA Writer Mono": "iA Writer Mono", "IBM Plex Mono": "IBM Plex Mono", "Source Serif": "Source Serif 4" };

/** iA Writer Mono, unless the app was built to start in another, as the browser tests are once for each font (`VITE_EDITOR_FONT`). */
const DEFAULT_FONT: FontName = FONT_NAMES.find((name) => name === import.meta.env.VITE_EDITOR_FONT) ?? "iA Writer Mono";

/** The app's own settings for how text looks, under `core.`. */
export const LOOK_SETTINGS = {
  textSize: {
    type: "integer",
    default: 100,
    minimum: 80,
    maximum: 150,
    title: "Text size",
    description: "The size of text across the app, as a percentage: menus, Settings, lists, pages and panels. A note's text follows it unless Editor text size is set.",
  },
  editorTextSize: {
    type: "integer",
    default: 100,
    minimum: 75,
    maximum: 200,
    title: "Editor text size",
    follows: { key: "core.textSize", title: "Text size" },
    description: "The size of a note's text, as a percentage. Until you set it, it is your Text size; once set, it is this whatever the Text size.",
  },
  editorFont: {
    type: "string",
    default: DEFAULT_FONT,
    enum: FONT_NAMES,
    title: "Font",
    description: "The font of a note's text and its headings. Code keeps a monospaced font. Custom uses Custom font.",
  },
  editorFontFamily: {
    type: "string",
    default: "",
    maxLength: 200,
    title: "Custom font",
    description: 'A CSS font-family list for a note\'s text when Font is Custom, such as "Georgia", serif. A font installed on this device works. Empty is the system font.',
  },
  editorLineHeight: { type: "number", default: 1.4, minimum: 1, maximum: 3, title: "Line height", description: "The height of a line of a note's text, as a multiple of its size." },
  editorReadingWidth: { type: "integer", default: 736, minimum: 400, maximum: 2400, title: "Reading width", description: "The most a note's column is across, in pixels. A narrower window makes it narrower still." },
} as const satisfies Record<string, Setting>;

type Key = `core.${keyof typeof LOOK_SETTINGS}`;

/**
 * The CSS custom properties the look settings come to, set on the page's root. `chosen` says whether
 * the member set the editor's text size themselves: until they do, it is the app's.
 */
export function lookOf(values: Readonly<Record<string, SettingValue>>, chosen: (key: string) => boolean): Record<string, string> {
  const value = <T extends SettingValue>(key: Key) => values[key] as T;
  const font = value<string>("core.editorFont") as FontName;
  const custom = value<string>("core.editorFontFamily").trim();
  const text = value<number>("core.textSize");
  const editor = chosen("core.editorTextSize") ? value<number>("core.editorTextSize") : text;
  return {
    "--text-scale": String(text / 100),
    "--editor-text-scale": String(editor / 100),
    "--editor-font": FONTS[font] ?? (custom ? `${custom}, var(--prose)` : "var(--prose)"),
    "--editor-line-height": String(value<number>("core.editorLineHeight")),
    "--editor-width": `${value<number>("core.editorReadingWidth")}px`,
  };
}
