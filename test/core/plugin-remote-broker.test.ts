import { describe, expect, it } from "vitest";
import type { Capability, InstalledPlugin, Permission } from "../../src/core/plugins.ts";
import { appsOwn, createBroker, decide, granted, kept, LIMITS, type Decision } from "../../src/web/remote/broker.ts";
import { MAX_STORED, MAX_STORED_KEYS, MAX_STORED_TOTAL, STORED_INDEX, WATCHED, read, type FromPlugin } from "../../src/web/remote/protocol.ts";

const NOTE = "abcdefghijkl";

const permission = (capability: Capability, state: Permission["state"], more: Partial<Permission> = {}): Permission => ({ capability, reason: "Because", origins: [], state, locked: false, decidedBy: null, voided: false, requests: [], ...more });

function installed(allowed: Capability[], off: Capability[] = []): InstalledPlugin {
  return {
    id: "plugin000001",
    thirdParty: true,
    manifest: { name: "Word counter", version: "1", capabilities: [...allowed, ...off].map((name) => ({ name, reason: "Because" })), commands: [], views: [], embeds: [], settings: {} },
    codeHash: "0".repeat(64),
    fullTrust: null,
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

describe("what every plugin that runs shut off was given so the app's own could run there", () => {
  /** One of the app's own, as the app tells of it: its code has no name. A member's copy of it has one. */
  const own = (allowed: Capability[]): InstalledPlugin => ({ ...installed(allowed), id: "quick-timer", thirdParty: false, codeHash: null, manifest: { ...installed(allowed).manifest, name: "Quick timer" } });
  const copy = (allowed: Capability[]): InstalledPlugin => ({ ...own(allowed), codeHash: "1".repeat(64) });

  it("tells a plugin of the note in front and of changes to the notes only when it may read notes", () => {
    for (const what of WATCHED) {
      expect(decide(installed(["notes.read"]), { v: 1, id: 4, call: "watch", what })).toEqual({ kind: "watch", id: 4, what });
      for (const plugin of [installed([]), installed(["notes.write", "todos.read", "members.read"]), installed([], ["notes.read"]), own([]), copy([])]) {
        expect(decide(plugin, { v: 1, id: 4, call: "watch", what })).toMatchObject({ kind: "refuse", id: 4, error: { code: "forbidden" } });
      }
    }
  });

  it("opens a note behind the one in front only when asked to, and still only for a plugin that may read notes", () => {
    expect(decide(installed(["notes.read"]), { v: 1, id: 3, call: "open", noteId: NOTE, background: true })).toEqual({ kind: "open", id: 3, noteId: NOTE, background: true });
    expect(decide(installed(["notes.read"]), { v: 1, id: 3, call: "open", noteId: NOTE, background: false })).toEqual({ kind: "open", id: 3, noteId: NOTE });
    expect(decide(own([]), { v: 1, id: 3, call: "open", noteId: NOTE, background: true })).toMatchObject({ kind: "refuse", error: { code: "forbidden" } });
  });

  it("keeps what a plugin asks to keep under its own keys, never the app's, and no more than a plugin may keep", () => {
    expect(decide(installed([]), { v: 1, id: 5, call: "storage.get", key: "running" })).toEqual({ kind: "stored", id: 5, key: "running" });
    expect(decide(installed([]), { v: 1, id: 5, call: "storage.set", key: "running", value: { length: "5m" } })).toEqual({ kind: "store", id: 5, key: "running", value: { length: "5m" } });
    for (const call of ["storage.get", "storage.set"] as const) expect(decide(installed([]), { v: 1, id: 5, call, key: STORED_INDEX, value: {} } as FromPlugin)).toMatchObject({ kind: "refuse", error: { code: "invalid" } });
    expect(decide(installed([]), { v: 1, id: 5, call: "storage.set", key: "big", value: "x".repeat(MAX_STORED) })).toMatchObject({ kind: "refuse", error: { code: "invalid" } });

    expect(kept(undefined, "a", "xy")).toEqual({ index: { a: 5 } });
    expect(kept({ a: 4, b: 9 }, "a", null)).toEqual({ index: { b: 9 } });
    // What the browser handed back is not trusted to be what the app wrote.
    expect(kept({ a: "many", b: -3, c: 2 }, "d", 1)).toEqual({ index: { c: 2, d: 2 } });
    expect(kept("nonsense", "d", 1)).toEqual({ index: { d: 2 } });
    // A key's name is kept as well as what is under it, so a long name counts.
    expect(kept(undefined, "k".repeat(100), 1)).toEqual({ index: { ["k".repeat(100)]: 101 } });
    const full = Object.fromEntries(Array.from({ length: MAX_STORED_KEYS }, (_, i) => [`k${i}`, 1]));
    expect(kept(full, "one-more", 1)).toHaveProperty("reason");
    expect(kept(full, "k3", "changed")).toHaveProperty("index");
    expect(kept({ a: MAX_STORED_TOTAL - 2 }, "b", "xyz")).toHaveProperty("reason");
    expect(kept({ a: MAX_STORED_TOTAL - 2 }, "a", "xyz")).toHaveProperty("index");
  });

  it("asks the member a plugin's question under the plugin's name, so it can't be taken for the app's: only the app's own unchanged code asks unnamed", () => {
    const ask: FromPlugin = { v: 1, id: 6, call: "prompt", title: "Sign in again", label: "Your password\u0000", value: "v".repeat(500), hint: "h".repeat(500), error: "one\ntwo" };
    const theirs = decide(installed([]), ask) as Extract<Decision, { kind: "prompt" }>;
    expect(theirs).toMatchObject({ kind: "prompt", id: 6, from: "Word counter", title: "Word counter plugin: Sign in again", label: "Your password ", error: "one two" });
    expect(theirs.value).toHaveLength(200);
    expect(theirs.hint).toHaveLength(LIMITS.notice);
    expect(decide(own([]), ask)).toMatchObject({ from: null, title: "Sign in again" });
    // A member's copy of one of the app's own is that member's code, and is named as a plugin is.
    expect(decide(copy([]), ask)).toMatchObject({ from: "Quick timer", title: "Quick timer plugin: Sign in again" });
    expect(decide(copy([]), { v: 1, id: 2, call: "notify", message: "Done" })).toEqual({ kind: "notify", id: 2, message: "Quick timer plugin: Done" });
    expect(decide(own([]), { v: 1, id: 2, call: "notify", message: "Done" })).toEqual({ kind: "notify", id: 2, message: "Done" });
    expect([appsOwn(own([])), appsOwn(copy([])), appsOwn(installed([])), appsOwn({ ...installed([]), codeHash: null })]).toEqual([true, false, false, false]);
  });

  it("is told how wide a frame in the bar draws, as a number of pixels and nothing else", () => {
    expect(decide(installed([]), { v: 1, fit: 120 })).toEqual({ kind: "fit", width: 120 });
    for (const fit of [-1, 1.5, 1e9, "120", null]) expect(read({ v: 1, fit })).toBeNull();
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
