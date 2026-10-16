import { MAX_SEARCH_LENGTH, type OpInput, type SearchResult } from "../../plugin-api.ts";

/** The results in one answer when no number is asked for, and the most that can be. They are the server's own (`search` in the protocol). */
const SEARCH_PAGE = 20;
const MAX_SEARCH_RESULTS = 50;

/**
 * What one search asks for, as the `search` operation takes it. Two asks that read the same are the
 * same search, and one with nothing typed is no search. `folderId` is left out to search every folder.
 */
export type Ask = Required<Pick<Extract<OpInput, { type: "search" }>, "query" | "includeArchived" | "hasTodos" | "sort">> & { folderId?: string };

/** What "More results" is doing: nothing, asking for the next page, or the reason it couldn't be read. */
export type More = "ready" | "asking" | { refused: string };

/**
 * A search at one moment. It is in exactly one of these, so results are never shown beside a
 * failure, and never under a query they weren't found for without saying so: while an answer is on
 * its way, `before` is what was listed for the search before it, kept on show until then.
 * `indexing` is the server saying it hasn't read every note yet, so the results may lack some: the
 * search is then asked again from the start, after a pause, until it says otherwise.
 */
export type Search =
  | { status: "idle" }
  | { status: "searching"; ask: Ask; before: readonly SearchResult[] | null }
  | { status: "listed"; ask: Ask; results: readonly SearchResult[]; next: number | null; more: More; indexing: boolean }
  | { status: "failed"; ask: Ask; message: string };

export type Event =
  /** The member's search is now this one. */
  | { type: "asked"; ask: Ask }
  | { type: "moreAsked" }
  /** The server answered `ask` from `offset` on. */
  | { type: "answered"; ask: Ask; offset: number; results: readonly SearchResult[]; next: number | null; indexing: boolean }
  /** The server answered `ask` from the start again, asked because its last answer may have lacked notes. */
  | { type: "reanswered"; ask: Ask; results: readonly SearchResult[]; next: number | null; indexing: boolean }
  | { type: "refused"; ask: Ask; offset: number; message: string };

export const IDLE: Search = { status: "idle" };

export const same = (a: Ask, b: Ask) => a.query === b.query && a.folderId === b.folderId && a.includeArchived === b.includeArchived && a.hasTodos === b.hasTodos && a.sort === b.sort;

/** Whether an answer for `ask` from `offset` is the one the list is waiting for. Any other is for a search the member has left, and changes nothing. */
function awaited(state: Search, ask: Ask, offset: number): boolean {
  if (state.status === "searching") return offset === 0 && same(state.ask, ask);
  return state.status === "listed" && state.more === "asking" && state.next === offset && same(state.ask, ask);
}

export function reduce(state: Search, event: Event): Search {
  switch (event.type) {
    case "asked": {
      if (!event.ask.query) return IDLE;
      if ((state.status === "searching" || state.status === "listed") && same(state.ask, event.ask)) return state;
      const before = state.status === "listed" ? state.results : state.status === "searching" ? state.before : null;
      return { status: "searching", ask: event.ask, before };
    }
    case "moreAsked":
      return state.status === "listed" && state.next !== null && state.more !== "asking" ? { ...state, more: "asking" } : state;
    case "answered": {
      if (!awaited(state, event.ask, event.offset)) return state;
      if (state.status !== "listed") return { status: "listed", ask: event.ask, results: event.results, next: event.next, more: "ready", indexing: event.indexing };
      // A note that changed between the two pages can be on both.
      const had = new Set(state.results.map((r) => r.note.id));
      return { ...state, results: [...state.results, ...event.results.filter((r) => !had.has(r.note.id))], next: event.next, more: "ready", indexing: event.indexing };
    }
    case "reanswered": {
      if (state.status !== "listed" || state.more === "asking" || !same(state.ask, event.ask)) return state;
      const got = new Set(event.results.map((r) => r.note.id));
      // Pages the member read past what was asked again stay listed, after it.
      const past = event.next !== null && state.results.length > event.results.length;
      const results = past ? [...event.results, ...state.results.filter((r) => !got.has(r.note.id))] : event.results;
      return { ...state, results, next: past ? state.next : event.next, indexing: event.indexing };
    }
    case "refused":
      if (!awaited(state, event.ask, event.offset)) return state;
      return state.status === "listed" ? { ...state, more: { refused: event.message } } : { status: "failed", ask: event.ask, message: event.message };
  }
}

/** How many results a search asked again from the start asks for, to cover what is listed: a page at least, and no more than one answer may hold. */
export const againLimit = (listed: number) => Math.min(MAX_SEARCH_RESULTS, Math.max(SEARCH_PAGE, listed));

/** What is searched for, as the server takes it: without the spaces around it, and no longer than a search may be. */
export const queryOf = (typed: string) => typed.trim().slice(0, MAX_SEARCH_LENGTH);

export const SEARCH_PATH = "/search";

/**
 * The query an address names with `?q=`. It is the whole of the Search page's list: which notes
 * (`is:archived`), whether they have todos (`has:todo`) and the order (`sort:`) are said in it.
 */
export const queryIn = (address: string) => queryOf(new URLSearchParams(address).get("q") ?? "");

/** The address of a search, which `queryIn` reads back. */
export function addressOf(query: string): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  const written = params.toString();
  return written ? `${SEARCH_PATH}?${written}` : SEARCH_PATH;
}
