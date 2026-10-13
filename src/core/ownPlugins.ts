import { OwnManifest, type Manifest } from "./plugins.ts";

/*
 * The plugins that come with Common Ink and run shut off from it, in the frames a third-party
 * plugin runs in, over the same port and to the same address on the server. Their manifests are
 * here, in the core, because the server holds each to what its manifest declares, as it holds an
 * installed plugin to what an admin allowed. What they declare is allowed from the start: they come
 * with the app, so there is nobody to ask. Their code is the app's, in `src/web/plugins/sandboxed/`.
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
    views: [{ slot: "bar", id: "quick-timer", label: "Quick timer", width: 200 }],
  },
  backlinks: {
    name: "Backlinks",
    description: "The notes that link to the open note, in the inspector.",
    icon: "backlinks",
    capabilities: [{ name: "notes.read", reason: "It lists the notes that link to the one you have open, and opens the one you pick." }],
    views: [{ slot: "inspector", id: "backlinks", label: "Backlinks", icon: "backlinks" }],
  },
} as const;

export type OwnSandboxedId = keyof typeof DECLARED;
export const OWN_SANDBOXED_IDS = Object.keys(DECLARED) as [OwnSandboxedId, ...OwnSandboxedId[]];

/** Each one's manifest, read by the schema every manifest is read by. */
export const OWN_SANDBOXED: Readonly<Record<OwnSandboxedId, Manifest>> = Object.fromEntries(OWN_SANDBOXED_IDS.map((id) => [id, OwnManifest.parse(DECLARED[id])])) as Record<OwnSandboxedId, Manifest>;

export const ownSandboxed = (id: string): Manifest | null => (Object.hasOwn(OWN_SANDBOXED, id) ? OWN_SANDBOXED[id as OwnSandboxedId] : null);
