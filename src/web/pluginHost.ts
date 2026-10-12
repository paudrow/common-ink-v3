import { chordFor, chordLabel } from "./keybindings.ts";
import type { App, Command, CommandInfo, Dispose, Embed, IconName, Plugin, PluginHost, Screenshot, Slots } from "./plugin-api.ts";

export interface PluginState {
  id: string;
  name: string;
  enabled: boolean;
  /** A required plugin can't be turned off. */
  required: boolean;
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
  embeds: readonly { name: string; title: string }[];
}

/** Everything the plugins that are on have added, in the order of the plugins and then of their registering. */
export interface Contributions {
  commands: readonly Command[];
  /** Which command each chord runs. The first command to claim a chord keeps it. */
  keybindings: Readonly<Record<string, string>>;
  views: { readonly [S in keyof Slots]: readonly Slots[S][] };
  embeds: readonly Embed[];
  plugins: readonly PluginState[];
}

/** What the app gives each plugin beyond registering: its reach into the workspace, bound to that plugin. */
export type Provided = Pick<PluginHost, "workspace" | "app" | "perform" | "agents" | "storage">;

export interface HostOptions {
  /** Every installed plugin, in the order their contributions are shown. */
  plugins: readonly Plugin[];
  required?: readonly string[];
  /** Where the ids of the plugins turned off are kept. */
  disabled: { read(): string[]; write(ids: string[]): void };
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
  /** Records against its plugin that a view or embed threw while being drawn. */
  fail(contribution: object, error: unknown): void;
  /** Turns every plugin off without forgetting which are on. They start again the next time contributions are read. */
  dispose(): void;
}

interface Owned<T> {
  plugin: number;
  seq: number;
  value: T;
}

const SLOTS = ["column", "section", "rail", "editor", "folder", "inspector", "page", "overlay"] as const satisfies readonly (keyof Slots)[];

const inOrder = <T>(owned: Iterable<Owned<T>>) => [...owned].sort((a, b) => a.plugin - b.plugin || a.seq - b.seq).map((o) => o.value);

export function createPluginHost({ plugins, required = [], disabled, mac, provide }: HostOptions): Host {
  const commands = new Map<string, Owned<Command>>();
  const embeds = new Map<string, Owned<Embed>>();
  const views = new Map<keyof Slots, Map<string, Owned<Slots[keyof Slots]>>>(SLOTS.map((slot) => [slot, new Map()]));
  /** What each running plugin registered, to take back out when it is turned off. */
  const running = new Map<string, Set<Dispose>>();
  const errors = new Map<string, string>();
  /** What each plugin had registered when contributions were last read with it on. */
  const added = new Map<string, Added>();
  const off = new Set(disabled.read().filter((id) => !required.includes(id)));
  const listeners = new Set<() => void>();
  /** Which plugin registered a view or an embed, and the reach that plugin was given. */
  const owners = new WeakMap<object, { id: string; app: () => App }>();
  /** Plugins start when contributions are first read, so a host that is made and never used starts nothing. */
  let started = false;
  let starting = false;
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
    const provided = provide({ id: plugin.id, name: plugin.name });
    const keep = (dispose: Dispose) => {
      mine.add(dispose);
      return dispose;
    };
    const command = (c: Command) => add(commands, c.id, c, index, "a command with the id");
    const owner = { id: plugin.id, app: provided.app };
    return {
      plugin: { id: plugin.id, name: plugin.name },
      ...provided,
      commands: {
        register: (c) => keep(command(c)),
        list: () => contributions().commands.map(infoOf),
        run,
      },
      views: {
        register(slot, view) {
          const table = views.get(slot) as Map<string, Owned<typeof view>>;
          if (slot === "page" && /^\/folder(\/|$)/.test((view as Slots["page"]).path)) throw new Error(`${(view as Slots["page"]).path} is where a folder's notes are listed, so no page can be there`);
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
      },
    };
  }

  function start(plugin: Plugin, index: number) {
    const mine = new Set<Dispose>();
    errors.delete(plugin.id);
    try {
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
    plugins.forEach((plugin, index) => {
      if (!off.has(plugin.id)) start(plugin, index);
    });
    starting = false;
  }

  function fail(contribution: object, error: unknown) {
    const owner = owners.get(contribution);
    const message = error instanceof Error ? error.message : String(error);
    const known = owner && errors.get(owner.id);
    if (!owner || known?.split("; ").includes(message)) return;
    errors.set(owner.id, known ? `${known}; ${message}` : message);
    changed();
  }

  function dispose() {
    if (!started) return;
    for (const plugin of plugins) stop(plugin);
    started = false;
    changed();
  }

  function setEnabled(id: string, enabled: boolean) {
    startAll();
    const index = plugins.findIndex((p) => p.id === id);
    if (index < 0 || required.includes(id) || enabled === !off.has(id)) return;
    if (enabled) {
      off.delete(id);
      start(plugins[index]!, index);
    } else {
      off.add(id);
      stop(plugins[index]!);
    }
    disabled.write([...off]);
    changed();
  }

  /** What the plugin at one place has in the tables now. */
  function addedBy(place: number): Added {
    const mine = <T>(owned: Iterable<Owned<T>>) => inOrder([...owned].filter((o) => o.plugin === place));
    return {
      commands: mine(commands.values()).map(({ id, title }) => ({ id, title })),
      views: SLOTS.flatMap((slot) => mine(views.get(slot)!.values()).map((view) => ({ slot, id: view.id, label: "label" in view ? view.label : null }))),
      embeds: mine(embeds.values()).map(({ name, title }) => ({ name, title })),
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
    const keybindings: Record<string, string> = {};
    for (const c of all) for (const chord of c.keys ?? []) keybindings[chord] ??= c.id;
    return (snapshot = {
      commands: all,
      keybindings,
      views: Object.fromEntries(SLOTS.map((slot) => [slot, inOrder(views.get(slot)!.values())])) as unknown as Contributions["views"],
      embeds: inOrder(embeds.values()),
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: !off.has(p.id),
        required: required.includes(p.id),
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
  };
}
