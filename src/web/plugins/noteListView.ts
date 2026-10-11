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

/** How a member has one folder's list set, which is kept while the app is open so coming back to its tab finds it as it was. */
export interface ListView {
  filter: string;
  sort: Sort;
  hasTodos: boolean;
  expanded: Readonly<Record<string, Expanded>>;
}

export const INITIAL_VIEW: ListView = { filter: "", sort: "recent", hasTodos: false, expanded: {} };

export type ListAction =
  | { type: "filter"; text: string }
  | { type: "sort"; sort: Sort }
  | { type: "toggle"; option: "hasTodos" }
  /** Expands a collapsed card to its excerpt, and collapses an expanded one. */
  | { type: "expandOrCollapse"; noteId: string }
  | { type: "collapse"; noteId: string }
  /** Shows the whole note in an expanded card, or goes back to its excerpt. It does nothing to a collapsed card. */
  | { type: "wholeOrExcerpt"; noteId: string };

const without = (expanded: ListView["expanded"], noteId: string) => Object.fromEntries(Object.entries(expanded).filter(([id]) => id !== noteId));

export function listReducer(view: ListView, action: ListAction): ListView {
  switch (action.type) {
    case "filter":
      return { ...view, filter: action.text };
    case "sort":
      return { ...view, sort: action.sort };
    case "toggle":
      return { ...view, [action.option]: !view[action.option] };
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

/** The folder's notes as the list is set: narrowed and in order. */
export function listed(inFolder: readonly NoteSummary[], view: ListView): NoteSummary[] {
  const needle = view.filter.trim().toLowerCase();
  return inFolder
    .filter((n) => (!view.hasTodos || n.openTodos > 0) && (!needle || `${titleOf(n)}\n${n.snippet}`.toLowerCase().includes(needle)))
    .sort(SORTS.find((s) => s.id === view.sort)!.compare);
}
