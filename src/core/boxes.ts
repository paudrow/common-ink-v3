/**
 * A todo's box and the state each mark in it says. Everything that reads or writes a box, the
 * parser, the index, the query language and the editor, goes through this table.
 */

/** What a todo's box says of it: still to do, done, abandoned (won't be done), or put off in the backlog. */
export type TodoState = "open" | "done" | "abandoned" | "backlog";

/** Each mark a todo's box can hold and the state it says. A state is written with the first of its marks. */
const BOXES: readonly (readonly [mark: string, state: TodoState])[] = [
  [" ", "open"],
  ["x", "done"],
  ["X", "done"],
  ["-", "abandoned"],
  [">", "backlog"],
];

/** Every state a todo can be in, in the order the boxes are listed. */
export const TODO_STATES: readonly TodoState[] = [...new Set(BOXES.map(([, state]) => state))];

/** The state a box's mark says, or null for a mark no box holds. */
export const stateOfMark = (mark: string): TodoState | null => BOXES.find(([written]) => written === mark)?.[1] ?? null;

/** The mark a box is written with for `state`. */
export const markOf = (state: TodoState): string => BOXES.find(([, said]) => said === state)![0];

/** Each state with the box it is written with, `- [ ] open` and so on, for help that teaches them. */
export const STATES_WRITTEN = TODO_STATES.map((state) => `- [${markOf(state)}] ${state}`).join(", ");

/** A todo's box in a pattern: `[`, any one mark a box can hold, and `]`. */
export const BOX_PATTERN = `\\[[${BOXES.map(([mark]) => mark.replace(/[-\]\\^]/g, "\\$&")).join("")}]\\]`;
