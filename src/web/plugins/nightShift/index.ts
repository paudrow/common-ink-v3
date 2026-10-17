import type { Plugin } from "../../plugin-api.ts";
import { STRENGTHS, nightTokens, tintMatrix, type Strength } from "./theme.ts";

const SVG = "http://www.w3.org/2000/svg";
/** The id of the filter the stylesheet tints pictures with. */
const FILTER = "night-shift-tint";

/**
 * The tint's filter, in a hidden `<svg>` at the end of the page. An SVG filter is what lets the tint have no blue in it
 * whatever the picture holds: a CSS `sepia()` or `hue-rotate()` leaves some.
 */
function tintFilter() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  const filter = svg.appendChild(document.createElementNS(SVG, "filter"));
  filter.id = FILTER;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const matrix = filter.appendChild(document.createElementNS(SVG, "feColorMatrix"));
  matrix.setAttribute("type", "matrix");
  document.body.append(svg);
  return { set: (strength: Strength) => matrix.setAttribute("values", tintMatrix(strength)), remove: () => svg.remove() };
}

/**
 * A red-on-black theme for the night, on top of the light or the dark one. It is the design tokens set on the page's root, so
 * everything drawn from them follows, and `data-night-shift` on the root for the few things the stylesheet colors by hand.
 * Turning it off takes both away and leaves the theme the member had, as it was.
 */
export const nightShift: Plugin = {
  id: "night-shift",
  name: "Night shift",
  description: "A red-on-black theme for the night, over the light or dark theme. Turn it on and off by hand with a command and a key.",
  icon: "moon",
  enabledByDefault: false,
  settings: {
    on: {
      type: "boolean",
      default: true,
      remembered: true,
      title: "Night shift is on",
      description: "Whether the theme is on right now. The command Toggle night shift changes it, and so does its key.",
    },
    strength: {
      type: "string",
      default: "red",
      enum: STRENGTHS,
      title: "Strength",
      description: "From deep red, which is red light and nothing else, to warm amber, which lets some green in. Neither has any blue.",
    },
    tint: {
      type: "boolean",
      default: false,
      title: "Tint pictures, videos and embeds",
      description: "Colors pictures and videos red too. A frame from another site can't be changed inside, so it is covered with a red tint that lets clicks through.",
    },
  },
  activate(host) {
    const root = document.documentElement;
    const tokens = Object.keys(nightTokens("red"));
    const filter = tintFilter();

    const clear = () => {
      for (const token of tokens) root.style.removeProperty(token);
      root.style.removeProperty("color-scheme");
      delete root.dataset.nightShift;
      delete root.dataset.nightTint;
      // The page had no style attribute, and has none again.
      if (!root.getAttribute("style")) root.removeAttribute("style");
    };
    const apply = () => {
      const strength = host.settings.get<Strength>("strength");
      filter.set(strength);
      if (!host.settings.get<boolean>("on")) return clear();
      for (const [token, value] of Object.entries(nightTokens(strength))) root.style.setProperty(token, value);
      root.style.setProperty("color-scheme", "dark");
      root.dataset.nightShift = strength;
      if (host.settings.get<boolean>("tint")) root.dataset.nightTint = "";
      else delete root.dataset.nightTint;
    };

    host.commands.register({
      id: "nightShift.toggle",
      title: "Toggle night shift",
      keys: ["mod+shift+x"],
      group: "Night shift",
      run() {
        if (!host.settings.set("on", !host.settings.get<boolean>("on"))) host.app().notify({ message: "Night shift can't be changed until your settings have loaded.", icon: "moon" });
      },
    });

    // Not at once: reading a setting while the plugin is starting has the host list what it adds before it is running, and its options are then shown as off.
    let stopped = false;
    queueMicrotask(() => !stopped && apply());
    host.settings.subscribe(apply);
    return () => {
      stopped = true;
      clear();
      filter.remove();
    };
  },
};
