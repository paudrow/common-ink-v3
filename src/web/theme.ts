export type Theme = "light" | "dark";

/** Asked for when it is wanted and not as this is loaded, which may be where there is no window. */
const device = () => matchMedia("(prefers-color-scheme: dark)");

/** The theme the app is drawn in now: dark while night shift is on, otherwise the member's setting, or the device's choice where the setting leaves it to the device. */
export function themeNow(): Theme {
  if (document.documentElement.dataset.nightShift !== undefined) return "dark";
  const set = document.documentElement.dataset.theme;
  return set === "light" || set === "dark" ? set : device().matches ? "dark" : "light";
}

/** The theme, and night shift's strength while it is on. */
const lookNow = () => `${themeNow()} ${document.documentElement.dataset.nightShift ?? ""}`;

/** Calls `changed` each time the app's look changes: from one theme to the other, or night shift going on, off or to another strength. Returns how to stop. */
export function onLook(changed: () => void): () => void {
  let was = lookNow();
  const look = () => {
    const now = lookNow();
    if (now === was) return;
    was = now;
    changed();
  };
  const setting = new MutationObserver(look);
  setting.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-night-shift"] });
  const devices = device();
  devices.addEventListener("change", look);
  return () => {
    setting.disconnect();
    devices.removeEventListener("change", look);
  };
}

/** Calls `changed` each time the app goes from one theme to the other. Returns how to stop. */
export function onTheme(changed: (theme: Theme) => void): () => void {
  let was = themeNow();
  return onLook(() => {
    const now = themeNow();
    if (now !== was) changed((was = now));
  });
}

/**
 * Keeps the window's own color the app's background, night shift's included. A browser and an installed app paint the title bar,
 * and the picture the system keeps of the window, from `<meta name="theme-color">`, which `index.html` sets for the device's
 * light or dark and nothing else. Each of those tags is given the background, so whichever the device picks is the app's.
 * It follows the theme and night shift, which are all that set the root's background.
 */
export function followWindowColor(): () => void {
  const paint = () => {
    const background = getComputedStyle(document.documentElement).backgroundColor;
    // Before the stylesheet applies there is none, and the page's own tags are better than a clear one.
    if (background === "rgba(0, 0, 0, 0)") return;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = background;
  };
  paint();
  return onLook(paint);
}
