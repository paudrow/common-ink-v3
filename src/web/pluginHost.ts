import { bind, chordLabel, chordsForFrames, frameCommand, onPlatform, rememberFrameKeys } from "./keybindings.ts";
import type { AddressEmbed, App, Need, Command, CommandInfo, Completion, Dispose, EditorExtension, Embed, IconName, OpInput, Plugin, PluginHost, Screenshot, Setting, SettingValue, Slots } from "./plugin-api.ts";
import { KEYBINDING, readSetting, resolve, sameValue, type Declared, type Problem, type SettingsDocument } from "./settings.ts";
import { OWN_NAMES, takenName } from "../core/plugins.ts";
import { lacks, type Device } from "./device.ts";

export interface PluginState {
  id: string;
  name: string;
  enabled: boolean;
  /** What this device lacks that the plugin needs, which keeps it off though its switch is on. */
  lacking: Need | null;
  /** A required plugin can't be turned off. */
  required: boolean;
  /** Whether it came with the app, and wasn't added to it. */
  builtIn: boolean;
  /** Why the plugin isn't running though it is turned on, or what of it failed while being drawn. */
  error: string | null;
  description: string | null;
  icon: IconName | null;
  screenshots: readonly Screenshot[];
  /** What it has registered: as it stands while the plugin is on, and as it last stood once it is off. Null for one that hasn't been on since the app loaded. */
  adds: Added | null;
  /** Whether it is one a workspace's admin installed, and not one that comes with Common Ink. */
  installed: boolean;
  /** Whether it is a workspace's plugin running inside the app with full trust, for this member, now. */
  inPage: boolean;
}

/** What one plugin has registered, read from the host's own tables and never from what the plugin says of itself. */
export interface Added {
  commands: readonly { id: string; title: string }[];
  views: readonly { slot: keyof Slots; id: string; label: string | null }[];
  /** `address` is on one a note writes as a web address alone on a line, and not as `::name{}`. */
  embeds: readonly { name: string; title: string; block: boolean; address?: true }[];
  completions: readonly { id: string; trigger: string }[];
  editorExtensions: readonly string[];
}

/**
 * A plugin that isn't compiled into the app and runs shut off from it, as the app's own code made a
 * plugin of it: one a workspace installed, or one of Common Ink's own. What the host lets it do
 * follows from what is said of it here, by the app, and from nothing the plugin says of itself.
 * Neither kind is among `trusted`: both are handed the host a third-party plugin is.
 */
export interface Installed {
  plugin: Plugin;
  /** Changes when the plugin is to start again: other code, another manifest, other permissions. */
  version: string;
  /** Whose it is. One that is `installed`, which it is unless said, can't go by a name of the app's own, and its embeds are written `::x-name{}`. */
  origin?: "own" | "installed";
  /** For one of the app's own: the built-in plugin its contributions come after. Any other comes after them all. */
  after?: string;
  /**
   * Set for code that runs in the page: a workspace's plugin an admin granted full trust for exactly
   * this code, which this member turned on. The app says so, of code it hashed itself, and only then
   * is the plugin handed what the app's own plugins are. `perform` is how its operations reach the
   * server: at the plugin's address, so each is the plugin's in History and is checked there again.
   */
  inPage?: { perform: Provided["perform"] };
}

/** Everything the plugins that are on have added, in the order of the plugins and then of their registering. */
export interface Contributions {
  commands: readonly Command[];
  /** Which command each chord runs: each command's own keys, with the member's keybindings over them. */
  keybindings: Readonly<Record<string, string>>;
  settings: MemberSettings;
  views: { readonly [S in keyof Slots]: readonly Slots[S][] };
  embeds: readonly (Embed | AddressEmbed)[];
  completions: readonly Completion[];
  editorExtensions: readonly EditorExtension[];
  plugins: readonly PluginState[];
}

/** The member's settings, read against the schema the plugins that are installed and the commands that are on add up to. */
export interface MemberSettings {
  /** Every setting there is, in the order of the plugins, with keybindings last. */
  declared: readonly Declared[];
  values: Readonly<Record<string, SettingValue>>;
  /** What is wrong in the member's document. None of it is taken out of the document. */
  problems: readonly Problem[];
  document: SettingsDocument;
}

/** What the app gives each plugin beyond registering: its reach into the workspace, bound to that plugin. */
export type Provided = Pick<PluginHost, "workspace" | "app" | "perform" | "agents" | "members" | "sharing" | "uploads" | "storage">;

export interface HostOptions {
  /**
   * Every plugin that comes with the app, in the order their contributions are shown. One whose id an earlier one
   * has is left out: the id is what a plugin's settings and switch are kept under, so a second one
   * would read and change the first one's. The ones a workspace installed come after, through `setInstalled`.
   */
  plugins: readonly Plugin[];
  required?: readonly string[];
  /**
   * The plugins that are Common Ink's own, as the very values in `plugins`: nothing a plugin says of
   * itself, such as its id, puts it here. Only they are given `host.agents`, `host.members`,
   * `host.sharing` and `host.uploads`. Any other plugin is handed ones whose every method refuses.
   */
  trusted?: readonly Plugin[];
  /** The ids of the plugins that came with the app. */
  builtIn?: readonly string[];
  /** The member's settings as they are at the start. */
  settings: SettingsDocument;
  /**
   * Asked to set one key of the member's settings, or to take it out when `value` is undefined. Only
   * `setSetting` asks, on behalf of the member. Answer with `settingsChanged` once the document has changed.
   */
  write(key: string, value: SettingValue | undefined): boolean;
  /** Whether chords are labelled for a Mac. */
  mac: boolean;
  /** The device the app runs on. A plugin that needs what it lacks is off. Without one, nothing is lacking. */
  device?: Device;
  /** Whether HTML embeds have a host of their own on this server, as the server says. A setting's `defaultWithoutEmbedSite` is its default where they don't. */
  embedSite?: boolean;
  provide(plugin: PluginHost["plugin"]): Provided;
}

export interface Host {
  subscribe(listener: () => void): () => void;
  /** The same object until something is registered, taken out, or turned on or off. */
  contributions(): Contributions;
  /** False when no command has that id. */
  run(commandId: string): boolean;
  setEnabled(pluginId: string, enabled: boolean): void;
  /** The app as the plugin that registered a view is given it. */
  appFor(view: object): App;
  /** Records against its plugin that a view or embed threw while being drawn, that a completion threw, or that an editor extension couldn't be used. */
  fail(contribution: object, error: unknown): void;
  /** Turns every plugin off without forgetting which are on. They start again the next time contributions are read. */
  dispose(): void;
  /** Sets one of the member's settings. A value that is the default is taken out of the document, as is `undefined`. False when it wasn't changed. */
  setSetting(key: string, value: SettingValue | undefined): boolean;
  /** Tells the host the member's document is now this one. Plugins it turns on or off start and stop. */
  settingsChanged(document: SettingsDocument): void;
  /** Tells the host the device changed. Plugins that need what it now lacks stop; ones that needed what it now has start. */
  deviceChanged(device: Device): void;
  /** Tells the host the app has arrived at an address. */
  navigated(): void;
  /** Tells the host the notes the member can see have changed. */
  notesChanged(): void;
  /**
   * Tells the host which plugins run shut off now: the app's own, and the third-party ones the
   * workspace has installed. One that is new starts if the member has it on, one that is gone stops
   * and takes what it added with it, and one whose version changed stops and starts again. None is
   * ever among the plugins the host was made with, or is handed what they are.
   */
  setInstalled(installed: readonly Installed[]): void;
}

/** The setting that turns a plugin on and off. */
export const enabledKey = (pluginId: string) => `${pluginId}.enabled`;
/** The member's setting that keeps plugins that need a keyboard on where none has been seen. */
export const KEEP_KEYBOARD_PLUGINS = "core.keyboardPluginsOnTouch";
const EVERYTHING: Device = { phone: false, touch: false, keyboard: "attached" };

interface Owned<T> {
  plugin: number;
  seq: number;
  value: T;
}

const SLOTS = ["column", "section", "editor", "folder", "inspector", "page", "dashboard", "bar", "overlay", "mark", "tool", "notice"] as const satisfies readonly (keyof Slots)[];

/** The most a plugin may keep in one remembered setting, in characters of JSON: the member's settings are small, and theirs. */
const MAX_REMEMBERED = 10_000;

/** How the ids of the host's own commands start: turning a plugin on or off, going to a page, and settings. Only a required plugin adds another. */
const RESERVED = ["plugins.", "go.", "settings.", "inspector."];

/** How the name of an installed plugin's embed starts, and no other's: so it can never be the name of one that comes with the app, on or off. */
export const INSTALLED_EMBED = "x-";

/** Names that are the app's own beside its plugins', which an installed plugin can't go by. */

const inOrder = <T>(owned: Iterable<Owned<T>>) => [...owned].sort((a, b) => a.plugin - b.plugin || a.seq - b.seq).map((o) => o.value);

/** The capabilities that act as the member where history can't take it back: minting a token, changing who is in the workspace, sharing with the world. */
const OWN_ONLY = ["agents", "members", "sharing"] as const;

/** Those capabilities for a plugin that isn't Common Ink's own: the same methods, each refusing. */
function withheld(plugin: Plugin, given: Provided): Pick<Provided, (typeof OWN_ONLY)[number]> {
  const refusing = (capability: (typeof OWN_ONLY)[number]) =>
    Object.fromEntries(
      Object.keys(given[capability] ?? {}).map((method) => [method, () => Promise.reject(new Error(`${plugin.name} isn't given host.${capability}.${method}: only Common Ink's own plugins are`))]),
    );
  return Object.fromEntries(OWN_ONLY.map((capability) => [capability, refusing(capability)])) as never;
}

/** `host.uploads` for a plugin that isn't Common Ink's own: no upload is known, none has an address, nothing is read, and nothing is sent. */
const noUploads = (plugin: Plugin): Provided["uploads"] => ({
  referred: () => null,
  onReferred: () => () => {},
  learn: () => {},
  address: () => "about:blank",
  tabAddress: () => null,
  bytes: () => Promise.reject(new Error(`${plugin.name} isn't given host.uploads.bytes: only Common Ink's own plugins are`)),
  send: () => Promise.reject(new Error(`${plugin.name} isn't given host.uploads.send: only Common Ink's own plugins are`)),
});

/** Why `host.perform` won't take an operation, or null when it will. The type `KeptFromPerform` says the same to a plugin written in TypeScript. */
function keptFromPerform(type: string): string | null {
  if (type.startsWith("settings.")) return "a plugin can't read or change the member's settings";
  if (type.startsWith("invite.") || (type.startsWith("member.") && type !== "member.list")) return "who is in a workspace is changed through host.members, by a plugin that is given it";
  if (type.startsWith("grant.") || type === "note.setPrivate") return "who a note or folder is shared with is read and changed through host.sharing, by a plugin that is given it";
  if (type === "upload.setPrivate") return "who an upload is shared with is read and changed through host.sharing, by a plugin that is given it";
  if (["upload.create", "upload.open", "upload.start", "upload.resume", "upload.part", "upload.finish", "upload.abort"].includes(type)) return "an upload's bytes are sent and asked for through host.uploads, by a plugin that is given it";
  if (type.startsWith("shared.")) return "only whoever holds a link asks what it opens";
  if (/^plugin\.(install|uninstall|permit|request|read)$/.test(type)) return "which plugins a workspace has, and what they are permitted, is decided on the Plugins page";
  return null;
}

/** Why a plugin that isn't Common Ink's own is refused an operation, or null when it isn't. The type `OwnOnly` says the same. */
const ownOnly = (type: string): string | null =>
  /^(source|event|contact|record)\./.test(type)
    ? "a member's data sources are theirs, and are read only by Common Ink's own plugins"
    : type.startsWith("upload.")
      ? "a workspace's uploads are read and changed only by Common Ink's own plugins"
      : /^(pin|visit)\./.test(type)
        ? "a member's pins and how far they have read the changes are theirs, and are read and changed only by Common Ink's own plugins"
        : type.startsWith("plugin.")
          ? "a workspace's record of its plugins is read only by Common Ink's own plugins"
          : null;

export function createPluginHost({ plugins: given, required = [], trusted = [], builtIn: cameWith = [], settings, write, mac, device: startedOn = EVERYTHING, embedSite = false, provide }: HostOptions): Host {
  const builtIn = given.filter((plugin, index) => given.findIndex((p) => p.id === plugin.id) === index);
  /** The plugins that run shut off: the app's own, and the third-party ones the workspace has installed. */
  let installed: readonly Installed[] = [];
  let plugins: readonly Plugin[] = builtIn;
  /** Where each plugin's contributions go among the others'. An installed plugin keeps its place while it is installed. */
  const places = new Map<string, number>(builtIn.map((p, index) => [p.id, index]));
  let nextPlace = builtIn.length;
  const ownNames = [...builtIn.map((p) => p.name), ...OWN_NAMES];
  /** Why an installed plugin can't start under the name it gives itself, or null when it can. Names are compared by how they read, so a look-alike letter is no way around it. */
  const about = (plugin: Plugin) => installed.find((i) => i.plugin === plugin);
  /** Whether a plugin is one a workspace installed. Everything a third-party plugin is refused by its name keys on this. */
  const theirs = (plugin: Plugin) => {
    const told = about(plugin);
    return told !== undefined && told.origin !== "own";
  };
  /** Whether a plugin is handed what the app's own are: one of them, or code the app vouches was granted full trust and turned on. */
  const trusts = (plugin: Plugin) => trusted.includes(plugin) || about(plugin)?.inPage !== undefined;
  const misnamed = (plugin: Plugin) => (theirs(plugin) ? takenName(plugin.name, ownNames) : null);
  const placeOf = (plugin: Plugin) => places.get(plugin.id)!;
  const commands = new Map<string, Owned<Command>>();
  const embeds = new Map<string, Owned<Embed | AddressEmbed>>();
  const completions = new Map<string, Owned<Completion>>();
  const editorExtensions = new Map<string, Owned<EditorExtension>>();
  const views = new Map<keyof Slots, Map<string, Owned<Slots[keyof Slots]>>>(SLOTS.map((slot) => [slot, new Map()]));
  /** What each running plugin registered, to take back out when it is turned off. */
  const running = new Map<string, Set<Dispose>>();
  const errors = new Map<string, string>();
  /** What each plugin had registered when contributions were last read with it on. */
  const added = new Map<string, Added>();
  let document = settings;
  let device = startedOn;
  /** A switch that isn't true or false reads as its default, as any setting does. */
  const switchedOn = (p: Plugin) => {
    const written = document[enabledKey(p.id)];
    return typeof written === "boolean" ? written : (p.enabledByDefault ?? true);
  };
  const lacking = (p: Plugin) => lacks(p.needs, device, document[KEEP_KEYBOARD_PLUGINS] === true);
  const isOff = (p: Plugin) => !required.includes(p.id) && (!switchedOn(p) || lacking(p) !== null);
  const off = new Set(plugins.filter(isOff).map((p) => p.id));
  const listeners = new Set<() => void>();
  /** Which plugin registered a view or an embed, and the reach that plugin was given. */
  const owners = new WeakMap<object, { id: string; app: () => App }>();
  /** Plugins start when contributions are first read, so a host that is made and never used starts nothing. */
  let started = false;
  let starting = false;
  /** The plugins that asked to hear when settings change. */
  const watching = new Set<() => void>();
  /** The plugins that asked to hear when the app arrives somewhere. */
  const arriving = new Set<() => void>();
  let arrived = false;
  /** The plugins that asked to hear when the notes change. */
  const listing = new Set<() => void>();
  let seq = 0;
  let snapshot: Contributions | null = null;

  const changed = () => {
    snapshot = null;
    if (!starting) for (const listener of [...listeners]) listener();
  };

  function add<T>(table: Map<string, Owned<T>>, key: string, value: T, plugin: number, what: string): Dispose {
    if (table.has(key)) throw new Error(`There's already ${what} ${key}`);
    const owned = { plugin, seq: seq++, value };
    table.set(key, owned);
    changed();
    return () => {
      if (table.get(key) !== owned) return;
      table.delete(key);
      changed();
    };
  }

  const run = (id: string) => {
    const command = contributions().commands.find((c) => c.id === id);
    command?.run();
    return command !== undefined;
  };

  function hostFor(plugin: Plugin, index: number, mine: Set<Dispose>): PluginHost {
    const given = provide({ id: plugin.id, name: plugin.name });
    const reach = { ...given, perform: about(plugin)?.inPage?.perform ?? given.perform };
    const provided = trusts(plugin) ? reach : { ...reach, ...withheld(plugin, given), uploads: noUploads(plugin) };
    const keep = (dispose: Dispose) => {
      mine.add(dispose);
      return dispose;
    };
    const command = (c: Command) => add(commands, c.id, c, index, "a command with the id");
    const owner = { id: plugin.id, app: provided.app };
    return {
      plugin: { id: plugin.id, name: plugin.name },
      ...provided,
      // This is the one way a plugin performs an operation of its own choosing, so it is where a plugin is refused.
      // What is sent is a copy taken once, so the type that was looked at is the type that goes.
      perform(op) {
        const sent = { ...(op as OpInput) };
        const type: unknown = sent.type;
        const why = typeof type === "string" ? (keptFromPerform(type) ?? (trusts(plugin) ? null : ownOnly(type))) : "a plugin can't read or change the member's settings";
        return why ? Promise.reject(new Error(`${plugin.name} can't ${String(type)}: ${why}`)) : provided.perform(sent as typeof op);
      },
      settings: {
        get<T extends SettingValue>(name: string) {
          if (!plugin.settings || !Object.hasOwn(plugin.settings, name)) throw new Error(`${plugin.name} declares no setting named ${name}`);
          return contributions().settings.values[`${plugin.id}.${name}`] as T;
        },
        set(name, value) {
          const key = `${plugin.id}.${name}`;
          // The key must be this plugin's own declaration and nothing else's: a dotted name, or an id such as `keybindings`, would make another's key.
          const own = contributions().settings.declared.some((d) => d.key === key && d.group.id === plugin.id);
          if (!plugin.settings?.[name]?.remembered || !Object.hasOwn(plugin.settings, name) || name.includes(".") || key.startsWith(KEYBINDING) || !own)
            throw new Error(`${plugin.name} can't change ${name}: a plugin changes only a setting it declares remembered`);
          const read = readSetting(plugin.settings[name]!, value);
          return "value" in read && JSON.stringify(read.value).length <= MAX_REMEMBERED && setSetting(key, read.value);
        },
        subscribe(listener) {
          // A listener that throws is its plugin's failure, and not the end of telling the others or of the change it was told of.
          const heard = () => {
            try {
              listener();
            } catch (err) {
              record(plugin.id, err);
            }
          };
          watching.add(heard);
          return keep(() => void watching.delete(heard));
        },
      },
      commands: {
        register(c) {
          const prefix = required.includes(plugin.id) ? undefined : RESERVED.find((p) => c.id.startsWith(p));
          if (prefix) throw new Error(`Only Common Ink adds a command whose id starts with ${prefix}, and this one is ${c.id}`);
          return keep(command(c));
        },
        list: () => contributions().commands.map(infoOf),
        run,
      },
      views: {
        in(slot) {
          return contributions().views[slot];
        },
        register(slot, view) {
          const table = views.get(slot) as Map<string, Owned<typeof view>>;
          if (slot === "page" && (view as Slots["page"]).home && !trusted.includes(plugin)) throw new Error(`Only Common Ink's own plugins add the page shown at /, and ${plugin.name} asked to with ${(view as Slots["page"]).path}`);
          if (slot === "page" && /^\/folder(\/|$)/.test((view as Slots["page"]).path)) throw new Error(`${(view as Slots["page"]).path} is where a folder's notes are listed, so no page can be there`);
          if (slot === "page" && [...table.values()].some((o) => (o.value as Slots["page"]).path === (view as Slots["page"]).path)) throw new Error(`There's already a page at ${(view as Slots["page"]).path}`);
          const dispose = keep(add(table, view.id, view, index, `a ${slot} view with the id`));
          owners.set(view, owner);
          if (slot !== "page" && slot !== "inspector") return dispose;
          const own =
            slot === "page"
              ? keep(command({ id: `go.${view.id}`, title: `Go to ${(view as Slots["page"]).label}`, run: () => provided.app().go((view as Slots["page"]).path) }))
              : keep(command({ id: `inspector.${view.id}`, title: `Toggle ${(view as Slots["inspector"]).label} panel`, run: () => provided.app().togglePanel(view.id) }));
          return () => {
            dispose();
            own();
          };
        },
      },
      embeds: {
        register(embed) {
          const marked = theirs(plugin);
          if (embed.name.startsWith(INSTALLED_EMBED) !== marked) throw new Error(`${marked ? "An" : "Only an"} installed plugin's embed has a name that starts with ${INSTALLED_EMBED}, and this one is ${embed.name}`);
          const address = "claims" in embed;
          // An address embed is in no note by its name, so it is no clash with an embed a note writes by the same one: a video by its address, and `::video{}`.
          const dispose = keep(add(embeds, address ? `address ${embed.name}` : embed.name, embed, index, address ? "an address embed named" : "an embed named"));
          owners.set(embed, owner);
          return dispose;
        },
        list: () =>
          contributions()
            .embeds.filter((e): e is Embed => !("claims" in e) && e.menu !== false)
            .map(({ name, title, block, starts, pick }) => ({ name, title, block, starts, ...(pick && { pick }) })),
      },
      completions: {
        register(completion) {
          const dispose = keep(add(completions, completion.id, completion, index, "a completion with the id"));
          owners.set(completion, owner);
          return dispose;
        },
      },
      editorExtensions: {
        register(extension) {
          const dispose = keep(add(editorExtensions, extension.id, extension, index, "an editor extension with the id"));
          owners.set(extension, owner);
          return dispose;
        },
      },
      report(error) {
        if (running.get(plugin.id) === mine) record(plugin.id, error);
      },
      onNavigate(listener) {
        const heard = () => listener();
        arriving.add(heard);
        // A plugin turned on after the app arrived hears where it is, once it has finished starting.
        if (arrived) queueMicrotask(() => arriving.has(heard) && heard());
        return keep(() => void arriving.delete(heard));
      },
      onItems(listener) {
        const heard = () => listener();
        listing.add(heard);
        return keep(() => void listing.delete(heard));
      },
    };
  }

  function start(plugin: Plugin, index: number) {
    const mine = new Set<Dispose>();
    errors.delete(plugin.id);
    try {
      const named = misnamed(plugin);
      if (named) throw new Error(named);
      if (plugin.settings && Object.hasOwn(plugin.settings, "enabled")) throw new Error("A plugin can't declare a setting named enabled, which turns it on and off");
      const stopping = plugin.activate(hostFor(plugin, index, mine));
      if (stopping) mine.add(stopping);
      running.set(plugin.id, mine);
    } catch (err) {
      // A plugin that can't start is left out whole, and the rest of the app carries on.
      undo(mine);
      errors.set(plugin.id, err instanceof Error ? err.message : String(err));
    }
  }

  function stop(plugin: Plugin) {
    const mine = running.get(plugin.id) ?? [];
    // It stops running before its contributions go one by one, so what it added is remembered whole and not as it stood halfway out.
    running.delete(plugin.id);
    const failed = undo(mine);
    errors.delete(plugin.id);
    if (failed.length) errors.set(plugin.id, failed.join("; "));
  }

  /** Takes back everything a plugin added. One part that throws as it goes doesn't keep the rest in, or stop whatever turned the plugin off: what it said is returned. */
  function undo(disposes: Iterable<Dispose>): string[] {
    const failed: string[] = [];
    for (const dispose of disposes) {
      try {
        dispose();
      } catch (err) {
        failed.push(err instanceof Error ? err.message : String(err));
      }
    }
    return failed;
  }

  /** The hint is the chord that runs the command now, which another command may have claimed first. */
  const infoOf = (c: Command): CommandInfo => {
    const { keybindings } = contributions();
    // Two chords can read the same, as / and Shift with / do.
    const keys = [...new Set(Object.keys(keybindings).filter((chord) => keybindings[chord] === c.id).map((chord) => chordLabel(chord, mac)))];
    return { id: c.id, title: c.title, shortcut: keys[0], keys, group: c.group, ...(c.aliases && { aliases: c.aliases }) };
  };

  function startAll() {
    if (started) return;
    started = starting = true;
    // A required plugin starts first, so no other can take an id it needs. Where its contributions are shown is still its place in the list.
    for (const first of [true, false]) {
      for (const plugin of plugins) if (required.includes(plugin.id) === first && !off.has(plugin.id)) start(plugin, placeOf(plugin));
    }
    starting = false;
  }

  /** Holds a failure against a plugin, once however often it happens, until the plugin is turned off or on again. */
  function record(pluginId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const known = errors.get(pluginId);
    if (known?.split("; ").includes(message)) return;
    errors.set(pluginId, known ? `${known}; ${message}` : message);
    changed();
  }

  function fail(contribution: object, error: unknown) {
    const owner = owners.get(contribution);
    if (owner) record(owner.id, error);
  }

  function dispose() {
    if (!started) return;
    for (const plugin of plugins) stop(plugin);
    started = false;
    changed();
  }

  function setEnabled(id: string, enabled: boolean) {
    if (plugins.some((p) => p.id === id) && !required.includes(id)) setSetting(enabledKey(id), enabled);
  }

  function setSetting(key: string, value: SettingValue | undefined) {
    const setting = contributions().settings.declared.find((d) => d.key === key)?.setting;
    const read = setting && value !== undefined ? readSetting(setting, value) : undefined;
    // A value the same as a default that depends on the server is kept: it is the member's choice wherever the app is.
    const followsServer = (setting?.type === "string" && setting.defaultWithoutEmbedSite !== undefined) || ((setting?.type === "number" || setting?.type === "integer") && setting.follows !== undefined);
    const isDefault = !followsServer && read && "value" in read && sameValue(read.value, setting!.default);
    return write(key, isDefault ? undefined : value);
  }

  function settingsChanged(next: SettingsDocument) {
    document = next;
    reconsider();
    // The frames are told the chords as they are after this change, which means working them out before the telling.
    contributions();
    for (const heard of [...watching]) heard();
  }

  function deviceChanged(next: Device) {
    if (next.phone === device.phone && next.touch === device.touch && next.keyboard === device.keyboard) return;
    device = next;
    reconsider();
  }

  /** Starts each plugin that should now be on and stops each that should now be off. */
  function reconsider() {
    for (const plugin of plugins) {
      if (isOff(plugin) === off.has(plugin.id)) continue;
      if (off.delete(plugin.id)) {
        if (started) start(plugin, placeOf(plugin));
      } else {
        off.add(plugin.id);
        stop(plugin);
      }
    }
    changed();
  }

  /** A place right after a built-in plugin's and before the next one's, or after everything for one that names none. */
  function placeAfter(after: string | undefined): number {
    const base = after === undefined ? undefined : places.get(after);
    if (base === undefined) return nextPlace++;
    const next = Math.min(base + 1, ...[...places.values()].filter((place) => place > base));
    return (base + next) / 2;
  }

  function setInstalled(next: readonly Installed[]) {
    // An id that is one of the app's own plugins' is never taken by an installed one.
    const usable = next.filter((now, index) => !builtIn.some((p) => p.id === now.plugin.id) && next.findIndex((other) => other.plugin.id === now.plugin.id) === index);
    const kept = (now: Installed) => installed.find((was) => was.plugin.id === now.plugin.id && was.version === now.version);
    if (usable.length === installed.length && usable.every((now, index) => installed[index] === kept(now))) return;
    for (const was of installed) {
      if (usable.some((now) => kept(now) === was)) continue;
      stop(was.plugin);
      off.delete(was.plugin.id);
      if (!usable.some((now) => now.plugin.id === was.plugin.id)) places.delete(was.plugin.id);
    }
    const before = installed;
    installed = usable.map((now) => kept(now) ?? now);
    for (const now of installed) if (!places.has(now.plugin.id)) places.set(now.plugin.id, placeAfter(now.after));
    // In the order of their places, so one of the app's own that runs shut off is listed, and starts, where it was when it ran in the page.
    plugins = [...builtIn, ...installed.map((i) => i.plugin)].sort((a, b) => placeOf(a) - placeOf(b));
    for (const now of installed) {
      if (before.includes(now)) continue;
      if (isOff(now.plugin)) off.add(now.plugin.id);
      else if (started) start(now.plugin, placeOf(now.plugin));
    }
    changed();
  }

  /** The schema: each plugin's switch and options, then a keybinding for each command that is on. */
  /** A setting as it is on this server: with no host of HTML embeds' own, its default is the one it gives for that. */
  function onThisServer(setting: Setting): Setting {
    return setting.type === "string" && !embedSite && setting.defaultWithoutEmbedSite !== undefined ? { ...setting, default: setting.defaultWithoutEmbedSite } : setting;
  }

  function declare(all: readonly Command[]): Declared[] {
    const options = plugins.flatMap((p) => {
      const group = { id: p.id, name: p.name };
      const active = running.has(p.id);
      const own = Object.entries(p.settings ?? {}).map(([name, setting]): Declared => ({ key: `${p.id}.${name}`, setting: onThisServer(setting), group, active }));
      if (required.includes(p.id)) return own;
      const on = p.enabledByDefault ?? true;
      const enabled: Declared = { switch: true, key: enabledKey(p.id), setting: { type: "boolean", default: on, title: "On", description: on ? `Turn ${p.name} off and what it adds goes away.` : `${p.name} is off until you turn it on here.` }, group, active: true };
      return [enabled, ...own];
    });
    const group = { id: "keybindings", name: "Keybindings" };
    return [...options, ...all.map((c): Declared => ({ key: KEYBINDING + c.id, setting: { type: "chords", default: c.keys ?? [], title: c.title }, group, active: true }))];
  }

  /** What the plugin at one place has in the tables now. */
  function addedBy(place: number): Added {
    const mine = <T>(owned: Iterable<Owned<T>>) => inOrder([...owned].filter((o) => o.plugin === place));
    return {
      commands: mine(commands.values()).map(({ id, title }) => ({ id, title })),
      views: SLOTS.flatMap((slot) => mine(views.get(slot)!.values()).map((view) => ({ slot, id: view.id, label: ("label" in view ? view.label : null) ?? null }))),
      embeds: mine(embeds.values()).map((e) => ("claims" in e ? { name: e.name, title: e.title, block: false, address: true as const } : { name: e.name, title: e.title, block: e.block ?? false })),
      completions: mine(completions.values()).map(({ id, trigger }) => ({ id, trigger })),
      editorExtensions: mine(editorExtensions.values()).map((extension) => extension.id),
    };
  }

  function contributions(): Contributions {
    startAll();
    if (snapshot) return snapshot;
    for (const p of plugins) if (running.has(p.id)) added.set(p.id, addedBy(placeOf(p)));
    const toggles = plugins
      // One that can't start under its name gets no command either, which would read as turning one of the app's own on or off.
      .filter((p) => !required.includes(p.id) && !misnamed(p))
      .map((p): Command => {
        const enable = !switchedOn(p);
        // One id whichever way it goes, so a key given to it turns the plugin off and then on again. Only its title says which.
        return { id: `plugins.toggle.${p.id}`, title: `${enable ? "Enable" : "Disable"} plugin: ${p.name}`, run: () => setEnabled(p.id, enable) };
      });
    const all = [...inOrder(commands.values()), ...toggles];
    const declared = declare(all);
    const { values, problems, chosen } = resolve(declared, document);
    const { keybindings, conflicts } = bind(all.map((c) => ({ id: c.id, title: c.title, chords: [...new Set((values[KEYBINDING + c.id] as readonly string[]).map((chord) => onPlatform(chord, mac)))], chosen: chosen.has(KEYBINDING + c.id) })));
    rememberFrameKeys({ chords: chordsForFrames(all, keybindings), commandId: (chord) => frameCommand(chord, all, keybindings) });
    return (snapshot = {
      commands: all,
      keybindings,
      settings: { declared, values, problems: [...problems, ...conflicts.map(({ commandId, reason }): Problem => ({ key: KEYBINDING + commandId, kind: "conflict", reason }))], document },
      views: Object.fromEntries(SLOTS.map((slot) => [slot, inOrder(views.get(slot)!.values())])) as unknown as Contributions["views"],
      embeds: inOrder(embeds.values()),
      completions: inOrder(completions.values()),
      editorExtensions: inOrder(editorExtensions.values()),
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: !off.has(p.id),
        lacking: required.includes(p.id) || !switchedOn(p) ? null : lacking(p),
        required: required.includes(p.id),
        builtIn: cameWith.includes(p.id) || about(p)?.origin === "own",
        installed: theirs(p),
        inPage: about(p)?.inPage !== undefined,
        error: errors.get(p.id) ?? misnamed(p),
        description: p.description ?? null,
        icon: p.icon ?? null,
        screenshots: p.screenshots ?? [],
        adds: added.get(p.id) ?? null,
      })),
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    contributions,
    run,
    setEnabled,
    appFor: (view) => owners.get(view)!.app(),
    fail,
    dispose,
    setSetting,
    settingsChanged,
    deviceChanged,
    navigated() {
      arrived = true;
      for (const heard of [...arriving]) heard();
    },
    notesChanged() {
      for (const heard of [...listing]) heard();
    },
    setInstalled,
  };
}
