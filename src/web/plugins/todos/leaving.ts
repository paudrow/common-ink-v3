import { PRIORITIES, TODO_STATES, nameKey, parseQuery, tagsOn, type ListedTodo, type QueryNode, type TodoState } from "../../plugin-api.ts";
import { DUE_FILTERS, dueLabel, dueRange, type DueFilter } from "./dates.ts";
import { PRIORITY } from "./picking.ts";
import { conjuncts } from "./tagged.ts";

/** What the Todos page is narrowed to, as a changed row is checked against it. */
export interface Narrowing {
  /** The states of the todos the list has, in the order the boxes are listed, or null when the query says them in a way this doesn't read. */
  states: readonly TodoState[] | null;
  due: DueFilter;
  /** A level, "0" to "3", or "" for any. */
  importance: string;
  tag: string;
  /** The folder narrowed to, by its name, and whether the row's note is in it or under it; null when the list isn't narrowed to one. */
  folder: { name: string; holds: boolean } | null;
  /** What a search narrows to, where the page has one. */
  search?: string;
}

/** Why a changed row will leave the list, one for each way the list is narrowed. */
export type Reason = "state" | "date" | "priority" | "tag" | "folder" | "search";

const REFRESH = "It leaves when you refresh.";

/** What was done to a todo to put it in each state, as the sentence under its row begins. */
const PUT: Record<TodoState, string> = { open: "Opened again", done: "Checked off", abandoned: "Abandoned", backlog: "Moved to the backlog" };

/** The todos a list of one state has, as the sentence names them. */
const LISTED: Record<TodoState, string> = { open: "the open todos", done: "the done todos", abandoned: "the abandoned todos", backlog: "the backlog" };

/** "Moved to tomorrow", "Moved to Friday", "Moved to Oct 20". */
const movedTo = (due: string, now: string) => {
  const label = dueLabel(due, now);
  return `Moved to ${/^(Today|Tomorrow|Yesterday)$/.test(label) ? label.toLowerCase() : label}`;
};

/**
 * Which way the list is narrowed that a row, as the member's change left it, no longer matches, and
 * the sentence said under the row: what changed, why it leaves, and when. The first of state, date,
 * priority, tag and folder that it fails, and else the search. Null when nothing says why.
 */
export function leaving(todo: Pick<ListedTodo, "state" | "due" | "importance" | "words" | "tagsElsewhere">, by: Narrowing, now: string): { reason: Reason; says: string } | null {
  const say = (reason: Reason, what: string) => ({ reason, says: `${what} ${REFRESH}` });
  if (by.states && !by.states.includes(todo.state)) return say("state", `${PUT[todo.state]}, so it no longer shows ${by.states.length === 1 ? `with ${LISTED[by.states[0]!]}` : "in this list"}.`);
  const { dueFrom, dueTo, noDue } = dueRange(by.due, now);
  const inRange = noDue ? todo.due === null : todo.due !== null ? (!dueFrom || todo.due >= dueFrom) && (!dueTo || todo.due <= dueTo) : !dueFrom && !dueTo;
  if (!inRange) return say("date", `${todo.due ? movedTo(todo.due, now) : "Its date was taken off"}, so it no longer shows under ${DUE_FILTERS[by.due]}.`);
  if (by.importance !== "" && Number(by.importance) !== todo.importance) {
    return say("priority", `${todo.importance ? `Set to ${PRIORITY[todo.importance]}` : "Its priority was taken off"}, so it no longer shows under Priority: ${PRIORITY[Number(by.importance)]}.`);
  }
  const tagged = tagsOn(todo.words).some((tag) => nameKey(tag.name) === nameKey(by.tag)) || todo.tagsElsewhere.some((name) => nameKey(name) === nameKey(by.tag));
  if (by.tag && !tagged) return say("tag", `#${by.tag} was taken off, so it no longer shows under #${by.tag}.`);
  if (by.folder && !by.folder.holds) return say("folder", `Its note is no longer in ${by.folder.name}, so it no longer shows there.`);
  if (by.search) return say("search", `Changed, so it no longer matches “${by.search}”.`);
  return null;
}

/** The state `is:` says, when a node is that filter. */
const stateIs = (node: QueryNode): TodoState | null => (node.kind === "filter" && node.key === "is" && (TODO_STATES as readonly string[]).includes(node.value) ? (node.value as TodoState) : null);

/**
 * The states of the todos a query lists, read from its terms at the top: an open todo when it names no
 * state, as the server lists them; else every state each term allows, `is:backlog`, `is:open OR is:done`
 * or `-is:done`. Null when a state is named anywhere else, as under a NOT of more than it or an OR with
 * other words, where which states it lists depends on more than the states.
 */
export function statesOf(where: QueryNode | null): readonly TodoState[] | null {
  const terms = conjuncts(where);
  const named = (node: QueryNode): boolean => stateIs(node) !== null || ((node.kind === "and" || node.kind === "or") && node.of.some(named)) || (node.kind === "not" && named(node.of));
  if (!terms.some(named)) return ["open"];
  let states: readonly TodoState[] = TODO_STATES;
  for (const term of terms) {
    if (!named(term)) continue;
    const either = term.kind === "or" ? term.of.map(stateIs) : [stateIs(term)];
    const not = term.kind === "not" ? stateIs(term.of) : null;
    if (not) states = states.filter((state) => state !== not);
    else if (either.every((state) => state !== null)) states = states.filter((state) => either.includes(state));
    else return null;
  }
  return states;
}

/**
 * What a todos query narrows the list to, as the sentences under a changed row read it: the states it
 * lists, its terms at the top that say a due date as a filter of its own did (`due:today`, `due:<today`,
 * `due:today..+6d`, `no:due`), a priority (`priority:high`) and a tag (`#health`), and the whole query as
 * the search for anything else.
 */
export function narrowingOf(text: string): Narrowing {
  const by: Narrowing = { states: ["open"], due: "any", importance: "", tag: "", folder: null, search: text.trim() };
  const read = parseQuery(text, "todos");
  if (!read.ok) return by;
  by.states = statesOf(read.query.where);
  for (const node of conjuncts(read.query.where)) {
    if (node.kind === "not" && node.of.kind === "filter" && node.of.key === "has" && node.of.value === "due") by.due = "none";
    if (node.kind !== "filter") continue;
    if (node.key === "due" && node.value === "today") {
      const due = node.cmp === "<" ? "overdue" : node.cmp !== "=" ? null : node.to === undefined ? "today" : node.to === "+6d" ? "week" : null;
      if (due) by.due = due;
    }
    if (node.key === "priority" && node.cmp === "=") by.importance = String(PRIORITIES.indexOf(node.value as (typeof PRIORITIES)[number]));
    if (node.key === "tag" && node.cmp === "=" && !by.tag) by.tag = node.value;
  }
  return by;
}
