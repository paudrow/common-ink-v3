import { describe, expect, it } from "vitest";
import type { Opened } from "../../src/web/plugin-api.ts";
import { NO_TRAVELS, keptTravels, stepped, travelled, type Travel, type Travels } from "../../src/web/travels.ts";

const note = (id: string): Opened => ({ kind: "note", id });
const page = (id: string, path = `/${id}`): Opened => ({ kind: "page", id, path });
const folder = (id: string): Opened => ({ kind: "folder", id });
const arrive = (place: Opened, left: number | null = null): Travel => ({ type: "arrive", place, left });
const through = (...travels: Travel[]) => travels.reduce(travelled, NO_TRAVELS);
/** Each stop as `id@cursor`, the one the member is at in brackets. */
const read = (t: Travels) => t.stops.map((s, i) => `${i === t.at ? "[" : ""}${s.place.id}${s.cursor === null ? "" : `@${s.cursor}`}${i === t.at ? "]" : ""}`).join(" ");
const anywhere = () => true;

describe("travels", () => {
  it("makes a stop of each place arrived at, pages and folders as well as notes, and keeps where the cursor was in a note left", () => {
    expect(read(through(arrive(page("dashboard")), arrive(note("a")), arrive(folder("f")), arrive(note("b"), null), arrive(page("search"), 7)))).toBe("dashboard a f b@7 [search]");
  });

  it("makes no stop of arriving at the place in front again, and keeps the page's latest query", () => {
    const t = through(arrive(page("search", "/search")), arrive(page("search", "/search?q=p")), arrive(page("search", "/search?q=plan")));
    expect(read(t)).toBe("[search]");
    expect(t.stops[0]!.place).toEqual(page("search", "/search?q=plan"));
  });

  it("makes a stop of each path of one page, as a person's page and the next", () => {
    const t = through(arrive(page("contacts")), arrive(page("person", "/person/ada")), arrive(page("person", "/person/ned")), arrive(page("uploads", "/uploads")), arrive(page("uploads", "/uploads/u1")));
    expect(t.stops.map((s) => (s.place.kind === "page" ? s.place.path : ""))).toEqual(["/contacts", "/person/ada", "/person/ned", "/uploads", "/uploads/u1"]);
  });

  it("steps back and forward, and arriving where a step went changes nothing", () => {
    let t = through(arrive(note("a")), arrive(note("b")), arrive(page("todos"), 3));
    t = stepped(t, -1, page("todos"), null, anywhere);
    expect(read(t)).toBe("a [b@3] todos");
    t = travelled(t, arrive(note("b")));
    expect(read(t)).toBe("a [b@3] todos");
    t = stepped(t, -1, note("b"), 9, anywhere);
    expect(read(t)).toBe("[a] b@9 todos");
    expect(stepped(t, -1, note("a"), 0, anywhere)).toBe(t);
    t = stepped(stepped(t, 1, note("a"), 0, anywhere), 1, note("b"), 9, anywhere);
    expect(read(t)).toBe("a@0 b@9 [todos]");
    expect(stepped(t, 1, page("todos"), null, anywhere)).toBe(t);
  });

  it("drops what was ahead when the member goes somewhere new from the middle", () => {
    let t = through(arrive(note("a")), arrive(note("b")), arrive(note("c")));
    t = stepped(t, -1, note("c"), 0, anywhere);
    t = travelled(t, arrive(page("search"), 4));
    expect(read(t)).toBe("a b@4 [search]");
  });

  it("steps over a place that can't be gone to", () => {
    const t = through(arrive(note("a")), arrive(note("gone")), arrive(note("c")));
    expect(read(stepped(t, -1, note("c"), 0, (p) => p.id !== "gone"))).toBe("[a] gone c@0");
  });

  it("goes back to the stop it is at from a place left out of the history", () => {
    const t = through(arrive(note("a")), arrive(note("b")));
    expect(read(stepped(t, -1, page("settings"), null, anywhere))).toBe("a [b]");
    expect(stepped(t, 1, page("settings"), null, anywhere)).toBe(t);
  });

  it("makes a stop of a jump within the note in front, and back comes to where it jumped from before the note before", () => {
    let t = through(arrive(note("a")), arrive(note("b")), { type: "jump", noteId: "b", from: 0, to: 500 });
    expect(read(t)).toBe("a b@0 [b@500]");
    t = stepped(t, -1, note("b"), 480, anywhere);
    expect(read(t)).toBe("a [b@0] b@480");
    t = stepped(t, -1, note("b"), 0, anywhere);
    expect(read(t)).toBe("[a] b@0 b@480");
    t = stepped(t, 1, note("a"), null, anywhere);
    expect(read(t)).toBe("a [b@0] b@480");
  });

  it("steps over a stop in the note in front that is where the cursor already is", () => {
    const t = through(arrive(note("a")), arrive(note("b")), { type: "jump", noteId: "b", from: 40, to: 900 }, { type: "jump", noteId: "b", from: 900, to: 40 });
    expect(read(t)).toBe("a b@40 b@900 [b@40]");
    expect(read(stepped(t, -1, note("b"), 40, anywhere))).toBe("a b@40 [b@900] b@40");
    expect(read(stepped(t, -1, note("b"), 900, anywhere))).toBe("a [b@40] b@900 b@900");
  });

  it("takes no jump in a note that isn't the one in front, and none that goes nowhere", () => {
    const t = through(arrive(note("a")));
    expect(travelled(t, { type: "jump", noteId: "b", from: 0, to: 10 })).toBe(t);
    expect(travelled(t, { type: "jump", noteId: "a", from: 10, to: 10 })).toBe(t);
  });

  it("keeps each stop in a note at its words when the text before it changes, and leaves the rest as they were", () => {
    const t = through(arrive(note("a"), null), arrive(note("b"), null), { type: "jump", noteId: "b", from: 2, to: 50 }, arrive(note("a"), 50));
    const typed = travelled(t, { type: "edit", noteId: "b", map: (at) => (at >= 10 ? at + 5 : at) });
    expect(read(typed)).toBe("a b@2 b@55 [a]");
    expect(travelled(t, { type: "edit", noteId: "b", map: (at) => at })).toBe(t);
  });

  it("lists the places visited, the latest first and each once", () => {
    const t = through(arrive(note("a")), arrive(page("todos")), arrive(note("b")), arrive(note("a")), arrive(page("todos", "/todos?q=x")));
    expect(t.recent).toEqual([page("todos", "/todos?q=x"), note("a"), note("b")]);
  });

  it("keeps a hundred stops at most, the newest", () => {
    const t = through(...Array.from({ length: 130 }, (_, i) => arrive(note(String(i)))));
    expect(t.stops).toHaveLength(100);
    expect(t.stops[0]!.place.id).toBe("30");
    expect(t.at).toBe(99);
  });

  it("reads back what a browser kept, and nothing from what it can't use", () => {
    const t = through(arrive(note("a")), arrive(page("search", "/search?q=x"), 5));
    expect(keptTravels(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(keptTravels({ stops: [{ place: note("a"), cursor: null }], at: 3, recent: [] })).toEqual(NO_TRAVELS);
    expect(keptTravels({ stops: [{ place: page("x", "//evil.example"), cursor: null }], at: 0, recent: [] })).toEqual(NO_TRAVELS);
    expect(keptTravels("nonsense")).toEqual(NO_TRAVELS);
  });
});
