import { askSite, type Plugin } from "../../plugin-api.ts";
import { isNight } from "./sun.ts";
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
  description: "A red-on-black theme for the night, over the light or dark theme. Turn it on and off by hand, or let a place you set turn it on from sunset to sunrise.",
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
    follow: {
      type: "boolean",
      default: false,
      remembered: true,
      title: "Follow the night",
      description: "Turns night shift on from sunset to sunrise at the place below. Off, the toggle and its key decide, and this never asks the browser where it is.",
    },
    place: {
      type: "string",
      default: "",
      remembered: true,
      title: "Place",
      description: "A city, set once. Follow the night uses its sunset and sunrise.",
    },
  },
  activate(host) {
    const tokens = Object.keys(nightTokens("red"));
    // Made the first time the theme goes on, so a plugin that is on and never shown touches nothing on the page.
    let filter: ReturnType<typeof tintFilter> | null = null;

    const clear = () => {
      const root = document.documentElement;
      for (const token of tokens) root.style.removeProperty(token);
      root.style.removeProperty("color-scheme");
      delete root.dataset.nightShift;
      delete root.dataset.nightTint;
      // The page had no style attribute, and has none again.
      if (!root.getAttribute("style")) root.removeAttribute("style");
    };
    let place = "";
    let coords: { lat: number; lon: number } | null = null;
    let looking = 0;
    const locate = () => {
      const name = host.settings.get<string>("place").trim();
      if (name === place) return;
      place = name;
      coords = null;
      if (!name) return;
      const round = ++looking;
      void askSite(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`).then((body) => {
        if (round !== looking) return;
        const hit = (body as { results?: { latitude: number; longitude: number }[] } | null)?.results?.[0];
        coords = hit ? { lat: hit.latitude, lon: hit.longitude } : null;
        apply();
      });
    };
    const apply = () => {
      const strength = host.settings.get<Strength>("strength");
      const following = host.settings.get<boolean>("follow") && coords !== null;
      const on = following && coords ? isNight(coords.lat, coords.lon, new Date()) : host.settings.get<boolean>("on");
      if (!on) return clear();
      (filter ??= tintFilter()).set(strength);
      const root = document.documentElement;
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
    const refresh = () => {
      locate();
      apply();
    };
    queueMicrotask(() => !stopped && refresh());
    host.settings.subscribe(refresh);
    const clock = setInterval(() => !stopped && apply(), 60_000);
    return () => {
      stopped = true;
      clearInterval(clock);
      clear();
      filter?.remove();
    };
  },
};
