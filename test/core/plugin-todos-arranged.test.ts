import { describe, expect, it } from "vitest";
import { EMPTY, arrange, keyOf, left, listing, pending, type Listing, type ListingEvent } from "../../src/web/plugins/todos/arranged.ts";

interface Row {
  noteId: string;
  line: number;
  text: string;
}

const row = (key: string, text = key): Row => ({ noteId: key, line: 0, text });
const rows = (keys: string) => keys.split(" ").filter(Boolean).map((key) => row(key));
const order = (list: Listing<Row>) => list.shown.map((r) => r.noteId).join(" ");
const run = (events: ListingEvent<Row>[]) => events.reduce<Listing<Row>>(listing, EMPTY);
const read = (keys: string, refresh = false): ListingEvent<Row> => ({ type: "read", rows: rows(keys), refresh });
const change = (key: string, text: string, hold: "changed" | "put away" = "changed"): ListingEvent<Row> => ({ type: "change", key: `${key}/0`, to: (r) => ({ ...r, text }), hold });

describe("the Todos page's list while the member works on it", () => {
  it("is shown as first read, in the server's order, with nothing to refresh", () => {
    const list = run([read("a b c", true)]);
    expect(order(list)).toBe("a b c");
    expect(pending(list)).toBe(false);
  });

  it("keeps its order when a change would sort a row somewhere else, and text a refresh would show another order", () => {
    const list = run([read("a b c", true), change("c", "now due today")]);
    expect(list.shown.map((r) => r.text)).toEqual(["a", "b", "now due today"]);
    const sorted = listing(list, { type: "read", rows: [row("c", "due today"), row("a"), row("b")], refresh: false });
    expect(sorted.shown.map((r) => r.text)).toEqual(["a", "b", "due today"]);
    expect(pending(list)).toBe(false);
    expect(pending(sorted)).toBe(true);
  });

  it("takes each row's newest words from the read, where the row is shown", () => {
    const list = run([read("a b", true), { type: "read", rows: [row("a"), row("b", "B, edited elsewhere")], refresh: false }]);
    expect(list.shown).toEqual([row("a"), row("b", "B, edited elsewhere")]);
    // A line someone else wrote in place of one shown is another todo: it is placed as the server lists it, and the one shown goes.
    const replaced = run([read("a b", true), { type: "read", rows: [row("b", "another todo"), row("a")], refresh: false }]);
    expect(replaced.shown).toEqual([row("b", "another todo"), row("a")]);
    expect(pending(replaced)).toBe(false);
  });

  it("keeps a row the member changed out of the list, dimmed, until it is refreshed, and then lets it go", () => {
    const list = run([read("a b c", true), change("b", "due next week"), read("a c")]);
    expect(order(list)).toBe("a b c");
    expect(list.shown[1]!.text).toBe("due next week");
    expect([...left(list)]).toEqual(["b/0"]);
    expect(pending(list)).toBe(true);

    const refreshed = listing(list, { type: "refresh" });
    expect(order(refreshed)).toBe("a c");
    expect(left(refreshed).size).toBe(0);
    expect(pending(refreshed)).toBe(false);
  });

  it("lets a row go that left the list without the member changing it, as one deleted elsewhere", () => {
    const list = run([read("a b c", true), read("a c")]);
    expect(order(list)).toBe("a c");
    expect(pending(list)).toBe(false);
  });

  it("puts a row that came right after the row the server lists before it, or first", () => {
    expect(order(run([read("a b c", true), read("a x b c")]))).toBe("a x b c");
    expect(order(run([read("a b c", true), read("x a b c")]))).toBe("x a b c");
    expect(order(run([read("a b", true), read("a b x y")]))).toBe("a b x y");
    // Next to the row before it as shown, which a change kept where it was.
    const list = run([read("a b c", true), change("c", "sooner"), read("c x a b")]);
    expect(order(list)).toBe("a b c x");
    expect(pending(list)).toBe(true);
  });

  it("holds a row checked off for its moment without asking for a refresh, and lets it go after it", () => {
    const list = run([read("a b c", true), change("b", "done", "put away"), read("a c")]);
    expect(order(list)).toBe("a b c");
    expect([...left(list)]).toEqual(["b/0"]);
    expect(pending(list)).toBe(false);
    const gone = listing(list, { type: "let go", key: "b/0" });
    expect(order(gone)).toBe("a c");
    expect(pending(gone)).toBe(false);
  });

  it("keeps a row checked off that the list still has, as one that repeats, and a let go changes nothing for it or for a row changed", () => {
    const list = run([read("a b", true), change("a", "next week", "put away"), read("b a"), { type: "let go", key: "a/0" }]);
    expect(order(list)).toBe("a b");
    expect(pending(list)).toBe(true);
    const changed = run([read("a b", true), change("a", "moved"), read("b"), { type: "let go", key: "a/0" }]);
    expect(order(changed)).toBe("a b");
  });

  it("keeps how a row is held through a change that only text where its line is now", () => {
    const list = run([read("a b", true), change("a", "done", "put away"), change("a", "open again"), read("b"), { type: "change", key: "a/0", to: (r) => ({ ...r, text: "at revision 3" }) }]);
    expect(list.held.get("a/0")).toBe("changed");
    expect(list.shown[0]!.text).toBe("at revision 3");
    expect(order(listing(list, { type: "let go", key: "a/0" }))).toBe("a b");
  });

  it("holds nothing for a change that was refused: the row goes as any the list no longer has", () => {
    const list = run([read("a b", true), change("b", "moved"), { type: "refused", key: "b/0" }, read("a")]);
    expect(order(list)).toBe("a");
    expect(list.held.size).toBe(0);
  });

  it("shows a list read for other filters, or refreshed, as read, forgetting what it held", () => {
    const list = run([read("a b c", true), change("b", "x"), read("a c"), read("d e", true)]);
    expect(order(list)).toBe("d e");
    expect(list.held.size).toBe(0);
    expect(pending(list)).toBe(false);
  });

  it("adds more read after it at the end, in the server's order", () => {
    const list = run([read("a b", true), change("a", "moved"), read("b a"), { type: "more", rows: rows("c d") }]);
    expect(order(list)).toBe("a b c d");
    expect(list.fresh.map(keyOf)).toEqual(["b/0", "a/0", "c/0", "d/0"]);
  });

  it("is arranged the same however often it is arranged", () => {
    const held = new Map([["b/0", "changed" as const]]);
    const once = arrange(rows("a b c"), rows("c x a"), held).rows;
    expect(once.map((r) => r.noteId)).toEqual(["a", "b", "c", "x"]);
    expect(arrange(once, rows("c x a"), held).rows).toEqual(once);
  });

  it("follows each row to the line it moved to when a line is written above it, keeping its place and its hold", () => {
    const line = (l: number, text: string): Row => ({ noteId: "n", line: l, text });
    const shown = [line(3, "aaa"), line(5, "ddd"), line(4, "bbb"), line(2, "ccc")];
    let list = listing(EMPTY as Listing<Row>, { type: "read", rows: shown, refresh: true });
    list = listing(list, { type: "change", key: "n/2", to: (r) => ({ ...r, text: "ccc sooner" }), hold: "changed" });
    // One line written above them all: every line is one further down, and the server sorts ccc first now.
    list = listing(list, { type: "read", rows: [line(3, "ccc sooner"), line(4, "aaa"), line(6, "ddd"), line(5, "bbb")], refresh: false });
    expect(list.shown.map((r) => `${r.line} ${r.text}`)).toEqual(["4 aaa", "6 ddd", "5 bbb", "3 ccc sooner"]);
    expect([...list.held]).toEqual([["n/3", "changed"]]);
    expect(left(list).size).toBe(0);
    expect(pending(list)).toBe(true);
  });
});
