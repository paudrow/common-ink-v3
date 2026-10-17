import { ALL_NOTES, SHARED_WITH_ME, type NoteSummary, type SortKey } from "../plugin-api.ts";

export const titleOf = (note: NoteSummary) => note.title || "Untitled";

export const SORTS = [
  { id: "recent", label: "Recent", compare: (a: NoteSummary, b: NoteSummary) => b.updatedAt - a.updatedAt },
  { id: "created", label: "Created", compare: (a: NoteSummary, b: NoteSummary) => b.createdAt - a.createdAt },
  { id: "title", label: "Title", compare: (a: NoteSummary, b: NoteSummary) => titleOf(a).localeCompare(titleOf(b)) },
] as const;

export type Sort = (typeof SORTS)[number]["id"];

/** The orders a query's `sort:` asks for, for a list of notes the app already holds. */
export const ORDERS: Partial<Record<SortKey, (a: NoteSummary, b: NoteSummary) => number>> = {
  "updated-desc": (a, b) => b.updatedAt - a.updatedAt,
  "updated-asc": (a, b) => a.updatedAt - b.updatedAt,
  "created-desc": (a, b) => b.createdAt - a.createdAt,
  "created-asc": (a, b) => a.createdAt - b.createdAt,
  "title-asc": (a, b) => titleOf(a).localeCompare(titleOf(b)),
  "title-desc": (a, b) => titleOf(b).localeCompare(titleOf(a)),
};

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
  /** The cards grown to the whole of their notes. Every other card shows its note's first part. */
  whole: Readonly<Record<string, true>>;
}

export const INITIAL_VIEW: ListView = { query: "", show: "open", sort: null, hasTodos: false, whole: {} };

export type ListAction =
  | { type: "query"; text: string }
  | { type: "show"; show: Show }
  | { type: "sort"; sort: Sort | null }
  | { type: "hasTodos" }
  /** Grows a card to the whole of its note, or cuts it back to the first part. */
  | { type: "wholeOrLess"; noteId: string };

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
    case "wholeOrLess": {
      const { [action.noteId]: was, ...rest } = view.whole;
      return { ...view, whole: was ? rest : { ...rest, [action.noteId]: true } };
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
