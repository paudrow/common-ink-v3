import { describe, expect, it } from "vitest";
import type { NoteSummary, SearchResult } from "../../src/core/protocol.ts";
import { pieces } from "../../src/web/plugins/search/marks.ts";
import { IDLE, addressOf, againLimit, askOf, reduce, type Ask, type Event, type Search } from "../../src/web/plugins/search/request.ts";

const result = (id: string): SearchResult => ({ note: { id } as NoteSummary, matches: [] });
const ids = (state: Search) => (state.status === "listed" ? state.results.map((r) => r.note.id) : null);
const after = (...events: Event[]) => events.reduce(reduce, IDLE);
const PLAN: Ask = { query: "plan", includeArchived: false };
const PLANS: Ask = { query: "plans", includeArchived: false };

describe("a matched line cut into pieces", () => {
  it("is its marked runs and the runs between them, in order", () => {
    expect(pieces("call the bank today", [[9, 13]])).toEqual([
      { text: "call the ", marked: false },
      { text: "bank", marked: true },
      { text: " today", marked: false },
    ]);
  });

  it("says exactly what the line says, whatever the marks", () => {
    const line = '<img src=x onerror="alert(1)"> **bold** plan';
    for (const marks of [[], [[40, 44]], [[0, 4], [2, 9], [9, 12]], [[50, 60]], [[-3, 2]], [[5, 5]], [[30, 10]], [[40, 400]]] as [number, number][][]) {
      expect(pieces(line, marks).map((p) => p.text).join("")).toBe(line);
    }
  });

  it("makes one run of marks that overlap or touch, and takes them in any order", () => {
    expect(pieces("abcdefgh", [[4, 6], [0, 2], [1, 3], [3, 4]])).toEqual([
      { text: "abcdef", marked: true },
      { text: "gh", marked: false },
    ]);
  });

  it("cuts a mark that reaches past the line to the line, and leaves out an empty one", () => {
    expect(pieces("plan", [[2, 99], [1, 1]])).toEqual([
      { text: "pl", marked: false },
      { text: "an", marked: true },
    ]);
    expect(pieces("", [[0, 3]])).toEqual([]);
  });
});

describe("the search request", () => {
  it("lists what the server answered for the search that is asked", () => {
    const state = after({ type: "asked", ask: PLAN }, { type: "answered", ask: PLAN, offset: 0, results: [result("a"), result("b")], next: 20, indexing: false });
    expect(state).toMatchObject({ status: "listed", ask: PLAN, next: 20, more: "ready", at: 0 });
    expect(ids(state)).toEqual(["a", "b"]);
  });

  it("never lets an answer for an older search replace a newer one, whichever arrives first", () => {
    const late = after(
      { type: "asked", ask: PLAN },
      { type: "asked", ask: PLANS },
      { type: "answered", ask: PLANS, offset: 0, results: [result("new")], next: null, indexing: false },
      { type: "answered", ask: PLAN, offset: 0, results: [result("old")], next: null, indexing: false },
    );
    expect(late).toMatchObject({ status: "listed", ask: PLANS });
    expect(ids(late)).toEqual(["new"]);

    const early = after({ type: "asked", ask: PLAN }, { type: "asked", ask: PLANS }, { type: "answered", ask: PLAN, offset: 0, results: [result("old")], next: null, indexing: false });
    expect(early).toEqual({ status: "searching", ask: PLANS, before: null });
  });

  it("tells a search that includes archived notes from one that doesn't", () => {
    const withArchived = { ...PLAN, includeArchived: true };
    const state = after({ type: "asked", ask: PLAN }, { type: "asked", ask: withArchived }, { type: "answered", ask: PLAN, offset: 0, results: [result("live")], next: null, indexing: false });
    expect(state).toEqual({ status: "searching", ask: withArchived, before: null });
  });

  it("keeps what was listed on show, and nothing selected, while the next search is on its way", () => {
    const state = after({ type: "asked", ask: PLAN }, { type: "answered", ask: PLAN, offset: 0, results: [result("a")], next: null, indexing: false }, { type: "asked", ask: PLANS });
    expect(state.status).toBe("searching");
    expect(state.status === "searching" && state.before?.map((r) => r.note.id)).toEqual(["a"]);
    expect(reduce(state, { type: "moved", by: 1 })).toBe(state);
  });

  it("is idle with nothing typed, and an answer on its way then changes nothing", () => {
    const state = after({ type: "asked", ask: PLAN }, { type: "asked", ask: { query: "", includeArchived: true } }, { type: "answered", ask: PLAN, offset: 0, results: [result("a")], next: null, indexing: false });
    expect(state).toEqual({ status: "idle" });
  });

  it("fails with the reason, and asks again when the same search is asked after that", () => {
    const failed = after({ type: "asked", ask: PLAN }, { type: "refused", ask: PLAN, offset: 0, message: "Common Ink can't be reached." });
    expect(failed).toEqual({ status: "failed", ask: PLAN, message: "Common Ink can't be reached." });
    expect(reduce(failed, { type: "asked", ask: PLAN })).toEqual({ status: "searching", ask: PLAN, before: null });
  });

  it("appends the next page once, and only to the search it was asked for", () => {
    const listed = after({ type: "asked", ask: PLAN }, { type: "answered", ask: PLAN, offset: 0, results: [result("a"), result("b")], next: 2, indexing: false });
    const page: Event = { type: "answered", ask: PLAN, offset: 2, results: [result("b"), result("c")], next: null, indexing: false };
    expect(reduce(listed, page)).toBe(listed);

    const asking = reduce(listed, { type: "moreAsked" });
    expect(asking).toMatchObject({ more: "asking" });
    const more = reduce(asking, page);
    expect(ids(more)).toEqual(["a", "b", "c"]);
    expect(more).toMatchObject({ next: null, more: "ready" });
    expect(reduce(more, page)).toBe(more);
    expect(reduce(more, { type: "moreAsked" })).toBe(more);

    const elsewhere = reduce(reduce(asking, { type: "asked", ask: PLANS }), page);
    expect(elsewhere).toMatchObject({ status: "searching", ask: PLANS });
  });

  it("keeps the results when the next page can't be read, and can ask for it again", () => {
    const refused = after(
      { type: "asked", ask: PLAN },
      { type: "answered", ask: PLAN, offset: 0, results: [result("a")], next: 1, indexing: false },
      { type: "moreAsked" },
      { type: "refused", ask: PLAN, offset: 1, message: "Try again." },
    );
    expect(refused).toMatchObject({ status: "listed", more: { refused: "Try again." }, next: 1 });
    expect(ids(refused)).toEqual(["a"]);
    expect(reduce(refused, { type: "moreAsked" })).toMatchObject({ more: "asking" });
  });

  it("says the results may lack notes while the server is still indexing, and no longer once an answer says it is done", () => {
    const partial = after({ type: "asked", ask: PLAN }, { type: "answered", ask: PLAN, offset: 0, results: [result("a")], next: null, indexing: true });
    expect(partial).toMatchObject({ status: "listed", indexing: true });

    const whole = reduce(partial, { type: "reanswered", ask: PLAN, results: [result("b"), result("a")], next: null, indexing: false });
    expect(whole).toMatchObject({ status: "listed", indexing: false, next: null });
    expect(ids(whole)).toEqual(["b", "a"]);
  });

  it("keeps the selection on its note when the search is answered again, and on the first result when that note is no longer there", () => {
    const partial = after(
      { type: "asked", ask: PLAN },
      { type: "answered", ask: PLAN, offset: 0, results: [result("a"), result("b")], next: null, indexing: true },
      { type: "moved", by: 1 },
    );

    expect(reduce(partial, { type: "reanswered", ask: PLAN, results: [result("c"), result("a"), result("b")], next: null, indexing: true })).toMatchObject({ at: 2, indexing: true });
    expect(reduce(partial, { type: "reanswered", ask: PLAN, results: [result("c"), result("a")], next: null, indexing: false })).toMatchObject({ at: 0 });
  });

  it("never lets a search answered again replace a newer search, or come between a next page and its answer", () => {
    const partial = after({ type: "asked", ask: PLAN }, { type: "answered", ask: PLAN, offset: 0, results: [result("a")], next: 1, indexing: true });
    const again: Event = { type: "reanswered", ask: PLAN, results: [result("old")], next: null, indexing: false };

    const searching = reduce(partial, { type: "asked", ask: PLANS });
    expect(reduce(searching, again)).toBe(searching);
    const newer = reduce(searching, { type: "answered", ask: PLANS, offset: 0, results: [result("new")], next: null, indexing: true });
    expect(reduce(newer, again)).toBe(newer);
    const asking = reduce(partial, { type: "moreAsked" });
    expect(reduce(asking, again)).toBe(asking);
    expect(reduce(IDLE, again)).toBe(IDLE);
  });

  it("keeps the pages read past what was asked again, and takes the next page's word on whether the server is done", () => {
    const pages = after(
      { type: "asked", ask: PLAN },
      { type: "answered", ask: PLAN, offset: 0, results: [result("a"), result("b")], next: 2, indexing: true },
      { type: "moreAsked" },
      { type: "answered", ask: PLAN, offset: 2, results: [result("c"), result("d")], next: 4, indexing: true },
    );
    expect(pages).toMatchObject({ indexing: true });

    const again = reduce(pages, { type: "reanswered", ask: PLAN, results: [result("n"), result("a"), result("b")], next: 3, indexing: true });
    expect(ids(again)).toEqual(["n", "a", "b", "c", "d"]);
    expect(again).toMatchObject({ next: 4, more: "ready" });

    const done = reduce(reduce(again, { type: "moreAsked" }), { type: "answered", ask: PLAN, offset: 4, results: [result("d"), result("e")], next: null, indexing: false });
    expect(ids(done)).toEqual(["n", "a", "b", "c", "d", "e"]);
    expect(done).toMatchObject({ next: null, indexing: false });
  });

  it("asks again for as many results as are listed, a page at least and no more than one answer holds", () => {
    expect([0, 3, 20, 35, 50, 80].map(againLimit)).toEqual([20, 20, 20, 35, 50, 50]);
  });

  it("moves the selection through the results and around the ends, and to the one pointed at", () => {
    const listed = after({ type: "asked", ask: PLAN }, { type: "answered", ask: PLAN, offset: 0, results: [result("a"), result("b"), result("c")], next: null, indexing: false });
    const at = (state: Search) => (state.status === "listed" ? state.at : null);
    expect(at(reduce(listed, { type: "moved", by: 1 }))).toBe(1);
    expect(at(reduce(listed, { type: "moved", by: -1 }))).toBe(2);
    expect(at(reduce(reduce(listed, { type: "moved", by: -1 }), { type: "moved", by: 1 }))).toBe(0);
    expect(at(reduce(listed, { type: "pointed", at: 2 }))).toBe(2);
    expect(reduce(listed, { type: "pointed", at: 3 })).toBe(listed);
  });
});

describe("a search's address", () => {
  it("carries what was typed and whether archived notes are included, and reads back the same", () => {
    expect(addressOf({ query: '"call the bank" #money +Home', includeArchived: false })).toBe("/search?q=%22call+the+bank%22+%23money+%2BHome");
    expect(askOf("?q=%22call+the+bank%22+%23money+%2BHome")).toEqual({ query: '"call the bank" #money +Home', includeArchived: false });
    expect(addressOf({ query: " plan ", includeArchived: true })).toBe("/search?q=plan&archived=1");
    expect(askOf("?q=plan&archived=1")).toEqual({ query: "plan", includeArchived: true });
  });

  it("is the page's own with nothing typed", () => {
    expect(addressOf({ query: "  ", includeArchived: false })).toBe("/search");
    expect(askOf("")).toEqual({ query: "", includeArchived: false });
    expect(askOf("?archived=1")).toEqual({ query: "", includeArchived: true });
  });

  it("cuts a query longer than a search may be", () => {
    expect(askOf(`?q=${"a".repeat(500)}`).query).toBe("a".repeat(200));
  });
});
