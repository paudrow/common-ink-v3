import { MAX_SEARCH_LENGTH, type SearchResult } from "../../plugin-api.ts";

/** The results in one answer when no number is asked for, and the most that can be. They are the server's own (`search` in the protocol). */
const SEARCH_PAGE = 20;
const MAX_SEARCH_RESULTS = 50;

/** What one search asks for. Two asks that read the same are the same search, and one with nothing typed is no search. */
export interface Ask {
  query: string;
  includeArchived: boolean;
}

/** What "More results" is doing: nothing, asking for the next page, or the reason it couldn't be read. */
export type More = "ready" | "asking" | { refused: string };

/**
 * The Search page at one moment. It is in exactly one of these, so results are never shown beside a
 * failure, and never under a query they weren't found for without saying so: while an answer is on
 * its way, `before` is what was listed for the search before it, kept on show until then.
 * `indexing` is the server saying it hasn't read every note yet, so the results may lack some: the
 * search is then asked again from the start, after a pause, until it says otherwise.
 */
export type Search =
  | { status: "idle" }
  | { status: "searching"; ask: Ask; before: readonly SearchResult[] | null }
  | { status: "listed"; ask: Ask; results: readonly SearchResult[]; next: number | null; more: More; at: number; indexing: boolean }
  | { status: "failed"; ask: Ask; message: string };

export type Event =
  /** The member's search is now this one. */
  | { type: "asked"; ask: Ask }
  | { type: "moreAsked" }
  /** The server answered `ask` from `offset` on. */
  | { type: "answered"; ask: Ask; offset: number; results: readonly SearchResult[]; next: number | null; indexing: boolean }
  /** The server answered `ask` from the start again, asked because its last answer may have lacked notes. */
  | { type: "reanswered"; ask: Ask; results: readonly SearchResult[]; next: number | null; indexing: boolean }
  | { type: "refused"; ask: Ask; offset: number; message: string }
  /** The selection moved by a result, around the ends. */
  | { type: "moved"; by: 1 | -1 }
  | { type: "pointed"; at: number };

export const IDLE: Search = { status: "idle" };

const same = (a: Ask, b: Ask) => a.query === b.query && a.includeArchived === b.includeArchived;

/** Whether an answer for `ask` from `offset` is the one the page is waiting for. Any other is for a search the member has left, and changes nothing. */
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
      if (state.status !== "listed") return { status: "listed", ask: event.ask, results: event.results, next: event.next, more: "ready", at: 0, indexing: event.indexing };
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
      const selected = state.results[state.at]?.note.id;
      return { ...state, results, next: past ? state.next : event.next, at: Math.max(0, results.findIndex((r) => r.note.id === selected)), indexing: event.indexing };
    }
    case "refused":
      if (!awaited(state, event.ask, event.offset)) return state;
      return state.status === "listed" ? { ...state, more: { refused: event.message } } : { status: "failed", ask: event.ask, message: event.message };
    case "moved": {
      if (state.status !== "listed" || !state.results.length) return state;
      const count = state.results.length;
      return { ...state, at: (state.at + event.by + count) % count };
    }
    case "pointed":
      return state.status === "listed" && event.at >= 0 && event.at < state.results.length && event.at !== state.at ? { ...state, at: event.at } : state;
  }
}

/** How many results a search asked again from the start asks for, to cover what is listed: a page at least, and no more than one answer may hold. */
export const againLimit = (listed: number) => Math.min(MAX_SEARCH_RESULTS, Math.max(SEARCH_PAGE, listed));

export const SEARCH_PATH = "/search";

/** The search an address's query names: `?q=` what was typed, and `archived=1` to include archived notes. */
export function askOf(query: string): Ask {
  const params = new URLSearchParams(query);
  return { query: (params.get("q") ?? "").trim().slice(0, MAX_SEARCH_LENGTH), includeArchived: params.get("archived") === "1" };
}

/** The address of a search, which `askOf` reads back. */
export function addressOf({ query, includeArchived }: Ask): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (includeArchived) params.set("archived", "1");
  const written = params.toString();
  return written ? `${SEARCH_PATH}?${written}` : SEARCH_PATH;
}
