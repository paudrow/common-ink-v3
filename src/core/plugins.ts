import { durationWords, SWATCHES, secondsIn, valueOf } from "./embedOptions.ts";
import { z } from "zod";
import type { OpType } from "./protocol.ts";

/*
 * A third-party plugin as a workspace holds it: a manifest, which is data, and its code, which is
 * text. Everything here is pure. What the workspace keeps of installs, permissions and requests,
 * and who may change it, is in pluginRecord.ts.
 */

/** The most characters a plugin's code may be. */
export const MAX_PLUGIN_CODE = 256_000;
/** The most characters a manifest may be, as JSON. */
export const MAX_PLUGIN_MANIFEST = 16_000;

/**
 * What a plugin can be permitted, and the operations each permission lets it perform. This table is
 * the whole of a plugin's reach: an operation that is in no row is refused to every plugin, whatever
 * it was permitted, and one in a row is refused until that permission is allowed. `network` lets it
 * perform nothing: it is the sites its frames may load from and send to.
 */
export const CAPABILITIES = {
  "notes.read": { title: "Read notes", detail: "The notes and folders you can see, which of them link to a note, and search across them.", ops: ["note.list", "note.read", "note.backlinks", "folder.list", "search", "daily.find"] },
  "notes.write": { title: "Write notes", detail: "Make notes and change the ones you can change. Each change is recorded in History as the plugin's.", ops: ["note.create", "note.write"] },
  "todos.read": { title: "Read todos", detail: "The todos in the notes you can see.", ops: ["todo.list"] },
  "members.read": { title: "Read members' names", detail: "The names and roles of the workspace's members. Never their emails.", ops: ["member.list"] },
  network: { title: "Use the network", detail: "Load from and send to the sites it lists, and no other.", ops: [] },
  /**
   * Not a reach into the workspace but where the code runs: inside the app's page, handed the plugin
   * host the app's own plugins are handed. It names no operation, because nothing in the page can be
   * held to a list. What its member may do is the only limit there is.
   */
  "full-trust": {
    title: "Full trust",
    detail:
      "Run inside Common Ink and not shut off from it. In the session of each member who turns it on it can see and do anything that member can: every note they can open, private ones included, their settings, and what they type. Granting it means this code can act as any member who turns it on, and as you if you turn it on.",
    ops: [],
  },
} as const;

/** The capability that asks to run in the app's page. */
export const FULL_TRUST = "full-trust";

export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as [Capability, ...Capability[]];

/** Each row names operations there are. Said apart from the table, whose names the operations' own schema is made from. */
const OPS: Record<Capability, { ops: readonly OpType[] }> = CAPABILITIES;

/** The operations a plugin may perform with these permissions allowed. */
export const opsAllowedBy = (allowed: Iterable<Capability>): ReadonlySet<OpType> => new Set([...allowed].flatMap((capability) => OPS[capability].ops));

/**
 * A site a frame may reach, as an origin: `https://api.example.com`, with a port if it has one. No
 * path, no wildcard, and `http` only for this machine. It is written into a Content-Security-Policy,
 * so nothing that could end or add to a directive gets through.
 */
export function readOrigin(text: string): string | null {
  if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.origin !== text) return null;
  if (url.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname) && !url.hostname.endsWith(".localhost")) return null;
  return url.origin;
}

export const Origin = z
  .string()
  .max(200)
  .refine((text) => readOrigin(text) !== null, "not a site such as https://api.example.com");
export const Origins = z.array(Origin).min(1).max(10);

const Words = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, "can't contain control or invisible characters, or a line or paragraph separator");

/** Letters of Cyrillic and Greek that are drawn as a Latin letter is, each beside that letter. Capitals and small letters are apart, since В looks like B and в does not. */
const LOOKALIKES: Record<string, string> = Object.fromEntries(
  [
    ["АВЕКМНОРСТХУІЈЅԚԜ", "ABEKMHOPCTXYIJSQW"],
    ["аеорсухіјѕкԛԝһ", "aeopcyxijskqwh"],
    ["ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ", "ABEZHIKMNOPTYX"],
    ["οανικρτυχ", "oavikptux"],
  ].flatMap(([from, to]) => [...from!].map((letter, at) => [letter, to![at]!])),
);

/**
 * What a name looks like, for telling whether two would be read as one: compatibility forms folded
 * (full-width letters, ligatures), accents taken off, Cyrillic and Greek letters that are drawn as
 * Latin ones read as those, case dropped, everything but letters and digits taken out, and `l`, `1`
 * and `0` read as the `i` and `o` they pass for. It covers Latin, Cyrillic and Greek and no other
 * script, so it catches `Сommon Ink` with a Cyrillic С and not every look-alike there is.
 */
export const nameSkeleton = (name: string): string =>
  [...name.normalize("NFKD")]
    // The dotless ı and the long ſ are Latin letters with no compatibility form.
    .map((letter) => (letter === "ı" ? "i" : letter === "ſ" ? "s" : (LOOKALIKES[letter] ?? letter)))
    .join("")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .replace(/[l1]/g, "i")
    .replace(/0/g, "o");

/**
 * Names that are Common Ink's own: the app, its pages, and the plugins that come with it. A
 * third-party plugin can't be installed under one, or under anything that would be read as one.
 * The app checks again against the built-in plugins it actually has, so one added there and not
 * here is still refused when it would start.
 */
export const OWN_NAMES = [
  "Common Ink", "Plugins", "Settings", "Agents", "Archive and Trash", "Backlinks", "Calendar", "Code blocks", "Coin", "Command palette", "Contacts", "Daily notes", "Dashboard", "Dates", "Dice", "Embed menu", "Folders",
  "GitHub-flavored markdown", "HTML embeds", "History", "Kanban", "LaTeX", "Links", "Media embeds", "Members", "Mentions", "Note clocks", "Note info", "Note list", "Outline bullets", "Quick open",
  "Quick timer", "References", "Sample calendar", "Search", "Sharing", "Sidebar", "Stopwatch", "Tables", "Tabs and splits", "Tags", "Timer", "Todos", "Trash", "Upload embeds", "Uploads", "Vim mode", "Weather", "Word count",
];

/** Why `name` can't be a third-party plugin's beside these names of the app's own, or null when it can. */
export function takenName(name: string, own: readonly string[] = OWN_NAMES): string | null {
  const skeleton = nameSkeleton(name);
  if (!skeleton) return "A plugin's name needs a letter or a digit";
  return skeleton.startsWith(nameSkeleton("Common Ink")) || own.some((mine) => nameSkeleton(mine) === skeleton) ? "Its name is one of Common Ink's own, or reads as one" : null;
}

/**
 * The pictures a plugin can stand under on the Plugins page, which the app draws: a manifest names
 * one and never brings its own, so nothing of a plugin's is fetched or drawn as markup there.
 */
export const PLUGIN_ICONS = [
  "plugin", "agent", "at", "backlinks", "board", "calendar", "chevron", "clock", "close", "code", "command", "contacts", "dashboard", "edit", "folders", "history", "info", "inspector", "keyboard", "link", "list",
  "lock", "markdown", "math", "members", "more", "numbers", "outline", "play", "plus", "search", "settings", "share", "sidebar", "slash", "stopwatch", "table", "tabs", "tag", "text", "today", "todos", "trash",
  "uploads",
] as const;
export type PluginIcon = (typeof PLUGIN_ICONS)[number];

/** A name a plugin gives one of its own things: a command, a view, an embed, an option. */
const Local = z.string().regex(/^[a-z][a-zA-Z0-9-]{0,39}$/, "letters, digits and - only, starting with a small letter");

const Declared = z
  .strictObject({
    name: z.enum(CAPABILITY_NAMES),
    /** Why the plugin wants it, in its author's words. It is shown to whoever decides. */
    reason: Words(300),
    /** For `network` only, and required for it: the sites. */
    origins: Origins.optional(),
  })
  .refine((c) => (c.name === "network") === (c.origins !== undefined), "origins are given for network, and only for it");
export type DeclaredCapability = z.output<typeof Declared>;

const Option = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("boolean"), default: z.boolean(), title: Words(80), description: Words(300).optional() }),
  z.strictObject({ type: z.literal("string"), default: z.string().max(1000), enum: z.array(z.string().max(100)).min(1).max(50).optional(), maxLength: z.number().int().min(1).max(10_000).optional(), title: Words(80), description: Words(300).optional() }),
  z.strictObject({ type: z.enum(["number", "integer"]), default: z.number(), minimum: z.number().optional(), maximum: z.number().optional(), title: Words(80), description: Words(300).optional() }),
]);

/** A value an embed's option writes as one word of its config: no quote, brace or line break. */
const OptionWord = (max: number) => z.string().max(max).regex(/^[^"{}\r\n]*$/, "no quotes, braces or line breaks");

/** One of an embed's options, as `DeclaredOption` in `embedOptions.ts` reads it. */
const EmbedOption = z.discriminatedUnion("type", [
  z
    .strictObject({ type: z.literal("text"), id: Local, label: Words(60), default: OptionWord(200).default(""), maxLength: z.number().int().min(1).max(200).optional() })
    .refine((o) => o.default === o.default.trim() && (o.maxLength === undefined || o.default.length <= o.maxLength), "the default is one the option takes"),
  z
    .strictObject({ type: z.literal("number"), id: Local, label: Words(60), default: z.number(), min: z.number().optional(), max: z.number().optional(), step: z.number().positive().optional() })
    .refine((o) => !("refused" in valueOf(o, String(o.default))), "the default is one the option takes"),
  z.strictObject({ type: z.literal("toggle"), id: Local, label: Words(60), default: z.boolean().default(false) }),
  z
    .strictObject({ type: z.literal("choice"), id: Local, label: Words(60), values: z.array(z.string().regex(/^[\w.:/+-]{1,40}$/, "one word of letters, digits and . : / + -")).min(2).max(12), default: z.string().optional() })
    .refine((o) => new Set(o.values).size === o.values.length, "each value once")
    .refine((o) => o.default === undefined || o.values.includes(o.default), "the default is one of the values"),
  z.strictObject({ type: z.literal("colour"), id: Local, label: Words(60), default: z.enum(["", ...SWATCHES]).default("") }),
  z.strictObject({ type: z.literal("duration"), id: Local, label: Words(60), default: z.string().refine((d) => secondsIn(d) !== null, "a duration like 25m").transform((d) => durationWords(secondsIn(d)!)) }),
  z.strictObject({ type: z.literal("date"), id: Local, label: Words(60), default: z.string().refine((d) => !("refused" in valueOf({ type: "date", id: "d", label: "d", default: "" }, d)), "a day like 2026-10-16, or empty").default("") }),
]);

/** The slots the view of a plugin that runs shut off may be in. Each is drawn in a frame of the plugin's own. */
export const REMOTE_SLOTS = ["inspector", "page", "bar", "dashboard"] as const;

const unique = <T>(of: (item: T) => string, what: string) => [(items: T[]) => new Set(items.map(of)).size === items.length, `each ${what} once`] as const;

/**
 * What a plugin says of itself. It is data: the app lists a plugin's commands, views, embeds and
 * options from it without running any of its code, and whoever decides its permissions reads its
 * capabilities and reasons from it.
 */
const shape = {
  name: Words(60),
  version: Words(20).default("1"),
  description: Words(300).optional(),
  icon: z.enum(PLUGIN_ICONS).optional(),
  capabilities: z
    .array(Declared)
    .max(CAPABILITY_NAMES.length)
    .refine(...unique<DeclaredCapability>((c) => c.name, "capability"))
    .default([]),
  commands: z
    .array(z.strictObject({ id: Local, title: Words(80) }))
    .max(30)
    .refine(...unique<{ id: string }>((c) => c.id, "command"))
    .default([]),
  views: z
    .array(
      z
        .strictObject({
          slot: z.enum(REMOTE_SLOTS),
          id: Local,
          label: Words(40),
          /** For an inspector tab and a page's link. */
          icon: z.enum(PLUGIN_ICONS).optional(),
          /** For a view in the bar, and required for it: the most room its frame takes, in pixels. The frame is as wide as what it draws, up to this. */
          width: z.number().int().min(24).max(480).optional(),
          /** For a view in the bar: whether it is at the bar's far end. */
          end: z.boolean().optional(),
          /** For a view in the bar: drawn in focus too, for something that changes as it is watched, such as a running timer. */
          live: z.boolean().optional(),
        })
        .refine((view) => (view.slot === "bar") === (view.width !== undefined) && (view.slot === "bar" || (view.end === undefined && view.live === undefined)), "width is given for a view in the bar, and width, end and live only for it"),
    )
    .max(10)
    .refine((views) => views.filter((view) => view.slot === "bar").length <= 1, "one view in the bar, which is a line everything shares")
    .refine(...unique<{ id: string }>((v) => v.id, "view"))
    .default([]),
  embeds: z
    .array(
      z.strictObject({
        name: Local,
        title: Words(60),
        height: z.number().int().min(24).max(1200).default(240),
        /** What a member sets in the embed's config from beneath it, which the app draws and writes. */
        options: z
          .array(EmbedOption)
          .max(12)
          .refine(...unique<{ id: string }>((o) => o.id, "option"))
          .optional(),
      }),
    )
    .max(10)
    .refine(...unique<{ name: string }>((e) => e.name, "embed"))
    .default([]),
  settings: z
    .record(Local, Option)
    .refine((s) => !Object.hasOwn(s, "enabled"), "enabled is the option that turns a plugin on and off")
    .refine((s) => Object.keys(s).length <= 30, "at most 30 options")
    .default({}),
};

/** A manifest whatever its name and with a picture, which is how the plugins that come with Common Ink declare themselves. */
export const OwnManifest = z.strictObject(shape);

/** The manifest of a plugin a workspace installs: the same, but for what would let it be taken for one of the app's. It is drawn under the plugin picture, whoever wrote it. */
export const Manifest = z
  .strictObject({
    ...shape,
    name: shape.name.refine((name) => takenName(name) === null, "a plugin can't have a name that is Common Ink's own, or that reads as one"),
  })
  .refine((manifest) => manifest.icon === undefined && manifest.views.every((view) => view.icon === undefined), "icon is for the plugins that come with Common Ink: a plugin a workspace installs is drawn under the plugin picture");
export type Manifest = z.output<typeof Manifest>;

/** Whether a manifest asks to run in the app's page. Then it runs there or not at all: none of it runs shut off. */
export const asksFullTrust = (manifest: Pick<Manifest, "capabilities">): boolean => manifest.capabilities.some((c) => c.name === FULL_TRUST);

/** The manifest written in `text`, or why it isn't one. `own` is for a copy of one of Common Ink's own plugins, which may keep its name. */
export function readManifest(text: string, own = false): { manifest: Manifest } | { reason: string } {
  if (text.length > MAX_PLUGIN_MANIFEST) return { reason: `A manifest is at most ${MAX_PLUGIN_MANIFEST} characters` };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { reason: "The manifest isn't JSON" };
  }
  const parsed = (own ? OwnManifest : Manifest).safeParse(json);
  return parsed.success ? { manifest: parsed.data } : { reason: z.prettifyError(parsed.error) };
}

/** The name of a plugin's code: the SHA-256 of its text, in hex. Other code has another name, so an approval of one is never an approval of the other. */
export async function codeHash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What installing a manifest and code would make of them, as `plugin.validate` answers. */
export type Validated = { ok: true; manifest: Manifest; codeHash: string; fullTrust: boolean } | { ok: false; reason: string };

/** The manifest as it would be kept, the name of the code and whether it asks for full trust; or why installing them would be refused. Nothing is kept. */
export async function validate(manifest: string, code: string): Promise<Validated> {
  const read = readManifest(manifest);
  if ("reason" in read) return { ok: false, reason: read.reason };
  return { ok: true, manifest: read.manifest, codeHash: await codeHash(code), fullTrust: asksFullTrust(read.manifest) };
}

/**
 * A new plugin's two files: a manifest that asks for nothing, with one command, one view in the
 * inspector and one embed with options the app draws, and code that runs shut off, fills them and
 * looks like the app with one line. Or why `name` can't be a plugin's.
 */
export function scaffold(name: string): { manifest: string; code: string } | { reason: string } {
  const manifest = JSON.stringify(
    {
      name,
      version: "1",
      description: `${name}: say here, in a sentence, what it does.`,
      capabilities: [],
      commands: [{ id: "hello", title: "Say hello" }],
      views: [{ slot: "inspector", id: "main", label: "Hello" }],
      embeds: [
        {
          name: "hello",
          title: "Hello",
          height: 120,
          options: [
            { type: "text", id: "to", label: "To", default: "everyone" },
            { type: "number", id: "times", label: "Times", default: 1, min: 1, max: 5, step: 1 },
            { type: "toggle", id: "loud", label: "Loud", default: false },
          ],
        },
      ],
      settings: { greeting: { type: "string", default: "Hello", title: "Greeting" } },
    },
    null,
    2,
  );
  const read = readManifest(manifest);
  if ("reason" in read) return { reason: read.reason };
  const code = `// ${name}. It runs shut off from the app, in a frame of its own, and reaches the workspace only through
// ink.perform, with what an admin permitted it. Ask for a capability in the manifest to read or change notes.

// The app's look: its buttons, fields and headings, in its colours, following its theme.
document.body.classList.add("ink-kit");

ink.onCommand("hello", () => ink.notify(ink.settings.greeting + " from " + ${JSON.stringify(name)}));

if (ink.context.kind === "embed") {
  // A note writes ::x-hello{to=Ada times=2}. The app draws the options beneath it and hands their values here.
  const { to, times, loud } = ink.context.options;
  const card = document.createElement("div");
  card.className = "ink-card ink-stack";
  const title = card.appendChild(document.createElement("h2"));
  title.textContent = "Hello";
  const said = card.appendChild(document.createElement("p"));
  said.textContent = Array.from({ length: times }, () => ink.settings.greeting + ", " + to + (loud ? "!" : ".")).join(" ");
  ink.root.append(card);
}

if (ink.context.kind === "view") {
  const said = document.createElement("p");
  said.textContent = ink.settings.greeting + ". The note in front is shown here once a note is open.";
  ink.root.append(said);
  ink.onNote((note) => (said.textContent = note ? ink.settings.greeting + ": " + note.text.split("\\n")[0] : ink.settings.greeting + "."));
}
`;
  return { manifest, code };
}

/**
 * What an approval was of, as one string: the capability as the manifest declared it, and the code.
 * An approval stands only while this is what the plugin still is, so new code voids every approval
 * and a capability declared another way, with another reason or other sites, voids its own.
 */
export const approvalOf = (declared: DeclaredCapability, hash: string): string => JSON.stringify([declared.name, declared.reason, declared.origins ?? null, hash]);

/**
 * What isn't a third-party plugin and still has a permission in the record: HTML embeds, written in
 * notes, whose network is off until an admin lists the sites they may reach.
 */
export const HTML_EMBEDS = "html";
export const BUILT_IN_SUBJECTS = {
  [HTML_EMBEDS]: {
    name: "HTML embeds",
    capability: "network",
    reason: "HTML written in a note can load from and send to the sites listed here, once whoever is reading presses Run.",
  },
} as const;

/** The states a permission is in. `off` is where each starts, and where a denial leaves it. */
export type PermissionState = "allowed" | "off";

/** What a member's part of the app is told of one permission. */
export interface Permission {
  capability: Capability;
  reason: string;
  /** For `network`: the sites. A plugin's are its manifest's; HTML embeds' are the ones an admin listed. */
  origins: string[];
  state: PermissionState;
  /** A locked permission takes no requests, and stays as it is until an admin unlocks it. */
  locked: boolean;
  /** Who decided it last, by name. Null for one nobody has decided, or whose approval the plugin's change voided. */
  decidedBy: string | null;
  /** The agent that decided it for `decidedBy`, by name. Null when the member decided it themself. */
  decidedVia: string | null;
  /** True when it was allowed and the plugin has changed since, so it is off again until someone looks. */
  voided: boolean;
  /** Who is waiting on an admin, oldest first. */
  requests: { by: { id: string; name: string }; at: number; origins: string[] }[];
}

/** A plugin installed in a workspace, or HTML embeds, as anyone in the workspace is told of it. */
export interface InstalledPlugin {
  /** Its id in this workspace, given when it was installed. Its changes in History carry it. */
  id: string;
  /** False for HTML embeds. */
  thirdParty: boolean;
  manifest: Manifest;
  /** The name of its code. Null for HTML embeds. */
  codeHash: string | null;
  /** For a plugin that asks for full trust, what stands between it and running for whoever asked. Null for every other, and for an agent or a plugin that asks, who are told nothing of it. */
  fullTrust: FullTrust | null;
  installedBy: string | null;
  /** The agent that installed it for `installedBy`, by name. Null when the member did it themself. */
  installedVia: string | null;
  installedAt: number | null;
  /** Who last put other code in its place, and the agent that did it for them: null until it is updated, and for the member themself. */
  updatedBy: string | null;
  updatedVia: string | null;
  updatedAt: number | null;
  permissions: Permission[];
}

/**
 * The two things a full-trust plugin runs by, as the one who asked is told of them. It runs in their
 * session only while `grantedHash` is the name of the code it is now and `on` is true.
 */
export interface FullTrust {
  /** The code an admin's grant that stands is of. Null when none stands: never granted, taken back, or ended by a change to the plugin. */
  grantedHash: string | null;
  /** True when a grant was ended by a change to the plugin, and nobody has decided since. */
  changedSince: boolean;
  /** Whether the one asking turned it on for themself, for the code it is now. */
  on: boolean;
  /** For an admin: every member who has it on for the code it is now. Null for anyone else. */
  turnedOnBy: { name: string; at: number }[] | null;
}

/** A member's own copy of a plugin's source, as they are told of it without its code. */
export interface DraftSummary {
  /** The plugin it is a copy of: an install's id, or the id of one of Common Ink's own that runs shut off. */
  pluginId: string;
  /** The manifest as the member wrote it, which may not be one yet. */
  manifest: string;
  codeHash: string;
  /** The name of the original's code when the copy was made, to say whether the original has changed since. */
  baseHash: string | null;
  /** Whether it runs in the original's place, for its author alone. */
  running: boolean;
  updatedAt: number;
}

export interface Draft extends DraftSummary {
  code: string;
}

/** The record of a workspace's plugins. Members read it; only an admin changes it. */
export interface PluginRecord {
  /** Whether the one asking is an admin, and so decides. */
  canManage: boolean;
  plugins: InstalledPlugin[];
}
