import { describe, expect, it } from "vitest";
import { frameDocument } from "../../src/web/remote/document.ts";
import { MAX_MESSAGE, read } from "../../src/web/remote/protocol.ts";

describe("what a plugin's frame sends, read at the app's end", () => {
  it("reads each of the four messages a frame may send", () => {
    expect(read({ v: 1, ready: true })).toEqual({ v: 1, ready: true });
    expect(read({ v: 1, id: 3, call: "perform", op: { type: "note.read", id: "abcdefghijkl" } })).toEqual({ v: 1, id: 3, call: "perform", op: { type: "note.read", id: "abcdefghijkl" } });
    expect(read({ v: 1, id: 4, call: "notify", message: "Done" })).toEqual({ v: 1, id: 4, call: "notify", message: "Done" });
    expect(read({ v: 1, id: 5, call: "open", noteId: "abcdefghijkl" })).toEqual({ v: 1, id: 5, call: "open", noteId: "abcdefghijkl" });
  });

  it("drops what isn't one of them: another version, a missing or wrong field, a call there isn't", () => {
    const dropped: unknown[] = [
      null,
      undefined,
      "perform",
      7,
      [],
      {},
      { ready: true },
      { v: 2, ready: true },
      { v: "1", ready: true },
      { v: 1, ready: 1 },
      { v: 1, id: 1, call: "perform" },
      { v: 1, id: 1, call: "perform", op: "note.list" },
      { v: 1, id: 1, call: "perform", op: { id: "abcdefghijkl" } },
      { v: 1, id: 1, call: "perform", op: { type: 5 } },
      { v: 1, id: "1", call: "notify", message: "x" },
      { v: 1, id: 1.5, call: "notify", message: "x" },
      { v: 1, id: -1, call: "notify", message: "x" },
      { v: 1, call: "notify", message: "x" },
      { v: 1, id: 1, call: "notify", message: { text: "x" } },
      { v: 1, id: 1, call: "open" },
      { v: 1, id: 1, call: "run", command: "plugins.disable.vim" },
      { v: 1, id: 1, call: "enable", plugin: "abcdefghijkl" },
      { v: 1, event: "command", id: "plugins.enable.abcdefghijkl" },
      { v: 1, reply: 1, ok: true, result: {} },
      { v: 1, init: { granted: ["notes.write"] } },
      { embedFrame: "ready" },
      { inkPort: true },
    ];
    for (const message of dropped) expect(read(message), JSON.stringify(message)).toBeNull();
  });

  it("drops a message with a key it doesn't know, wherever an identity might be claimed", () => {
    expect(read({ v: 1, ready: true, plugin: "abcdefghijkl" })).toBeNull();
    expect(read({ v: 1, id: 1, call: "notify", message: "x", pluginId: "abcdefghijkl" })).toBeNull();
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.list" }, plugin: "abcdefghijkl" })).toBeNull();
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.list" }, as: "member" })).toBeNull();
    expect(read({ v: 1, id: 1, call: "open", noteId: "abcdefghijkl", workspaceId: "abcdefghijkl" })).toBeNull();
  });

  it("drops a message over the size cap, and one that can't be written as JSON", () => {
    const fits = "x".repeat(MAX_MESSAGE - 200);
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.write", id: "abcdefghijkl", text: fits } })).not.toBeNull();
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.write", id: "abcdefghijkl", text: "x".repeat(1_000_000) } })).toBeNull();
    expect(read({ v: 1, id: 1, call: "notify", message: "x".repeat(MAX_MESSAGE + 1) })).toBeNull();
    const circular: Record<string, unknown> = { v: 1, id: 1, call: "perform", op: { type: "note.list" } };
    (circular.op as Record<string, unknown>).self = circular;
    expect(read(circular)).toBeNull();
    expect(read({ v: 1, id: 1n, call: "notify", message: "x" })).toBeNull();
  });

  it("drops a message holding a __proto__, constructor or prototype key at any depth, and leaves every prototype as it was", () => {
    const polluting = [
      JSON.parse('{"v":1,"id":1,"call":"perform","op":{"type":"note.list","__proto__":{"polluted":true}}}'),
      JSON.parse('{"v":1,"id":1,"call":"perform","op":{"type":"note.list","constructor":{"prototype":{"polluted":true}}}}'),
      JSON.parse('{"v":1,"id":1,"call":"perform","op":{"type":"note.write","id":"abcdefghijkl","text":"x","deep":[{"a":{"prototype":{"polluted":true}}}]}}'),
      JSON.parse('{"v":1,"id":1,"call":"notify","message":"x","__proto__":{"call":"perform"}}'),
      JSON.parse('{"__proto__":{"v":1,"ready":true}}'),
    ];
    for (const message of polluting) expect(read(message), JSON.stringify(message)).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("reads plain data only, and hands on a copy of it: nothing of the object that arrived", () => {
    class Op {
      type = "note.list";
    }
    const sent = { v: 1, id: 1, call: "perform", op: { type: "note.list" } };
    const got = read(sent) as { op: object };
    expect(got).toEqual(sent);
    expect(got.op).not.toBe(sent.op);
    expect(read({ v: 1, id: 1, call: "perform", op: new Op() })).toBeNull();
    expect(read({ v: 1, id: 1, call: "perform", op: new Map([["type", "note.list"]]) })).toBeNull();
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.list", at: new Date(0) } })).toBeNull();
  });

  it("turns away what is too large without writing it out: a long array, bytes, a deep nest", () => {
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.list", pad: new Array(50_000_000) } })).toBeNull();
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.list", pad: new Uint8Array(1_000_000) } })).toBeNull();
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.list", pad: Array.from({ length: MAX_MESSAGE + 1 }, () => 0) } })).toBeNull();
    let deep: unknown = "x";
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(read({ v: 1, id: 1, call: "perform", op: { type: "note.list", deep } })).toBeNull();
  });
});

describe("the document a plugin's frame is given", () => {
  const holder = (html: string) => /<script type="application\/json" id="ink-code">([^]*?)<\/script>/.exec(html)![1]!;

  it("holds the plugin's code as data that reads back exactly, whatever the code says", () => {
    const code = `const a = "</script><script>alert(1)</script>"; // <!-- <script>\nif (1</script>/.test("x")) {}\n const b = \`</SCRIPT >\`;`;
    const html = frameDocument({ code, sdk: "/* sdk */", styles: "body { color: red }", scheme: "dark" });

    expect(JSON.parse(holder(html))).toBe(code);
    expect(holder(html)).not.toContain("<");
    // The app's own two scripts and no third: nothing in the code closed its holder or opened another.
    expect(html.match(/<script/gi)).toHaveLength(2);
    expect(html.match(/<\/script/gi)).toHaveLength(2);
  });

  it("puts the app's script before the code, and says which scheme it is drawn in", () => {
    const html = frameDocument({ code: "ink.notify('hi')", sdk: "/* sdk */", styles: "", scheme: "light" });

    expect(html.indexOf("/* sdk */")).toBeGreaterThan(0);
    expect(html.indexOf("/* sdk */")).toBeLessThan(html.indexOf('id="ink-code"'));
    expect(html).toContain("color-scheme: light");
  });
});
