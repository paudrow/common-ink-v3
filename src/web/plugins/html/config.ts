import { optionValues, type DeclaredOption } from "../../plugin-api.ts";

export const DEFAULT_HEIGHT = 320;

/** The HTML embed's one option, declared: the app draws its field and writes `height=480` into the config. */
export const HTML_OPTIONS: readonly DeclaredOption[] = [{ type: "number", id: "height", label: "Height", min: 40, max: 2000, step: 1, default: DEFAULT_HEIGHT }];

/** How tall the note says the embed is, in pixels: `height=480` in its config, within 40 to 2000, or the usual. */
export function heightIn(config: string): number {
  return Number(optionValues(HTML_OPTIONS, config).height);
}
