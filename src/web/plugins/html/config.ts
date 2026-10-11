export const DEFAULT_HEIGHT = 320;

/** How tall the note says the embed is, in pixels: `height=480` in its config. */
export function heightIn(config: string): number {
  const asked = Number(/(?:^|\s)height=(\d{1,5})(?:\s|$)/.exec(config)?.[1]);
  return asked ? Math.min(Math.max(asked, 40), 2000) : DEFAULT_HEIGHT;
}
