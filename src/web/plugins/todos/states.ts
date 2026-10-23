import { TODO_STATES, parseQuery, printQuery, queryNames, type QueryNode, type TodoState } from "../../plugin-api.ts";
import { without } from "../lib/queryTerms.ts";
import { conjuncts } from "./tagged.ts";

/** The choices of todos by their state under the Todos page's bar, each the states its `is:` names. A query that names none lists the open ones. */
export const STATE_CHOICES = [
  { id: "open", label: "Open", states: ["open"] },
  { id: "backlog", label: "Backlog", states: ["backlog"] },
  { id: "done", label: "Done", states: ["done"] },
  { id: "abandoned", label: "Abandoned", states: ["abandoned"] },
  { id: "all", label: "All", states: ["open", "backlog", "done", "abandoned"] },
] as const satisfies readonly { id: string; label: string; states: readonly TodoState[] }[];

export type StateChoice = (typeof STATE_CHOICES)[number]["id"];

const isState = (node: QueryNode): node is Extract<QueryNode, { kind: "filter" }> => node.kind === "filter" && node.key === "is" && (TODO_STATES as readonly string[]).includes(node.value);

const clauseOf = (states: readonly string[]) => (states.length === 1 ? `is:${states[0]}` : `(${states.map((state) => `is:${state}`).join(" OR ")})`);

const STATE_WORD = `is:(?:${TODO_STATES.join("|")})`;
/** A state, or states joined by OR in brackets, as they are typed. */
const TYPED_STATES = new RegExp(`(^|\\s)(?:${STATE_WORD}|\\(\\s*${STATE_WORD}(?:\\s+OR\\s+${STATE_WORD})*\\s*\\))(?=\\s|$)`, "giu");

/**
 * The bar with one choice of states written at its end, in place of every state it named, and asked
 * for beside everything else the bar asks. What was typed is kept as typed where that reads as the
 * same query, and is otherwise written the one way the query is printed. A bar that can't be read
 * keeps what was typed, as the order and the tags' chips keep it.
 */
export function withState(text: string, choice: StateChoice): string {
  const clause = clauseOf(STATE_CHOICES.find((item) => item.id === choice)!.states);
  const typed = text.trim();
  const cut = typed.replace(TYPED_STATES, " ").replace(/\s+/g, " ").trim();
  const added = cut ? `${cut} ${clause}` : clause;
  const read = parseQuery(typed, "todos");
  const state = parseQuery(clause, "todos");
  if (!read.ok || !state.ok) return added;
  const rest = conjuncts(without(read.query.where, isState));
  const wanted = printQuery({ ...read.query, where: rest.length ? { kind: "and", of: [...rest, state.query.where!] } : state.query.where });
  const again = parseQuery(added, "todos");
  return again.ok && printQuery(again.query) === wanted ? added : wanted;
}

/** The states a term asks for, when it asks for nothing else: `is:done`, or states joined by OR. */
function statesIn(node: QueryNode): Set<string> | null {
  if (isState(node)) return new Set([node.value]);
  if (node.kind !== "or" || !node.of.every(isState)) return null;
  return new Set(node.of.map((term) => (term as Extract<QueryNode, { kind: "filter" }>).value));
}

/**
 * Which choice the bar shows: the one whose states one term of the bar asks for, beside everything else
 * it asks. With no state named, the open ones. Null when the states are named some other way, inside a
 * NOT or across terms, or are no choice's, or the bar can't be read.
 */
export function stateOf(text: string): StateChoice | null {
  const read = parseQuery(text, "todos");
  if (!read.ok) return null;
  const naming = conjuncts(read.query.where).filter((term) => TODO_STATES.some((state) => queryNames(term, state)));
  if (naming.length === 0) return "open";
  const asked = naming.length === 1 ? statesIn(naming[0]!) : null;
  return STATE_CHOICES.find((choice) => asked !== null && choice.states.length === asked.size && choice.states.every((state) => asked.has(state)))?.id ?? null;
}
