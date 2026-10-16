import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../../src/core/protocol.ts";
import { ALL_NOTES, SHARED_WITH_ME } from "../../src/web/plugin-api.ts";
import { INITIAL_VIEW, SHOWS, fits, includeArchivedOf, listReducer, listed, notesIn } from "../../src/web/plugins/noteListView.ts";

const note = (id: string, over: Partial<NoteSummary> = {}) =>
  ({ id, title: id, snippet: "", folderId: "f", openTodos: 0, createdAt: 0, updatedAt: 0, state: "live", ...over }) as NoteSummary;
const ids = (notes: readonly NoteSummary[]) => notes.map((n) => n.id);

describe("which notes a folder's list is of", () => {
  const notes = [note("a", { folderId: "f" }), note("b", { folderId: "g" }), note("c", { folderId: null })];

  it("is the folder's own notes, every note for All notes, and the ones with no folder to see for Shared with me", () => {
    expect(ids(notesIn(notes, "f"))).toEqual(["a"]);
    expect(ids(notesIn(notes, ALL_NOTES))).toEqual(["a", "b", "c"]);
    expect(ids(notesIn(notes, SHARED_WITH_ME))).toEqual(["c"]);
    expect(ids(notesIn(notes, "nowhere"))).toEqual([]);
  });
});

describe("how the list is set", () => {
  const notes = [
    note("Banana", { snippet: "Yellow", updatedAt: 3, createdAt: 1, openTodos: 1 }),
    note("apple", { snippet: "Red or green", updatedAt: 1, createdAt: 2 }),
    note("Cherry", { updatedAt: 2, createdAt: 3, openTodos: 2, state: "archived" }),
    note("Gone", { updatedAt: 9, state: "trashed" }),
    note("", { snippet: "no title", updatedAt: 0 }),
  ];
  const withView = (...actions: Parameters<typeof listReducer>[1][]) => actions.reduce(listReducer, INITIAL_VIEW);

  it("shows open notes, archived notes alone, or both, and notes in Trash never", () => {
    expect(ids(listed(notes, INITIAL_VIEW))).toEqual(["Banana", "apple", ""]);
    expect(ids(listed(notes, withView({ type: "show", show: "archived" })))).toEqual(["Cherry"]);
    expect(ids(listed(notes, withView({ type: "show", show: "all" })))).toEqual(["Banana", "Cherry", "apple", ""]);
    expect(ids(listed(notes, withView({ type: "show", show: "all" }, { type: "show", show: "open" })))).toEqual(["Banana", "apple", ""]);
    expect(SHOWS.map((s) => [s.id, includeArchivedOf(s.id)])).toEqual([["open", false], ["archived", "only"], ["all", true]]);
  });

  it("sorts by the last change until another order is picked, by when each was made, or by title with an untitled note under U", () => {
    const all = { type: "show", show: "all" } as const;
    expect(ids(listed(notes, withView(all, { type: "sort", sort: "recent" })))).toEqual(["Banana", "Cherry", "apple", ""]);
    expect(ids(listed(notes, withView(all, { type: "sort", sort: "created" })))).toEqual(["Cherry", "apple", "Banana", ""]);
    expect(ids(listed(notes, withView(all, { type: "sort", sort: "title" })))).toEqual(["apple", "Banana", "Cherry", ""]);
    expect(ids(listed(notes, withView(all, { type: "sort", sort: "title" }, { type: "sort", sort: null })))).toEqual(["Banana", "Cherry", "apple", ""]);
  });

  it("narrows to notes with open todos, and keeps what is searched for without narrowing by it: the server finds those", () => {
    expect(ids(listed(notes, withView({ type: "hasTodos" })))).toEqual(["Banana"]);
    expect(ids(listed(notes, withView({ type: "hasTodos" }, { type: "show", show: "all" })))).toEqual(["Banana", "Cherry"]);
    expect(ids(listed(notes, withView({ type: "hasTodos" }, { type: "hasTodos" })))).toEqual(["Banana", "apple", ""]);
    const searching = withView({ type: "query", text: "red" });
    expect(searching.query).toBe("red");
    expect(ids(listed(notes, searching))).toEqual(["Banana", "apple", ""]);
    expect(listReducer(searching, { type: "query", text: "red" })).toBe(searching);
  });

  it("says of one note whether a list set so has it, as a search's results are held to", () => {
    const [banana, , cherry, gone] = notes;
    expect([banana!, cherry!, gone!].map((n) => fits({ show: "open", hasTodos: false }, n))).toEqual([true, false, false]);
    expect([banana!, cherry!, gone!].map((n) => fits({ show: "archived", hasTodos: false }, n))).toEqual([false, true, false]);
    expect([banana!, cherry!, gone!].map((n) => fits({ show: "all", hasTodos: true }, n))).toEqual([true, true, false]);
  });
});

describe("a card", () => {
  const expand = { type: "expandOrCollapse", noteId: "a" } as const;
  const whole = { type: "wholeOrExcerpt", noteId: "a" } as const;

  it("expands to an excerpt, then to the whole note and back, and collapses from either", () => {
    const excerpt = listReducer(INITIAL_VIEW, expand);
    expect(excerpt.expanded).toEqual({ a: "excerpt" });
    expect(listReducer(excerpt, whole).expanded).toEqual({ a: "whole" });
    expect(listReducer(listReducer(excerpt, whole), whole).expanded).toEqual({ a: "excerpt" });
    expect(listReducer(listReducer(excerpt, whole), expand).expanded).toEqual({});
    expect(listReducer(excerpt, { type: "collapse", noteId: "a" }).expanded).toEqual({});
  });

  it("is expanded apart from the others, and a collapsed one is left as it is by what only an expanded one takes", () => {
    const two = listReducer(listReducer(INITIAL_VIEW, expand), { type: "expandOrCollapse", noteId: "b" });
    expect(listReducer(two, whole).expanded).toEqual({ a: "whole", b: "excerpt" });
    expect(listReducer(INITIAL_VIEW, whole)).toBe(INITIAL_VIEW);
    expect(listReducer(INITIAL_VIEW, { type: "collapse", noteId: "a" })).toBe(INITIAL_VIEW);
  });
});
