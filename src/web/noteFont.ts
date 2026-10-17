/** How long a note waits for its font to load before it is drawn without it. */
const FONT_WAIT_MS = 1000;

/**
 * Settles once the face a note's text is set in has loaded, or has been waited for long enough. Text
 * drawn in a stand-in and then in the face would move as it arrived, and a measure taken in one would
 * be wrong in the other. A face on this device, or one already loaded, settles at once.
 */
export function fontLoaded(): Promise<unknown> {
  // The first family named is the one chosen; the rest stand in for it.
  const family = getComputedStyle(document.documentElement).getPropertyValue("--editor-font").split(",")[0]!.trim();
  if (!family || family.startsWith("var(")) return Promise.resolve();
  const loading = Promise.all(["400 1em", "700 1em"].map((face) => document.fonts.load(`${face} ${family}`).catch(() => [])));
  return Promise.race([loading, new Promise((done) => setTimeout(done, FONT_WAIT_MS))]);
}
