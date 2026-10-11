import { StateField, type EditorState } from "@codemirror/state";
import { todosIn } from "../../plugin-api.ts";

const startsOf = (text: string): ReadonlySet<number> => new Set(todosIn(text).map((todo) => todo.from));

/**
 * Where each line that is a todo starts, read from the whole text by the function the server indexes
 * todos with. So what is drawn as a todo is what the Todos page lists, where the editor's own parse
 * would say otherwise: a checkbox nested three deep is indented as far as a code block is.
 */
export const todoLines = StateField.define<ReadonlySet<number>>({
  create: (state) => startsOf(state.doc.toString()),
  update: (lines, tr) => (tr.docChanged ? startsOf(tr.state.doc.toString()) : lines),
});

/** Whether `pos` is on a line that is a todo. */
export const onTodo = (state: EditorState, pos: number) => state.field(todoLines).has(state.doc.lineAt(pos).from);
