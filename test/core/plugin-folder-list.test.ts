import { describe, expect, it } from "vitest";
import type { NoteSummary } from "../../src/core/protocol.ts";
import { ALL_NOTES, SHARED_WITH_ME } from "../../src/web/plugin-api.ts";
import { INITIAL_VIEW, SHOWS, fits, includeArchivedOf, lifeOf, listReducer, listed, notesIn, taggedQuery, todosOf, withLife, withTodos, withoutTagMarks } from "../../src/web/plugins/noteListView.ts";

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

describe("the choice under the search bar", () => {
  it("writes the choice into the bar and replaces the one already there", () => {
    expect(withLife("", "active")).toBe("is:open");
    expect(withLife("tea", "archived")).toBe("tea is:archived");
    expect(withLife("tea is:open", "all")).toBe("tea (is:open OR is:archived)");
    expect(withLife("is:archived sort:title-asc", "active")).toBe("sort:title-asc is:open");
    expect(withLife("is:trashed", "archived")).toBe("is:archived");
    expect(withLife("is:open OR is:archived", "active")).toBe("is:open");
    expect(withLife("((", "all")).toBe("(is:open OR is:archived)");
  });

  it("reads the choice back, and an empty bar is active notes", () => {
    expect(lifeOf("")).toBe("active");
    expect(lifeOf("tea")).toBe("active");
    expect(lifeOf("is:open")).toBe("active");
    expect(lifeOf("tea is:archived")).toBe("archived");
    expect(lifeOf("tea (is:open OR is:archived)")).toBe("all");
  });
});

describe("a card", () => {
  const whole = { type: "wholeOrLess", noteId: "a" } as const;

  it("grows to the whole of its note and is cut back again, apart from the others", () => {
    expect(INITIAL_VIEW.whole).toEqual({});
    expect(listReducer(INITIAL_VIEW, whole).whole).toEqual({ a: true });
    expect(listReducer(listReducer(INITIAL_VIEW, whole), whole).whole).toEqual({});
    const two = listReducer(listReducer(INITIAL_VIEW, whole), { type: "wholeOrLess", noteId: "b" });
    expect(two.whole).toEqual({ a: true, b: true });
    expect(listReducer(two, whole).whole).toEqual({ b: true });
  });
});

describe("the choice of todos under the search bar", () => {
  it("writes the choice into the bar and replaces the one already there", () => {
    expect(withTodos("", "open")).toBe("has:open-todo");
    expect(withTodos("tea is:open", "done")).toBe("tea is:open has:todo no:open-todo");
    expect(withTodos("tea has:todo no:open-todo", "open")).toBe("tea has:open-todo");
    expect(withTodos("has:task -has:open-task sort:title-asc", "any")).toBe("sort:title-asc");
    expect(withTodos("((", "open")).toBe("has:open-todo");
  });

  it("reads the choice back, and one inside an OR is no choice", () => {
    expect(todosOf("")).toBe("any");
    expect(todosOf("tea has:open-todo")).toBe("open");
    expect(todosOf("has:todo no:open-todo is:open")).toBe("done");
    expect(todosOf("has:todo")).toBe("any");
    expect(todosOf("has:open-todo OR tea")).toBe("any");
  });
});

describe("what a tag's list asks the server", () => {
  it("is the tag alone with nothing typed, and the tag beside what is typed, an OR kept whole and an order kept last", () => {
    expect(taggedQuery("garden", "")).toBe("tag:garden");
    expect(taggedQuery("garden", "seeds")).toBe("tag:garden seeds");
    expect(taggedQuery("garden", "seeds OR beds")).toBe("tag:garden (seeds OR beds)");
    expect(taggedQuery("garden", "sort:title-asc")).toBe("tag:garden sort:title-asc");
    expect(taggedQuery("garden", "is:archived #money")).toBe("tag:garden is:archived tag:money");
    expect(taggedQuery("work/2026-q4", "plan")).toBe("tag:work/2026-q4 plan");
  });

  it("is the tag alone while what is typed can't be read yet", () => {
    expect(taggedQuery("garden", "seeds (")).toBe("tag:garden");
    expect(taggedQuery("garden", "is:bogus")).toBe("tag:garden");
  });
});

describe("the lines a tag's list shows a search matched", () => {
  it("leaves the tag itself unmarked, whatever its case, and a line marked only for it out", () => {
    const matches = [
      { line: 2, text: "Dig the beds #Garden", marks: [[0, 3], [13, 20]] as [number, number][] },
      { line: 4, text: "#garden", marks: [[0, 7]] as [number, number][] },
      { line: 5, text: "#gardening dig", marks: [[0, 10], [11, 14]] as [number, number][] },
    ];
    expect(withoutTagMarks(matches, "garden")).toEqual([
      { line: 2, text: "Dig the beds #Garden", marks: [[0, 3]] },
      { line: 5, text: "#gardening dig", marks: [[0, 10], [11, 14]] },
    ]);
  });
});
