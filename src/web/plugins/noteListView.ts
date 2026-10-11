import { ALL_NOTES, SHARED_WITH_ME, type NoteSummary } from "../plugin-api.ts";

export const titleOf = (note: NoteSummary) => note.title || "Untitled";

export const SORTS = [
  { id: "recent", label: "Recent", compare: (a: NoteSummary, b: NoteSummary) => b.updatedAt - a.updatedAt },
  { id: "created", label: "Created", compare: (a: NoteSummary, b: NoteSummary) => b.createdAt - a.createdAt },
  { id: "title", label: "Title", compare: (a: NoteSummary, b: NoteSummary) => titleOf(a).localeCompare(titleOf(b)) },
] as const;

export type Sort = (typeof SORTS)[number]["id"];

/** How much of an expanded card's note is shown: its first part, fading out, or all of it. A card that isn't here is collapsed. */
export type Expanded = "excerpt" | "whole";

/** Which of a folder's notes a list is of, by where each is in its life. A note in Trash is in none of them. */
export const SHOWS = [
  { id: "open", label: "Open", includeArchived: false },
  { id: "archived", label: "Archived", includeArchived: "only" },
  { id: "all", label: "All", includeArchived: true },
] as const;

export type Show = (typeof SHOWS)[number]["id"];

/** What a listing or a search is asked for a choice of {@link Show}, as the operations take it. */
export const includeArchivedOf = (show: Show) => SHOWS.find((s) => s.id === show)!.includeArchived;

const shows = (show: Show, note: NoteSummary) => (show === "all" ? note.state !== "trashed" : note.state === (show === "open" ? "live" : "archived"));

/**
 * How a member has one folder's list set, which is kept while the app is open so coming back to its
 * tab finds it as it was. `query` is what is searched for, and with none the list is the folder's
 * notes. `sort` is null until the member picks an order: a list is then by the last change, and a
 * search by the best match.
 */
export interface ListView {
  query: string;
  show: Show;
  sort: Sort | null;
  hasTodos: boolean;
  expanded: Readonly<Record<string, Expanded>>;
}

export const INITIAL_VIEW: ListView = { query: "", show: "open", sort: null, hasTodos: false, expanded: {} };

export type ListAction =
  | { type: "query"; text: string }
  | { type: "show"; show: Show }
  | { type: "sort"; sort: Sort | null }
  | { type: "hasTodos" }
  /** Expands a collapsed card to its excerpt, and collapses an expanded one. */
  | { type: "expandOrCollapse"; noteId: string }
  | { type: "collapse"; noteId: string }
  /** Shows the whole note in an expanded card, or goes back to its excerpt. It does nothing to a collapsed card. */
  | { type: "wholeOrExcerpt"; noteId: string };

const without = (expanded: ListView["expanded"], noteId: string) => Object.fromEntries(Object.entries(expanded).filter(([id]) => id !== noteId));

export function listReducer(view: ListView, action: ListAction): ListView {
  switch (action.type) {
    case "query":
      return action.text === view.query ? view : { ...view, query: action.text };
    case "show":
      return { ...view, show: action.show };
    case "sort":
      return { ...view, sort: action.sort };
    case "hasTodos":
      return { ...view, hasTodos: !view.hasTodos };
    case "expandOrCollapse":
      return { ...view, expanded: view.expanded[action.noteId] ? without(view.expanded, action.noteId) : { ...view.expanded, [action.noteId]: "excerpt" } };
    case "collapse":
      return view.expanded[action.noteId] ? { ...view, expanded: without(view.expanded, action.noteId) } : view;
    case "wholeOrExcerpt": {
      const now = view.expanded[action.noteId];
      return now ? { ...view, expanded: { ...view.expanded, [action.noteId]: now === "whole" ? "excerpt" : "whole" } } : view;
    }
  }
}

/** The notes a folder's list is of, out of every note the member can see: the folder's own, not those of the folders inside it. */
export const notesIn = (notes: readonly NoteSummary[], folderId: string) =>
  folderId === ALL_NOTES ? notes : notes.filter((n) => n.folderId === (folderId === SHARED_WITH_ME ? null : folderId));

/** Whether a note belongs in a list set to `view`, whatever is searched for: by its state, and by its open todos. */
export const fits = (view: Pick<ListView, "show" | "hasTodos">, note: NoteSummary) => shows(view.show, note) && (!view.hasTodos || note.openTodos > 0);

/** The folder's notes as the list is set when nothing is searched for: never one in Trash, narrowed and in order. */
export function listed(inFolder: readonly NoteSummary[], view: Pick<ListView, "show" | "hasTodos" | "sort">): NoteSummary[] {
  return inFolder.filter((n) => fits(view, n)).sort(SORTS.find((s) => s.id === (view.sort ?? "recent"))!.compare);
}
