import { describe, expect, it } from "vitest";
import type { App, Dispose, OpInput, Plugin, PluginHost, SettingValue } from "../../src/web/plugin-api.ts";
import { createPluginHost, type Host, type HostOptions } from "../../src/web/pluginHost.ts";
import { onPlatform } from "../../src/web/keybindings.ts";
import { html as htmlPlugin } from "../../src/web/plugins/html/index.ts";
import { documentOf, editSetting } from "../../src/web/settings.ts";

const View = () => null;

function hostWith(plugins: Plugin[], options: Partial<HostOptions> = {}) {
  /** The member's document, kept the way the app keeps it: as text, edited one key at a time. */
  let text = JSON.stringify(options.settings ?? {});
  const went: string[] = [];
  const performed: [plugin: string, op: string][] = [];
  const host: Host = createPluginHost({
    plugins,
    mac: true,
    settings: {},
    write(key: string, value: SettingValue | undefined) {
      text = editSetting(text, key, value);
      host.settingsChanged(documentOf(text)!);
    },
    provide: (plugin) => ({
      workspace: { id: "w1", name: "Acme", role: "editor" },
      app: () => ({ go: (path: string) => void went.push(path) }) as App,
      perform: (async (op: { type: string }) => void performed.push([plugin.id, op.type])) as PluginHost["perform"],
      agents: { list: async () => [], connect: async () => ({}) as never, edit: async () => ({}) as never, disconnect: async () => {} },
      storage: { get: () => undefined, set: () => {} },
    }),
    ...options,
  });
  host.contributions();
  const ids = () => host.contributions().commands.map((c) => c.id);
  /** Replaces the member's document, as editing the JSON does. */
  const wrote = (document: Record<string, unknown>) => {
    text = JSON.stringify(document);
    host.settingsChanged(document);
  };
  const problems = () => host.contributions().settings.problems;
  return { host, ids, went, performed, stored: () => JSON.parse(text) as Record<string, unknown>, wrote, problems };
}

const notes: Plugin = {
  id: "notes",
  name: "Notes",
  activate(host) {
    host.commands.register({ id: "note.new", title: "New note", run: () => {}, keys: ["mod+n"] });
    host.views.register("column", { id: "list", component: View });
    host.views.register("page", { id: "todos", path: "/todos", label: "Todos", component: View });
    host.embeds.register({ name: "timer", title: "Timer", starts: { config: "5m" }, render: () => {} });
    host.completions.register({ id: "embeds", trigger: "/", items: () => host.embeds.list().map((e) => ({ label: e.title, insert: `::${e.name}{${e.starts?.config ?? ""}}` })) });
  },
};

const palette: Plugin = {
  id: "palette",
  name: "Command palette",
  activate(host) {
    host.commands.register({ id: "commands.show", title: "Show all commands", run: () => {}, keys: ["mod+shift+p", "f1"] });
    host.views.register("overlay", { id: "commands", component: View });
  },
};

describe("plugin host", () => {
  it("lists what plugins add: commands, their chords, views by slot, and embeds", () => {
    const { host, ids } = hostWith([notes, palette]);
    const { views, embeds, keybindings } = host.contributions();

    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.toggle.notes", "plugins.toggle.palette"]);
    expect(keybindings).toEqual({ "mod+n": "note.new", "mod+shift+p": "commands.show", f1: "commands.show" });
    expect(views.column.map((v) => v.id)).toEqual(["list"]);
    expect(views.page.map((v) => [v.id, v.path])).toEqual([["todos", "/todos"]]);
    expect(views.overlay.map((v) => v.id)).toEqual(["commands"]);
    expect(views.inspector).toEqual([]);
    expect(embeds.map((e) => e.name)).toEqual(["timer"]);
  });

  it("lists the embeds to a plugin as a menu would offer them, and takes a completion out with its plugin", async () => {
    const board: Plugin = { id: "board", name: "Board", activate: (h) => void h.embeds.register({ name: "kanban", title: "Kanban board", block: true, render: () => {} }) };
    const { host } = hostWith([notes, board]);
    const [menu] = host.contributions().completions;

    expect([menu!.id, menu!.trigger]).toEqual(["embeds", "/"]);
    expect(await menu!.items("")).toEqual([
      { label: "Timer", insert: "::timer{5m}" },
      { label: "Kanban board", insert: "::kanban{}" },
    ]);

    host.setEnabled("board", false);
    expect(await menu!.items("")).toEqual([{ label: "Timer", insert: "::timer{5m}" }]);
    host.setEnabled("notes", false);
    expect(host.contributions().completions).toEqual([]);
  });

  it("holds a completion that threw against its plugin", () => {
    const { host } = hostWith([notes]);

    host.fail(host.contributions().completions[0]!, new Error("The menu broke"));
    expect(host.contributions().plugins.find((p) => p.id === "notes")!.error).toBe("The menu broke");
  });

  it("runs a command by its id, and says so when nobody registered it", () => {
    const ran: string[] = [];
    const { host } = hostWith([{ id: "a", name: "A", activate: (h) => void h.commands.register({ id: "a.go", title: "Go", run: () => ran.push("a") }) }]);

    expect(host.run("a.go")).toBe(true);
    expect(ran).toEqual(["a"]);
    expect(host.run("b.go")).toBe(false);
  });

  it("gives each page a command that goes to it", () => {
    const { host, went } = hostWith([notes]);

    host.run("go.todos");
    expect(went).toEqual(["/todos"]);
    expect(host.contributions().commands.find((c) => c.id === "go.todos")!.title).toBe("Go to Todos");
  });

  it("takes out everything a plugin added when it is turned off, and puts it back in the same order when turned on", () => {
    const { host, ids, stored } = hostWith([notes, palette]);

    host.setEnabled("notes", false);
    expect(ids()).toEqual(["commands.show", "plugins.toggle.notes", "plugins.toggle.palette"]);
    expect(host.contributions().keybindings).toEqual({ "mod+shift+p": "commands.show", f1: "commands.show" });
    expect(host.contributions().views.column).toEqual([]);
    expect(host.contributions().views.page).toEqual([]);
    expect(host.contributions().embeds).toEqual([]);
    expect(host.run("note.new")).toBe(false);
    expect(stored()).toEqual({ "notes.enabled": false });
    expect(host.contributions().plugins.map((p) => [p.id, p.enabled])).toEqual([
      ["notes", false],
      ["palette", true],
    ]);

    host.setEnabled("notes", true);
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.toggle.notes", "plugins.toggle.palette"]);
    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["timer"]);
    expect(stored()).toEqual({});
  });

  it("leaves a plugin off that was turned off before, and turns it on from its command", () => {
    const { host, ids } = hostWith([notes, palette], { settings: { "palette.enabled": false } });

    expect(ids()).toEqual(["note.new", "go.todos", "plugins.toggle.notes", "plugins.toggle.palette"]);
    expect(host.contributions().commands.at(-1)!.title).toBe("Enable plugin: Command palette");

    host.run("plugins.toggle.palette");
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.toggle.notes", "plugins.toggle.palette"]);
  });

  it("keeps a key given to a plugin's switch through turning it off and on, under one command whose title says which it does", () => {
    const { host, wrote, stored, problems, ids } = hostWith([notes, palette], { settings: { "keybindings.plugins.toggle.notes": ["mod+shift+9"] } });
    const key = onPlatform("mod+shift+9", false);
    const toggle = () => host.contributions().commands.find((c) => c.id === host.contributions().keybindings[key])!;

    expect([toggle().id, toggle().title]).toEqual(["plugins.toggle.notes", "Disable plugin: Notes"]);
    host.run(toggle().id);
    wrote(stored());
    // It used to become another command once the plugin was off, which the key was not bound to and the settings called unknown.
    expect(ids()).not.toContain("note.new");
    expect([toggle().id, toggle().title]).toEqual(["plugins.toggle.notes", "Enable plugin: Notes"]);
    expect(problems()).toEqual([]);
    host.run(toggle().id);
    wrote(stored());
    expect(ids()).toContain("note.new");
    expect([toggle().id, toggle().title]).toEqual(["plugins.toggle.notes", "Disable plugin: Notes"]);
    expect(problems()).toEqual([]);
  });

  it("carries on when a plugin throws as it is told of a change to the settings, or as it is stopped, and holds it against that plugin", () => {
    const heard: string[] = [];
    const stopped: string[] = [];
    const loud: Plugin = {
      id: "loud",
      name: "Loud",
      settings: { size: { type: "integer", default: 1, title: "Size" } },
      activate(h) {
        h.settings.subscribe(() => {
          throw new Error("The listener broke");
        });
        h.commands.register({ id: "loud.go", title: "Go", run: () => {} });
        return () => {
          throw new Error("The stop broke");
        };
      },
    };
    const quiet: Plugin = {
      id: "quiet",
      name: "Quiet",
      settings: { size: { type: "integer", default: 1, title: "Size" } },
      activate(h) {
        h.settings.subscribe(() => heard.push(`quiet ${h.settings.get<number>("size")}`));
        return () => stopped.push("quiet");
      },
    };
    const { host, wrote, ids } = hostWith([loud, quiet]);
    const errorOf = (id: string) => host.contributions().plugins.find((p) => p.id === id)!.error;

    // Either throw used to come out of the change itself, in the middle of the settings being saved, and nothing was saved after it.
    expect(() => wrote({ "quiet.size": 2 })).not.toThrow();
    expect(heard).toEqual(["quiet 2"]);
    expect(errorOf("loud")).toBe("The listener broke");

    expect(() => wrote({ "quiet.size": 2, "loud.enabled": false, "quiet.enabled": false })).not.toThrow();
    expect(stopped).toEqual(["quiet"]);
    expect(ids()).not.toContain("loud.go");
    expect(host.contributions().plugins.map((p) => [p.id, p.enabled])).toEqual([["loud", false], ["quiet", false]]);
    expect(errorOf("loud")).toBe("The stop broke");

    wrote({});
    expect(ids()).toContain("loud.go");
    expect(() => host.dispose()).not.toThrow();
  });

  it("won't turn off a required plugin, whatever was stored", () => {
    const { host, ids } = hostWith([notes, palette], { required: ["notes"], settings: { "notes.enabled": false } });

    host.setEnabled("notes", false);
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.toggle.palette"]);
    expect(host.contributions().plugins[0]).toEqual({ id: "notes", name: "Notes", enabled: true, required: true, builtIn: false, error: null, description: null, icon: null, screenshots: [], adds: expect.any(Object) });
  });

  it("says which plugins came with the app, and no others", () => {
    const { host } = hostWith([notes, palette], { builtIn: ["notes"] });

    expect(host.contributions().plugins.map((p) => [p.id, p.builtIn])).toEqual([
      ["notes", true],
      ["palette", false],
    ]);
  });

  it("leaves out the whole of a plugin that can't start, and says why", () => {
    const clashing: Plugin = {
      id: "clash",
      name: "Clash",
      activate(host) {
        host.commands.register({ id: "clash.first", title: "First", run: () => {} });
        host.commands.register({ id: "note.new", title: "Another new note", run: () => {} });
      },
    };
    const { host, ids } = hostWith([notes, clashing]);

    expect(ids()).toEqual(["note.new", "go.todos", "plugins.toggle.notes", "plugins.toggle.clash"]);
    expect(host.contributions().commands[0]!.title).toBe("New note");
    expect(host.contributions().plugins[1]!.error).toBe("There's already a command with the id note.new");
  });

  it("takes a single contribution back out, leaving one registered later under the same id", () => {
    const ran: string[] = [];
    let first: Dispose = () => {};
    const { host, ids } = hostWith([
      {
        id: "a",
        name: "A",
        activate(h) {
          first = h.commands.register({ id: "a.go", title: "Go", run: () => ran.push("first") });
          first();
          h.commands.register({ id: "a.go", title: "Go", run: () => ran.push("second") });
        },
      },
    ]);

    first();
    host.run("a.go");
    expect(ran).toEqual(["second"]);
    expect(ids()).toEqual(["a.go", "plugins.toggle.a"]);
  });

  it("lists commands for a plugin with each one's first chord as a person reads it", () => {
    let list: PluginHost["commands"]["list"] = () => [];
    hostWith([notes, palette, { id: "reader", name: "Reader", activate: (h) => void (list = h.commands.list) }]);

    expect(list().slice(0, 3)).toEqual([
      { id: "note.new", title: "New note", shortcut: "⌘N" },
      { id: "go.todos", title: "Go to Todos", shortcut: undefined },
      { id: "commands.show", title: "Show all commands", shortcut: "⇧⌘P" },
    ]);
  });

  it("hints at the chord that runs a command now, not one another command claimed first", () => {
    let list: PluginHost["commands"]["list"] = () => [];
    const later: Plugin = {
      id: "later",
      name: "Later",
      activate(h) {
        h.commands.register({ id: "later.find", title: "Find", run: () => {}, keys: ["mod+n", "mod+f"] });
        h.commands.register({ id: "later.new", title: "New thing", run: () => {}, keys: ["mod+n"] });
        list = h.commands.list;
      },
    };
    const { host } = hostWith([notes, later]);

    expect(host.contributions().keybindings["mod+n"]).toBe("note.new");
    expect(list().filter((c) => c.id !== "go.todos" && !c.id.startsWith("plugins.")).map((c) => [c.id, c.shortcut])).toEqual([
      ["note.new", "⌘N"],
      ["later.find", "⌘F"],
      ["later.new", undefined],
    ]);
  });

  it("runs what a plugin's activate returns when the plugin is turned off", () => {
    const stopped: string[] = [];
    const ticking: Plugin = { id: "ticking", name: "Ticking", activate: () => () => void stopped.push("ticking") };
    const { host } = hostWith([notes, ticking]);

    expect(stopped).toEqual([]);
    host.setEnabled("ticking", false);
    expect(stopped).toEqual(["ticking"]);
    host.setEnabled("ticking", true);
    host.setEnabled("ticking", false);
    expect(stopped).toEqual(["ticking", "ticking"]);
  });

  it("starts nothing until contributions are read, stops every plugin when disposed, and starts one set again after", () => {
    const events: string[] = [];
    const counted = (id: string): Plugin => ({
      id,
      name: id,
      activate(h) {
        events.push(`start ${id}`);
        h.commands.register({ id: `${id}.go`, title: id, run: () => {} });
        return () => void events.push(`stop ${id}`);
      },
    });
    const host = createPluginHost({
      plugins: [counted("a"), counted("b"), counted("c")],
      mac: true,
      settings: { "b.enabled": false },
      write: () => {},
      provide: () => ({}) as never,
    });
    const ids = () => host.contributions().commands.map((c) => c.id);

    expect(events).toEqual([]);
    expect(ids()).toEqual(["a.go", "c.go", "plugins.toggle.a", "plugins.toggle.b", "plugins.toggle.c"]);
    expect(events).toEqual(["start a", "start c"]);

    host.dispose();
    host.dispose();
    expect(events).toEqual(["start a", "start c", "stop a", "stop c"]);

    expect(ids()).toEqual(["a.go", "c.go", "plugins.toggle.a", "plugins.toggle.b", "plugins.toggle.c"]);
    expect(events).toEqual(["start a", "start c", "stop a", "stop c", "start a", "start c"]);
  });

  it("gives a view its own plugin's app, and records what failed while drawing against that plugin", () => {
    const view = { id: "drawn", component: View };
    const embed = { name: "clock", title: "Clock", render: () => {} };
    const drawing: Plugin = {
      id: "drawing",
      name: "Drawing",
      activate(h) {
        h.views.register("column", view);
        h.embeds.register(embed);
      },
    };
    const host: Host = createPluginHost({
      plugins: [notes, drawing],
      mac: true,
      settings: {},
      write: (key, value) => host.settingsChanged(value === undefined ? {} : { [key]: value }),
      provide: (plugin) => ({ app: () => ({ path: `/as/${plugin.id}` }) as App }) as never,
    });
    const errorOf = (id: string) => host.contributions().plugins.find((p) => p.id === id)!.error;

    expect(host.appFor(host.contributions().views.column.find((v) => v === view)!).path).toBe("/as/drawing");
    expect(host.appFor(host.contributions().views.page[0]!).path).toBe("/as/notes");

    host.fail(view, new Error("The column broke"));
    host.fail(view, new Error("The column broke"));
    host.fail(embed, new Error("The embed broke"));
    expect(errorOf("drawing")).toBe("The column broke; The embed broke");
    expect(errorOf("notes")).toBeNull();

    host.setEnabled("drawing", false);
    expect(errorOf("drawing")).toBeNull();
  });

  it("performs an operation for the plugin that asked", async () => {
    let asked: PluginHost | null = null;
    const { performed } = hostWith([notes, { id: "history", name: "History", activate: (h) => void (asked = h) }]);

    await asked!.perform({ type: "history.authors" });
    expect(performed).toEqual([["history", "history.authors"]]);
    expect(asked!.plugin).toEqual({ id: "history", name: "History" });
  });

  it("tells whoever is listening when contributions change, and hands back the same list until they do", () => {
    const { host } = hostWith([notes, palette]);
    let told = 0;
    const stop = host.subscribe(() => told++);
    const before = host.contributions();

    expect(host.contributions()).toBe(before);
    host.setEnabled("palette", false);
    expect(told).toBeGreaterThanOrEqual(1);
    expect(host.contributions()).not.toBe(before);
    expect(host.contributions().views.overlay).toEqual([]);

    stop();
    const heard = told;
    host.setEnabled("palette", true);
    expect(told).toBe(heard);
  });

  it("refuses a plugin that asks to read or change the member's settings, and never sends it on", async () => {
    let asked: PluginHost | null = null;
    const { performed, stored } = hostWith([{ id: "greedy", name: "Greedy", activate: (h) => void (asked = h) }]);
    const perform = asked!.perform as (op: OpInput) => Promise<unknown>;

    await expect(perform({ type: "settings.write", text: '{"core.theme":"dark"}', baseRevision: 0 })).rejects.toThrow("Greedy can't settings.write: a plugin can't read or change the member's settings");
    await expect(perform({ type: "settings.read" })).rejects.toThrow("Greedy can't settings.read");
    expect(performed).toEqual([]);
    expect(stored()).toEqual({});
    expect(Object.keys(asked!.settings).sort()).toEqual(["get", "subscribe"]);
  });

  it("lets the HTML embeds plugin read whether to run HTML by itself, and no plugin change it or another read it", async () => {
    let html: PluginHost | null = null;
    let other: PluginHost | null = null;
    const { host, stored, performed } = hostWith([
      { ...htmlPlugin, activate: (h) => void (html = h) },
      { id: "greedy", name: "Greedy", activate: (h) => void (other = h) },
    ]);
    expect(host.contributions().settings.values["html.run"]).toBe("automatically");
    expect(html!.settings.get("run")).toBe("automatically");
    expect(() => other!.settings.get("run")).toThrow("Greedy declares no setting named run");
    for (const plugin of [html!, other!]) {
      await expect((plugin.perform as (op: OpInput) => Promise<unknown>)({ type: "settings.write", text: '{"html.run":"automatically"}', baseRevision: 0 })).rejects.toThrow("a plugin can't read or change the member's settings");
      await expect((plugin.perform as (op: OpInput) => Promise<unknown>)({ type: "settings.read" })).rejects.toThrow("a plugin can't read or change the member's settings");
    }
    // Only the member sets it, and what they set is what the plugin reads.
    host.setSetting("html.run", "ask first");
    expect(stored()).toEqual({ "html.run": "ask first" });
    expect(html!.settings.get("run")).toBe("ask first");
    // A value it can't read asks first, as does one written in other letters or as something other than words.
    for (const value of ["whenever", "Ask first", ["ask first"], 1]) {
      host.setSetting("html.run", "automatically");
      host.setSetting("html.run", value as SettingValue);
      expect(html!.settings.get("run"), JSON.stringify(value)).toBe("ask first");
    }
    expect(performed).toEqual([]);
  });

  it("sends a plugin's operation as it was looked at, so one whose type changes as it is read can't reach the member's settings", async () => {
    let asked: PluginHost | null = null;
    const { performed } = hostWith([{ id: "sly", name: "Sly", activate: (h) => void (asked = h) }]);
    let reads = 0;
    const shifty = { get type() { return reads++ === 0 ? "note.list" : "settings.write"; }, text: "{}", baseRevision: 0 };
    await (asked!.perform as (op: unknown) => Promise<unknown>)(shifty);
    expect(performed).toEqual([["sly", "note.list"]]);
    await expect((asked!.perform as (op: unknown) => Promise<unknown>)({ type: 5 })).rejects.toThrow("a plugin can't read or change the member's settings");
  });

  it("leaves out a plugin whose id another has, so it never starts and can't read that one's settings", () => {
    const started: string[] = [];
    let impostor: PluginHost | null = null;
    const { host } = hostWith([
      { ...htmlPlugin, activate: () => void started.push("html") },
      { id: "html", name: "Impostor", settings: { run: { title: "Run", type: "string", default: "x" } }, activate: (h) => void (started.push("impostor"), (impostor = h)) },
    ]);
    host.setSetting("html.run", "ask first");
    expect(started).toEqual(["html"]);
    expect(impostor).toBeNull();
    expect(host.contributions().plugins.map((p) => p.name)).toEqual(["HTML embeds"]);
  });
});

const size = { type: "integer", default: 14, minimum: 8, maximum: 32, title: "Text size" } as const;
const reader: Plugin = {
  id: "reader",
  name: "Reader",
  settings: { size, face: { type: "string", default: "serif", enum: ["serif", "sans"], title: "Typeface" } },
  activate(host) {
    host.commands.register({ id: "reader.open", title: "Open reader", keys: ["mod+r"], run: () => {} });
  },
};

describe("settings, as the plugin host assembles and reads them", () => {
  it("declares each plugin's switch and options under its id, then a keybinding for every command that is on", () => {
    const { host } = hostWith([notes, reader], { required: ["notes"] });

    expect(host.contributions().settings.declared.map((d) => [d.key, d.group.name, d.setting.type, d.setting.default])).toEqual([
      ["reader.enabled", "Reader", "boolean", true],
      ["reader.size", "Reader", "integer", 14],
      ["reader.face", "Reader", "string", "serif"],
      ["keybindings.note.new", "Keybindings", "chords", ["mod+n"]],
      ["keybindings.go.todos", "Keybindings", "chords", []],
      ["keybindings.reader.open", "Keybindings", "chords", ["mod+r"]],
      ["keybindings.plugins.toggle.reader", "Keybindings", "chords", []],
    ]);
    expect(host.contributions().settings.declared.find((d) => d.key === "reader.size")!.setting).toBe(size);
  });

  it("gives a plugin its own options: the default, then what the member wrote, as soon as they write it", () => {
    let mine: PluginHost["settings"] | null = null;
    let told = 0;
    const watcher: Plugin = { ...reader, activate: (h) => void ((mine = h.settings), h.settings.subscribe(() => told++)) };
    const { wrote } = hostWith([watcher]);

    expect(mine!.get("size")).toBe(14);
    wrote({ "reader.size": 20 });
    expect(mine!.get("size")).toBe(20);
    expect(told).toBe(1);
    expect(() => mine!.get("theme")).toThrow("Reader declares no setting named theme");
  });

  it("overlays only the valid values on the defaults, and says what is wrong with the rest without dropping it", () => {
    const { host, wrote, problems, stored } = hostWith([reader]);
    const document = { "reader.size": 99, "reader.face": "sans", "reader.colour": "red", "keybindings.reader.open": ["cmd+r"], "keybindings.gone.command": ["mod+g"] };

    wrote(document);

    const { values } = host.contributions().settings;
    expect([values["reader.size"], values["reader.face"], values["keybindings.reader.open"]]).toEqual([14, "sans", ["mod+r"]]);
    expect(problems()).toEqual([
      { key: "reader.size", kind: "invalid", reason: "Expected 32 or less, not 99. The default is used." },
      { key: "keybindings.reader.open", kind: "invalid", reason: '"cmd" in "cmd+r" isn\'t a modifier. Use mod, ctrl, alt, or shift, then one key. The default is used.' },
      { key: "reader.colour", kind: "unknown", reason: "There's no setting by this name. It may belong to a plugin that isn't installed." },
      { key: "keybindings.gone.command", kind: "unknown", reason: 'There\'s no command "gone.command". It may belong to a plugin that is off.' },
    ]);
    expect(stored()).toEqual(document);
  });

  it("writes one key and keeps the member's others, and takes a key out when it is set back to its default", () => {
    const { host, stored, wrote } = hostWith([reader]);
    wrote({ "not.a.setting": { kept: true }, "reader.face": "sans" });

    host.setSetting("reader.size", 20);
    expect(stored()).toEqual({ "not.a.setting": { kept: true }, "reader.face": "sans", "reader.size": 20 });

    host.setSetting("reader.size", 14);
    host.setSetting("reader.face", "serif");
    expect(stored()).toEqual({ "not.a.setting": { kept: true } });

    host.setSetting("not.a.setting", undefined);
    expect(stored()).toEqual({});
  });

  it("keeps a plugin's options known and its keys in the document while it is off, and marks them as not applying", () => {
    const { host, wrote, problems, stored } = hostWith([reader]);

    wrote({ "reader.enabled": false, "reader.size": 20, "keybindings.reader.open": ["mod+o"] });

    expect(host.contributions().plugins[0]!.enabled).toBe(false);
    expect(host.contributions().settings.declared.filter((d) => d.group.id === "reader").map((d) => [d.key, d.active])).toEqual([
      ["reader.enabled", true],
      ["reader.size", false],
      ["reader.face", false],
    ]);
    expect(host.contributions().settings.values["reader.size"]).toBe(20);
    expect(problems()).toEqual([{ key: "keybindings.reader.open", kind: "unknown", reason: 'There\'s no command "reader.open". It may belong to a plugin that is off.' }]);

    host.setEnabled("reader", true);
    expect(stored()).toEqual({ "reader.size": 20, "keybindings.reader.open": ["mod+o"] });
    expect(problems()).toEqual([]);
    expect(host.contributions().keybindings["mod+o"]).toBe("reader.open");
  });

  it("turns plugins on and off as the document says, whoever wrote it", () => {
    const { ids, wrote } = hostWith([notes, palette]);

    wrote({ "notes.enabled": false });
    expect(ids()).toEqual(["commands.show", "plugins.toggle.notes", "plugins.toggle.palette"]);
    wrote({ "notes.enabled": "no" });
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.toggle.notes", "plugins.toggle.palette"]);
  });

  it("won't start a plugin that declares the setting that turns it off", () => {
    const { host } = hostWith([{ id: "sly", name: "Sly", settings: { enabled: { type: "boolean", default: true, title: "On" } }, activate: () => {} }]);

    expect(host.contributions().plugins[0]!.error).toBe("A plugin can't declare a setting named enabled, which turns it on and off");
  });
});

describe("what is the host's and the required plugins' to have", () => {
  const pages: Plugin = { id: "pages", name: "Pages", activate: (h) => void h.views.register("page", { id: "settings", path: "/settings", label: "Settings", component: View }) };
  const errorOf = (host: Host, id: string) => host.contributions().plugins.find((p) => p.id === id)!.error;

  it("starts a required plugin before the others, wherever it is listed, so none of them can take its ids", () => {
    const squatter: Plugin = { id: "squatter", name: "Squatter", activate: (h) => void h.views.register("page", { id: "settings", path: "/mine", label: "Mine", component: View }) };
    const { host } = hostWith([notes, squatter, pages], { required: ["pages"] });

    expect(host.contributions().views.page.map((p) => [p.id, p.path])).toEqual([
      ["todos", "/todos"],
      ["settings", "/settings"],
    ]);
    expect(errorOf(host, "pages")).toBeNull();
    expect(errorOf(host, "squatter")).toBe("There's already a page view with the id settings");
    expect(host.contributions().commands.map((c) => c.id)).toContain("go.settings");
  });

  it("keeps one page to an address", () => {
    const squatter: Plugin = { id: "squatter", name: "Squatter", activate: (h) => void h.views.register("page", { id: "mine", path: "/settings", label: "Mine", component: View }) };
    const { host } = hostWith([squatter, pages], { required: ["pages"] });

    expect(host.contributions().views.page.map((p) => p.id)).toEqual(["settings"]);
    expect(errorOf(host, "squatter")).toBe("There's already a page at /settings");
  });

  it("keeps pages off the addresses where a folder's notes are listed", () => {
    for (const path of ["/folder", "/folder/all"] as const) {
      const squatter: Plugin = { id: "squatter", name: "Squatter", activate: (h) => void h.views.register("page", { id: "mine", path, label: "Mine", component: View }) };
      const { host } = hostWith([squatter]);

      expect(host.contributions().views.page).toEqual([]);
      expect(errorOf(host, "squatter")).toBe(`${path} is where a folder's notes are listed, so no page can be there`);
    }
    const near: Plugin = { id: "near", name: "Near", activate: (h) => void h.views.register("page", { id: "folders", path: "/folders", label: "Folders", component: View }) };
    expect(hostWith([near]).host.contributions().views.page.map((p) => p.path)).toEqual(["/folders"]);
  });

  it("refuses a plugin a command id that starts as the host's own do, and leaves that plugin out", () => {
    for (const id of ["go.settings", "go.elsewhere", "plugins.toggle.notes", "settings.open"]) {
      const ran: string[] = [];
      const impostor: Plugin = {
        id: "impostor",
        name: "Impostor",
        activate(h) {
          h.commands.register({ id: "impostor.fine", title: "Fine", run: () => {} });
          h.commands.register({ id, title: "Enable plugin: Notes", run: () => ran.push(id) });
        },
      };
      const { host, ids } = hostWith([impostor, notes, pages], { required: ["pages"], settings: { "notes.enabled": false } });

      expect(errorOf(host, "impostor"), id).toBe(`Only Common Ink adds a command whose id starts with ${id.split(".")[0]}., and this one is ${id}`);
      expect(ids()).not.toContain("impostor.fine");
      host.run("plugins.toggle.notes");
      expect(ran).toEqual([]);
      expect(ids()).toContain("note.new");
      expect(ids()).toContain("go.settings");
    }
  });

  it("lets a required plugin add such a command, and gives any plugin's page its go command", () => {
    const core: Plugin = { id: "core", name: "Core", activate: (h) => void h.commands.register({ id: "settings.open", title: "Open settings", run: () => {} }) };
    const { host, ids } = hostWith([core, notes], { required: ["core"] });

    expect(ids()).toEqual(["settings.open", "note.new", "go.todos", "plugins.toggle.notes"]);
    expect(errorOf(host, "notes")).toBeNull();
  });
});

describe("keybindings, as settings", () => {
  it("says which command is left with no key when the member gives its only chord to another", () => {
    const { wrote, problems } = hostWith([notes, palette]);

    wrote({ "keybindings.commands.show": ["mod+n", "f1"] });
    expect(problems()).toEqual([
      { key: "keybindings.commands.show", kind: "conflict", reason: "mod+n is also the key for New note (note.new). It runs Show all commands. New note is left with no key." },
    ]);

    wrote({ "keybindings.note.new": ["mod+shift+p"] });
    expect(problems()).toEqual([{ key: "keybindings.note.new", kind: "conflict", reason: "mod+shift+p is also the key for Show all commands (commands.show). It runs New note." }]);
  });

  const shortcuts = (host: Host) => host.contributions().keybindings;

  it("rebinds a command, in the table and in what the palette shows", () => {
    let list: PluginHost["commands"]["list"] = () => [];
    const { host, wrote, problems } = hostWith([notes, palette, { id: "reader", name: "Reader", activate: (h) => void (list = h.commands.list) }]);

    wrote({ "keybindings.note.new": ["shift+MOD+k", "f2"] });

    expect(shortcuts(host)).toEqual({ "mod+shift+k": "note.new", f2: "note.new", "mod+shift+p": "commands.show", f1: "commands.show" });
    expect(list()[0]).toEqual({ id: "note.new", title: "New note", shortcut: "⇧⌘K" });
    expect(problems()).toEqual([]);
  });

  it("unbinds a default with an empty list", () => {
    let list: PluginHost["commands"]["list"] = () => [];
    const { host, wrote } = hostWith([notes, palette, { id: "reader", name: "Reader", activate: (h) => void (list = h.commands.list) }]);

    wrote({ "keybindings.commands.show": [] });

    expect(shortcuts(host)).toEqual({ "mod+n": "note.new" });
    expect(list()[2]).toEqual({ id: "commands.show", title: "Show all commands", shortcut: undefined });
  });

  it("gives a chord to the command the member bound it to, and flags that another command had it", () => {
    const { host, wrote, problems } = hostWith([notes, palette]);

    wrote({ "keybindings.commands.show": ["mod+n"] });

    expect(shortcuts(host)).toEqual({ "mod+n": "commands.show" });
    expect(problems()).toEqual([{ key: "keybindings.commands.show", kind: "conflict", reason: "mod+n is also the key for New note (note.new). It runs Show all commands. New note is left with no key." }]);

    wrote({ "keybindings.commands.show": ["mod+n"], "keybindings.note.new": [] });
    expect(problems()).toEqual([]);
  });

  it("flags both commands when the member binds one chord twice, and runs the first", () => {
    const { host, wrote, problems } = hostWith([notes, palette]);

    wrote({ "keybindings.commands.show": ["mod+j"], "keybindings.note.new": ["mod+j"] });

    expect(shortcuts(host)).toEqual({ "mod+j": "note.new" });
    expect(problems()).toEqual([
      { key: "keybindings.note.new", kind: "conflict", reason: "mod+j is also the key for Show all commands (commands.show). It runs New note. Show all commands is left with no key." },
      { key: "keybindings.commands.show", kind: "conflict", reason: "mod+j is also the key for New note (note.new). It runs New note." },
    ]);
  });
});

describe("what a plugin adds to the editor, and hears of the app", () => {
  const marks = { id: "marks", extension: [] };
  const marking: Plugin = { id: "marking", name: "Marking", activate: (host) => void host.editorExtensions.register(marks) };

  it("lists an editor extension while its plugin is on, in the order of the plugins", () => {
    const first = { id: "first", extension: [] };
    const { host } = hostWith([{ id: "early", name: "Early", activate: (h) => void h.editorExtensions.register(first) }, marking]);

    expect(host.contributions().editorExtensions).toEqual([first, marks]);
    host.setEnabled("early", false);
    expect(host.contributions().editorExtensions).toEqual([marks]);
    host.setEnabled("marking", false);
    expect(host.contributions().editorExtensions).toEqual([]);
  });

  it("holds an editor extension that couldn't be used against the plugin that added it", () => {
    const { host } = hostWith([notes, marking]);

    host.fail(marks, new Error("Unrecognized extension value"));

    expect(host.contributions().plugins.map((p) => [p.id, p.error])).toEqual([
      ["notes", null],
      ["marking", "Unrecognized extension value"],
    ]);
  });

  it("shows what a plugin reports against it until it is turned off, and drops a report from one that has stopped", () => {
    let report: PluginHost["report"] = () => {};
    const loading: Plugin = { id: "loading", name: "Loading", activate: (host) => void (report = host.report) };
    const { host } = hostWith([notes, loading]);
    const errors = () => host.contributions().plugins.map((p) => [p.id, p.error]);

    report(new Error("Its editing couldn't be loaded"));
    report(new Error("Its editing couldn't be loaded"));
    expect(errors()).toEqual([
      ["notes", null],
      ["loading", "Its editing couldn't be loaded"],
    ]);

    const stale = report;
    host.setEnabled("loading", false);
    host.setEnabled("loading", true);
    stale(new Error("Late"));
    expect(errors()).toEqual([
      ["notes", null],
      ["loading", null],
    ]);
  });

  const quiet: Plugin = { id: "quiet", name: "Quiet", enabledByDefault: false, activate: (host) => void host.commands.register({ id: "quiet.go", title: "Go quietly", run: () => {} }) };

  it("leaves a plugin off that starts off, until the member turns it on, and keeps only that choice", () => {
    const { host, ids, stored } = hostWith([quiet]);

    expect(ids()).toEqual(["plugins.toggle.quiet"]);
    expect(host.contributions().settings.declared[0]).toEqual({
      key: "quiet.enabled",
      setting: { type: "boolean", default: false, title: "On", description: "Quiet is off until you turn it on here." },
      group: { id: "quiet", name: "Quiet" },
      active: true,
      switch: true,
    });

    host.setEnabled("quiet", true);
    expect(ids()).toEqual(["quiet.go", "plugins.toggle.quiet"]);
    expect(stored()).toEqual({ "quiet.enabled": true });

    host.setEnabled("quiet", false);
    expect(ids()).toEqual(["plugins.toggle.quiet"]);
    expect(stored()).toEqual({});
  });

  it("reads a switch that isn't true or false as the plugin's default", () => {
    const { ids, wrote } = hostWith([quiet, notes]);

    wrote({ "quiet.enabled": "yes", "notes.enabled": "no" });

    expect(ids()).toEqual(["note.new", "go.todos", "plugins.toggle.quiet", "plugins.toggle.notes"]);
  });

  it("tells a plugin each time the app arrives somewhere, and one turned on later where the app already is", async () => {
    const heard: string[] = [];
    const listening = (id: string): Plugin => ({ id, name: id, activate: (host) => void host.onNavigate(() => heard.push(id)) });
    const { host } = hostWith([listening("early"), listening("late")], { settings: { "late.enabled": false } });

    host.navigated();
    host.navigated();
    expect(heard).toEqual(["early", "early"]);

    host.setEnabled("late", true);
    await Promise.resolve();
    expect(heard).toEqual(["early", "early", "late"]);

    host.setEnabled("early", false);
    host.navigated();
    expect(heard).toEqual(["early", "early", "late", "late"]);
  });

  it("binds a ctrl chord to the Control key on a Mac, and to the same key as mod elsewhere", () => {
    const jumping: Plugin = { id: "jumping", name: "Jumping", activate: (host) => void host.commands.register({ id: "jump.back", title: "Back", keys: ["ctrl+o"], run: () => {} }) };
    const opening: Plugin = { id: "opening", name: "Opening", activate: (host) => void host.commands.register({ id: "file.open", title: "Open", keys: ["mod+o"], run: () => {} }) };

    expect(hostWith([jumping, opening], { mac: true }).host.contributions().keybindings).toEqual({ "ctrl+o": "jump.back", "mod+o": "file.open" });
    expect(hostWith([jumping, opening], { mac: false }).host.contributions().keybindings).toEqual({ "mod+o": "jump.back" });
  });
});

describe("what the host says of each plugin", () => {
  const stateOf = (host: Host, id: string) => host.contributions().plugins.find((p) => p.id === id)!;

  it("passes on a plugin's description, icon and pictures, and says nothing for one that has none", () => {
    const shown: Plugin = { ...notes, description: "Notes, listed.", icon: "list", screenshots: [{ src: "/shots/notes.png", alt: "The list of notes" }] };
    const { host } = hostWith([shown, palette]);

    expect(stateOf(host, "notes")).toMatchObject({ description: "Notes, listed.", icon: "list", screenshots: [{ src: "/shots/notes.png", alt: "The list of notes" }] });
    expect(stateOf(host, "palette")).toMatchObject({ description: null, icon: null, screenshots: [] });
  });

  it("lists what a plugin added from its registrations: its commands and the one its page was given, its views by slot, its embeds, completions and editor extensions", () => {
    const editing: Plugin = { id: "editing", name: "Editing", activate: (host) => void host.editorExtensions.register({ id: "editing.keys", extension: {} }) };
    const { host } = hostWith([notes, palette, editing]);

    expect(stateOf(host, "notes").adds).toEqual({
      commands: [
        { id: "note.new", title: "New note" },
        { id: "go.todos", title: "Go to Todos" },
      ],
      views: [
        { slot: "column", id: "list", label: null },
        { slot: "page", id: "todos", label: "Todos" },
      ],
      embeds: [{ name: "timer", title: "Timer", block: false }],
      completions: [{ id: "embeds", trigger: "/" }],
      editorExtensions: [],
    });
    expect(stateOf(host, "palette").adds).toEqual({ commands: [{ id: "commands.show", title: "Show all commands" }], views: [{ slot: "overlay", id: "commands", label: null }], embeds: [], completions: [], editorExtensions: [] });
    expect(stateOf(host, "editing").adds?.editorExtensions).toEqual(["editing.keys"]);
  });

  it("remembers the whole of what a plugin added once it is turned off, and knows nothing of one that hasn't been on", () => {
    const quiet: Plugin = { id: "quiet", name: "Quiet", enabledByDefault: false, activate: (host) => void host.commands.register({ id: "quiet.go", title: "Go quietly", run: () => {} }) };
    const { host, ids } = hostWith([notes, quiet]);
    // A page that is listening reads the contributions each time one is taken out, as the Plugins page does.
    host.subscribe(() => void host.contributions());
    const whole = stateOf(host, "notes").adds;
    expect(stateOf(host, "quiet").adds).toBeNull();

    host.setEnabled("notes", false);
    host.setEnabled("quiet", true);

    expect(ids()).toEqual(["quiet.go", "plugins.toggle.notes", "plugins.toggle.quiet"]);
    expect(stateOf(host, "notes")).toMatchObject({ enabled: false, adds: whole });
    expect(stateOf(host, "quiet").adds?.commands).toEqual([{ id: "quiet.go", title: "Go quietly" }]);
  });

  it("marks the setting that turns a plugin on and off as its switch, and no other", () => {
    const reader: Plugin = { id: "reader", name: "Reader", settings: { wide: { type: "boolean", default: false, title: "Wide" } }, activate: () => {} };
    const { host } = hostWith([reader, palette]);

    expect(host.contributions().settings.declared.map((d) => [d.key, d.switch ?? false])).toEqual([
      ["reader.enabled", true],
      ["reader.wide", false],
      ["palette.enabled", true],
      ["keybindings.commands.show", false],
      ["keybindings.plugins.toggle.reader", false],
      ["keybindings.plugins.toggle.palette", false],
    ]);
  });
});
