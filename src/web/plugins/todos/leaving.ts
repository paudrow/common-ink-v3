import { PRIORITIES, nameKey, parseQuery, tagsOn, type ListedTodo } from "../../plugin-api.ts";
import { DUE_FILTERS, dueLabel, dueRange, type DueFilter } from "./dates.ts";
import { PRIORITY } from "./picking.ts";
import { conjuncts } from "./tagged.ts";

/** What the Todos page is narrowed to, as a changed row is checked against it. */
export interface Narrowing {
  completed: boolean;
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
export type Reason = "done" | "date" | "priority" | "tag" | "folder" | "search";

const REFRESH = "It leaves when you refresh.";

/** "Moved to tomorrow", "Moved to Friday", "Moved to Oct 20". */
const movedTo = (due: string, now: string) => {
  const label = dueLabel(due, now);
  return `Moved to ${/^(Today|Tomorrow|Yesterday)$/.test(label) ? label.toLowerCase() : label}`;
};

/**
 * Which way the list is narrowed that a row, as the member's change left it, no longer matches, and
 * the sentence said under the row: what changed, why it leaves, and when. The first of done, date,
 * priority, tag and folder that it fails, and else the search. Null when nothing says why.
 */
export function leaving(todo: Pick<ListedTodo, "done" | "due" | "importance" | "words">, by: Narrowing, now: string): { reason: Reason; says: string } | null {
  const say = (reason: Reason, what: string) => ({ reason, says: `${what} ${REFRESH}` });
  if (todo.done && !by.completed) return say("done", "Checked off, so it no longer shows with the open todos.");
  const { dueFrom, dueTo, noDue } = dueRange(by.due, now);
  const inRange = noDue ? todo.due === null : todo.due !== null ? (!dueFrom || todo.due >= dueFrom) && (!dueTo || todo.due <= dueTo) : !dueFrom && !dueTo;
  if (!inRange) return say("date", `${todo.due ? movedTo(todo.due, now) : "Its date was taken off"}, so it no longer shows under ${DUE_FILTERS[by.due]}.`);
  if (by.importance !== "" && Number(by.importance) !== todo.importance) {
    return say("priority", `${todo.importance ? `Set to ${PRIORITY[todo.importance]}` : "Its priority was taken off"}, so it no longer shows under Priority: ${PRIORITY[Number(by.importance)]}.`);
  }
  if (by.tag && !tagsOn(todo.words).some((tag) => nameKey(tag.name) === nameKey(by.tag))) return say("tag", `#${by.tag} was taken off, so it no longer shows under #${by.tag}.`);
  if (by.folder && !by.folder.holds) return say("folder", `Its note is no longer in ${by.folder.name}, so it no longer shows there.`);
  if (by.search) return say("search", `Changed, so it no longer matches “${by.search}”.`);
  return null;
}

/**
 * What a todos query narrows the list to, as the sentences under a changed row read it: its terms at the
 * top that say a due date as a filter of its own did (`due:today`, `due:<today`, `due:today..+6d`,
 * `no:due`), a priority (`priority:high`) and a tag (`#health`), and the whole query as the search for
 * anything else. A todo checked off is said of by the Task completed notice, not here.
 */
export function narrowingOf(text: string): Narrowing {
  const by: Narrowing = { completed: true, due: "any", importance: "", tag: "", folder: null, search: text.trim() };
  const read = parseQuery(text, "todos");
  if (!read.ok) return by;
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
