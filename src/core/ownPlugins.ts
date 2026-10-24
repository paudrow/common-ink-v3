import { OwnManifest, type InstalledPlugin, type Manifest } from "./plugins.ts";

/*
 * The plugins that come with Common Ink and run shut off from it, in the frames a third-party
 * plugin runs in, over the same port and to the same address on the server. Their manifests are
 * here, in the core, because the server holds each to what its manifest declares, as it holds an
 * installed plugin to what an admin allowed. What they declare is allowed from the start: they come
 * with the app, so there is nobody to ask. Their code is the app's, in `src/web/plugins/sandboxed/`.
 * Some are demos, there to show what a plugin can do: that is the app's to know, and no part of a manifest.
 */
const DECLARED = {
  "word-count": {
    name: "Word count",
    description: "The word count and reading time of the note in front, in the bottom bar. Select some of it to count just that.",
    icon: "text",
    capabilities: [{ name: "notes.read", reason: "It counts the words of the note in front, as you type, and of what you select in it." }],
    views: [{ slot: "bar", id: "word-count", label: "Word count", width: 260, end: true }],
  },
  "quick-timer": {
    name: "Quick timer",
    description: "A timer that belongs to no note, started from the command palette.",
    icon: "clock",
    commands: [
      { id: "start", title: "Start a quick timer…" },
      { id: "stop", title: "Stop the quick timer" },
    ],
    views: [{ slot: "bar", id: "quick-timer", label: "Quick timer", width: 200, live: true }],
  },
  weather: {
    demo: true,
    name: "Weather",
    description: "The weather where you are, as a panel on the Dashboard. It asks for this browser's location when you add it, and a place you type is used when you decline.",
    icon: "today",
    capabilities: [{ name: "network", reason: "It looks up the city for this browser's place, a place you name, and the weather there, and reaches no other site.", origins: ["https://geocoding-api.open-meteo.com", "https://api.open-meteo.com", "https://api.bigdatacloud.net"] }],
    views: [{ slot: "dashboard", id: "weather", label: "Weather" }],
  },
  "sample-calendar": {
    demo: true,
    name: "Sample calendar",
    description: "A sample day in the inspector, on the right, so a calendar widget can be tried without a connected calendar.",
    icon: "calendar",
    views: [{ slot: "inspector", id: "day", label: "Sample calendar", icon: "calendar" }],
  },
  coin: {
    demo: true,
    name: "Coin",
    description: "A coin in the bottom bar. Press it to flip.",
    icon: "command",
    views: [{ slot: "bar", id: "coin", label: "Coin", width: 72 }],
  },
  dice: {
    demo: true,
    name: "Dice",
    description: "A die you roll, on its own page under More.",
    icon: "play",
    views: [{ slot: "page", id: "dice", label: "Dice", icon: "play" }],
  },
} as const;

export type OwnSandboxedId = keyof typeof DECLARED;
export const OWN_SANDBOXED_IDS = Object.keys(DECLARED) as [OwnSandboxedId, ...OwnSandboxedId[]];

const declared = (id: OwnSandboxedId): { name: string; demo?: true } => DECLARED[id];

/** Each one's manifest, read by the schema every manifest is read by. */
export const OWN_SANDBOXED: Readonly<Record<OwnSandboxedId, Manifest>> = Object.fromEntries(
  OWN_SANDBOXED_IDS.map((id) => {
    const { demo, ...manifest } = declared(id);
    return [id, OwnManifest.parse(manifest)];
  }),
) as Record<OwnSandboxedId, Manifest>;

const DEMOS: ReadonlySet<string> = new Set(OWN_SANDBOXED_IDS.filter((id) => declared(id).demo));

/** Whether a plugin is on for a member who hasn't turned it on or off: the app's own are, but its demos only on a development server or a Preview. */
export const onByDefault = ({ id, thirdParty }: Pick<InstalledPlugin, "id" | "thirdParty">, dev: boolean): boolean => !thirdParty && (dev || !DEMOS.has(id));

export const ownSandboxed = (id: string): Manifest | null => (Object.hasOwn(OWN_SANDBOXED, id) ? OWN_SANDBOXED[id as OwnSandboxedId] : null);
