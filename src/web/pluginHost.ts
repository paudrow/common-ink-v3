import { bind, chordFor, chordLabel, onPlatform } from "./keybindings.ts";
import type { App, Command, CommandInfo, Completion, Dispose, EditorExtension, Embed, IconName, OpInput, Plugin, PluginHost, Screenshot, SettingValue, Slots } from "./plugin-api.ts";
import { KEYBINDING, readSetting, resolve, sameValue, type Declared, type Problem, type SettingsDocument } from "./settings.ts";

export interface PluginState {
  id: string;
  name: string;
  enabled: boolean;
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
}

/** What one plugin has registered, read from the host's own tables and never from what the plugin says of itself. */
export interface Added {
  commands: readonly { id: string; title: string }[];
  views: readonly { slot: keyof Slots; id: string; label: string | null }[];
  embeds: readonly { name: string; title: string; block: boolean }[];
  completions: readonly { id: string; trigger: string }[];
  editorExtensions: readonly string[];
}

/** Everything the plugins that are on have added, in the order of the plugins and then of their registering. */
export interface Contributions {
  commands: readonly Command[];
  /** Which command each chord runs: each command's own keys, with the member's keybindings over them. */
  keybindings: Readonly<Record<string, string>>;
  settings: MemberSettings;
  views: { readonly [S in keyof Slots]: readonly Slots[S][] };
  embeds: readonly Embed[];
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
export type Provided = Pick<PluginHost, "workspace" | "app" | "perform" | "agents" | "members" | "sharing" | "storage">;

export interface HostOptions {
  /** Every installed plugin, in the order their contributions are shown. */
  plugins: readonly Plugin[];
  required?: readonly string[];
  /**
   * The plugins that are Common Ink's own, as the very values in `plugins`: nothing a plugin says of
   * itself, such as its id, puts it here. Only they are given `host.agents`, `host.members` and
   * `host.sharing`. Any other plugin is handed ones whose every method refuses.
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
  write(key: string, value: SettingValue | undefined): void;
  /** Whether chords are labelled for a Mac. */
  mac: boolean;
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
  /** Sets one of the member's settings. A value that is the default is taken out of the document, as is `undefined`. */
  setSetting(key: string, value: SettingValue | undefined): void;
  /** Tells the host the member's document is now this one. Plugins it turns on or off start and stop. */
  settingsChanged(document: SettingsDocument): void;
  /** Tells the host the app has arrived at an address. */
  navigated(): void;
  /** Tells the host the notes the member can see have changed. */
  notesChanged(): void;
}

/** The setting that turns a plugin on and off. */
export const enabledKey = (pluginId: string) => `${pluginId}.enabled`;

interface Owned<T> {
  plugin: number;
  seq: number;
  value: T;
}

const SLOTS = ["column", "section", "editor", "folder", "inspector", "page", "bar", "overlay"] as const satisfies readonly (keyof Slots)[];

/** How the ids of the host's own commands start: turning a plugin on or off, going to a page, and settings. Only a required plugin adds another. */
const RESERVED = ["plugins.", "go.", "settings."];

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

/** Why `host.perform` won't take an operation, or null when it will. The type `KeptFromPerform` says the same to a plugin written in TypeScript. */
function keptFromPerform(type: string): string | null {
  if (type.startsWith("settings.")) return "a plugin can't read or change the member's settings";
  if (type.startsWith("invite.") || (type.startsWith("member.") && type !== "member.list")) return "who is in a workspace is changed through host.members, by a plugin that is given it";
  if (type.startsWith("grant.") || type === "note.setPrivate") return "who a note or folder is shared with is read and changed through host.sharing, by a plugin that is given it";
  if (type.startsWith("shared.")) return "only whoever holds a link asks what it opens";
  return null;
}

export function createPluginHost({ plugins, required = [], trusted = [], builtIn = [], settings, write, mac, provide }: HostOptions): Host {
  const commands = new Map<string, Owned<Command>>();
  const embeds = new Map<string, Owned<Embed>>();
  const completions = new Map<string, Owned<Completion>>();
  const editorExtensions = new Map<string, Owned<EditorExtension>>();
  const views = new Map<keyof Slots, Map<string, Owned<Slots[keyof Slots]>>>(SLOTS.map((slot) => [slot, new Map()]));
  /** What each running plugin registered, to take back out when it is turned off. */
  const running = new Map<string, Set<Dispose>>();
  const errors = new Map<string, string>();
  /** What each plugin had registered when contributions were last read with it on. */
  const added = new Map<string, Added>();
  let document = settings;
  /** A switch that isn't true or false reads as its default, as any setting does. */
  const isOff = (p: Plugin) => {
    const written = document[enabledKey(p.id)];
    return !required.includes(p.id) && !(typeof written === "boolean" ? written : (p.enabledByDefault ?? true));
  };
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
    const provided = trusted.includes(plugin) ? given : { ...given, ...withheld(plugin, given) };
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
      perform(op) {
        const { type } = op as OpInput;
        const why = keptFromPerform(type);
        return why ? Promise.reject(new Error(`${plugin.name} can't ${type}: ${why}`)) : provided.perform(op);
      },
      settings: {
        get<T extends SettingValue>(name: string) {
          if (!plugin.settings || !Object.hasOwn(plugin.settings, name)) throw new Error(`${plugin.name} declares no setting named ${name}`);
          return contributions().settings.values[`${plugin.id}.${name}`] as T;
        },
        subscribe(listener) {
          const heard = () => listener();
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
        register(slot, view) {
          const table = views.get(slot) as Map<string, Owned<typeof view>>;
          if (slot === "page" && /^\/folder(\/|$)/.test((view as Slots["page"]).path)) throw new Error(`${(view as Slots["page"]).path} is where a folder's notes are listed, so no page can be there`);
          if (slot === "page" && [...table.values()].some((o) => (o.value as Slots["page"]).path === (view as Slots["page"]).path)) throw new Error(`There's already a page at ${(view as Slots["page"]).path}`);
          const dispose = keep(add(table, view.id, view, index, `a ${slot} view with the id`));
          owners.set(view, owner);
          if (slot !== "page") return dispose;
          const page = view as Slots["page"];
          const go = keep(command({ id: `go.${page.id}`, title: `Go to ${page.label}`, run: () => provided.app().go(page.path) }));
          return () => {
            dispose();
            go();
          };
        },
      },
      embeds: {
        register(embed) {
          const dispose = keep(add(embeds, embed.name, embed, index, "an embed named"));
          owners.set(embed, owner);
          return dispose;
        },
        list: () =>
          contributions()
            .embeds.filter((e) => e.menu !== false)
            .map(({ name, title, block, starts }) => ({ name, title, block, starts })),
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
      onNotes(listener) {
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
      if (plugin.settings && Object.hasOwn(plugin.settings, "enabled")) throw new Error("A plugin can't declare a setting named enabled, which turns it on and off");
      const stopping = plugin.activate(hostFor(plugin, index, mine));
      if (stopping) mine.add(stopping);
      running.set(plugin.id, mine);
    } catch (err) {
      // A plugin that can't start is left out whole, and the rest of the app carries on.
      for (const dispose of mine) dispose();
      errors.set(plugin.id, err instanceof Error ? err.message : String(err));
    }
  }

  function stop(plugin: Plugin) {
    const mine = running.get(plugin.id) ?? [];
    // It stops running before its contributions go one by one, so what it added is remembered whole and not as it stood halfway out.
    running.delete(plugin.id);
    for (const dispose of mine) dispose();
    errors.delete(plugin.id);
  }

  /** The hint is the chord that runs the command now, which another command may have claimed first. */
  const infoOf = (c: Command): CommandInfo => {
    const chord = chordFor(c.id, contributions().keybindings);
    return { id: c.id, title: c.title, shortcut: chord === undefined ? undefined : chordLabel(chord, mac) };
  };

  function startAll() {
    if (started) return;
    started = starting = true;
    // A required plugin starts first, so no other can take an id it needs. Where its contributions are shown is still its place in the list.
    for (const first of [true, false]) {
      plugins.forEach((plugin, index) => {
        if (required.includes(plugin.id) === first && !off.has(plugin.id)) start(plugin, index);
      });
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
    const isDefault = read && "value" in read && sameValue(read.value, setting!.default);
    write(key, isDefault ? undefined : value);
  }

  function settingsChanged(next: SettingsDocument) {
    document = next;
    plugins.forEach((plugin, index) => {
      if (isOff(plugin) === off.has(plugin.id)) return;
      if (off.delete(plugin.id)) {
        if (started) start(plugin, index);
      } else {
        off.add(plugin.id);
        stop(plugin);
      }
    });
    changed();
    for (const heard of [...watching]) heard();
  }

  /** The schema: each plugin's switch and options, then a keybinding for each command that is on. */
  function declare(all: readonly Command[]): Declared[] {
    const options = plugins.flatMap((p) => {
      const group = { id: p.id, name: p.name };
      const active = running.has(p.id);
      const own = Object.entries(p.settings ?? {}).map(([name, setting]): Declared => ({ key: `${p.id}.${name}`, setting, group, active }));
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
      views: SLOTS.flatMap((slot) => mine(views.get(slot)!.values()).map((view) => ({ slot, id: view.id, label: "label" in view ? view.label : null }))),
      embeds: mine(embeds.values()).map(({ name, title, block }) => ({ name, title, block: block ?? false })),
      completions: mine(completions.values()).map(({ id, trigger }) => ({ id, trigger })),
      editorExtensions: mine(editorExtensions.values()).map((extension) => extension.id),
    };
  }

  function contributions(): Contributions {
    startAll();
    if (snapshot) return snapshot;
    plugins.forEach((p, place) => {
      if (running.has(p.id)) added.set(p.id, addedBy(place));
    });
    const toggles = plugins
      .filter((p) => !required.includes(p.id))
      .map((p): Command => {
        const enable = off.has(p.id);
        return { id: `plugins.${enable ? "enable" : "disable"}.${p.id}`, title: `${enable ? "Enable" : "Disable"} plugin: ${p.name}`, run: () => setEnabled(p.id, enable) };
      });
    const all = [...inOrder(commands.values()), ...toggles];
    const declared = declare(all);
    const { values, problems, chosen } = resolve(declared, document);
    const { keybindings, conflicts } = bind(all.map((c) => ({ id: c.id, title: c.title, chords: [...new Set((values[KEYBINDING + c.id] as readonly string[]).map((chord) => onPlatform(chord, mac)))], chosen: chosen.has(KEYBINDING + c.id) })));
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
        required: required.includes(p.id),
        builtIn: builtIn.includes(p.id),
        error: errors.get(p.id) ?? null,
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
    navigated() {
      arrived = true;
      for (const heard of [...arriving]) heard();
    },
    notesChanged() {
      for (const heard of [...listing]) heard();
    },
  };
}
