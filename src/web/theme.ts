export type Theme = "light" | "dark";

/** Asked for when it is wanted and not as this is loaded, which may be where there is no window. */
const device = () => matchMedia("(prefers-color-scheme: dark)");

/** The theme the app is drawn in now: the member's setting, or the device's choice where the setting leaves it to the device. */
export function themeNow(): Theme {
  const set = document.documentElement.dataset.theme;
  return set === "light" || set === "dark" ? set : device().matches ? "dark" : "light";
}

/** Calls `changed` each time the app goes from one theme to the other. Returns how to stop. */
export function onTheme(changed: (theme: Theme) => void): () => void {
  let was = themeNow();
  const look = () => {
    const now = themeNow();
    if (now !== was) changed((was = now));
  };
  const setting = new MutationObserver(look);
  setting.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const devices = device();
  devices.addEventListener("change", look);
  return () => {
    setting.disconnect();
    devices.removeEventListener("change", look);
  };
}
