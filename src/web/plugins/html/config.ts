import { EMBED_SCHEMAS, optionValues } from "../../plugin-api.ts";

/** How tall the note says the embed is, in pixels: `height=480` in its config, within 40 to 2000, or the usual. */
export function heightIn(config: string): number {
  return Number(optionValues(EMBED_SCHEMAS.html!.keys, config).height);
}
