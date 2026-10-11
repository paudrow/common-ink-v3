import { describe, expect, it } from "vitest";
import type { Capability, InstalledPlugin, Permission } from "../../src/core/plugins.ts";
import { createBroker, decide, granted, LIMITS, type Decision } from "../../src/web/remote/broker.ts";
import type { FromPlugin } from "../../src/web/remote/protocol.ts";

const NOTE = "abcdefghijkl";

const permission = (capability: Capability, state: Permission["state"], more: Partial<Permission> = {}): Permission => ({ capability, reason: "Because", origins: [], state, locked: false, decidedBy: null, voided: false, requests: [], ...more });

function installed(allowed: Capability[], off: Capability[] = []): InstalledPlugin {
  return {
    id: "plugin000001",
    thirdParty: true,
    manifest: { name: "Word counter", version: "1", capabilities: [...allowed, ...off].map((name) => ({ name, reason: "Because" })), commands: [], views: [], embeds: [], settings: {} },
    codeHash: "0".repeat(64),
    installedBy: "Ada",
    installedAt: 1,
    updatedAt: 1,
    permissions: [...allowed.map((c) => permission(c, "allowed")), ...off.map((c) => permission(c, "off"))],
  };
}

const perform = (op: Record<string, unknown>, id = 1): FromPlugin => ({ v: 1, id, call: "perform", op: op as { type: string } });

describe("what a plugin is permitted, decided from the record", () => {
  it("counts a permission only while it is allowed: one that is off, or was voided by new code, grants nothing", () => {
    const plugin = installed(["notes.read"], ["notes.write"]);
    plugin.permissions.push(permission("todos.read", "off", { voided: true, decidedBy: null }));

    expect(granted(plugin)).toEqual(["notes.read"]);
  });

  it("lets a plugin perform an operation its permissions name, as the operation the server will read", () => {
    expect(decide(installed(["notes.read"]), perform({ type: "note.read", id: NOTE }))).toEqual({ kind: "perform", id: 1, op: { type: "note.read", id: NOTE } });
    expect(decide(installed(["notes.read", "notes.write"]), perform({ type: "note.write", id: NOTE, text: "# New", baseRevision: 2 }, 9))).toMatchObject({ kind: "perform", id: 9, op: { type: "note.write", id: NOTE, text: "# New" } });
  });

  it("refuses an operation no permission of its names, and says which", () => {
    const refused = (allowed: Capability[], type: string, more: Record<string, unknown> = {}) => decide(installed(allowed), perform({ type, ...more }));

    expect(refused(["notes.read"], "note.write", { id: NOTE, text: "x" })).toEqual({ kind: "refuse", id: 1, error: { code: "forbidden", message: "Word counter isn't permitted to note.write" } });
    for (const type of ["settings.read", "settings.write", "plugin.permit", "plugin.install", "plugin.list", "plugin.frame", "member.invite", "member.setRole", "upload.list", "upload.open", "grant.link", "note.trash", "history.revertAuthor", "agent.connect", "no.such.op", "__proto__", "constructor", "toString"])
      expect(refused(["notes.read", "notes.write", "todos.read", "members.read", "network"], type), type).toMatchObject({ kind: "refuse", error: { code: "forbidden", message: `Word counter isn't permitted to ${type}` } });
    expect(refused([], "note.list")).toMatchObject({ kind: "refuse", error: { code: "forbidden" } });
  });

  it("refuses an operation that is allowed but isn't written as one, before it is sent anywhere", () => {
    expect(decide(installed(["notes.read"]), perform({ type: "note.read", id: "../../ops" }))).toMatchObject({ kind: "refuse", id: 1, error: { code: "invalid" } });
    expect(decide(installed(["notes.read"]), perform({ type: "note.read", id: "abcdefghijkl/../x" }))).toMatchObject({ kind: "refuse", error: { code: "invalid" } });
    expect(decide(installed(["notes.read"]), perform({ type: "note.read" }))).toMatchObject({ kind: "refuse", error: { code: "invalid" } });
  });

  it("sends on only the fields the operation has: nothing else a plugin put beside them", () => {
    const decision = decide(installed(["notes.read"]), perform({ type: "note.read", id: NOTE, pluginId: "plugin000002", actor: { kind: "member" }, workspaceId: "other0000001" }));

    expect(decision).toEqual({ kind: "perform", id: 1, op: { type: "note.read", id: NOTE } });
  });

  it("shows a notice as text under the plugin's name, cut to 200 characters, with nothing that isn't printed", () => {
    expect(decide(installed([]), { v: 1, id: 2, call: "notify", message: "Counted 12 words" })).toEqual({ kind: "notify", id: 2, message: "Word counter plugin: Counted 12 words" });
    const long = decide(installed([]), { v: 1, id: 2, call: "notify", message: "y".repeat(5000) }) as Extract<Decision, { kind: "notify" }>;
    expect(long.message).toHaveLength(200);
    expect(long.message.startsWith("Word counter plugin: yyy")).toBe(true);
    expect(decide(installed([]), { v: 1, id: 2, call: "notify", message: "one\u0000\ntwo\u001b[31m" })).toEqual({ kind: "notify", id: 2, message: "Word counter plugin: one two [31m" });
  });

  it("opens a note only for a plugin that may read notes, and only by an id", () => {
    expect(decide(installed(["notes.read"]), { v: 1, id: 3, call: "open", noteId: NOTE })).toEqual({ kind: "open", id: 3, noteId: NOTE });
    expect(decide(installed(["notes.write"]), { v: 1, id: 3, call: "open", noteId: NOTE })).toMatchObject({ kind: "refuse", id: 3, error: { code: "forbidden" } });
    expect(decide(installed(["notes.read"]), { v: 1, id: 3, call: "open", noteId: "/settings" })).toMatchObject({ kind: "refuse", id: 3, error: { code: "invalid" } });
    expect(decide(installed(["notes.read"]), { v: 1, id: 3, call: "open", noteId: "javascript:alert(1)" })).toMatchObject({ kind: "refuse", error: { code: "invalid" } });
  });
});

describe("the broker between one plugin's frames and the app", () => {
  function brokerFor(plugin: InstalledPlugin | null) {
    let time = 1000;
    let now: InstalledPlugin | null = plugin;
    const broker = createBroker({ plugin: () => now, now: () => time });
    return { broker, wait: (ms: number) => (time += ms), set: (next: InstalledPlugin | null) => (now = next) };
  }
  const list = (id: number) => ({ v: 1, id, call: "perform", op: { type: "note.list" } });

  it("reads the record each time, so a permission allowed or taken away since the frame started is what decides", () => {
    const { broker, set } = brokerFor(installed([], ["notes.read"]));

    expect(broker.receive(list(1))).toMatchObject({ kind: "refuse", error: { code: "forbidden" } });
    set(installed(["notes.read"]));
    expect(broker.receive(list(2))).toMatchObject({ kind: "perform", id: 2 });
    broker.settled();
    set(null);
    expect(broker.receive(list(3))).toEqual({ kind: "refuse", id: 3, error: { code: "forbidden", message: "This plugin isn't installed any more" } });
  });

  it("drops what it can't read, with no answer", () => {
    const { broker } = brokerFor(installed(["notes.read"]));

    expect(broker.receive({ v: 2, id: 1, call: "perform", op: { type: "note.list" } })).toEqual({ kind: "drop" });
    expect(broker.receive({ v: 1, id: 1, call: "perform", op: { type: "note.list" }, plugin: "plugin000002" })).toEqual({ kind: "drop" });
    expect(broker.receive("perform note.list")).toEqual({ kind: "drop" });
    expect(broker.receive({ v: 1, id: 1, call: "notify", message: "x".repeat(1_000_000) })).toEqual({ kind: "drop" });
  });

  it("answers the start of a frame once", () => {
    const { broker } = brokerFor(installed([]));

    expect(broker.receive({ v: 1, ready: true })).toEqual({ kind: "ready" });
  });

  it("takes a burst and then so many a second, answering the rest rate_limited", () => {
    const { broker, wait } = brokerFor(installed([]));
    const notify = (id: number) => broker.receive({ v: 1, id, call: "notify", message: "x" });

    for (let i = 0; i < LIMITS.burst; i++) expect(notify(i).kind, `message ${i}`).toBe("notify");
    expect(notify(100)).toEqual({ kind: "refuse", id: 100, error: { code: "rate_limited", message: "Word counter is sending too much. Try again in a moment." } });
    wait(1000);
    for (let i = 0; i < LIMITS.perSecond; i++) expect(notify(200 + i).kind, `after a second, message ${i}`).toBe("notify");
    expect(notify(300).kind).toBe("refuse");
    // However long it waits, there is never more than a burst to spend.
    wait(60_000);
    for (let i = 0; i < LIMITS.burst; i++) expect(notify(400 + i).kind).toBe("notify");
    expect(notify(500).kind).toBe("refuse");
  });

  it("has at most eight operations under way, and takes the next when one is settled", () => {
    const { broker } = brokerFor(installed(["notes.read"]));

    for (let i = 0; i < LIMITS.inFlight; i++) expect(broker.receive(list(i)).kind).toBe("perform");
    expect(broker.receive(list(50))).toEqual({ kind: "refuse", id: 50, error: { code: "rate_limited", message: "Word counter has too many operations under way. Wait for one to finish." } });
    broker.settled();
    expect(broker.receive(list(51)).kind).toBe("perform");
    expect(broker.receive(list(52)).kind).toBe("refuse");
  });

  it("stops a plugin that keeps flooding, and from then on reads nothing it sends", () => {
    const { broker, wait } = brokerFor(installed(["notes.read"]));
    const kinds: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) {
      const { kind } = broker.receive({ v: 1, id: i, call: "notify", message: "flood" });
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }

    expect(kinds).toEqual({ notify: LIMITS.burst, refuse: LIMITS.flood, stop: 1, drop: 5000 - LIMITS.burst - LIMITS.flood - 1 });
    expect(broker.stopped()).toBe("it sent too many messages");
    wait(60_000);
    expect(broker.receive(list(1))).toEqual({ kind: "drop" });
    expect(broker.receive({ v: 1, ready: true })).toEqual({ kind: "drop" });
  });

  it("stops a plugin that floods with what can't be read, too", () => {
    const { broker } = brokerFor(installed([]));
    let stopped = 0;
    for (let i = 0; i < 2000 && !stopped; i++) if (broker.receive({ junk: i }).kind === "stop") stopped = i;

    // What can't be read counts for more, since reading it is the cost: a few dozen stop it.
    expect(stopped).toBe(LIMITS.flood / LIMITS.unreadable);
  });

  it("doesn't stop a plugin that is refused now and then over a long while", () => {
    const { broker, wait } = brokerFor(installed([]));
    const kinds = new Set<string>();
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < LIMITS.burst + 100; i++) kinds.add(broker.receive({ v: 1, id: i, call: "notify", message: "x" }).kind);
      wait(LIMITS.floodWindowMs + 1);
    }

    expect([...kinds].sort()).toEqual(["notify", "refuse"]);
    expect(broker.stopped()).toBeNull();
  });
});
