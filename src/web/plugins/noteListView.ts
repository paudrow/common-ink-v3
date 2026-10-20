import { ALL_NOTES, SHARED_WITH_ME, parseQuery, printQuery, queryNames, type NoteSummary, type QueryNode, type SortKey } from "../plugin-api.ts";

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

/** The three ways a folder's list is asked for notes, written into the search bar so the choice is visible. */
export const LIVES = [
  { id: "active", label: "Active", show: "open", clause: "is:open" },
  { id: "archived", label: "Archived", show: "archived", clause: "is:archived" },
  { id: "all", label: "All", show: "all", clause: "(is:open OR is:archived)" },
] as const;

export type Life = (typeof LIVES)[number]["id"];

const STATE_WORDS = new Set(["open", "archived", "trashed"]);

/** A query with every filter `drop` names taken out, so a new choice replaces the last. */
function without(node: QueryNode | null, drop: (filter: Extract<QueryNode, { kind: "filter" }>) => boolean): QueryNode | null {
  if (!node) return null;
  if (node.kind === "text") return node;
  if (node.kind === "filter") return drop(node) ? null : node;
  if (node.kind === "not") {
    const of = without(node.of, drop);
    return of ? { kind: "not", of } : null;
  }
  const of = node.of.flatMap((child) => {
    const next = without(child, drop);
    return next ? [next] : [];
  });
  if (of.length === 0) return null;
  if (of.length === 1) return of[0]!;
  return { kind: node.kind, of };
}

/** A query with every `is:open`, `is:archived` and `is:trashed` taken out. */
const withoutState = (node: QueryNode | null) => without(node, (f) => f.key === "is" && STATE_WORDS.has(f.value));

/**
 * The search bar with one choice of notes written into it. What was already asked for stays, and an
 * earlier choice of active, archived or all notes is replaced. A query that can't be read becomes the choice alone.
 */
export function withLife(text: string, life: Life): string {
  const clause = LIVES.find((item) => item.id === life)!.clause;
  const read = parseQuery(text, "notes");
  if (!read.ok) return clause;
  const rest = printQuery({ ...read.query, where: withoutState(read.query.where) });
  return rest ? `${rest} ${clause}` : clause;
}

/** Which choice the search bar is showing. With none written, the list is active notes. */
export function lifeOf(text: string): Life {
  const read = parseQuery(text, "notes");
  if (!read.ok || !read.query.where) return "active";
  const open = queryNames(read.query.where, "open");
  const archived = queryNames(read.query.where, "archived");
  if (open && archived) return "all";
  if (archived) return "archived";
  return "active";
}

/** The choice of notes by their todos, written into the search bar beside the choice of which notes. */
export const TODO_CHOICES = [
  { id: "any", label: "Any", clause: "" },
  { id: "open", label: "Open todos", clause: "has:open-todo" },
  { id: "done", label: "All done", clause: "has:todo no:open-todo" },
] as const;

export type TodoChoice = (typeof TODO_CHOICES)[number]["id"];

const TODO_WORDS = new Set(["todo", "open-todo"]);

/** The search bar with one choice of todos written into it, in place of the one already there. A query that can't be read becomes the choice alone. */
export function withTodos(text: string, choice: TodoChoice): string {
  const clause = TODO_CHOICES.find((item) => item.id === choice)!.clause;
  const read = parseQuery(text, "notes");
  if (!read.ok) return clause;
  const rest = printQuery({ ...read.query, where: without(read.query.where, (f) => f.key === "has" && TODO_WORDS.has(f.value)) });
  return [rest, clause].filter(Boolean).join(" ");
}

/** Which choice of todos the search bar is showing: one only when the bar asks for it among everything else it asks, not inside an OR. */
export function todosOf(text: string): TodoChoice {
  const read = parseQuery(text, "notes");
  const where = read.ok ? read.query.where : null;
  const all = !where ? [] : where.kind === "and" ? where.of : [where];
  const asks = (value: string) => all.some((n) => n.kind === "filter" && n.key === "has" && n.value === value);
  const refuses = (value: string) => all.some((n) => n.kind === "not" && n.of.kind === "filter" && n.of.key === "has" && n.of.value === value);
  if (asks("open-todo")) return "open";
  if (asks("todo") && refuses("open-todo")) return "done";
  return "any";
}

/** What the list itself is of, for the same choice the search bar shows. */
export const showOf = (life: Life): Show => LIVES.find((item) => item.id === life)!.show;

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
