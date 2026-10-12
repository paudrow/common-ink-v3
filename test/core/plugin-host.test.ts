import { describe, expect, it } from "vitest";
import type { App, Dispose, Plugin, PluginHost } from "../../src/web/plugin-api.ts";
import { createPluginHost, type Host, type HostOptions } from "../../src/web/pluginHost.ts";

const View = () => null;

function hostWith(plugins: Plugin[], options: Partial<HostOptions> = {}) {
  let stored: string[] = [];
  const went: string[] = [];
  const performed: [plugin: string, op: string][] = [];
  const host = createPluginHost({
    plugins,
    mac: true,
    disabled: { read: () => stored, write: (ids) => void (stored = ids) },
    provide: (plugin) => ({
      workspace: { id: "w1", name: "Acme", role: "editor" },
      app: () => ({ go: (path: string) => void went.push(path) }) as App,
      perform: (async (op: { type: string }) => void performed.push([plugin.id, op.type])) as PluginHost["perform"],
      agents: { list: async () => [], connect: async () => ({}) as never, disconnect: async () => {} },
      storage: { get: () => undefined, set: () => {} },
    }),
    ...options,
  });
  host.contributions();
  const ids = () => host.contributions().commands.map((c) => c.id);
  return { host, ids, went, performed, stored: () => stored };
}

const notes: Plugin = {
  id: "notes",
  name: "Notes",
  activate(host) {
    host.commands.register({ id: "note.new", title: "New note", run: () => {}, keys: ["mod+n"] });
    host.views.register("column", { id: "list", component: View });
    host.views.register("page", { id: "todos", path: "/todos", label: "Todos", component: View });
    host.embeds.register({ name: "timer", title: "Timer", render: () => {} });
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

    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.notes", "plugins.disable.palette"]);
    expect(keybindings).toEqual({ "mod+n": "note.new", "mod+shift+p": "commands.show", f1: "commands.show" });
    expect(views.column.map((v) => v.id)).toEqual(["list"]);
    expect(views.page.map((v) => [v.id, v.path])).toEqual([["todos", "/todos"]]);
    expect(views.overlay.map((v) => v.id)).toEqual(["commands"]);
    expect(views.inspector).toEqual([]);
    expect(embeds.map((e) => e.name)).toEqual(["timer"]);
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

  it("keeps pages off the addresses where a folder's notes are listed", () => {
    for (const path of ["/folder", "/folder/all"] as const) {
      const squatter: Plugin = { id: "squatter", name: "Squatter", activate: (h) => void h.views.register("page", { id: "mine", path, label: "Mine", component: View }) };
      const { host } = hostWith([squatter]);

      expect(host.contributions().views.page).toEqual([]);
      expect(host.contributions().plugins[0]!.error).toBe(`${path} is where a folder's notes are listed, so no page can be there`);
    }
    const near: Plugin = { id: "near", name: "Near", activate: (h) => void h.views.register("page", { id: "folders", path: "/folders", label: "Folders", component: View }) };
    expect(hostWith([near]).host.contributions().views.page.map((p) => p.path)).toEqual(["/folders"]);
  });

  it("takes out everything a plugin added when it is turned off, and puts it back in the same order when turned on", () => {
    const { host, ids, stored } = hostWith([notes, palette]);

    host.setEnabled("notes", false);
    expect(ids()).toEqual(["commands.show", "plugins.enable.notes", "plugins.disable.palette"]);
    expect(host.contributions().keybindings).toEqual({ "mod+shift+p": "commands.show", f1: "commands.show" });
    expect(host.contributions().views.column).toEqual([]);
    expect(host.contributions().views.page).toEqual([]);
    expect(host.contributions().embeds).toEqual([]);
    expect(host.run("note.new")).toBe(false);
    expect(stored()).toEqual(["notes"]);
    expect(host.contributions().plugins.map((p) => [p.id, p.enabled])).toEqual([
      ["notes", false],
      ["palette", true],
    ]);

    host.setEnabled("notes", true);
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.notes", "plugins.disable.palette"]);
    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["timer"]);
    expect(stored()).toEqual([]);
  });

  it("leaves a plugin off that was turned off before, and turns it on from its command", () => {
    const { host, ids } = hostWith([notes, palette], { disabled: { read: () => ["palette"], write: () => {} } });

    expect(ids()).toEqual(["note.new", "go.todos", "plugins.disable.notes", "plugins.enable.palette"]);
    expect(host.contributions().commands.at(-1)!.title).toBe("Enable plugin: Command palette");

    host.run("plugins.enable.palette");
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.notes", "plugins.disable.palette"]);
  });

  it("won't turn off a required plugin, whatever was stored", () => {
    const { host, ids } = hostWith([notes, palette], { required: ["notes"], disabled: { read: () => ["notes"], write: () => {} } });

    host.setEnabled("notes", false);
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.palette"]);
    expect(host.contributions().plugins[0]).toEqual({ id: "notes", name: "Notes", enabled: true, required: true, error: null, description: null, icon: null, screenshots: [], adds: expect.any(Object) });
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

    expect(ids()).toEqual(["note.new", "go.todos", "plugins.disable.notes", "plugins.disable.clash"]);
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
    expect(ids()).toEqual(["a.go", "plugins.disable.a"]);
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
    let stored = ["b"];
    const host = createPluginHost({
      plugins: [counted("a"), counted("b"), counted("c")],
      mac: true,
      disabled: { read: () => stored, write: (ids) => void (stored = ids) },
      provide: () => ({}) as never,
    });
    const ids = () => host.contributions().commands.map((c) => c.id);

    expect(events).toEqual([]);
    expect(ids()).toEqual(["a.go", "c.go", "plugins.disable.a", "plugins.enable.b", "plugins.disable.c"]);
    expect(events).toEqual(["start a", "start c"]);

    host.dispose();
    host.dispose();
    expect(events).toEqual(["start a", "start c", "stop a", "stop c"]);
    expect(stored).toEqual(["b"]);

    expect(ids()).toEqual(["a.go", "c.go", "plugins.disable.a", "plugins.enable.b", "plugins.disable.c"]);
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
    const host = createPluginHost({
      plugins: [notes, drawing],
      mac: true,
      disabled: { read: () => [], write: () => {} },
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
});

describe("what the host says of each plugin", () => {
  const stateOf = (host: Host, id: string) => host.contributions().plugins.find((p) => p.id === id)!;

  it("passes on a plugin's description, icon and pictures, and says nothing for one that has none", () => {
    const shown: Plugin = { ...notes, description: "Notes, listed.", icon: "list", screenshots: [{ src: "/shots/notes.png", alt: "The list of notes" }] };
    const { host } = hostWith([shown, palette]);

    expect(stateOf(host, "notes")).toMatchObject({ description: "Notes, listed.", icon: "list", screenshots: [{ src: "/shots/notes.png", alt: "The list of notes" }] });
    expect(stateOf(host, "palette")).toMatchObject({ description: null, icon: null, screenshots: [] });
  });

  it("lists what a plugin added from its registrations: its commands and the one its page was given, its views by slot and its embeds", () => {
    const { host } = hostWith([notes, palette]);

    expect(stateOf(host, "notes").adds).toEqual({
      commands: [
        { id: "note.new", title: "New note" },
        { id: "go.todos", title: "Go to Todos" },
      ],
      views: [
        { slot: "column", id: "list", label: null },
        { slot: "page", id: "todos", label: "Todos" },
      ],
      embeds: [{ name: "timer", title: "Timer" }],
    });
    expect(stateOf(host, "palette").adds).toEqual({ commands: [{ id: "commands.show", title: "Show all commands" }], views: [{ slot: "overlay", id: "commands", label: null }], embeds: [] });
  });

  it("remembers the whole of what a plugin added once it is turned off, and knows nothing of one that hasn't been on", () => {
    const quiet: Plugin = { id: "quiet", name: "Quiet", activate: (host) => void host.commands.register({ id: "quiet.go", title: "Go quietly", run: () => {} }) };
    const { host, ids } = hostWith([notes, quiet], { disabled: { read: () => ["quiet"], write: () => {} } });
    // A page that is listening reads the contributions each time one is taken out, as the Plugins page does.
    host.subscribe(() => void host.contributions());
    const whole = stateOf(host, "notes").adds;
    expect(stateOf(host, "quiet").adds).toBeNull();

    host.setEnabled("notes", false);
    host.setEnabled("quiet", true);

    expect(ids()).toEqual(["quiet.go", "plugins.enable.notes", "plugins.disable.quiet"]);
    expect(stateOf(host, "notes")).toMatchObject({ enabled: false, adds: whole });
    expect(stateOf(host, "quiet").adds?.commands).toEqual([{ id: "quiet.go", title: "Go quietly" }]);
  });
});
