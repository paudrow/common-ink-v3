import { describe, expect, it } from "vitest";
import type { App, Dispose, OpInput, Plugin, PluginHost, SettingValue } from "../../src/web/plugin-api.ts";
import { createPluginHost, type Host, type HostOptions, type Installed } from "../../src/web/pluginHost.ts";
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
      agents: { list: async () => [], connect: async () => ({}) as never, disconnect: async () => {} },
      members: { invite: async () => ({}) as never, setRole: async () => ({}) as never, remove: async () => {}, leave: async () => {}, invites: async () => [], revoke: async () => {} },
      sharing: { of: async () => ({}) as never, grant: async () => ({}) as never, link: async () => null, revoke: async () => {}, setPrivate: async () => ({ removed: 0 }), all: async () => [] },
      uploads: { referred: () => undefined, onReferred: () => () => {}, learn: () => {}, address: (id: string) => `/files/${id}`, send: async () => ({ id: "sent" }) as never },
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

    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.notes", "plugins.disable.palette"]);
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
    expect(ids()).toEqual(["commands.show", "plugins.enable.notes", "plugins.disable.palette"]);
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
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.notes", "plugins.disable.palette"]);
    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["timer"]);
    expect(stored()).toEqual({});
  });

  it("leaves a plugin off that was turned off before, and turns it on from its command", () => {
    const { host, ids } = hostWith([notes, palette], { settings: { "palette.enabled": false } });

    expect(ids()).toEqual(["note.new", "go.todos", "plugins.disable.notes", "plugins.enable.palette"]);
    expect(host.contributions().commands.at(-1)!.title).toBe("Enable plugin: Command palette");

    host.run("plugins.enable.palette");
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.notes", "plugins.disable.palette"]);
  });

  it("won't turn off a required plugin, whatever was stored", () => {
    const { host, ids } = hostWith([notes, palette], { required: ["notes"], settings: { "notes.enabled": false } });

    host.setEnabled("notes", false);
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.palette"]);
    expect(host.contributions().plugins[0]).toEqual({ id: "notes", name: "Notes", enabled: true, required: true, error: null, installed: false });
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
    const host = createPluginHost({
      plugins: [counted("a"), counted("b"), counted("c")],
      mac: true,
      settings: { "b.enabled": false },
      write: () => {},
      provide: () => ({}) as never,
    });
    const ids = () => host.contributions().commands.map((c) => c.id);

    expect(events).toEqual([]);
    expect(ids()).toEqual(["a.go", "c.go", "plugins.disable.a", "plugins.enable.b", "plugins.disable.c"]);
    expect(events).toEqual(["start a", "start c"]);

    host.dispose();
    host.dispose();
    expect(events).toEqual(["start a", "start c", "stop a", "stop c"]);

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

  it("refuses a plugin that asks, as an operation, to change who is in the workspace or read its invites, and lets it list the members", async () => {
    let asked: PluginHost | null = null;
    const { performed } = hostWith([{ id: "greedy", name: "Greedy", activate: (h) => void (asked = h) }]);
    const perform = asked!.perform as (op: OpInput) => Promise<unknown>;
    const kept: OpInput[] = [
      { type: "member.invite", email: "mallory@example.com", as: "admin" },
      { type: "member.setRole", memberId: "aaaaaaaaaaaa", as: "admin" },
      { type: "member.remove", memberId: "aaaaaaaaaaaa" },
      { type: "member.leave" },
      { type: "invite.list" },
      { type: "invite.revoke", id: "aaaaaaaaaaaa" },
    ];

    for (const op of kept) await expect(perform(op), op.type).rejects.toThrow(`Greedy can't ${op.type}: who is in a workspace is changed through host.members, by a plugin that is given it`);
    expect(performed).toEqual([]);
    await perform({ type: "member.list" });
    expect(performed).toEqual([["greedy", "member.list"]]);
  });

  it("refuses a plugin that isn't Common Ink's own the member's data sources, their contacts among them, and lets one that is read them", async () => {
    let greedy: PluginHost | null = null;
    let own: PluginHost | null = null;
    const contacts: Plugin = { id: "contacts", name: "Contacts", activate: (h) => void (own = h) };
    const { performed } = hostWith([contacts, { id: "greedy", name: "Greedy", activate: (h) => void (greedy = h) }], { trusted: [contacts] });
    const kept: OpInput[] = [
      { type: "contact.list" },
      { type: "event.list", from: 0, to: 1, timeZone: "UTC" },
      { type: "source.list" },
      { type: "record.read", ref: "aaaaaaaaaaaa" },
      { type: "record.refer", sourceId: "sample-contacts", id: "sam" },
    ];

    for (const op of kept) await expect((greedy!.perform as (op: OpInput) => Promise<unknown>)(op), op.type).rejects.toThrow(`Greedy can't ${op.type}: a member's data sources are theirs, and are read only by Common Ink's own plugins`);
    expect(performed).toEqual([]);
    await own!.perform({ type: "contact.list" });
    expect(performed).toEqual([["contacts", "contact.list"]]);
  });

  it("gives a plugin that isn't Common Ink's own no upload: no operation on one, nothing known of one, no address for its bytes, and no way to send a file", async () => {
    let greedy: PluginHost | null = null;
    let own: PluginHost | null = null;
    const uploads: Plugin = { id: "uploads", name: "Uploads", activate: (h) => void (own = h) };
    const { performed } = hostWith([uploads, { id: "greedy", name: "Greedy", activate: (h) => void (greedy = h) }], { trusted: [uploads] });
    const kept: OpInput[] = [
      { type: "upload.list", includeArchived: true },
      { type: "upload.read", id: "aaaaaaaaaaaa" },
      { type: "upload.move", id: "aaaaaaaaaaaa", folderId: "bbbbbbbbbbbb" },
      { type: "upload.trash", id: "aaaaaaaaaaaa" },
      { type: "upload.purge", id: "aaaaaaaaaaaa" },
      { type: "upload.trashed" },
    ];

    for (const op of kept) await expect((greedy!.perform as (op: OpInput) => Promise<unknown>)(op), op.type).rejects.toThrow(`Greedy can't ${op.type}: a workspace's uploads are read and changed only by Common Ink's own plugins`);
    expect(performed).toEqual([]);
    expect(greedy!.uploads.referred("aaaaaaaaaaaa")).toBeNull();
    expect(greedy!.uploads.address("aaaaaaaaaaaa")).toBe("about:blank");
    await expect(greedy!.uploads.send(new Blob(["x"]), { name: "x.txt" })).rejects.toThrow("Greedy isn't given host.uploads.send: only Common Ink's own plugins are");

    await own!.perform({ type: "upload.list", includeArchived: true });
    expect(performed).toEqual([["uploads", "upload.list"]]);
    expect(own!.uploads.address("aaaaaaaaaaaa")).toBe("/files/aaaaaaaaaaaa");
    expect(await own!.uploads.send(new Blob(["x"]), { name: "x.txt" })).toEqual({ id: "sent" });
  });

  it("gives a plugin that isn't Common Ink's own neither the member's pins nor how far they have read the changes", async () => {
    let greedy: PluginHost | null = null;
    let own: PluginHost | null = null;
    const dashboard: Plugin = { id: "dashboard", name: "Dashboard", activate: (h) => void (own = h) };
    const { performed } = hostWith([dashboard, { id: "greedy", name: "Greedy", activate: (h) => void (greedy = h) }], { trusted: [dashboard] });
    const kept: OpInput[] = [{ type: "pin.list" }, { type: "pin.set", id: "aaaaaaaaaaaa", pinned: true }, { type: "visit.read" }, { type: "visit.mark", until: 1 }];

    for (const op of kept) await expect((greedy!.perform as (op: OpInput) => Promise<unknown>)(op), op.type).rejects.toThrow(`Greedy can't ${op.type}: a member's pins and how far they have read the changes are theirs, and are read and changed only by Common Ink's own plugins`);
    expect(performed).toEqual([]);

    await own!.perform({ type: "visit.mark", until: 1 });
    expect(performed).toEqual([["dashboard", "visit.mark"]]);
  });

  it("refuses every plugin an upload's bytes and its privacy as operations, which go through host.uploads and host.sharing", async () => {
    let own: PluginHost | null = null;
    const uploads: Plugin = { id: "uploads", name: "Uploads", activate: (h) => void (own = h) };
    const { performed } = hostWith([uploads], { trusted: [uploads] });
    const perform = own!.perform as (op: OpInput) => Promise<unknown>;

    await expect(perform({ type: "upload.create", name: "a.png", size: 1, private: false })).rejects.toThrow("Uploads can't upload.create: an upload's bytes are sent and asked for through host.uploads, by a plugin that is given it");
    await expect(perform({ type: "upload.open", id: "aaaaaaaaaaaa" })).rejects.toThrow("Uploads can't upload.open: an upload's bytes are sent and asked for through host.uploads, by a plugin that is given it");
    await expect(perform({ type: "upload.setPrivate", id: "aaaaaaaaaaaa", private: true })).rejects.toThrow("Uploads can't upload.setPrivate: who an upload is shared with is read and changed through host.sharing, by a plugin that is given it");
    expect(performed).toEqual([]);
  });

  it("refuses a plugin that asks, as an operation, who something is shared with, to change that, or what a link opens", async () => {
    let asked: PluginHost | null = null;
    const { performed } = hostWith([{ id: "greedy", name: "Greedy", activate: (h) => void (asked = h) }]);
    const perform = asked!.perform as (op: OpInput) => Promise<unknown>;
    const sharing: OpInput[] = [
      { type: "grant.list" },
      { type: "grant.list", noteId: "aaaaaaaaaaaa" },
      { type: "grant.set", noteId: "aaaaaaaaaaaa", email: "mallory@example.com", access: "edit" },
      { type: "grant.link", folderId: "aaaaaaaaaaaa", link: "public" },
      { type: "grant.revoke", id: "aaaaaaaaaaaa" },
      { type: "note.setPrivate", id: "aaaaaaaaaaaa", private: false },
    ];
    const visitors: OpInput[] = [{ type: "shared.open" }, { type: "shared.read", id: "aaaaaaaaaaaa" }];

    for (const op of sharing) await expect(perform(op), op.type).rejects.toThrow(`Greedy can't ${op.type}: who a note or folder is shared with is read and changed through host.sharing, by a plugin that is given it`);
    for (const op of visitors) await expect(perform(op), op.type).rejects.toThrow(`Greedy can't ${op.type}: only whoever holds a link asks what it opens`);
    expect(performed).toEqual([]);
    expect(Object.keys(asked!.sharing).sort()).toEqual(["all", "grant", "link", "of", "revoke", "setPrivate"]);
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
      ["keybindings.plugins.disable.reader", "Keybindings", "chords", []],
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
    expect(ids()).toEqual(["commands.show", "plugins.enable.notes", "plugins.disable.palette"]);
    wrote({ "notes.enabled": "no" });
    expect(ids()).toEqual(["note.new", "go.todos", "commands.show", "plugins.disable.notes", "plugins.disable.palette"]);
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
    for (const id of ["go.settings", "go.elsewhere", "plugins.enable.notes", "plugins.disable.notes", "settings.open"]) {
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
      host.run("plugins.enable.notes");
      expect(ran).toEqual([]);
      expect(ids()).toContain("note.new");
      expect(ids()).toContain("go.settings");
    }
  });

  it("lets a required plugin add such a command, and gives any plugin's page its go command", () => {
    const core: Plugin = { id: "core", name: "Core", activate: (h) => void h.commands.register({ id: "settings.open", title: "Open settings", run: () => {} }) };
    const { host, ids } = hostWith([core, notes], { required: ["core"] });

    expect(ids()).toEqual(["settings.open", "note.new", "go.todos", "plugins.disable.notes"]);
    expect(errorOf(host, "notes")).toBeNull();
  });

  it("lets only a plugin that is Common Ink's own add the page shown at /, and leaves out any other that tries", () => {
    const dashboard: Plugin = { id: "dashboard", name: "Dashboard", activate: (h) => void h.views.register("page", { id: "dashboard", path: "/dashboard", label: "Dashboard", home: true, component: View }) };
    const usurper: Plugin = {
      id: "usurper",
      name: "Usurper",
      activate(h) {
        h.commands.register({ id: "usurper.fine", title: "Fine", run: () => {} });
        h.views.register("page", { id: "mine", path: "/mine", label: "Mine", home: true, component: View });
      },
    };
    const { host, ids } = hostWith([usurper, dashboard, pages], { required: ["pages"], trusted: [dashboard, pages] });

    expect(host.contributions().views.page.filter((p) => p.home).map((p) => p.id)).toEqual(["dashboard"]);
    expect(errorOf(host, "usurper")).toBe("Only Common Ink's own plugins add the page shown at /, and Usurper asked to with /mine");
    expect(errorOf(host, "dashboard")).toBeNull();
    expect(ids()).not.toContain("usurper.fine");
    expect(ids()).not.toContain("go.mine");
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

    expect(ids()).toEqual(["plugins.enable.quiet"]);
    expect(host.contributions().settings.declared[0]).toEqual({
      key: "quiet.enabled",
      setting: { type: "boolean", default: false, title: "On", description: "Quiet is off until you turn it on here." },
      group: { id: "quiet", name: "Quiet" },
      active: true,
    });

    host.setEnabled("quiet", true);
    expect(ids()).toEqual(["quiet.go", "plugins.disable.quiet"]);
    expect(stored()).toEqual({ "quiet.enabled": true });

    host.setEnabled("quiet", false);
    expect(ids()).toEqual(["plugins.enable.quiet"]);
    expect(stored()).toEqual({});
  });

  it("reads a switch that isn't true or false as the plugin's default", () => {
    const { ids, wrote } = hostWith([quiet, notes]);

    wrote({ "quiet.enabled": "yes", "notes.enabled": "no" });

    expect(ids()).toEqual(["note.new", "go.todos", "plugins.enable.quiet", "plugins.disable.notes"]);
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

  it("tells a plugin each time the notes change, until it is turned off", () => {
    const heard: string[] = [];
    const listening = (id: string): Plugin => ({ id, name: id, activate: (host) => void host.onItems(() => heard.push(id)) });
    const { host } = hostWith([listening("links"), listening("other")]);

    host.notesChanged();
    host.setEnabled("other", false);
    host.notesChanged();

    expect(heard).toEqual(["links", "other", "links"]);
  });

  it("binds a ctrl chord to the Control key on a Mac, and to the same key as mod elsewhere", () => {
    const jumping: Plugin = { id: "jumping", name: "Jumping", activate: (host) => void host.commands.register({ id: "jump.back", title: "Back", keys: ["ctrl+o"], run: () => {} }) };
    const opening: Plugin = { id: "opening", name: "Opening", activate: (host) => void host.commands.register({ id: "file.open", title: "Open", keys: ["mod+o"], run: () => {} }) };

    expect(hostWith([jumping, opening], { mac: true }).host.contributions().keybindings).toEqual({ "ctrl+o": "jump.back", "mod+o": "file.open" });
    expect(hostWith([jumping, opening], { mac: false }).host.contributions().keybindings).toEqual({ "mod+o": "jump.back" });
  });

  it("gives a plugin that isn't Common Ink's own none of agents, members and sharing, whatever id it claims, and gives its own all three", async () => {
    const reached: string[] = [];
    const reaching = (name: string) => async () => void reached.push(name);
    const hosts = new Map<string, PluginHost>();
    const plugin = (id: string, name: string): Plugin => ({ id, name, activate: (h) => void hosts.set(name, h) });
    const own = plugin("sharing", "Sharing");
    // The same id as a built-in doesn't make it one: the host knows its own plugins by the values it was handed.
    const impostor = plugin("members", "Impostor");
    const theirs = plugin("theirs", "Theirs");
    createPluginHost({
      plugins: [own, impostor, theirs],
      trusted: [own],
      mac: true,
      settings: {},
      write: () => {},
      provide: () =>
        ({
          app: () => ({}) as App,
          perform: reaching("perform"),
          agents: { list: reaching("agents.list"), connect: reaching("agents.connect"), disconnect: reaching("agents.disconnect") },
          members: { invite: reaching("members.invite"), setRole: reaching("members.setRole"), remove: reaching("members.remove"), leave: reaching("members.leave"), invites: reaching("members.invites"), revoke: reaching("members.revoke") },
          sharing: { of: reaching("sharing.of"), grant: reaching("sharing.grant"), link: reaching("sharing.link"), revoke: reaching("sharing.revoke"), setPrivate: reaching("sharing.setPrivate"), all: reaching("sharing.all") },
          storage: { get: () => undefined, set: () => {} },
        }) as never,
    }).contributions();
    const every = (h: PluginHost) =>
      (["agents", "members", "sharing"] as const).flatMap((capability) => Object.entries(h[capability]).map(([method, call]) => [`${capability}.${method}`, call as () => Promise<unknown>] as const));

    for (const who of ["Impostor", "Theirs"]) {
      for (const [name, call] of every(hosts.get(who)!)) await expect(call(), `${who} ${name}`).rejects.toThrow(`${who} isn't given host.${name}: only Common Ink's own plugins are`);
    }
    expect(reached).toEqual([]);
    expect(every(hosts.get("Theirs")!).map(([name]) => name)).toHaveLength(15);

    for (const [, call] of every(hosts.get("Sharing")!)) await call();
    expect(reached).toHaveLength(15);
  });
});

describe("the plugins a workspace installed, which change while the app runs", () => {
  const View = () => null;
  const stopped: string[] = [];
  const third = (id: string, name: string, version = "1"): Installed => ({
    version,
    plugin: {
      id,
      name,
      enabledByDefault: false,
      settings: { unit: { type: "string", default: "words", title: "Unit" } },
      activate(host) {
        host.commands.register({ id: `${id}.count`, title: `${name}: Count (${version})`, run: () => {} });
        host.views.register("inspector", { id: `${id}.panel`, label: name, icon: "info", component: View });
        host.embeds.register({ name: `x-${id}`, title: name, render: () => {} });
        return () => void stopped.push(`${name} ${version}`);
      },
    },
  });
  const core: Plugin = { id: "core", name: "Core", activate: (host) => void host.commands.register({ id: "note.new", title: "New note", run: () => {} }) };
  const last: Plugin = { id: "pages", name: "Pages", activate: (host) => void host.views.register("inspector", { id: "info", label: "Info", icon: "info", component: View }) };
  const on = (...ids: string[]) => Object.fromEntries(ids.map((id) => [`${id}.enabled`, true]));

  it("leaves an installed plugin off until the member turns it on, and lists it as installed with its options", () => {
    const { host, ids, wrote } = hostWith([core, last], { required: ["core"] });
    host.setInstalled([third("aaaaaaaaaaaa", "Counter")]);

    expect(ids()).toEqual(["note.new", "plugins.disable.pages", "plugins.enable.aaaaaaaaaaaa"]);
    expect(host.contributions().plugins.map((p) => [p.id, p.enabled, p.installed])).toEqual([
      ["core", true, false],
      ["pages", true, false],
      ["aaaaaaaaaaaa", false, true],
    ]);
    expect(host.contributions().settings.declared.filter((d) => d.group.id === "aaaaaaaaaaaa").map((d) => [d.key, d.active])).toEqual([
      ["aaaaaaaaaaaa.enabled", true],
      ["aaaaaaaaaaaa.unit", false],
    ]);

    wrote(on("aaaaaaaaaaaa"));
    expect(ids()).toEqual(["note.new", "aaaaaaaaaaaa.count", "plugins.disable.pages", "plugins.disable.aaaaaaaaaaaa"]);
  });

  it("puts what installed plugins add after everything that comes with the app, in the order they were installed", () => {
    const { host } = hostWith([core, last], { settings: on("aaaaaaaaaaaa", "bbbbbbbbbbbb") });
    host.settingsChanged(on("aaaaaaaaaaaa", "bbbbbbbbbbbb"));
    host.setInstalled([third("aaaaaaaaaaaa", "Counter"), third("bbbbbbbbbbbb", "Weather")]);

    expect(host.contributions().views.inspector.map((v) => v.id)).toEqual(["info", "aaaaaaaaaaaa.panel", "bbbbbbbbbbbb.panel"]);
    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["x-aaaaaaaaaaaa", "x-bbbbbbbbbbbb"]);
  });

  it("stops a plugin that is no longer installed and takes out all it added, and leaves the others running as they were", () => {
    stopped.length = 0;
    const { host, ids } = hostWith([core, last]);
    host.settingsChanged(on("aaaaaaaaaaaa", "bbbbbbbbbbbb"));
    const weather = third("bbbbbbbbbbbb", "Weather");
    host.setInstalled([third("aaaaaaaaaaaa", "Counter"), weather]);
    const before = host.contributions().views.inspector.find((v) => v.id === "bbbbbbbbbbbb.panel");

    // The record read again says the same of Weather, in a value made anew.
    host.setInstalled([third("bbbbbbbbbbbb", "Weather")]);

    expect(stopped).toEqual(["Counter 1"]);
    expect(ids()).toEqual(["note.new", "bbbbbbbbbbbb.count", "plugins.disable.core", "plugins.disable.pages", "plugins.disable.bbbbbbbbbbbb"]);
    expect(host.contributions().views.inspector.map((v) => v.id)).toEqual(["info", "bbbbbbbbbbbb.panel"]);
    expect(host.contributions().views.inspector.find((v) => v.id === "bbbbbbbbbbbb.panel"), "the same view, not one made again").toBe(before);
    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["x-bbbbbbbbbbbb"]);
    expect(host.run("aaaaaaaaaaaa.count")).toBe(false);
    expect(host.contributions().plugins.map((p) => p.id)).toEqual(["core", "pages", "bbbbbbbbbbbb"]);
  });

  it("starts a plugin again when its version changed, and tells whoever is listening", () => {
    stopped.length = 0;
    const { host } = hostWith([core, last]);
    host.settingsChanged(on("aaaaaaaaaaaa"));
    host.setInstalled([third("aaaaaaaaaaaa", "Counter")]);
    let told = 0;
    host.subscribe(() => told++);

    host.setInstalled([third("aaaaaaaaaaaa", "Counter", "2")]);

    expect(stopped).toEqual(["Counter 1"]);
    expect(host.contributions().commands.find((c) => c.id === "aaaaaaaaaaaa.count")?.title).toBe("Counter: Count (2)");
    expect(told).toBeGreaterThan(0);
    told = 0;
    host.setInstalled([third("aaaaaaaaaaaa", "Counter", "2")]);
    expect(told, "nothing changed, so nothing is said").toBe(0);
    expect(stopped).toEqual(["Counter 1"]);
  });

  it("never lets an installed plugin take the place of one that comes with the app, by taking its id", () => {
    const { host, ids } = hostWith([core, last], { required: ["core"] });
    host.settingsChanged(on("core", "pages"));
    host.setInstalled([third("core", "Impostor"), third("pages", "Second impostor")]);

    expect(host.contributions().plugins.map((p) => p.name)).toEqual(["Core", "Pages"]);
    expect(ids()).toEqual(["note.new", "plugins.disable.pages"]);
  });

  it("won't start an installed plugin named as one of Common Ink's own is, whatever its case and the space around it, and says why whether it is on or off", () => {
    const TAKEN = "Its name is one of Common Ink's own, or reads as one";
    const offByDefault: Plugin = { id: "vim", name: "Vim", enabledByDefault: false, activate: () => {} };
    const { host, ids, wrote } = hostWith([core, last, offByDefault], { required: ["core"] });
    const named = ["Pages", "  pAGES ", "vim", "Core", "common ink", "PLUGINS", "Pages 2", "Counter"];
    host.setInstalled(named.map((name, index) => third(`${"abcdefgh"[index]}aaaaaaaaaaa`, name)));
    const errors = () => host.contributions().plugins.filter((p) => p.installed).map((p) => [p.name, p.error]);
    const expected = [
      ["Pages", TAKEN],
      ["  pAGES ", TAKEN],
      ["vim", TAKEN],
      ["Core", TAKEN],
      ["common ink", TAKEN],
      ["PLUGINS", TAKEN],
      ["Pages 2", null],
      ["Counter", null],
    ];

    expect(errors(), "while they are off").toEqual(expected);
    wrote(on(..."abcdefgh".split("").map((letter) => `${letter}aaaaaaaaaaa`)));
    expect(errors(), "once they are on").toEqual(expected);
    expect(ids().filter((id) => id.endsWith(".count"))).toEqual(["gaaaaaaaaaaa.count", "haaaaaaaaaaa.count"]);


    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["x-gaaaaaaaaaaa", "x-haaaaaaaaaaa"]);
    // Nor is there a command that reads as turning one of the app's own on or off.
    expect(host.contributions().commands.map((c) => c.title).filter((title) => /plugin: /.test(title))).toEqual(["Disable plugin: Pages", "Enable plugin: Vim", "Disable plugin: Pages 2", "Disable plugin: Counter"]);

    // Letters of another alphabet that are drawn as these are, and a digit for a letter, are no way around it: Cyrillic Р and а, Greek Ρ, a zero.
    host.setInstalled(["Раges", "Ρages", "C0re", "V\u200Bim"].map((name, index) => third(`${"jkmn"[index]}aaaaaaaaaaa`, name)));
    expect(host.contributions().plugins.filter((p) => p.installed).map((p) => p.error)).toEqual([TAKEN, TAKEN, TAKEN, TAKEN]);
  });

  it("keeps embed names apart: an installed plugin's start with x-, and none that comes with the app does", () => {
    const timer: Plugin = { id: "timer", name: "Timer", activate: (h) => void h.embeds.register({ name: "timer", title: "Timer", render: () => {} }) };
    const reaching: Plugin = { id: "reaching", name: "Reaching", activate: (h) => void h.embeds.register({ name: "x-counter", title: "Reaching", render: () => {} }) };
    const squatter = (name: string): Installed => ({ version: "1", plugin: { id: "aaaaaaaaaaaa", name: "Squatter", enabledByDefault: false, activate: (h) => void h.embeds.register({ name, title: "Timer", render: () => {} }) } });
    // The built-in Timer is off, so nothing else holds the name.
    const { host } = hostWith([timer, reaching], { trusted: [timer, reaching], settings: { "timer.enabled": false, ...on("aaaaaaaaaaaa") } });
    host.settingsChanged({ "timer.enabled": false, ...on("aaaaaaaaaaaa") });
    const errorOf = (id: string) => host.contributions().plugins.find((p) => p.id === id)!.error;

    host.setInstalled([squatter("timer")]);
    expect(errorOf("aaaaaaaaaaaa")).toBe("An installed plugin's embed has a name that starts with x-, and this one is timer");
    expect(host.contributions().embeds).toEqual([]);

    host.setInstalled([{ ...squatter("x-timer"), version: "2" }]);
    expect(errorOf("aaaaaaaaaaaa")).toBeNull();
    expect(host.contributions().embeds.map((e) => e.name)).toEqual(["x-timer"]);
    expect(errorOf("reaching")).toBe("Only an installed plugin's embed has a name that starts with x-, and this one is x-counter");
  });

  it("refuses an installed plugin the record of plugins whole, and every plugin the operations that change it", async () => {
    const hosts = new Map<string, PluginHost>();
    const own: Plugin = { id: "html", name: "HTML embeds", activate: (h) => void hosts.set("own", h) };
    const { host, performed } = hostWith([own], { trusted: [own], settings: on("aaaaaaaaaaaa") });
    host.settingsChanged(on("aaaaaaaaaaaa"));
    host.setInstalled([{ version: "1", plugin: { id: "aaaaaaaaaaaa", name: "Greedy", enabledByDefault: false, activate: (h) => void hosts.set("theirs", h) } }]);
    const as = (who: string) => hosts.get(who)!.perform as unknown as (op: OpInput) => Promise<unknown>;
    const changing: OpInput[] = [
      { type: "plugin.install", manifest: "{}", code: "" },
      { type: "plugin.uninstall", id: "aaaaaaaaaaaa" },
      { type: "plugin.permit", id: "aaaaaaaaaaaa", capability: "notes.write", allowed: true },
      { type: "plugin.request", id: "aaaaaaaaaaaa", capability: "notes.write" },
      { type: "plugin.read", id: "bbbbbbbbbbbb" },
    ];

    for (const op of changing) {
      await expect(as("theirs")(op), `theirs ${op.type}`).rejects.toThrow(`Greedy can't ${op.type}: which plugins a workspace has, and what they are permitted, is decided on the Plugins page`);
      await expect(as("own")(op), `own ${op.type}`).rejects.toThrow(`HTML embeds can't ${op.type}: which plugins a workspace has, and what they are permitted, is decided on the Plugins page`);
    }
    for (const op of [{ type: "plugin.list" }, { type: "plugin.frame", id: "html" }] as OpInput[])
      await expect(as("theirs")(op)).rejects.toThrow(`Greedy can't ${op.type}: a workspace's record of its plugins is read only by Common Ink's own plugins`);
    expect(performed).toEqual([]);

    await as("own")({ type: "plugin.list" });
    await as("own")({ type: "plugin.frame", id: "html" });
    expect(performed).toEqual([
      ["html", "plugin.list"],
      ["html", "plugin.frame"],
    ]);
  });
});
